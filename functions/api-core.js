const { cert, getApps, initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");
const crypto = require("node:crypto");

let db;
let firebaseAuth;
const DEVELOPER_EMAILS = new Set(["info.onchari@gmail.com"]);
const LOAN_INTEREST_RATE = 0.1;
const TREASURER_DEFAULT = "Mrs. Kithinji";
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || "qopne8fk";
const PUSH_API_URL = process.env.PUSH_API_URL || "https://legacybuildersgroup.vercel.app/api/send-push";

const emailKey = (email) => String(email || "").trim().toLowerCase();
const safeDocId = (value) => encodeURIComponent(String(value || "").trim()).replace(/\./g, "%2E");
const nowIso = () => new Date().toISOString();
const asNumber = (value) => Number(value) || 0;
const rows = async (collection) => {
    const snapshot = await db.collection(collection).get();
    return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
};
const recordRef = (collection, id) => db.collection(collection).doc(safeDocId(id));
const publicUser = (user) => ({
    email: user.email || "",
    name: user.name || "",
    role: user.role || "member",
    status: user.status || "pending",
    created_at: user.created_at || "",
    approved_by: user.approved_by || "",
    approved_at: user.approved_at || ""
});
const isCloudinaryImageUrl = (value) => {
    try {
        const url = new URL(String(value || ""));
        return url.protocol === "https:"
            && url.hostname === "res.cloudinary.com"
            && url.pathname.startsWith(`/${CLOUDINARY_CLOUD_NAME}/image/upload/`);
    } catch {
        return false;
    }
};

function initializeFirebaseAdmin() {
    if (db && firebaseAuth) return;

    let serviceAccount;
    if (process.env.VERCEL) {
        const serializedAccount = process.env.FIREBASE_SERVICE_ACCOUNT;
        if (!serializedAccount) {
            throw new Error("Firebase Admin configuration error: FIREBASE_SERVICE_ACCOUNT is missing in Vercel.");
        }
        try {
            serviceAccount = JSON.parse(serializedAccount);
        } catch {
            throw new Error("Firebase Admin configuration error: FIREBASE_SERVICE_ACCOUNT must contain the full service-account JSON file contents.");
        }
        if (!serviceAccount.project_id || !serviceAccount.client_email || !serviceAccount.private_key) {
            throw new Error("Firebase Admin configuration error: FIREBASE_SERVICE_ACCOUNT is missing required service-account fields. Use the complete JSON key file.");
        }
    }

    try {
        const app = getApps()[0] || initializeApp(
            serviceAccount ? { credential: cert(serviceAccount) } : {}
        );
        db = getFirestore(app);
        firebaseAuth = getAuth(app);
    } catch (error) {
        console.error("Firebase Admin initialization failed:", error);
        throw new Error("Firebase Admin could not initialize. Verify the service-account key and Firestore permissions.");
    }
}

async function audit(actor, action, details = "") {
    await db.collection("auditLog").add({
        timestamp: nowIso(),
        actor: actor || "Unknown",
        action,
        details: details || ""
    });
}

async function profileFor(email) {
    const ref = db.collection("users").doc(safeDocId(email));
    const snapshot = await ref.get();
    if (!snapshot.exists) return null;
    return { ref, data: snapshot.data() };
}

const isDeveloper = (user) => user.profile.role === "developer";
const isAdmin = (user) => ["admin", "developer"].includes(user.profile.role);
const requireAdmin = (user) => {
    if (!isAdmin(user)) throw new Error("Access denied. Treasurer or developer privileges required.");
};
const requireDeveloper = (user) => {
    if (!isDeveloper(user)) throw new Error("Access denied. Developer privileges required.");
};

async function getTreasurerName() {
    const snapshot = await db.collection("settings").doc("treasurer").get();
    return snapshot.exists && snapshot.data().value
        ? String(snapshot.data().value)
        : TREASURER_DEFAULT;
}

async function emailForName(nameOrEmail) {
    const value = String(nameOrEmail || "").trim();
    if (value.includes("@")) return emailKey(value);
    const users = await rows("users");
    const match = users.find((item) => String(item.name || "").trim().toLowerCase() === value.toLowerCase());
    return emailKey(match && match.email);
}

async function sendPush(title, body, recipient = null, sender = null, data = {}) {
    const subscriptions = await rows("subscriptions");
    const targetEmail = recipient ? await emailForName(recipient) : null;
    const senderEmail = sender ? await emailForName(sender) : null;
    const selected = recipient
        ? (targetEmail ? subscriptions.filter((item) => emailKey(item.email) === targetEmail) : [])
        : subscriptions.filter((item) => !senderEmail || emailKey(item.email) !== senderEmail);
    const results = await Promise.allSettled(selected.map(async (item) => {
        const subscription = item.subscription || {
            endpoint: item.endpoint,
            keys: { auth: item.auth, p256dh: item.p256dh }
        };
        const response = await fetch(PUSH_API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ subscription, title, body, data })
        });
        if (!response.ok && response.status !== 410) {
            throw new Error(`Push API returned HTTP ${response.status}`);
        }
        if (response.status === 410) await recordRef("subscriptions", item.id).delete();
    }));
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length) console.error("Some push notifications could not be delivered", failures);
    return selected.length - failures.length;
}

function summarizeData(transactions, activeLoans) {
    let savingsIn = 0;
    let loansTaken = 0;
    let repaid = 0;
    for (const row of transactions) {
        const amount = asNumber(row.amount);
        if (row.type === "Savings") savingsIn += amount;
        else if (row.type === "Loan Taken") loansTaken += amount;
        else if (row.type === "Loan Repayment") repaid += amount;
    }
    const outstanding = activeLoans.reduce((total, loan) => {
        if (loan.status === "paid_off") return total;
        return total + Math.max(0, asNumber(loan.principal) - asNumber(loan.amountRepaid));
    }, 0);
    const interestEarned = activeLoans.reduce((total, loan) => total + asNumber(loan.interest), 0);
    return {
        success: true,
        savings: Math.max(0, savingsIn - outstanding),
        loansTaken,
        repaid,
        outstanding,
        interestEarned
    };
}

async function getSummaryData() {
    const [transactions, activeLoans] = await Promise.all([
        rows("transactions"),
        rows("activeLoans")
    ]);
    return summarizeData(transactions, activeLoans);
}

async function getDashboard(user, params) {
    const collections = ["transactions", "users", "pendingLoans", "activeLoans"];
    if (isAdmin(user)) collections.push("pendingTransactions", "pendingEdits", "loansAwaitingDueDate");
    const values = await Promise.all(collections.map(rows));
    const data = Object.fromEntries(collections.map((name, index) => [name, values[index]]));
    const allTransactions = data.transactions || [];
    const summary = summarizeData(allTransactions, data.activeLoans || []);
    const members = (data.users || [])
        .filter((item) => item.status === "approved" && item.name)
        .map((item) => item.name);
    const loans = (data.pendingLoans || []).map((loan) => {
        const principal = asNumber(loan.amount ?? loan.principal);
        const interest = Math.round(principal * LOAN_INTEREST_RATE);
        return {
            id: loan.id,
            date: loan.date || "",
            member: loan.member || "",
            principal,
            interest,
            totalDue: principal + interest,
            message: loan.message || loan.description || "",
            approvals: Array.isArray(loan.approvals) ? loan.approvals : [],
            status: loan.status || "pending"
        };
    });
    const activeLoans = (data.activeLoans || []).map((loan) => {
        const totalDue = asNumber(loan.totalDue);
        const amountRepaid = asNumber(loan.amountRepaid);
        const remaining = Math.max(0, totalDue - amountRepaid);
        const dueDate = loan.dueDate || "";
        const isOverdue = Boolean(dueDate && remaining > 0 && new Date(dueDate) < new Date(new Date().toDateString()));
        return {
            ...loan,
            loanId: loan.loanId || loan.id,
            totalDue,
            amountRepaid,
            remaining,
            status: remaining <= 0 ? "paid_off" : (isOverdue ? "overdue" : "active"),
            isOverdue
        };
    });
    const pendingEditsMap = {};
    for (const edit of data.pendingEdits || []) {
        const key = `${String(edit.member).trim()}|${String(edit.type).trim()}|${asNumber(edit.newAmount)}`;
        pendingEditsMap[key] = {
            editId: edit.id,
            originalAmount: asNumber(edit.originalAmount),
            originalMessage: edit.originalMessage || ""
        };
    }
    const result = {
        success: true,
        records: allTransactions.map((item) => ({
            ...item,
            date: item.date || "",
            member: item.member || "",
            type: item.type || "",
            amount: asNumber(item.amount)
        })),
        summary,
        members,
        loans,
        pendingTransactions: isAdmin(user) ? (data.pendingTransactions || []) : [],
        pendingEditsMap: isAdmin(user) ? pendingEditsMap : {},
        activeLoans: params.includeLoanTracking === "false" ? [] : activeLoans,
        treasurerName: await getTreasurerName()
    };
    if (isAdmin(user) && params.includeLoanTracking !== "false") {
        result.loansAwaitingDueDate = data.loansAwaitingDueDate || [];
    }
    return result;
}

async function handleAction(action, params, user) {
    const name = user.profile.name || user.auth.name || user.email.split("@")[0];
    switch (action) {
        case "bootstrapProfile":
            return { success: true, name, email: user.email, role: user.profile.role || "member", status: user.profile.status };
        case "getProfileImage": {
            const snapshot = await db.collection("profileImages").doc(safeDocId(user.email)).get();
            return {
                success: true,
                image: snapshot.exists ? snapshot.data().image || null : null,
                publicId: snapshot.exists ? snapshot.data().publicId || null : null
            };
        }
        case "saveProfileImage": {
            if (emailKey(params.email) !== user.email) throw new Error("You can only update your own profile photo.");
            const image = String(params.image || "");
            const publicId = String(params.publicId || "");
            const legacyImage = image.startsWith("data:image/") && image.length <= 48000;
            const cloudinaryImage = isCloudinaryImageUrl(image)
                && publicId.startsWith("legacy-builders/profiles/")
                && publicId.length <= 255;
            if (!legacyImage && !cloudinaryImage) {
                throw new Error("Choose a valid profile photo uploaded to Cloudinary.");
            }
            await db.collection("profileImages").doc(safeDocId(user.email)).set({
                email: user.email,
                name,
                image,
                publicId: cloudinaryImage ? publicId : "",
                updated_at: nowIso()
            }, { merge: true });
            return { success: true };
        }
        case "getGroupMemories": {
            const snapshot = await db.collection("groupMemories")
                .orderBy("created_at", "desc")
                .limit(50)
                .get();
            return {
                success: true,
                memories: snapshot.docs
                    .map((doc) => ({ id: doc.id, ...doc.data() }))
                    .filter((item) => isCloudinaryImageUrl(item.image))
            };
        }
        case "saveGroupMemory": {
            const image = String(params.image || "");
            const publicId = String(params.publicId || "");
            const caption = String(params.caption || "").trim();
            if (!isCloudinaryImageUrl(image) || !publicId.startsWith("legacy-builders/memories/") || publicId.length > 255) {
                throw new Error("Choose a valid photo uploaded to Cloudinary.");
            }
            if (caption.length > 200) throw new Error("Memory captions must be 200 characters or fewer.");
            const id = crypto.randomUUID();
            const memory = {
                id,
                image,
                publicId,
                caption,
                member: name,
                email: user.email,
                created_at: nowIso()
            };
            await recordRef("groupMemories", id).create(memory);
            return { success: true, memory };
        }
        case "getGroupMessages": {
            const [messageSnapshot, requestSnapshot] = await Promise.all([
                db.collection("groupMessages").orderBy("created_at", "desc").limit(100).get(),
                db.collection("registrationRequests").where("status", "==", "pending").limit(50).get()
            ]);
            const messages = messageSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
            const joinRequests = requestSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
            messages.sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
            joinRequests.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
            return {
                success: true,
                messages,
                joinRequests
            };
        }
        case "sendGroupMessage": {
            const message = String(params.message || "").trim();
            if (!message || message.length > 1000) throw new Error("Messages must be 1-1,000 characters.");
            const id = crypto.randomUUID();
            const item = {
                id,
                message,
                member: name,
                email: user.email,
                created_at: nowIso()
            };
            await recordRef("groupMessages", id).create(item);
            return { success: true, message: item };
        }
        case "getMembersWithImages": {
            const members = await rows("users");
            const images = await rows("profileImages");
            const byEmail = new Map(images.map((item) => [emailKey(item.email || item.id), item.image]));
            return {
                success: true,
                members: members.filter((item) => item.status === "approved").map((item) => ({
                    name: item.name || "",
                    email: item.email || "",
                    role: item.role || "member",
                    image: byEmail.get(emailKey(item.email)) || null,
                    hasImage: Boolean(byEmail.get(emailKey(item.email)))
                }))
            };
        }
        case "getDashboardData":
            return getDashboard(user, params);
        case "get":
            return { success: true, records: (await rows("transactions")) };
        case "getSummary":
            return getSummaryData();
        case "submitTransaction": {
            const type = String(params.type || "");
            const amount = Number(params.amount);
            if (!["Savings", "Loan Repayment"].includes(type) || !Number.isFinite(amount) || amount <= 0) {
                throw new Error("Choose a valid transaction type and positive amount.");
            }
            if (type === "Loan Repayment" && !params.loanId) throw new Error("Choose the loan being repaid.");
            const id = crypto.randomUUID();
            await recordRef("pendingTransactions", id).create({
                id, date: params.date || "", member: name, type, amount,
                message: String(params.message || ""), submittedBy: name,
                submittedAt: nowIso(), loanId: params.loanId || ""
            });
            await audit(name, `Submitted ${type}`, `KES ${amount.toLocaleString()} — awaiting approval`);
            await sendPush(
                `New Transaction from ${name}`,
                `${name} submitted a ${type} of KES ${amount.toLocaleString()}. Please approve.`,
                await emailForName(await getTreasurerName()),
                name,
                { type: "transaction_submission", amount, member: name, transactionType: type, transactionId: id }
            );
            return { success: true, id };
        }
        case "approveTransaction": {
            requireAdmin(user);
            const id = String(params.id || "");
            const ref = recordRef("pendingTransactions", id);
            let transaction;
            await db.runTransaction(async (tx) => {
                const snapshot = await tx.get(ref);
                if (!snapshot.exists) throw new Error("Pending transaction not found.");
                transaction = snapshot.data();
                if (transaction.editId) {
                    const editRef = recordRef("pendingEdits", transaction.editId);
                    const editSnapshot = await tx.get(editRef);
                    if (!editSnapshot.exists) throw new Error("The related edit request could not be found.");
                    const edit = editSnapshot.data();
                    const originalRef = recordRef("transactions", edit.transactionId);
                    const originalSnapshot = await tx.get(originalRef);
                    if (!originalSnapshot.exists) throw new Error("The original transaction no longer exists.");
                    tx.update(originalRef, {
                        amount: asNumber(edit.newAmount),
                        message: edit.newMessage || "",
                        approvedBy: name,
                        approvalDate: nowIso()
                    });
                    tx.delete(editRef);
                } else {
                    const txRef = db.collection("transactions").doc();
                    tx.create(txRef, {
                        date: transaction.date || "",
                        member: transaction.member,
                        type: transaction.type,
                        amount: asNumber(transaction.amount),
                        message: transaction.message || "",
                        status: "Approved",
                        approvedBy: name,
                        approvalDate: nowIso(),
                        balanceAfter: 0,
                        loanId: transaction.loanId || ""
                    });
                }
                tx.delete(ref);
                if (!transaction.editId && transaction.type === "Loan Repayment" && transaction.loanId) {
                    const loanRef = recordRef("activeLoans", transaction.loanId);
                    const loanSnap = await tx.get(loanRef);
                    if (loanSnap.exists) {
                        const loan = loanSnap.data();
                        const repaid = asNumber(loan.amountRepaid) + asNumber(transaction.amount);
                        tx.update(loanRef, { amountRepaid: repaid, status: repaid >= asNumber(loan.totalDue) ? "paid_off" : "active" });
                    }
                }
            });
            await audit(name, transaction.editId ? "Approved transaction edit" : `Approved ${transaction.type}`, `${transaction.member}'s KES ${asNumber(transaction.amount).toLocaleString()}`);
            await sendPush("Transaction Approved", `Your ${transaction.type} of KES ${asNumber(transaction.amount).toLocaleString()} has been approved by ${name}.`, transaction.member, name, { type: "transaction_approved" });
            return { success: true };
        }
        case "rejectTransaction": {
            requireAdmin(user);
            const ref = recordRef("pendingTransactions", params.id);
            const snapshot = await ref.get();
            if (!snapshot.exists) throw new Error("Pending transaction not found.");
            const transaction = snapshot.data();
            await ref.delete();
            await audit(name, `Rejected ${transaction.type}`, `${transaction.member}'s KES ${asNumber(transaction.amount).toLocaleString()}`);
            await sendPush("Transaction Rejected", `Your ${transaction.type} transaction was rejected.`, transaction.member, name, { type: "transaction_rejected" });
            return { success: true };
        }
        case "submitLoan": {
            const amount = Number(params.amount);
            if (!Number.isFinite(amount) || amount <= 0) throw new Error("Loan amount must be positive.");
            const summary = await getSummaryData();
            if (amount > summary.savings) throw new Error(`Loan exceeds available savings of KES ${summary.savings.toLocaleString()}.`);
            const id = crypto.randomUUID();
            await recordRef("pendingLoans", id).create({
                id, date: params.date || "", member: name, amount,
                message: String(params.message || ""), notes: String(params.notes || ""),
                approvals: [], status: "pending", createdAt: nowIso()
            });
            await audit(name, "Requested a loan", `KES ${amount.toLocaleString()} — needs member approval`);
            await sendPush(
                `New Loan Request from ${name}`,
                `${name} has requested a loan of KES ${amount.toLocaleString()}. Please approve.`,
                null,
                name,
                { type: "loan_request", amount, member: name, loanId: id }
            );
            return { success: true, id };
        }
        case "approveLoan": {
            const id = String(params.loanId || "");
            const ref = recordRef("pendingLoans", id);
            let approvalCount = 0;
            let completedLoan = null;
            await db.runTransaction(async (tx) => {
                const [loanSnap, usersSnap] = await Promise.all([
                    tx.get(ref),
                    tx.get(db.collection("users").where("status", "==", "approved"))
                ]);
                if (!loanSnap.exists) throw new Error("Loan not found.");
                const loan = loanSnap.data();
                if (loan.member === name) throw new Error("You cannot approve your own loan request.");
                const approvals = Array.isArray(loan.approvals) ? loan.approvals : [];
                if (approvals.includes(name)) throw new Error("You already approved this loan.");
                approvals.push(name);
                approvalCount = approvals.length;
                const needed = Math.max(usersSnap.size - 1, 1);
                if (approvalCount >= needed) {
                    completedLoan = { ...loan, approvals, approvedBy: approvals.join(", ") };
                    tx.create(recordRef("loansAwaitingDueDate", id), completedLoan);
                    tx.delete(ref);
                } else {
                    tx.update(ref, { approvals });
                }
            });
            await audit(name, "Approved a loan vote", `${approvalCount} approval(s)`);
            if (completedLoan) {
                await sendPush(
                    "Loan Fully Approved!",
                    `Your loan of KES ${asNumber(completedLoan.amount).toLocaleString()} has been approved by all members. The treasurer will set a repayment due date.`,
                    completedLoan.member,
                    name,
                    { type: "loan_fully_approved", loanId: id, amount: asNumber(completedLoan.amount) }
                );
                await sendPush(
                    "Set Loan Due Date",
                    `${completedLoan.member}'s loan has been fully approved and needs a due date.`,
                    await getTreasurerName(),
                    name,
                    { type: "loan_needs_due_date", loanId: id, member: completedLoan.member }
                );
            } else {
                const loan = await ref.get();
                const member = loan.exists ? loan.data().member : "";
                await sendPush(
                    "Loan Approval Update",
                    `${name} approved ${member}'s loan. ${Math.max(0, Math.max(1, (await rows("users")).filter((item) => item.status === "approved").length - 1) - approvalCount)} more approval(s) needed.`,
                    member,
                    name,
                    { type: "loan_approval_update", loanId: id, approvals: approvalCount }
                );
            }
            return { success: true, approvals: approvalCount };
        }
        case "rejectLoan": {
            requireAdmin(user);
            const ref = recordRef("pendingLoans", params.loanId);
            const snapshot = await ref.get();
            if (!snapshot.exists) throw new Error("Loan not found.");
            const loan = snapshot.data();
            await ref.delete();
            await audit(name, "Rejected a loan request", `${loan.member}'s loan request`);
            await sendPush("Loan Request Rejected", `Your loan request has been rejected by ${name}.`, loan.member, name, { type: "loan_rejected", loanId: params.loanId });
            return { success: true };
        }
        case "cancelLoan": {
            const ref = recordRef("pendingLoans", params.loanId);
            const snapshot = await ref.get();
            if (!snapshot.exists) throw new Error("Loan not found.");
            if (snapshot.data().member !== name && !isAdmin(user)) throw new Error("You can only cancel your own loan request.");
            const loan = snapshot.data();
            await ref.delete();
            await sendPush("Loan Request Cancelled", `${name} cancelled a loan request of KES ${asNumber(loan.amount).toLocaleString()}.`, null, name, { type: "loan_cancelled", loanId: params.loanId });
            return { success: true };
        }
        case "setLoanDueDate": {
            requireAdmin(user);
            const loanId = String(params.loanId || "");
            const dueDate = String(params.dueDate || "");
            if (!dueDate) throw new Error("Due date is required.");
            const awaitingRef = recordRef("loansAwaitingDueDate", loanId);
            let loanMember = "";
            await db.runTransaction(async (tx) => {
                const snapshot = await tx.get(awaitingRef);
                if (!snapshot.exists) throw new Error("Loan not found or already activated.");
                const loan = snapshot.data();
                loanMember = loan.member;
                const principal = asNumber(loan.principal ?? loan.amount);
                const interest = Math.round(principal * LOAN_INTEREST_RATE);
                const activeRef = recordRef("activeLoans", loanId);
                const transactionRef = db.collection("transactions").doc();
                tx.create(activeRef, {
                    loanId, member: loan.member, principal, interest, totalDue: principal + interest,
                    amountRepaid: 0, dueDate, dateTaken: loan.date || "", status: "active"
                });
                tx.create(transactionRef, {
                    date: loan.date || "", member: loan.member, type: "Loan Taken",
                    amount: principal, message: loan.message || loan.description || "",
                    status: "Approved", approvedBy: loan.approvedBy || "", approvalDate: nowIso(), balanceAfter: 0
                });
                tx.delete(awaitingRef);
            });
            await audit(name, "Activated loan with due date", `${loanId} — due ${dueDate}`);
            await sendPush("Loan Activated", `Your loan is active. Repayment due: ${dueDate}.`, loanMember, name, { type: "loan_due_date_set", loanId, dueDate });
            return { success: true };
        }
        case "getPendingRegistrations":
        case "getPendingTransactions":
        case "getPendingLoans":
        case "getLoansAwaitingDueDate":
        case "getActiveLoans":
        case "getMeetingMinutes":
        case "getAuditLog":
        case "getDeveloperAuditLog":
        case "getAllUsersFull":
        case "getSystemStats":
        case "getScheduledMeeting":
        case "getTreasurerInfo":
        case "getSubscriptions": {
            if (["getPendingRegistrations", "getPendingTransactions", "getLoansAwaitingDueDate"].includes(action)) requireAdmin(user);
            if (["getDeveloperAuditLog", "getAllUsersFull", "getSystemStats", "getSubscriptions"].includes(action)) requireDeveloper(user);
            if (action === "getPendingRegistrations") {
                const [users, joinRequests] = await Promise.all([
                    rows("users"),
                    rows("registrationRequests")
                ]);
                return {
                    success: true,
                    registrations: users.filter((item) => item.status === "pending").map(publicUser),
                    joinRequests: joinRequests.filter((item) => item.status === "pending")
                };
            }
            if (action === "getPendingTransactions") return { success: true, transactions: await rows("pendingTransactions") };
            if (action === "getPendingLoans") return { success: true, loans: await rows("pendingLoans") };
            if (action === "getLoansAwaitingDueDate") return { success: true, loans: await rows("loansAwaitingDueDate") };
            if (action === "getActiveLoans") return { success: true, loans: await rows("activeLoans") };
            if (action === "getMeetingMinutes") {
                const meetings = await rows("meetingMinutes");
                meetings.sort((a, b) => String(a.date).localeCompare(String(b.date)));
                return { success: true, meetings };
            }
            if (action === "getAuditLog" || action === "getDeveloperAuditLog") {
                const entries = await rows("auditLog");
                entries.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
                return { success: true, entries: entries.slice(0, Math.min(Number(params.limit) || 50, 200)) };
            }
            if (action === "getAllUsersFull") return { success: true, users: (await rows("users")).map(publicUser) };
            if (action === "getSystemStats") {
                const [users, joinRequests, pendingTransactions, pendingLoans, activeLoans, subscriptions, summary] = await Promise.all([
                    rows("users"), rows("registrationRequests"), rows("pendingTransactions"), rows("pendingLoans"),
                    rows("activeLoans"), rows("subscriptions"), getSummaryData()
                ]);
                const pendingUserEmails = new Set(users
                    .filter((item) => item.status === "pending")
                    .map((item) => emailKey(item.email)));
                return {
                    success: true,
                    stats: {
                        totalUsers: users.length,
                        pendingRegistrations: pendingUserEmails.size + joinRequests.filter((item) =>
                            item.status === "pending" && !pendingUserEmails.has(emailKey(item.email))
                        ).length,
                        pendingTransactions: pendingTransactions.length,
                        pendingLoans: pendingLoans.length,
                        activeLoans: activeLoans.filter((item) => item.status !== "paid_off").length,
                        pushSubscriptions: subscriptions.length,
                        totalSavings: summary.savings,
                        outstandingLoans: summary.outstanding,
                        interestEarned: summary.interestEarned
                    }
                };
            }
            if (action === "getScheduledMeeting") {
                const snapshot = await db.collection("scheduledMeeting").doc("current").get();
                return { success: true, meeting: snapshot.exists ? snapshot.data() : null };
            }
            if (action === "getTreasurerInfo") return { success: true, name: await getTreasurerName() };
            return { success: true, subscriptions: await rows("subscriptions") };
        }
        case "approveRegistration": {
            requireAdmin(user);
            const email = emailKey(params.email);
            const ref = db.collection("users").doc(safeDocId(email));
            const requestRef = db.collection("registrationRequests").doc(safeDocId(email));
            const [snapshot, requestSnapshot] = await Promise.all([ref.get(), requestRef.get()]);
            if (snapshot.exists) {
                const updates = { status: "approved", approved_by: name, approved_at: nowIso() };
                await Promise.all([
                    ref.update(updates),
                    ...(requestSnapshot.exists && requestSnapshot.data().status === "pending"
                        ? [requestRef.update(updates)]
                        : [])
                ]);
            } else if (requestSnapshot.exists && requestSnapshot.data().status === "pending") {
                const request = requestSnapshot.data();
                await ref.create({
                    email,
                    name: request.name,
                    role: "member",
                    status: "approved",
                    created_at: request.created_at || nowIso(),
                    approved_by: name,
                    approved_at: nowIso()
                });
                await requestRef.update({ status: "approved", approved_by: name, approved_at: nowIso() });
            } else {
                throw new Error("Registration request not found.");
            }
            await audit(name, "Approved registration", email);
            return { success: true };
        }
        case "rejectRegistration": {
            requireAdmin(user);
            const email = emailKey(params.email);
            const ref = db.collection("users").doc(safeDocId(email));
            const requestRef = db.collection("registrationRequests").doc(safeDocId(email));
            const [snapshot, requestSnapshot] = await Promise.all([ref.get(), requestRef.get()]);
            if (snapshot.exists) {
                const updates = { status: "rejected", rejected_by: name, rejected_at: nowIso() };
                await Promise.all([
                    ref.update(updates),
                    ...(requestSnapshot.exists && requestSnapshot.data().status === "pending"
                        ? [requestRef.update(updates)]
                        : [])
                ]);
            } else if (requestSnapshot.exists && requestSnapshot.data().status === "pending") {
                await requestRef.update({ status: "rejected", rejected_by: name, rejected_at: nowIso() });
            } else {
                throw new Error("Registration request not found.");
            }
            await audit(name, "Rejected registration", email);
            return { success: true };
        }
        case "updateUserRole": {
            requireDeveloper(user);
            const email = emailKey(params.email);
            const role = String(params.role || "").toLowerCase();
            if (!["member", "admin", "developer"].includes(role)) throw new Error("Invalid role.");
            if (email === user.email) throw new Error("You cannot change your own role.");
            const ref = db.collection("users").doc(safeDocId(email));
            const snapshot = await ref.get();
            if (!snapshot.exists) throw new Error("User not found.");
            if (snapshot.data().role === "developer" && role !== "developer") {
                const developers = (await rows("users")).filter((item) => item.role === "developer" && item.status === "approved");
                if (developers.length <= 1) throw new Error("Cannot remove the last developer.");
            }
            await ref.update({ role });
            await audit(name, "Updated user role", `${email} → ${role}`);
            return { success: true, message: `User role updated to ${role}` };
        }
        case "deleteUser": {
            requireDeveloper(user);
            const email = emailKey(params.email);
            if (email === user.email) throw new Error("You cannot delete your own account.");
            const ref = db.collection("users").doc(safeDocId(email));
            const snapshot = await ref.get();
            if (!snapshot.exists) throw new Error("User not found.");
            if (snapshot.data().role === "developer") {
                const developers = (await rows("users")).filter((item) => item.role === "developer" && item.status === "approved");
                if (developers.length <= 1) throw new Error("Cannot disable the last developer.");
            }
            // Preserve history: disable the profile rather than deleting its document.
            await ref.update({ status: "disabled", disabled_at: nowIso() });
            await audit(name, "Disabled user", email);
            return { success: true, message: `User ${email} has been disabled.` };
        }
        case "refreshAllData":
            requireDeveloper(user);
            await audit(name, "Refreshed all system data", "Developer forced data refresh");
            return { success: true, message: "All data refreshed successfully." };
        case "saveMeetingMinutes": {
            requireAdmin(user);
            const id = crypto.randomUUID();
            await recordRef("meetingMinutes", id).create({
                id, date: params.date || "", recordedBy: name, agenda: String(params.agenda || ""),
                notes: String(params.notes || ""), decisions: String(params.decisions || ""),
                nextMeeting: params.nextMeeting || ""
            });
            await audit(name, "Saved meeting minutes", params.date || "");
            return { success: true, id };
        }
        case "deleteMeeting": {
            requireAdmin(user);
            const ref = recordRef("meetingMinutes", params.id);
            if (!(await ref.get()).exists) throw new Error("Meeting not found.");
            await ref.delete();
            return { success: true };
        }
        case "scheduleMeeting": {
            requireAdmin(user);
            await db.collection("scheduledMeeting").doc("current").set({
                date: params.date || "", agenda: String(params.agenda || ""),
                venue: String(params.venue || ""), scheduledBy: name
            });
            await sendPush("New Meeting Scheduled", `A meeting has been scheduled for ${params.date || ""}.`, null, name, { type: "meeting_scheduled", date: params.date || "", agenda: params.agenda || "", venue: params.venue || "" });
            return { success: true };
        }
        case "cancelScheduledMeeting":
            requireAdmin(user);
            await db.collection("scheduledMeeting").doc("current").delete();
            await sendPush("Meeting Cancelled", "The scheduled meeting has been cancelled.", null, name, { type: "meeting_cancelled" });
            return { success: true };
        case "savePushSubscription": {
            const subscription = params.subscription;
            if (!subscription || !subscription.endpoint || !subscription.keys) throw new Error("Valid push subscription is required.");
            const id = crypto.createHash("sha256").update(subscription.endpoint).digest("hex");
            await recordRef("subscriptions", id).set({
                email: user.email, endpoint: subscription.endpoint,
                auth: subscription.keys.auth || "", p256dh: subscription.keys.p256dh || "",
                subscription, timestamp: nowIso()
            }, { merge: true });
            return { success: true };
        }
        case "sendPushNotification": {
            requireAdmin(user);
            const count = await sendPush(
                String(params.title || "Legacy Builders Group"),
                String(params.body || ""),
                params.recipient || null,
                params.sender || name,
                params.data || {}
            );
            return { success: true, sent: count };
        }
        case "requestTransactionEdit": {
            const rowKey = String(params.rowKey || "");
            const [date, member, type, amountValue] = rowKey.split("|");
            if (member !== name) throw new Error("You can only request changes to your own transaction.");
            const newAmount = Number(params.newAmount);
            if (!Number.isFinite(newAmount) || newAmount <= 0) throw new Error("Enter a valid amount.");
            const matches = (await rows("transactions")).filter((item) =>
                item.date === date && item.member === member && item.type === type && asNumber(item.amount) === Number(amountValue)
            );
            if (matches.length !== 1) throw new Error("Could not uniquely identify the transaction to edit.");
            const id = crypto.randomUUID();
            const batch = db.batch();
            batch.create(recordRef("pendingEdits", id), {
                id, member, type, originalAmount: Number(amountValue), newAmount,
                originalMessage: matches[0].message || "", newMessage: String(params.newMessage || ""),
                transactionId: matches[0].id, requestedBy: name, requestedAt: nowIso()
            });
            batch.create(recordRef("pendingTransactions", id), {
                id, editId: id, date, member, type, amount: newAmount,
                message: String(params.newMessage || ""), submittedBy: name, submittedAt: nowIso()
            });
            await batch.commit();
            return { success: true, id };
        }
        case "rejectTransactionEdit": {
            requireAdmin(user);
            const ref = recordRef("pendingEdits", params.editId);
            const snapshot = await ref.get();
            if (!snapshot.exists) throw new Error("Pending edit not found.");
            const batch = db.batch();
            batch.delete(ref);
            batch.delete(recordRef("pendingTransactions", params.editId));
            await batch.commit();
            await audit(name, "Rejected transaction edit", String(params.editId));
            return { success: true };
        }
        default:
            throw new Error(`Unknown Firebase action: ${String(action || "")}`);
    }
}

function setResponseHeader(res, name, value) {
    if (typeof res.set === "function") res.set(name, value);
    else res.setHeader(name, value);
}

function sendJson(res, statusCode, body) {
    if (typeof res.status === "function" && typeof res.json === "function") {
        return res.status(statusCode).json(body);
    }
    res.statusCode = statusCode;
    setResponseHeader(res, "Content-Type", "application/json");
    return res.end(JSON.stringify(body));
}

function getRequestHeader(req, name) {
    if (typeof req.get === "function") return req.get(name) || "";
    const value = req.headers && req.headers[name.toLowerCase()];
    return Array.isArray(value) ? value[0] || "" : value || "";
}

async function submitJoinRequest(params) {
    const name = String(params.name || "").trim();
    const email = emailKey(params.email);
    if (name.length < 2 || name.length > 80) throw new Error("Enter a name between 2 and 80 characters.");
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new Error("Enter a valid email address.");
    }

    const userRef = db.collection("users").doc(safeDocId(email));
    const requestRef = db.collection("registrationRequests").doc(safeDocId(email));
    let alreadySubmitted = false;
    await db.runTransaction(async (transaction) => {
        const [userSnapshot, requestSnapshot] = await Promise.all([
            transaction.get(userRef),
            transaction.get(requestRef)
        ]);
        if (userSnapshot.exists) {
            const status = userSnapshot.data().status;
            throw new Error(status === "approved"
                ? "This email already has an approved account. Please sign in with Google."
                : "A registration for this email is already being reviewed.");
        }
        if (requestSnapshot.exists && requestSnapshot.data().status === "pending") {
            alreadySubmitted = true;
            return;
        }
        transaction.set(requestRef, {
            email,
            name,
            status: "pending",
            created_at: nowIso()
        });
    });
    return {
        success: true,
        status: "pending",
        alreadySubmitted,
        message: "Your request has been sent to the group for review."
    };
}

async function handleApiRequest(req, res) {
    const origin = getRequestHeader(req, "origin");
    const allowedOrigins = new Set([
        "https://legacybuildersgroup.vercel.app",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        ...(process.env.ALLOWED_ORIGINS || "").split(",").map((value) => value.trim()).filter(Boolean)
    ]);
    if (allowedOrigins.has(origin)) setResponseHeader(res, "Access-Control-Allow-Origin", origin);
    setResponseHeader(res, "Vary", "Origin");
    setResponseHeader(res, "Access-Control-Allow-Headers", "Authorization, Content-Type");
    setResponseHeader(res, "Access-Control-Allow-Methods", "POST, OPTIONS");
    if (req.method === "OPTIONS") {
        res.statusCode = 204;
        return res.end();
    }
    if (req.method !== "POST") return sendJson(res, 405, { success: false, error: "Method not allowed" });
    try {
        initializeFirebaseAdmin();
        const action = req.body && req.body.action;
        const params = req.body && typeof req.body === "object" ? req.body : {};
        if (action === "submitJoinRequest") {
            return sendJson(res, 200, await submitJoinRequest(params));
        }
        const header = getRequestHeader(req, "authorization");
        const tokenMatch = header.match(/^Bearer\s+(.+)$/i);
        if (!tokenMatch) throw new Error("Authentication required");
        const decoded = await firebaseAuth.verifyIdToken(tokenMatch[1]);
        const email = emailKey(decoded.email);
        if (!email || !decoded.email_verified) throw new Error("A verified Google account is required");
        let profile = await profileFor(email);
        if (action === "bootstrapProfile" && !profile) {
            const ref = db.collection("users").doc(safeDocId(email));
            const role = DEVELOPER_EMAILS.has(email) ? "developer" : "member";
            const data = {
                email,
                name: decoded.name || email.split("@")[0],
                role,
                status: role === "developer" ? "approved" : "pending",
                created_at: nowIso()
            };
            await ref.create(data);
            profile = { ref, data };
            await audit(data.name, "Requested to join the group", "Google sign-in registration");
        }
        if (!profile) throw new Error("Account is not registered. Sign in again to submit a registration.");
        if (profile.data.status !== "approved" && action !== "bootstrapProfile") {
            throw new Error(profile.data.status === "pending" ? "Your account is pending approval." : "This account is not approved.");
        }
        if (action === "bootstrapProfile" && profile.data.status !== "approved") {
            return sendJson(res, 200, {
                success: true, status: profile.data.status, email,
                name: profile.data.name || decoded.name || ""
            });
        }
        const user = { auth: decoded, email, ref: profile.ref, profile: profile.data };
        const result = await handleAction(action, params, user);
        return sendJson(res, 200, result);
    } catch (error) {
        const message = error && error.message ? error.message : "Unexpected Firebase API error";
        if (message.startsWith("Firebase Admin")) {
            return sendJson(res, 500, { success: false, error: message });
        }
        const unauthenticated = message.includes("Authentication") || message.includes("verified Google");
        if (!unauthenticated) console.error("Firebase API request failed:", error);
        return sendJson(res, unauthenticated ? 401 : 200, { success: false, error: message });
    }
}

module.exports = { handleApiRequest };
