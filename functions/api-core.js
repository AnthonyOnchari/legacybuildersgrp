const { cert, getApps, initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { AggregateField, FieldPath, getFirestore } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");
const crypto = require("node:crypto");

let db;
let firebaseAuth;
let storageBucket;
let pushSubscriptionsCache = null;
let pushSubscriptionsCacheExpiresAt = 0;
const DEVELOPER_EMAILS = new Set(["info.onchari@gmail.com"]);
const BANK_INTEREST_EARNED_DEFAULT = 252.90;
const COMPANY_FILE_MAX_BYTES = 20 * 1024 * 1024;
const COMPANY_FILE_MIME_TYPES = new Set([
    "application/pdf", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-powerpoint", "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "text/plain", "text/csv", "image/jpeg", "image/png"
]);
const COMPANY_FILE_OTP_COOLDOWN_MS = 60 * 1000;
const COMPANY_FILE_OTP_LIFETIME_MS = 10 * 60 * 1000;
const LOAN_INTEREST_RATE = 0.1;
const LOAN_RESERVE_RATIO = 0.5;
const TREASURER_DEFAULT = "Mrs. Kithinji";
const POSITION_TITLES = new Set(["Chairman", "Vice-Chairman", "Treasurer", "Secretary", "Member"]);
const PROFILE_SALUTATIONS = new Set(["Mr.", "Mrs."]);
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || "qopne8fk";
const PAYMENT_EVIDENCE_BUCKET = process.env.FIREBASE_STORAGE_BUCKET || "legacy-builders-group.firebasestorage.app";
const PAYMENT_EVIDENCE_MAX_BYTES = 5 * 1024 * 1024;
const PAYMENT_EVIDENCE_TYPES = new Set(["application/pdf", "image/jpeg", "image/png"]);
const PUSH_API_URL = process.env.PUSH_API_URL || "https://legacybuildersgroup.vercel.app/api/send-push";

const emailKey = (email) => String(email || "").trim().toLowerCase();
const safeDocId = (value) => encodeURIComponent(String(value || "").trim()).replace(/\./g, "%2E");
const nowIso = () => new Date().toISOString();
const asNumber = (value) => Number(value) || 0;
const isIsoDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
    && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
const rows = async (collection) => {
    const snapshot = await db.collection(collection).get();
    return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
};
const recordRef = (collection, id) => db.collection(collection).doc(safeDocId(id));
const cleanCompanyFileName = (value) => String(value || "").replace(/[\\/\r\n\"]+/g, "_").trim().slice(0, 120);
const companyFileOtpHash = (challengeId, code) => crypto
    .createHmac("sha256", process.env.RESEND_API_KEY || "")
    .update(`${challengeId}:${code}`)
    .digest("hex");
async function sendCompanyFileOtp(email, code, memberName) {
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.RESEND_FROM_EMAIL;
    if (!apiKey || !from) {
        console.error("Company file email delivery is not configured.");
        throw new Error("Email access codes are not available yet. Contact the administrator.");
    }
    const safeName = String(memberName || "NBFA Group member").replace(/[&<>"']/g, (character) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
    })[character]);
    const text = `Hello ${memberName || "NBFA Group member"},\n\nYour NBFA Group company files access code is ${code}.\n\nEnter this six-digit code in Company Files to view shared documents. It expires in 10 minutes. Keep it private; if you did not request it, you can ignore this email.\n\nNBFA Group`;
    const html = `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">Your NBFA Group access code expires in 10 minutes.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f7fa;font-family:Arial,Helvetica,sans-serif;color:#243447"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background:#ffffff;border:1px solid #e3e8ef;border-radius:14px">
<tr><td align="center" style="padding:26px 28px 20px"><img src="https://legacybuildersgroup.vercel.app/Assets/notification-icon.png" alt="NBFA Group logo" width="88" height="88" style="display:block;width:88px;height:88px;margin:0 auto 10px"><div style="font-size:13px;font-weight:700;letter-spacing:2px;color:#225b9b">NBFA GROUP</div><div style="margin-top:5px;font-size:11px;color:#697586">WHERE FAMILIES BUILD WEALTH TOGETHER</div></td></tr>
<tr><td style="padding:0 32px"><div style="height:1px;background:#e9edf2;font-size:1px;line-height:1px">&nbsp;</div></td></tr>
<tr><td style="padding:24px 32px 8px"><h1 style="margin:0;font-size:21px;line-height:1.35;color:#243447">Your secure access code</h1><p style="margin:14px 0 0;font-size:15px;line-height:1.6;color:#4b5565">Hello ${safeName}, use this one-time code to open the shared company files in your NBFA Group account.</p></td></tr>
<tr><td align="center" style="padding:22px 32px"><div style="padding:18px 12px;border:1px solid #dce5ef;border-radius:10px;background:#f7f9fc;font-size:32px;line-height:1.2;font-weight:700;letter-spacing:9px;color:#183f68">${code}</div><p style="margin:12px 0 0;font-size:13px;color:#606d7c">This code expires in <strong style="color:#344256">10 minutes</strong>.</p></td></tr>
<tr><td style="padding:0 32px 24px"><div style="padding:14px 16px;border-radius:9px;background:#f5f7fa;font-size:13px;line-height:1.6;color:#4b5565"><strong style="color:#243447">Keep your code private.</strong> NBFA Group will never ask you to share it. If you did not request this code, you can ignore this email.</div></td></tr>
<tr><td align="center" style="padding:16px 24px;border-top:1px solid #e9edf2;font-size:12px;line-height:1.5;color:#778294">This is an automated security email from NBFA Group. Please do not reply.</td></tr></table></td></tr></table>`;
    const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
            from,
            to: [email],
            subject: "Your NBFA Group company files access code",
            text,
            html,
        })
    });
    if (!response.ok) {
        const details = await response.text();
        console.error("Resend company-file OTP delivery failed:", response.status, details.slice(0, 500));
        throw new Error("The access code email could not be sent. Try again later or contact the administrator.");
    }
}
const publicUser = (user) => ({
    email: user.email || "",
    name: user.name || "",
    role: user.role || "member",
    position: POSITION_TITLES.has(user.position) ? user.position : "Member",
    salutation: PROFILE_SALUTATIONS.has(user.salutation) ? user.salutation : "",
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
        storageBucket = getStorage(app).bucket(PAYMENT_EVIDENCE_BUCKET);
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
async function hasAdminAccess(user) {
    if (isAdmin(user)) return true;
    if (user.profile.position === "Treasurer") return true;
    const userNames = [user.profile.name, user.profile.displayName, user.auth.name]
        .map(normalizedName)
        .filter(Boolean);
    return userNames.includes(normalizedName(await getTreasurerName()));
}
const requireAdmin = async (user) => {
    if (!await hasAdminAccess(user)) throw new Error("Access denied. Administrator or treasurer privileges required.");
};
const normalizedName = (value) => String(value || "").trim().toLocaleLowerCase();
const loanBorrowerKey = (loan) => normalizedName(loan.member)
    ? `name:${normalizedName(loan.member)}`
    : emailKey(loan.requesterEmail);
const loanPrincipalRemaining = (loan) => Math.max(
    0,
    asNumber(loan.principal ?? loan.amount) - asNumber(loan.amountRepaid)
);
const loanBalanceRemaining = (loan) => Math.max(
    0,
    (asNumber(loan.totalDue) || asNumber(loan.principal ?? loan.amount)) - asNumber(loan.amountRepaid)
);

function calculateLoanCapacity(totalSavings, activeLoans, pendingLoans, awaitingLoans) {
    const reservedRequests = new Map();
    [...pendingLoans, ...awaitingLoans].forEach((loan, index) => {
        const status = String(loan.status || "pending").toLowerCase();
        if (["rejected", "cancelled", "paid_off", "completed"].includes(status)) return;
        const id = String(loan.id || loan.loanId || `${loanBorrowerKey(loan)}:${index}`);
        reservedRequests.set(id, loan);
    });
    const liveLoans = activeLoans.filter((loan) => loan.status !== "paid_off" && loanBalanceRemaining(loan) > 0);
    const committedLoans = [...liveLoans, ...reservedRequests.values()];
    const totalCommitted = committedLoans.reduce((sum, loan) =>
        sum + (liveLoans.includes(loan) ? loanPrincipalRemaining(loan) : asNumber(loan.principal ?? loan.amount)), 0);
    const savings = Math.max(0, asNumber(totalSavings));
    const lendingPool = savings * LOAN_RESERVE_RATIO;
    const availableForLending = Math.max(0, lendingPool - totalCommitted);
    return {
        totalSavings: savings,
        reserveAmount: savings - lendingPool,
        lendingPool,
        totalCommitted,
        availableForLending,
        borrowerCount: new Set(committedLoans.map(loanBorrowerKey).filter(Boolean)).size,
        requestLimit: availableForLending
    };
}

function getLoanBoardMembers(users, treasurerName) {
    const approved = users.filter((item) => item.status === "approved");
    const pick = (position) => approved.filter((item) => normalizedName(item.position) === normalizedName(position));
    const configuredTreasurer = approved.find((item) => normalizedName(item.name) === normalizedName(treasurerName));
    const membersByPosition = [
        ...pick("Chairman").map((member) => ({ position: "Chairman", member })),
        ...pick("Vice-Chairman").map((member) => ({ position: "Vice-Chairman", member })),
        ...pick("Secretary").map((member) => ({ position: "Secretary", member })),
        ...(configuredTreasurer
            ? [{ position: "Treasurer", member: configuredTreasurer }]
            : pick("Treasurer").map((member) => ({ position: "Treasurer", member })))
    ];
    return membersByPosition.map(({ position, member }) => ({
        position,
        name: String(member.name || "").trim(),
        email: emailKey(member.email || member.id)
    }));
}

function loanRequesterIsMember(loan, member) {
    if (emailKey(loan.requesterEmail) && emailKey(member.email)) {
        return emailKey(loan.requesterEmail) === emailKey(member.email);
    }
    return normalizedName(loan.member) === normalizedName(member.name);
}

function getLoanDueDateSetter(loan, board) {
    const treasurer = board.find((member) => member.position === "Treasurer");
    const chairman = board.find((member) => member.position === "Chairman");
    if (!treasurer) return null;
    return loanRequesterIsMember(loan, treasurer) ? chairman : treasurer;
}

function hasCompleteLoanBoard(board) {
    return board.length === 4
        && new Set(board.map((member) => member.position)).size === 4
        && board.every((member) => member.email && member.name)
        && new Set(board.map((member) => member.email)).size === 4;
}

function eligibleLoanApproverEmails(loan, board) {
    const stored = Array.isArray(loan.requiredApproverEmails)
        ? loan.requiredApproverEmails.map(emailKey).filter(Boolean)
        : board.filter((member) => !loanRequesterIsMember(loan, member)).map((member) => member.email);
    return [...new Set(stored)];
}

function getValidLoanApprovals(loan, requiredEmails, users) {
    const names = Array.isArray(loan.approvals) ? loan.approvals : [];
    const emailRecordsExist = Array.isArray(loan.approvalEmails);
    const emails = emailRecordsExist
        ? loan.approvalEmails.map(emailKey)
        : names.map((approverName) => {
            const profile = users.find((item) => normalizedName(item.name) === normalizedName(approverName));
            return emailKey(profile && profile.email);
        });
    const allowed = new Set(requiredEmails);
    const seen = new Set();
    const validNames = [];
    const validEmails = [];
    emails.forEach((email, index) => {
        if (!email || !allowed.has(email) || seen.has(email)) return;
        seen.add(email);
        const profile = users.find((item) => emailKey(item.email) === email);
        validEmails.push(email);
        validNames.push(String(profile && profile.name || names[index] || email));
    });
    return { approvals: validNames, approvalEmails: validEmails };
}
async function canApproveTransactions(user) {
    return hasAdminAccess(user);
}
async function requireTransactionApprover(user) {
    if (!await canApproveTransactions(user)) {
        throw new Error("Access denied. Treasurer, administrator, or developer privileges required.");
    }
}
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
    try {
        if (!pushSubscriptionsCache || Date.now() >= pushSubscriptionsCacheExpiresAt) {
            pushSubscriptionsCache = await rows("subscriptions");
            pushSubscriptionsCacheExpiresAt = Date.now() + 30_000;
        }
        const subscriptions = pushSubscriptionsCache;
        const targetEmail = recipient ? await emailForName(recipient) : null;
        const senderEmail = sender ? await emailForName(sender) : null;
        const selected = recipient
            ? (targetEmail ? subscriptions.filter((item) => emailKey(item.email) === targetEmail) : [])
            : subscriptions.filter((item) => !senderEmail || emailKey(item.email) !== senderEmail);
        const type = String(data.type || "");
        const genericCopy = {
            announcement: ["New group announcement", "A new announcement is available. Open NBFA Group to read it."],
            transaction_submission: ["Group transaction submitted", "A transaction was submitted for review. Open NBFA Group for details."],
            transaction_approved: ["Group transaction approved", "A transaction was approved. Open NBFA Group for details."],
            transaction_rejected: ["Group transaction declined", "A transaction was declined. Open NBFA Group for details."],
            transaction_edit_request: ["Transaction update requested", "A transaction update was submitted for review. Open NBFA Group for details."],
            transaction_edit_rejected: ["Transaction update declined", "A transaction update was declined. Open NBFA Group for details."],
            loan_request: ["Loan request needs Board approval", "A loan request needs Board approval. Open NBFA Group to review it."],
            loan_approved: ["Loan request approved", "A loan request was approved. Open NBFA Group for details."],
            loan_rejected: ["Loan request declined", "A loan request was declined. Open NBFA Group for details."],
            loan_cancelled: ["Loan request cancelled", "A loan request was cancelled. Open NBFA Group for details."],
            loan_due_date_set: ["Loan activated", "A loan was activated. Open NBFA Group for details."],
            loan_fully_approved: ["Loan request approved", "A loan request was approved. Open NBFA Group for details."],
            loan_needs_due_date: ["Loan activation needed", "An approved loan needs its repayment schedule. Open NBFA Group for details."],
            loan_approval_update: ["Loan request update", "A loan request received an approval. Open NBFA Group for details."],
            registration_approved: ["Registration approved", "A membership registration was approved."],
            registration_rejected: ["Registration declined", "A membership registration was declined."],
            registration_request: ["New membership request", "A membership request needs review. Open NBFA Group to review it."],
            meeting_scheduled: ["New meeting scheduled", "A group meeting was scheduled. Open NBFA Group for details."],
            meeting_cancelled: ["Meeting cancelled", "A group meeting was cancelled."],
            meeting_minutes_saved: ["Meeting minutes available", "New meeting minutes are available in NBFA Group."],
            classified_developer_security_alert: [title, body]
        };
        const copy = genericCopy[type] || [title, body];
        const safeData = type ? { type } : {};
        const results = await Promise.allSettled(selected.map(async (item) => {
            const subscription = item.subscription || {
                endpoint: item.endpoint,
                keys: { auth: item.auth, p256dh: item.p256dh }
            };
            const response = await fetch(PUSH_API_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ subscription, title: copy[0], body: copy[1], data: safeData })
            });
            if (response.status === 410) {
                await recordRef("subscriptions", item.id).delete();
                if (Array.isArray(pushSubscriptionsCache)) {
                    pushSubscriptionsCache = pushSubscriptionsCache.filter((subscriptionItem) => subscriptionItem.id !== item.id);
                }
                return "expired";
            }
            if (!response.ok) throw new Error(`Push API returned HTTP ${response.status}`);
            return "sent";
        }));
        const sent = results.filter((result) => result.status === "fulfilled" && result.value === "sent").length;
        const expired = results.filter((result) => result.status === "fulfilled" && result.value === "expired").length;
        const failed = results.filter((result) => result.status === "rejected").length;
        if (failed) console.error("Some push notifications could not be delivered", results.filter((result) => result.status === "rejected"));
        return { attempted: selected.length, sent, failed, expired };
    } catch (error) {
        console.error("Push delivery could not be completed", error);
        return { attempted: 0, sent: 0, failed: 1, expired: 0, error: error.message || "Push delivery could not be completed." };
    }
}

function combinePushDeliveries(deliveries) {
    return deliveries.reduce((total, delivery) => ({
        attempted: total.attempted + (delivery?.attempted || 0),
        sent: total.sent + (delivery?.sent || 0),
        failed: total.failed + (delivery?.failed || 0),
        expired: total.expired + (delivery?.expired || 0),
        ...(delivery?.error ? { error: delivery.error } : {})
    }), { attempted: 0, sent: 0, failed: 0, expired: 0 });
}

async function notifyDevelopersOfProtectedAccountAttempt(actor, targetEmail, action) {
    const developerUsers = (await rows("users"))
        .filter((item) => item.role === "developer" && item.status === "approved")
        .map((item) => emailKey(item.email))
        .filter(Boolean);
    const recipients = [...new Set([...DEVELOPER_EMAILS, ...developerUsers])];
    await Promise.all(recipients.map((recipient) => sendPush(
        "CLASSIFIED — Developer security alert",
        `A protected developer account action was blocked. Action: ${action}. Actor: ${actor || "Unknown"}.`,
        recipient,
        null,
        { type: "classified_developer_security_alert", action }
    )));
}

async function notifyAdministratorsOfRegistration(name, email) {
    const treasurerName = await getTreasurerName();
    const [admins, treasurers, configuredTreasurer] = await Promise.all([
        db.collection("users").where("role", "in", ["admin", "developer"]).get(),
        db.collection("users").where("position", "==", "Treasurer").get(),
        db.collection("users").where("name", "==", treasurerName).get()
    ]);
    const recipients = new Set([
        ...[...admins.docs, ...treasurers.docs, ...configuredTreasurer.docs]
            .filter((doc) => doc.data().status === "approved")
            .map((doc) => emailKey(doc.data().email || doc.id))
    ].filter((recipient) => recipient && recipient !== emailKey(email)));
    return Promise.all([...recipients].map((recipient) => sendPush(
        "New membership request",
        `${name} requested to join the group.`,
        recipient,
        null,
        { type: "registration_request" }
    )));
}

function summarizeData(transactions, activeLoans) {
    const totals = { savingsIn: 0, loansTaken: 0, repaid: 0 };
    for (const row of transactions) {
        const amount = asNumber(row.amount);
        if (row.type === "Savings") totals.savingsIn += amount;
        else if (row.type === "Loan Taken") totals.loansTaken += amount;
        else if (row.type === "Loan Repayment") totals.repaid += amount;
    }
    return summarizeTotals(totals, activeLoans);
}

function summarizeTotals(totals, activeLoans) {
    const outstanding = activeLoans.reduce((total, loan) => {
        if (loan.status === "paid_off") return total;
        return total + Math.max(0, asNumber(loan.principal) - asNumber(loan.amountRepaid));
    }, 0);
    const interestEarned = activeLoans.reduce((total, loan) => total + asNumber(loan.interest), 0);
    return {
        success: true,
        totalSavings: Math.max(0, totals.savingsIn),
        savings: Math.max(0, totals.savingsIn - outstanding),
        loansTaken: totals.loansTaken,
        repaid: totals.repaid,
        outstanding,
        interestEarned
    };
}

async function getSummaryData() {
    const transactionTypes = [
        ["Savings", "savingsIn"],
        ["Loan Taken", "loansTaken"],
        ["Loan Repayment", "repaid"]
    ];
    const [transactionTotals, activeLoans] = await Promise.all([
        Promise.all(transactionTypes.map(async ([type, key]) => {
            const snapshot = await db.collection("transactions")
                .where("type", "==", type)
                .aggregate({ total: AggregateField.sum("amount") })
                .get();
            return [key, asNumber(snapshot.data().total)];
        })),
        rows("activeLoans")
    ]);
    return summarizeTotals(Object.fromEntries(transactionTotals), activeLoans);
}

async function getDashboard(user, params) {
    const collections = ["transactions", "users", "pendingLoans", "activeLoans"];
    const treasurerName = await getTreasurerName();
    const userNames = [user.profile.name, user.profile.displayName, user.auth.name]
        .map(normalizedName)
        .filter(Boolean);
    const adminAccess = isAdmin(user)
        || user.profile.position === "Treasurer"
        || userNames.includes(normalizedName(treasurerName));
    const transactionApprover = adminAccess;
    if (transactionApprover) collections.push("pendingTransactions", "pendingEdits");
    collections.push("loansAwaitingDueDate");
    const [values, bankInterestSnapshot] = await Promise.all([
        Promise.all(collections.map(rows)),
        recordRef("settings", "bankInterest").get()
    ]);
    const configuredBankInterest = bankInterestSnapshot.exists
        ? Number(bankInterestSnapshot.data().amount)
        : BANK_INTEREST_EARNED_DEFAULT;
    const bankInterestEarned = Number.isFinite(configuredBankInterest) && configuredBankInterest >= 0
        ? configuredBankInterest
        : BANK_INTEREST_EARNED_DEFAULT;
    const data = Object.fromEntries(collections.map((name, index) => [name, values[index]]));
    const allTransactions = data.transactions || [];
    const summary = summarizeData(allTransactions, data.activeLoans || []);
    const actorEmail = emailKey(user.email);
    const actorName = user.profile.name || user.auth.name || user.email.split("@")[0];
    const approvedUsers = (data.users || []).filter((item) => item.status === "approved")
        .map((item) => ({ ...item, email: item.email || item.id }));
    const board = getLoanBoardMembers(approvedUsers, treasurerName);
    const members = approvedUsers.filter((item) => item.name).map((item) => item.name);
    const loans = (data.pendingLoans || []).map((loan) => {
        const principal = asNumber(loan.amount ?? loan.principal);
        const interest = Math.round(principal * LOAN_INTEREST_RATE);
        const requiredEmails = eligibleLoanApproverEmails(loan, board);
        const approvalRecords = getValidLoanApprovals(loan, requiredEmails, approvedUsers);
        let requesterEmail = emailKey(loan.requesterEmail);
        if (!requesterEmail) {
            const requester = approvedUsers.find((item) => String(item.name || "").trim().toLowerCase() === String(loan.member || "").trim().toLowerCase());
            requesterEmail = emailKey(requester && requester.email);
        }
        return {
            id: loan.id,
            date: loan.date || "",
            member: loan.member || "",
            isRequester: requesterEmail === actorEmail || (!requesterEmail && loan.member === actorName),
            viewerHasApproved: approvalRecords.approvalEmails.includes(actorEmail),
            viewerCanApprove: requiredEmails.includes(actorEmail) && !approvalRecords.approvalEmails.includes(actorEmail),
            principal,
            interest,
            totalDue: principal + interest,
            message: loan.message || loan.description || "",
            approvals: approvalRecords.approvals,
            approvalsRequired: requiredEmails.length || Number(loan.approvalsRequired) || 0,
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
        records: allTransactions.map((item) => {
            const { evidenceId, submittedByEmail, ...record } = item;
            const canViewEvidence = transactionApprover
                || emailKey(submittedByEmail) === actorEmail;
            return {
                ...record,
                date: item.date || "",
                member: item.member || "",
                type: item.type || "",
                amount: asNumber(item.amount),
                ...(transactionApprover && submittedByEmail ? { submittedByEmail } : {}),
                ...(canViewEvidence && evidenceId ? { evidenceId } : {})
            };
        }),
        summary,
        members,
        loans,
        pendingTransactions: transactionApprover ? (data.pendingTransactions || []) : [],
        pendingEditsMap: transactionApprover ? pendingEditsMap : {},
        activeLoans: params.includeLoanTracking === "false" ? [] : activeLoans,
        bankInterestEarned,
        treasurerName
    };
    if (params.includeLoanTracking !== "false") {
        result.loansAwaitingDueDate = (data.loansAwaitingDueDate || []).filter((loan) => {
            const setter = getLoanDueDateSetter(loan, board);
            return setter && setter.email === actorEmail;
        });
    }
    return result;
}

async function handleAction(action, params, user) {
    const name = user.profile.name || user.auth.name || user.email.split("@")[0];
    const actorEmail = emailKey(user.email);
    switch (action) {
        case "bootstrapProfile":
            return {
                success: true,
                name,
                displayName: user.profile.displayName || name,
                email: user.email,
                role: user.profile.role || "member",
                position: POSITION_TITLES.has(user.profile.position) ? user.profile.position : "Member",
                salutation: PROFILE_SALUTATIONS.has(user.profile.salutation) ? user.profile.salutation : "",
                status: user.profile.status,
                phone: user.profile.phone || "",
                phoneCountry: user.profile.phoneCountry || "",
                phoneDialCode: user.profile.phoneDialCode || "",
                phoneVerifiedAt: user.profile.phoneVerifiedAt || "",
                phoneVerifiedBy: user.profile.phoneVerifiedBy || ""
            };
        case "updateOwnProfile": {
            const displayName = String(params.displayName || "").trim();
            if (displayName.length < 2 || displayName.length > 80) {
                throw new Error("Enter a name between 2 and 80 characters.");
            }
            await user.ref.update({ displayName, updated_at: nowIso() });
            await audit(name, "Updated own profile display name", user.email);
            return { success: true, displayName };
        }
        case "getAdminMemberProfiles": {
            await requireAdmin(user);
            const profiles = (await rows("users"))
                .filter((profile) => profile.status === "approved")
                .map((profile) => ({
                    email: emailKey(profile.email || profile.id),
                    name: String(profile.displayName || profile.name || ""),
                    phone: String(profile.phone || ""),
                    phoneCountry: String(profile.phoneCountry || ""),
                    phoneDialCode: String(profile.phoneDialCode || ""),
                    phoneVerifiedAt: String(profile.phoneVerifiedAt || ""),
                    phoneVerifiedBy: String(profile.phoneVerifiedBy || "")
                }))
                .filter((profile) => profile.email);
            return { success: true, profiles };
        }
        case "setMemberPhone": {
            await requireAdmin(user);
            const email = emailKey(params.email);
            const ref = db.collection("users").doc(safeDocId(email));
            const snapshot = await ref.get();
            if (!snapshot.exists || snapshot.data().status !== "approved") {
                throw new Error("Approved member not found.");
            }
            const phone = String(params.phone || "").trim();
            if (!phone) {
                await ref.update({
                    phone: "",
                    phoneCountry: "",
                    phoneDialCode: "",
                    phoneVerifiedAt: "",
                    phoneVerifiedBy: "",
                    phoneUpdatedAt: nowIso()
                });
                await audit(name, "Removed member phone number", email);
                return { success: true };
            }
            const country = String(params.country || "").trim().toUpperCase();
            const dialCode = String(params.dialCode || "").trim();
            const supportedDialCodes = {
                KE: "+254",
                UG: "+256",
                TZ: "+255",
                RW: "+250",
                ET: "+251",
                SS: "+211",
                US: "+1",
                GB: "+44",
                CA: "+1",
                AE: "+971"
            };
            if (!/^\+[1-9]\d{7,14}$/.test(phone)
                || !/^[A-Z]{2}$/.test(country)
                || !/^\+[1-9]\d{0,3}$/.test(dialCode)
                || supportedDialCodes[country] !== dialCode
                || !phone.startsWith(dialCode)) {
                throw new Error("Enter a valid phone number and country code.");
            }
            const verifiedAt = nowIso();
            await ref.update({
                phone,
                phoneCountry: country,
                phoneDialCode: dialCode,
                phoneVerifiedAt: verifiedAt,
                phoneVerifiedBy: user.email,
                phoneUpdatedAt: verifiedAt
            });
            await audit(name, "Added admin-verified member phone number", email);
            return { success: true, phone, country, dialCode, phoneVerifiedAt: verifiedAt, phoneVerifiedBy: user.email };
        }
        case "getProfileImage": {
            const snapshot = await db.collection("profileImages").doc(safeDocId(user.email)).get();
            return {
                success: true,
                image: snapshot.exists ? snapshot.data().image || null : null,
                publicId: snapshot.exists ? snapshot.data().publicId || null : null
            };
        }
        case "saveProfileImage": {
            const targetEmail = emailKey(params.email || user.email);
            const editingSomeoneElse = targetEmail !== user.email;
            if (editingSomeoneElse && !isDeveloper(user)) throw new Error("Only the developer can update another user's profile photo.");
            const targetProfile = await profileFor(targetEmail);
            if (!targetProfile) throw new Error("User profile not found.");
            const image = String(params.image || "");
            const publicId = String(params.publicId || "");
            if (!isCloudinaryImageUrl(image) || !publicId || publicId.length > 255) {
                throw new Error("Choose a valid profile photo uploaded to Cloudinary.");
            }
            await db.collection("profileImages").doc(safeDocId(targetEmail)).set({
                email: targetEmail,
                name: targetProfile.data.name || targetEmail,
                image,
                publicId,
                updated_at: nowIso()
            }, { merge: true });
            await audit(name, editingSomeoneElse ? "Updated member profile photo" : "Updated profile photo", targetEmail);
            return { success: true, email: targetEmail, image };
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
            if (!isCloudinaryImageUrl(image) || !publicId || publicId.length > 255) {
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
        case "updateGroupMemoryCaption": {
            const id = String(params.id || "");
            const caption = String(params.caption || "").trim();
            if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Choose a valid group photo.");
            if (caption.length > 200) throw new Error("Memory captions must be 200 characters or fewer.");
            const ref = db.collection("groupMemories").doc(id);
            const snapshot = await ref.get();
            if (!snapshot.exists || emailKey(snapshot.data().email) !== user.email) {
                throw new Error("You can only edit the caption on a photo you shared.");
            }
            await ref.update({ caption, updated_at: nowIso() });
            await audit(name, "Updated group memory caption", id);
            return { success: true, caption };
        }
        case "updateGroupMemoryImage": {
            const id = String(params.id || "");
            const image = String(params.image || "");
            const publicId = String(params.publicId || "");
            if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Choose a valid group photo.");
            if (!isCloudinaryImageUrl(image) || !publicId || publicId.length > 255) {
                throw new Error("Choose a valid cropped photo uploaded to Cloudinary.");
            }
            const ref = db.collection("groupMemories").doc(id);
            const snapshot = await ref.get();
            if (!snapshot.exists || emailKey(snapshot.data().email) !== user.email) {
                throw new Error("You can only recrop a photo you shared.");
            }
            await ref.update({ image, publicId, updated_at: nowIso() });
            await audit(name, "Recropped group memory image", id);
            return { success: true, image, publicId };
        }
        case "deleteGroupMemory": {
            const id = String(params.id || "");
            if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Choose a valid group photo.");
            const ref = db.collection("groupMemories").doc(id);
            const snapshot = await ref.get();
            if (!snapshot.exists || emailKey(snapshot.data().email) !== user.email) {
                throw new Error("You can only delete a photo you shared.");
            }
            await ref.delete();
            await audit(name, "Deleted group memory", id);
            return { success: true, id };
        }
        case "getGroupMessages": {
            const adminAccess = await hasAdminAccess(user);
            const requestedLimit = Number(params.limit);
            const limit = Number.isInteger(requestedLimit) ? Math.min(50, Math.max(1, requestedLimit)) : 50;
            const cursor = params.cursor && typeof params.cursor === "object" ? params.cursor : null;
            let query = db.collection("groupMessages")
                .orderBy("created_at", "desc")
                .orderBy(FieldPath.documentId(), "desc")
                .limit(limit + 1);
            if (cursor) {
                if (typeof cursor.createdAt !== "string" || !cursor.createdAt || typeof cursor.id !== "string" || !cursor.id) {
                    throw new Error("The group inbox page cursor is invalid.");
                }
                query = query.startAfter(cursor.createdAt, cursor.id);
            }
            const [messageSnapshot, requestSnapshot, readSnapshot] = await Promise.all([
                query.get(),
                adminAccess
                    ? db.collection("registrationRequests").where("status", "==", "pending").limit(50).get()
                    : Promise.resolve({ docs: [] }),
                recordRef("groupInboxReads", user.email).get()
            ]);
            const docs = messageSnapshot.docs.slice(0, limit);
            const messages = docs.map((doc) => ({ id: doc.id, ...doc.data() }));
            const joinRequests = requestSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
            messages.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
            joinRequests.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
            return {
                success: true,
                messages,
                joinRequests,
                readAt: readSnapshot.exists ? String(readSnapshot.data().readAt || "") : "",
                hasMore: messageSnapshot.docs.length > limit,
                nextCursor: docs.length
                    ? { createdAt: String(docs[docs.length - 1].data().created_at || ""), id: docs[docs.length - 1].id }
                    : null
            };
        }
        case "markGroupMessagesRead": {
            const requestedReadAt = String(params.readAt || "");
            const requestedTimestamp = requestedReadAt ? Date.parse(requestedReadAt) : NaN;
            if (requestedReadAt && (!Number.isFinite(requestedTimestamp) || requestedTimestamp > Date.now() + 1000)) {
                throw new Error("The group inbox read timestamp is invalid.");
            }
            const readAt = requestedReadAt || nowIso();
            await recordRef("groupInboxReads", user.email).set({ email: user.email, readAt });
            return { success: true, readAt };
        }
        case "deleteGroupMessage": {
            await requireAdmin(user);
            const id = String(params.id || "").trim();
            if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Choose a valid group message.");
            const ref = recordRef("groupMessages", id);
            const snapshot = await ref.get();
            if (!snapshot.exists) throw new Error("Group message not found.");
            await ref.delete();
            await audit(name, "Deleted group message", `${id} — ${snapshot.data().member || "Group member"}`);
            return { success: true, id };
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
                    position: POSITION_TITLES.has(item.position) ? item.position : "Member",
                    image: byEmail.get(emailKey(item.email)) || null,
                    hasImage: Boolean(byEmail.get(emailKey(item.email)))
                }))
            };
        }
        case "getDashboardData":
            return getDashboard(user, params);
        case "setBankInterestEarned": {
            await requireAdmin(user);
            const amount = Number(params.amount);
            if (params.amount === undefined || params.amount === null || String(params.amount).trim() === ""
                || !Number.isFinite(amount) || amount < 0 || amount > 100000000) {
                throw new Error("Enter a valid bank interest amount.");
            }
            const roundedAmount = Math.round(amount * 100) / 100;
            await recordRef("settings", "bankInterest").set({
                amount: roundedAmount,
                updatedAt: nowIso(),
                updatedBy: user.email
            }, { merge: true });
            await audit(name, "Updated actual bank interest credited", `KES ${roundedAmount.toFixed(2)}`);
            return { success: true, amount: roundedAmount };
        }
        case "createCompanyFileUpload": {
            requireDeveloper(user);
            const fileName = cleanCompanyFileName(params.fileName);
            const contentType = String(params.contentType || "").toLowerCase();
            const size = Number(params.size);
            if (!fileName || !COMPANY_FILE_MIME_TYPES.has(contentType)) {
                throw new Error("Choose a supported company file (PDF, Office document, text, CSV, JPEG, or PNG).");
            }
            if (!Number.isInteger(size) || size < 1 || size > COMPANY_FILE_MAX_BYTES) {
                throw new Error("Company files must be 20 MB or smaller.");
            }
            const id = crypto.randomUUID();
            const storagePath = `company-files/${id}`;
            const expiresAt = Date.now() + 10 * 60 * 1000;
            const [uploadUrl] = await storageBucket.file(storagePath).getSignedUrl({
                version: "v4", action: "write", expires: expiresAt, contentType
            });
            await recordRef("companyFileUploads", id).create({
                id, email: user.email, fileName, contentType, size, storagePath,
                createdAt: nowIso(), expiresAt, status: "uploading"
            });
            return { success: true, fileId: id, uploadUrl, contentType };
        }
        case "completeCompanyFileUpload": {
            requireDeveloper(user);
            const id = String(params.fileId || "");
            if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Choose a valid company file upload.");
            const intentRef = recordRef("companyFileUploads", id);
            const intentSnapshot = await intentRef.get();
            if (!intentSnapshot.exists) throw new Error("Company file upload has expired. Start again.");
            const intent = intentSnapshot.data();
            if (emailKey(intent.email) !== user.email || Date.now() > Number(intent.expiresAt)) {
                throw new Error("Company file upload has expired. Start again.");
            }
            const object = storageBucket.file(intent.storagePath);
            const [metadata] = await object.getMetadata();
            if (Number(metadata.size) !== Number(intent.size) || String(metadata.contentType || "").toLowerCase() !== intent.contentType) {
                await object.delete({ ignoreNotFound: true });
                await intentRef.delete();
                throw new Error("Uploaded file details did not match. Please upload the file again.");
            }
            const file = {
                id,
                fileName: intent.fileName,
                contentType: intent.contentType,
                size: Number(intent.size),
                storagePath: intent.storagePath,
                createdAt: nowIso(),
                uploadedBy: user.email
            };
            await recordRef("companyFiles", id).create(file);
            await intentRef.delete();
            await audit(name, "Uploaded a company file", intent.fileName);
            return { success: true, file: { id, fileName: file.fileName, size: file.size, createdAt: file.createdAt } };
        }
        case "deleteCompanyFile": {
            requireDeveloper(user);
            const id = String(params.fileId || "");
            if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Choose a valid company file.");
            const ref = recordRef("companyFiles", id);
            const snapshot = await ref.get();
            if (!snapshot.exists) throw new Error("Company file not found.");
            const file = snapshot.data();
            await storageBucket.file(file.storagePath).delete({ ignoreNotFound: true });
            await ref.delete();
            await audit(name, "Deleted a company file", file.fileName || id);
            return { success: true, fileId: id };
        }
        case "requestCompanyFilesOtp": {
            const email = emailKey(user.email);
            const now = Date.now();
            const today = new Date(now).toISOString().slice(0, 10);
            const rateRef = recordRef("companyFileOtpRateLimits", email);
            await db.runTransaction(async (transaction) => {
                const snapshot = await transaction.get(rateRef);
                const rate = snapshot.exists ? snapshot.data() : {};
                const lastSentAt = Number(rate.lastSentAt || 0);
                if (now - lastSentAt < COMPANY_FILE_OTP_COOLDOWN_MS) {
                    throw new Error("Wait one minute before requesting another company files code.");
                }
                const requestsToday = rate.day === today ? Number(rate.requestsToday) || 0 : 0;
                if (requestsToday >= 10) throw new Error("You have reached today's company files code limit. Try again tomorrow.");
                transaction.set(rateRef, { email, lastSentAt: now, day: today, requestsToday: requestsToday + 1 }, { merge: true });
            });
            const code = String(crypto.randomInt(100000, 1000000));
            const challengeId = crypto.randomUUID();
            const previousChallenges = await db.collection("companyFileOtpChallenges").where("email", "==", email).get();
            if (!previousChallenges.empty) {
                const batch = db.batch();
                previousChallenges.docs.forEach((doc) => batch.delete(doc.ref));
                await batch.commit();
            }
            const challengeRef = recordRef("companyFileOtpChallenges", challengeId);
            await challengeRef.create({
                email,
                codeHash: companyFileOtpHash(challengeId, code),
                attempts: 0,
                createdAt: now,
                expiresAt: now + COMPANY_FILE_OTP_LIFETIME_MS
            });
            try {
                await sendCompanyFileOtp(email, code, user.profile.name || user.auth.name);
            } catch (error) {
                await challengeRef.delete();
                throw error;
            }
            return { success: true, challengeId, emailHint: `${email.slice(0, 2)}•••${email.includes("@") ? email.slice(email.indexOf("@")) : ""}` };
        }
        case "verifyCompanyFilesOtp": {
            const challengeId = String(params.challengeId || "");
            const code = String(params.code || "").trim();
            if (!/^[0-9a-f-]{36}$/i.test(challengeId) || !/^\d{6}$/.test(code)) {
                throw new Error("Enter the six-digit code from your email.");
            }
            const challengeRef = recordRef("companyFileOtpChallenges", challengeId);
            const result = await db.runTransaction(async (transaction) => {
                const snapshot = await transaction.get(challengeRef);
                if (!snapshot.exists) return { error: "This code is invalid or has expired. Request a new code." };
                const challenge = snapshot.data();
                if (emailKey(challenge.email) !== user.email || challenge.usedAt || Date.now() > Number(challenge.expiresAt)) {
                    return { error: "This code is invalid or has expired. Request a new code." };
                }
                if (Number(challenge.attempts) >= 5) return { error: "Too many attempts. Request a new code." };
                const expected = Buffer.from(String(challenge.codeHash || ""), "hex");
                const actual = Buffer.from(companyFileOtpHash(challengeId, code), "hex");
                const matches = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
                if (!matches) {
                    transaction.update(challengeRef, { attempts: Number(challenge.attempts || 0) + 1 });
                    return { error: "That code is incorrect. Try again." };
                }
                transaction.delete(challengeRef);
                return { success: true };
            });
            if (result.error) throw new Error(result.error);
            const snapshot = await db.collection("companyFiles").orderBy("createdAt", "desc").limit(100).get();
            const files = await Promise.all(snapshot.docs.map(async (doc) => {
                const file = doc.data();
                const [url] = await storageBucket.file(file.storagePath).getSignedUrl({
                    version: "v4", action: "read", expires: Date.now() + 5 * 60 * 1000
                });
                return {
                    id: doc.id,
                    fileName: file.fileName || "Company file",
                    contentType: file.contentType || "application/octet-stream",
                    size: Number(file.size) || 0,
                    createdAt: file.createdAt || "",
                    url
                };
            }));
            return { success: true, files, expiresInSeconds: 300 };
        }
        case "get":
            return { success: true, records: (await rows("transactions")) };
        case "getSummary":
            return getSummaryData();
        case "createPaymentEvidenceUpload": {
            const contentType = String(params.contentType || "").toLowerCase();
            const fileName = String(params.fileName || "").replace(/[\\/]/g, "_").slice(0, 120);
            if (!PAYMENT_EVIDENCE_TYPES.has(contentType)) {
                throw new Error("Upload a PDF, JPEG, or PNG payment receipt.");
            }
            if (!fileName) throw new Error("Choose a payment receipt file.");
            const id = crypto.randomUUID();
            const stagingPath = `payment-evidence-staging/${id}`;
            const expiresAt = Date.now() + 10 * 60 * 1000;
            const [uploadUrl] = await storageBucket.file(stagingPath).getSignedUrl({
                version: "v4",
                action: "write",
                expires: expiresAt,
                contentType
            });
            await recordRef("paymentEvidence", id).create({
                id,
                email: user.email,
                fileName,
                contentType,
                stagingPath,
                status: "uploading",
                created_at: nowIso()
            });
            return { success: true, evidenceId: id, uploadUrl, expiresAt };
        }
        case "getMyPaymentEvidence": {
            const snapshot = await db.collection("paymentEvidence")
                .where("email", "==", user.email)
                .limit(50)
                .get();
            const receipts = snapshot.docs.map((doc) => {
                const evidence = doc.data();
                return {
                    id: doc.id,
                    fileName: evidence.fileName || "payment-receipt",
                    status: evidence.status || "uploading",
                    created_at: evidence.created_at || "",
                    reviewedAt: evidence.reviewedAt || "",
                    available: Boolean(evidence.storagePath)
                };
            }).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
            return { success: true, receipts };
        }
        case "getPaymentEvidence": {
            const evidenceId = String(params.evidenceId || "");
            if (!/^[0-9a-f-]{36}$/i.test(evidenceId)) throw new Error("Choose a valid payment receipt.");
            const ref = recordRef("paymentEvidence", evidenceId);
            const snapshot = await ref.get();
            if (!snapshot.exists) throw new Error("Payment receipt not found.");
            const evidence = snapshot.data();
            if (emailKey(evidence.email) !== user.email && !await canApproveTransactions(user)) {
                throw new Error("Access denied. This payment receipt is private.");
            }
            if (!["pending", "approved", "rejected"].includes(evidence.status) || !evidence.storagePath) {
                throw new Error("This payment receipt is not available yet.");
            }
            const [url] = await storageBucket.file(evidence.storagePath).getSignedUrl({
                version: "v4",
                action: "read",
                expires: Date.now() + 5 * 60 * 1000
            });
            return { success: true, url, fileName: evidence.fileName || "payment-receipt" };
        }
        case "submitTransaction": {
            const type = String(params.type || "");
            const amount = Number(params.amount);
            if (!["Savings", "Loan Repayment"].includes(type) || !Number.isFinite(amount) || amount <= 0) {
                throw new Error("Choose a valid transaction type and positive amount.");
            }
            if (type === "Loan Repayment" && !params.loanId) throw new Error("Choose the loan being repaid.");
            const evidenceId = String(params.evidenceId || "");
            let evidence = null;
            let finalEvidencePath = "";
            let stagedEvidencePath = "";
            if (evidenceId) {
                if (!/^[0-9a-f-]{36}$/i.test(evidenceId)) throw new Error("Choose a valid payment receipt.");
                const evidenceRef = recordRef("paymentEvidence", evidenceId);
                const evidenceSnapshot = await evidenceRef.get();
                if (!evidenceSnapshot.exists || emailKey(evidenceSnapshot.data().email) !== user.email
                    || evidenceSnapshot.data().status !== "uploading") {
                    throw new Error("The payment receipt could not be verified. Please upload it again.");
                }
                evidence = evidenceSnapshot.data();
                const stagedFile = storageBucket.file(evidence.stagingPath);
                let metadata;
                try {
                    [metadata] = await stagedFile.getMetadata();
                } catch (error) {
                    console.error("Could not verify uploaded payment evidence", error);
                    throw new Error("The payment receipt upload is missing or could not be verified.");
                }
                const fileSize = Number(metadata.size);
                const contentType = String(metadata.contentType || "").toLowerCase();
                if (!Number.isFinite(fileSize) || fileSize <= 0 || fileSize > PAYMENT_EVIDENCE_MAX_BYTES
                    || contentType !== evidence.contentType || !PAYMENT_EVIDENCE_TYPES.has(contentType)) {
                    try {
                        await stagedFile.delete({ ignoreNotFound: true });
                    } catch (cleanupError) {
                        console.error("Could not remove invalid payment evidence", cleanupError);
                    }
                    await evidenceRef.update({ status: "invalid", rejectedAt: nowIso() });
                    throw new Error("Payment receipts must be a PDF, JPEG, or PNG no larger than 5 MB.");
                }
                const [fileHeader] = await stagedFile.download({ start: 0, end: 7 });
                const isPdf = contentType === "application/pdf" && fileHeader.subarray(0, 5).toString() === "%PDF-";
                const isPng = contentType === "image/png" && fileHeader.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
                const isJpeg = contentType === "image/jpeg" && fileHeader.subarray(0, 3).equals(Buffer.from([255, 216, 255]));
                if (!isPdf && !isPng && !isJpeg) {
                    try {
                        await stagedFile.delete({ ignoreNotFound: true });
                    } catch (cleanupError) {
                        console.error("Could not remove payment evidence with an invalid file signature", cleanupError);
                    }
                    await evidenceRef.update({ status: "invalid", rejectedAt: nowIso() });
                    throw new Error("The uploaded file does not match its declared receipt format.");
                }
                stagedEvidencePath = evidence.stagingPath;
                finalEvidencePath = `payment-evidence/${evidenceId}`;
                await stagedFile.copy(finalEvidencePath);
            }
            const id = crypto.randomUUID();
            const submittedAt = nowIso();
            const inboxMessageRef = db.collection("groupMessages").doc();
            try {
                await db.runTransaction(async (tx) => {
                    if (evidenceId) {
                        const evidenceRef = recordRef("paymentEvidence", evidenceId);
                        const evidenceSnapshot = await tx.get(evidenceRef);
                        if (!evidenceSnapshot.exists || emailKey(evidenceSnapshot.data().email) !== user.email
                            || evidenceSnapshot.data().status !== "uploading") {
                            throw new Error("The payment receipt has already been used or is no longer available.");
                        }
                        tx.update(evidenceRef, {
                            status: "pending",
                            storagePath: finalEvidencePath,
                            transactionId: id
                        });
                    }
                    tx.create(recordRef("pendingTransactions", id), {
                        id, date: params.date || "", member: name, type, amount,
                        message: String(params.message || ""), submittedBy: name,
                        submittedByEmail: user.email, submittedAt, loanId: params.loanId || "", evidenceId
                    });
                    tx.create(inboxMessageRef, {
                        id: inboxMessageRef.id,
                        message: `${name} submitted a ${type} of KES ${amount.toLocaleString()} for group approval.`,
                        member: name,
                        email: user.email,
                        type: "transaction_submission",
                        created_at: submittedAt
                    });
                });
            } catch (error) {
                if (finalEvidencePath) {
                    try {
                        await storageBucket.file(finalEvidencePath).delete({ ignoreNotFound: true });
                    } catch (cleanupError) {
                        console.error("Could not clean up an unlinked payment receipt", cleanupError);
                    }
                }
                throw error;
            }
            if (stagedEvidencePath) {
                try {
                    await storageBucket.file(stagedEvidencePath).delete({ ignoreNotFound: true });
                } catch (error) {
                    console.error("Could not remove the temporary payment receipt upload", error);
                }
            }
            await audit(name, `Submitted ${type}`, `KES ${amount.toLocaleString()} — awaiting approval`);
            const pushDelivery = await sendPush(
                "Group transaction submitted",
                "A transaction was submitted for review.",
                null,
                name,
                { type: "transaction_submission" }
            );
            return { success: true, id, pushDelivery };
        }
        case "approveTransaction": {
            await requireTransactionApprover(user);
            const id = String(params.id || "");
            const ref = recordRef("pendingTransactions", id);
            let transaction;
            const approvedAt = nowIso();
            const groupMessageRef = db.collection("groupMessages").doc();
            await db.runTransaction(async (tx) => {
                const snapshot = await tx.get(ref);
                if (!snapshot.exists) throw new Error("Pending transaction not found.");
                transaction = snapshot.data();
                const evidenceRef = transaction.evidenceId ? recordRef("paymentEvidence", transaction.evidenceId) : null;
                const evidenceSnapshot = evidenceRef ? await tx.get(evidenceRef) : null;
                let loanRef;
                let loanSnapshot;
                if (!transaction.editId && transaction.type === "Loan Repayment" && transaction.loanId) {
                    loanRef = recordRef("activeLoans", transaction.loanId);
                    loanSnapshot = await tx.get(loanRef);
                }
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
                        approvalDate: approvedAt
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
                        approvalDate: approvedAt,
                        balanceAfter: 0,
                        loanId: transaction.loanId || "",
                        submittedByEmail: transaction.submittedByEmail || "",
                        evidenceId: transaction.evidenceId || ""
                    });
                }
                tx.delete(ref);
                if (evidenceRef && !evidenceSnapshot?.exists) throw new Error("The payment receipt record could not be found.");
                if (evidenceRef) tx.update(evidenceRef, { status: "approved", reviewedAt: approvedAt, reviewedBy: user.email });
                if (loanSnapshot?.exists) {
                    const loan = loanSnapshot.data();
                    const repaid = asNumber(loan.amountRepaid) + asNumber(transaction.amount);
                    tx.update(loanRef, { amountRepaid: repaid, status: repaid >= asNumber(loan.totalDue) ? "paid_off" : "active" });
                }
                const actionDescription = transaction.editId
                    ? `approved a transaction update for ${transaction.member}'s ${transaction.type} (KES ${asNumber(transaction.amount).toLocaleString()})`
                    : `approved ${transaction.member}'s ${transaction.type} of KES ${asNumber(transaction.amount).toLocaleString()}`;
                tx.create(groupMessageRef, {
                    id: groupMessageRef.id,
                    message: `${name} ${actionDescription}.`,
                    member: name,
                    email: user.email,
                    type: "transaction_approved",
                    created_at: approvedAt
                });
            });
            await audit(name, transaction.editId ? "Approved transaction edit" : `Approved ${transaction.type}`, `${transaction.member}'s KES ${asNumber(transaction.amount).toLocaleString()}`);
            const pushDelivery = await sendPush(
                "Transaction Approved",
                "A group transaction was approved.",
                null,
                name,
                { type: "transaction_approved" }
            );
            return { success: true, pushDelivery };
        }
        case "rejectTransaction": {
            await requireTransactionApprover(user);
            const ref = recordRef("pendingTransactions", params.id);
            let transaction;
            const inboxMessageRef = db.collection("groupMessages").doc();
            const declinedAt = nowIso();
            await db.runTransaction(async (tx) => {
                const snapshot = await tx.get(ref);
                if (!snapshot.exists) throw new Error("Pending transaction not found.");
                transaction = snapshot.data();
                const evidenceRef = transaction.evidenceId ? recordRef("paymentEvidence", transaction.evidenceId) : null;
                const evidenceSnapshot = evidenceRef ? await tx.get(evidenceRef) : null;
                tx.delete(ref);
                if (evidenceRef && !evidenceSnapshot?.exists) throw new Error("The payment receipt record could not be found.");
                if (evidenceRef) tx.update(evidenceRef, { status: "rejected", reviewedAt: declinedAt, reviewedBy: user.email });
                tx.create(inboxMessageRef, {
                    id: inboxMessageRef.id,
                    message: `${name} declined ${transaction.member}'s ${transaction.type} of KES ${asNumber(transaction.amount).toLocaleString()}.`,
                    member: name,
                    email: user.email,
                    type: "transaction_rejected",
                    created_at: declinedAt
                });
            });
            await audit(name, `Rejected ${transaction.type}`, `${transaction.member}'s KES ${asNumber(transaction.amount).toLocaleString()}`);
            const pushDelivery = await sendPush(
                "Transaction Declined",
                "A group transaction was declined.",
                null,
                name,
                { type: "transaction_rejected" }
            );
            return { success: true, pushDelivery };
        }
        case "submitLoan": {
            const amount = Number(params.amount);
            if (!Number.isFinite(amount) || amount <= 0) throw new Error("Loan amount must be positive.");
            const date = String(params.date || "");
            const requestedDueDate = String(params.requestedDueDate || "");
            const message = String(params.message || "").trim();
            if (!isIsoDate(date)) {
                throw new Error("Enter a valid loan request date.");
            }
            if (!isIsoDate(requestedDueDate) || requestedDueDate <= date) {
                throw new Error("Choose a valid repayment date after the request date.");
            }
            if (message.length < 3 || message.length > 500) {
                throw new Error("Describe the purpose of the loan in 3-500 characters.");
            }
            const id = crypto.randomUUID();
            const createdAt = nowIso();
            const [usersSnapshot, treasurerName] = await Promise.all([
                db.collection("users").where("status", "==", "approved").get(),
                getTreasurerName()
            ]);
            const requesterEmail = emailKey(user.email);
            const board = getLoanBoardMembers(usersSnapshot.docs.map((doc) => ({
                id: doc.id,
                ...doc.data(),
                email: doc.data().email || doc.id
            })), treasurerName);
            if (!hasCompleteLoanBoard(board)) {
                throw new Error("Loan requests need an approved Chairman, Vice-Chairman, Secretary and Treasurer assigned first.");
            }
            const requiredApproverEmails = board
                .filter((member) => !loanRequesterIsMember({ requesterEmail, member: name }, member))
                .map((member) => member.email);
            const requiredApproverNames = board
                .filter((member) => requiredApproverEmails.includes(member.email))
                .map((member) => member.name);
            const approvalsRequired = requiredApproverEmails.length;
            const loan = {
                id,
                date,
                member: name,
                requesterEmail,
                amount,
                principal: amount,
                interest: Math.round(amount * LOAN_INTEREST_RATE),
                totalDue: amount + Math.round(amount * LOAN_INTEREST_RATE),
                requestedDueDate,
                message,
                notes: String(params.notes || ""),
                approvals: [],
                approvalEmails: [],
                requiredApproverEmails,
                approvalsRequired,
                status: "pending",
                createdAt
            };
            if (approvalsRequired < 1) throw new Error("At least one other approved member must be available to review a loan request.");
            const inboxMessage = {
                id: crypto.randomUUID(),
                message: `${name} requested KES ${amount.toLocaleString()} for ${message}. Estimated total with 10% interest: KES ${loan.totalDue.toLocaleString()}. Requested repayment date: ${requestedDueDate}. Board approval needed from: ${requiredApproverNames.join(", ")}.`,
                member: name,
                email: requesterEmail,
                type: "loan_request",
                loanId: id,
                created_at: createdAt
            };
            await db.runTransaction(async (tx) => {
                const capacityLockRef = recordRef("settings", "loanCapacity");
                const [capacityLockSnapshot, savingsSnapshot, activeSnapshot, pendingSnapshot, awaitingSnapshot] = await Promise.all([
                    tx.get(capacityLockRef),
                    tx.get(db.collection("transactions").where("type", "==", "Savings")),
                    tx.get(db.collection("activeLoans")),
                    tx.get(db.collection("pendingLoans")),
                    tx.get(db.collection("loansAwaitingDueDate"))
                ]);
                const totalSavings = savingsSnapshot.docs.reduce((sum, doc) => sum + asNumber(doc.data().amount), 0);
                const capacity = calculateLoanCapacity(
                    totalSavings,
                    activeSnapshot.docs.map((doc) => doc.data()),
                    pendingSnapshot.docs.map((doc) => doc.data()),
                    awaitingSnapshot.docs.map((doc) => doc.data())
                );
                if (capacity.requestLimit <= 0) {
                    throw new Error("No borrowing capacity is currently available. Half of group savings is reserved for the group.");
                }
                if (amount > capacity.requestLimit) {
                    throw new Error(`Maximum request available to you is KES ${Math.floor(capacity.requestLimit).toLocaleString()} under the group loan limits.`);
                }
                tx.set(capacityLockRef, {
                    version: asNumber(capacityLockSnapshot.exists && capacityLockSnapshot.data().version) + 1,
                    updatedAt: nowIso()
                });
                tx.create(recordRef("pendingLoans", id), loan);
                tx.create(recordRef("loanRequests", id), loan);
                tx.create(recordRef("groupMessages", inboxMessage.id), inboxMessage);
            });
            await audit(name, "Requested a loan", `KES ${amount.toLocaleString()} — needs member approval`);
            const pushDeliveries = await Promise.all(requiredApproverNames.map((approver) => sendPush(
                "New Loan Request",
                "A loan request needs Board approval. Open NBFA Group to review it.",
                approver,
                null,
                { type: "loan_request" }
            )));
            const pushDelivery = combinePushDeliveries(pushDeliveries);
            return { success: true, id, approvalsRequired, pushDelivery };
        }
        case "approveLoan": {
            const id = String(params.loanId || "");
            const ref = recordRef("pendingLoans", id);
            const historyRef = recordRef("loanRequests", id);
            let approvalCount = 0;
            let completedLoan = null;
            let member = "";
            let approvalsRequired = 0;
            let dueDateSetterName = "";
            const approverEmail = actorEmail;
            const configuredTreasurerName = await getTreasurerName();
            await db.runTransaction(async (tx) => {
                const [loanSnap, usersSnap] = await Promise.all([
                    tx.get(ref),
                    tx.get(db.collection("users").where("status", "==", "approved"))
                ]);
                if (!loanSnap.exists) throw new Error("Loan not found.");
                const loan = loanSnap.data();
                const board = getLoanBoardMembers(usersSnap.docs.map((doc) => ({
                    id: doc.id,
                    ...doc.data(),
                    email: doc.data().email || doc.id
                })), configuredTreasurerName);
                const requiredEmails = eligibleLoanApproverEmails(loan, board);
                if (!requiredEmails.length) throw new Error("No eligible Board approvers are assigned to this request.");
                if (emailKey(loan.requesterEmail) === approverEmail || (!loan.requesterEmail && normalizedName(loan.member) === normalizedName(name))) {
                    throw new Error("You cannot approve your own loan request.");
                }
                if (!requiredEmails.includes(approverEmail)) {
                    throw new Error("Only the designated Board members can approve this loan request.");
                }
                const approvedProfiles = usersSnap.docs.map((doc) => ({ id: doc.id, ...doc.data(), email: doc.data().email || doc.id }));
                const priorApprovals = getValidLoanApprovals(loan, requiredEmails, approvedProfiles);
                if (priorApprovals.approvalEmails.includes(approverEmail)) {
                    throw new Error("You already approved this loan.");
                }
                const approvals = [...priorApprovals.approvals];
                const approvalEmails = [...priorApprovals.approvalEmails];
                approvals.push(name);
                approvalEmails.push(approverEmail);
                approvalCount = approvals.length;
                approvalsRequired = requiredEmails.length;
                member = loan.member;
                const updatedLoan = {
                    ...loan,
                    approvals,
                    approvalEmails,
                    requiredApproverEmails: requiredEmails,
                    approvalsRequired,
                    status: approvalCount >= approvalsRequired ? "approved" : "pending"
                };
                if (approvalCount >= approvalsRequired) {
                    const dueDateSetter = getLoanDueDateSetter(loan, board);
                    if (!dueDateSetter) throw new Error("The Board needs an assigned Treasurer and Chairman to activate loans.");
                    dueDateSetterName = dueDateSetter.name;
                    completedLoan = { ...updatedLoan, approvedBy: approvals.join(", "), approvedAt: nowIso() };
                    tx.create(recordRef("loansAwaitingDueDate", id), completedLoan);
                    tx.delete(ref);
                } else {
                    tx.update(ref, {
                        approvals,
                        approvalEmails,
                        approvalsRequired,
                        status: "pending"
                    });
                }
                tx.set(historyRef, completedLoan || updatedLoan);
                const inboxMessage = {
                    id: crypto.randomUUID(),
                    message: `${name} approved ${loan.member}'s KES ${asNumber(loan.amount).toLocaleString()} loan request. ${Math.max(0, approvalsRequired - approvalCount)} more approval(s) required.`,
                    member: name,
                    email: approverEmail,
                    type: "loan_approval",
                    loanId: id,
                    created_at: nowIso()
                };
                tx.create(recordRef("groupMessages", inboxMessage.id), inboxMessage);
            });
            await audit(name, "Approved a loan vote", `${approvalCount} approval(s)`);
            let pushDeliveries;
            if (completedLoan) {
                pushDeliveries = await Promise.all([
                sendPush(
                    "Loan Fully Approved!",
                    "A loan request received all required approvals.",
                    member,
                    null,
                    { type: "loan_fully_approved" }
                ),
                sendPush(
                    "Set Loan Due Date",
                    "An approved loan needs its repayment schedule.",
                    dueDateSetterName,
                    null,
                    { type: "loan_needs_due_date" }
                )
                ]);
            } else {
                pushDeliveries = [await sendPush(
                    "Loan Approval Update",
                    "A loan request received an approval.",
                    null,
                    approverEmail,
                    { type: "loan_approval_update" }
                )];
            }
            return { success: true, approvals: approvalCount, approvalsRequired, pushDelivery: combinePushDeliveries(pushDeliveries) };
        }
        case "rejectLoan": {
            const id = String(params.loanId || "");
            const reason = String(params.reason || "").trim();
            if (reason.length < 3 || reason.length > 500) throw new Error("Provide a decline reason in 3-500 characters.");
            const ref = recordRef("pendingLoans", id);
            const historyRef = recordRef("loanRequests", id);
            let loanMember = "";
            const configuredTreasurerName = await getTreasurerName();
            await db.runTransaction(async (tx) => {
                const [snapshot, historySnapshot, usersSnapshot] = await Promise.all([
                    tx.get(ref),
                    tx.get(historyRef),
                    tx.get(db.collection("users").where("status", "==", "approved"))
                ]);
                if (!snapshot.exists) throw new Error("Pending loan request not found.");
                const loan = snapshot.data();
                if (emailKey(loan.requesterEmail) === actorEmail || (!loan.requesterEmail && loan.member === name)) {
                    throw new Error("You cannot decline your own loan request.");
                }
                const board = getLoanBoardMembers(usersSnapshot.docs.map((doc) => ({
                    id: doc.id,
                    ...doc.data(),
                    email: doc.data().email || doc.id
                })), configuredTreasurerName);
                const requiredEmails = eligibleLoanApproverEmails(loan, board);
                if (!requiredEmails.includes(actorEmail)) {
                    throw new Error("Only the designated Board members can decline this loan request.");
                }
                const hasApprovalEmailRecords = Array.isArray(loan.approvalEmails);
                const approvalEmails = hasApprovalEmailRecords ? loan.approvalEmails.map(emailKey) : [];
                if (approvalEmails.includes(actorEmail)
                    || (!hasApprovalEmailRecords && Array.isArray(loan.approvals) && loan.approvals.includes(name))) {
                    throw new Error("You have already approved this loan request.");
                }
                loanMember = loan.member;
                const updatedLoan = {
                    ...(historySnapshot.exists ? historySnapshot.data() : loan),
                    status: "rejected",
                    rejectionReason: reason,
                    rejectedBy: name,
                    rejectedByEmail: user.email,
                    decidedAt: nowIso()
                };
                tx.set(historyRef, updatedLoan);
                tx.delete(ref);
                const inboxMessage = {
                    id: crypto.randomUUID(),
                    message: `${name} declined ${loan.member}'s KES ${asNumber(loan.amount).toLocaleString()} loan request. Reason: ${reason}`,
                    member: name,
                    email: actorEmail,
                    type: "loan_rejected",
                    loanId: id,
                    created_at: nowIso()
                };
                tx.create(recordRef("groupMessages", inboxMessage.id), inboxMessage);
            });
            await audit(name, "Rejected a loan request", `${loanMember}'s request — ${reason}`);
            const pushDelivery = await sendPush("Loan Request Declined", "A loan request was declined.", null, actorEmail, { type: "loan_rejected" });
            return { success: true, pushDelivery };
        }
        case "cancelLoan": {
            const adminAccess = await hasAdminAccess(user);
            const id = String(params.loanId || "");
            const ref = recordRef("pendingLoans", id);
            const historyRef = recordRef("loanRequests", id);
            let amount = 0;
            await db.runTransaction(async (tx) => {
                const [snapshot, historySnapshot] = await Promise.all([tx.get(ref), tx.get(historyRef)]);
                if (!snapshot.exists) throw new Error("Loan not found.");
                const loan = snapshot.data();
                const requesterIsAnotherMember = loan.requesterEmail
                    ? emailKey(loan.requesterEmail) !== actorEmail
                    : loan.member !== name;
                if (requesterIsAnotherMember && !adminAccess) {
                    throw new Error("You can only cancel your own loan request.");
                }
                amount = asNumber(loan.amount);
                tx.delete(ref);
                tx.set(historyRef, {
                    ...(historySnapshot.exists ? historySnapshot.data() : loan),
                    status: "cancelled",
                    cancelledAt: nowIso(),
                    cancelledBy: name
                });
                const inboxMessage = {
                    id: crypto.randomUUID(),
                    message: `${name} cancelled a loan request of KES ${amount.toLocaleString()}.`,
                    member: name,
                    email: user.email,
                    type: "loan_cancelled",
                    loanId: id,
                    created_at: nowIso()
                };
                tx.create(recordRef("groupMessages", inboxMessage.id), inboxMessage);
            });
            const pushDelivery = await sendPush("Loan Request Cancelled", "A loan request was cancelled.", null, actorEmail, { type: "loan_cancelled" });
            return { success: true, pushDelivery };
        }
        case "setLoanDueDate": {
            const loanId = String(params.loanId || "");
            const dueDate = String(params.dueDate || "");
            if (!isIsoDate(dueDate)) {
                throw new Error("Enter a valid repayment due date.");
            }
            const configuredTreasurerName = await getTreasurerName();
            const awaitingRef = recordRef("loansAwaitingDueDate", loanId);
            const historyRef = recordRef("loanRequests", loanId);
            let loanMember = "";
            await db.runTransaction(async (tx) => {
                const [snapshot, historySnapshot, usersSnapshot] = await Promise.all([
                    tx.get(awaitingRef),
                    tx.get(historyRef),
                    tx.get(db.collection("users").where("status", "==", "approved"))
                ]);
                if (!snapshot.exists) throw new Error("Loan not found or already activated.");
                const loan = snapshot.data();
                const board = getLoanBoardMembers(usersSnapshot.docs.map((doc) => ({
                    id: doc.id,
                    ...doc.data(),
                    email: doc.data().email || doc.id
                })), configuredTreasurerName);
                if (!hasCompleteLoanBoard(board)) {
                    throw new Error("An approved Chairman, Vice-Chairman, Secretary and Treasurer must be assigned to the Board.");
                }
                const dueDateSetter = getLoanDueDateSetter(loan, board);
                if (!dueDateSetter || dueDateSetter.email !== actorEmail) {
                    const expectedPosition = loanRequesterIsMember(loan, board.find((member) => member.position === "Treasurer") || {})
                        ? "Chairman"
                        : "Treasurer";
                    throw new Error(`Only the ${expectedPosition} can set the final repayment date for this loan.`);
                }
                if (loan.date && dueDate <= loan.date) throw new Error("Repayment due date must be after the request date.");
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
                tx.set(historyRef, {
                    ...(historySnapshot.exists ? historySnapshot.data() : loan),
                    status: "active",
                    dueDate,
                    activatedAt: nowIso()
                });
                tx.delete(awaitingRef);
                const inboxMessage = {
                    id: crypto.randomUUID(),
                    message: `${loan.member}'s approved loan of KES ${principal.toLocaleString()} is now active. Total due: KES ${(principal + interest).toLocaleString()}. Repayment due: ${dueDate}.`,
                    member: name,
                    email: user.email,
                    type: "loan_activated",
                    loanId,
                    created_at: nowIso()
                };
                tx.create(recordRef("groupMessages", inboxMessage.id), inboxMessage);
            });
            await audit(name, "Activated loan with due date", `${loanId} — due ${dueDate}`);
            const pushDelivery = await sendPush("Loan Activated", "A loan was activated.", null, null, { type: "loan_due_date_set" });
            return { success: true, pushDelivery };
        }
        case "getPendingRegistrations":
        case "getPendingTransactions":
        case "getPendingLoans":
        case "getLoansDashboard":
        case "getLoansAwaitingDueDate":
        case "getActiveLoans":
        case "getMeetingMinutes":
        case "getAuditLog":
        case "getDeveloperAuditLog":
        case "getDeveloperPortalData":
        case "getDeveloperUsers":
        case "getAllUsersFull":
        case "getSystemStats":
        case "getScheduledMeeting":
        case "getTreasurerInfo":
        case "getSubscriptions":
        case "exportSystemData":
        case "exportAuditLog": {
            const adminAccess = await hasAdminAccess(user);
            if (["getPendingRegistrations", "getPendingTransactions", "getLoansAwaitingDueDate"].includes(action)) await requireAdmin(user);
            if (["getAllUsersFull", "exportAuditLog"].includes(action)) await requireAdmin(user);
            if (["getDeveloperAuditLog", "getDeveloperPortalData", "getDeveloperUsers", "getSystemStats", "getSubscriptions", "exportSystemData"].includes(action)) requireDeveloper(user);
            if (action === "getAuditLog") await requireAdmin(user);
            if (action === "getPendingRegistrations") {
                const [usersSnapshot, joinRequestsSnapshot] = await Promise.all([
                    db.collection("users").where("status", "==", "pending").get(),
                    db.collection("registrationRequests").where("status", "==", "pending").get()
                ]);
                return {
                    success: true,
                    registrations: usersSnapshot.docs.map((doc) => publicUser(doc.data())),
                    joinRequests: joinRequestsSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }))
                };
            }
            if (action === "getDeveloperUsers") {
                const requestedLimit = Number(params.limit);
                const limit = Number.isInteger(requestedLimit) ? Math.min(50, Math.max(1, requestedLimit)) : 25;
                let query = db.collection("users").orderBy(FieldPath.documentId()).limit(limit + 1);
                const cursor = String(params.cursor || "");
                if (cursor) query = query.startAfter(cursor);
                const snapshot = await query.get();
                const docs = snapshot.docs.slice(0, limit);
                return {
                    success: true,
                    users: docs.map((doc) => publicUser({ ...doc.data(), email: doc.data().email || doc.id })),
                    nextCursor: docs.length ? docs[docs.length - 1].id : null,
                    hasMore: snapshot.docs.length > limit
                };
            }
            if (action === "exportSystemData") {
                const allowedCollections = new Set([
                    "activeLoans", "auditLog", "groupMemories", "groupMessages", "loanRequests",
                    "loansAwaitingDueDate", "meetingMinutes", "pendingEdits", "pendingLoans",
                    "pendingTransactions", "registrationRequests", "scheduledMeeting", "settings",
                    "subscriptions", "transactions", "users"
                ]);
                const collection = String(params.collection || "");
                if (!allowedCollections.has(collection)) throw new Error("Choose a supported backup data collection.");
                const requestedLimit = Number(params.limit);
                const limit = Number.isInteger(requestedLimit) ? Math.min(100, Math.max(1, requestedLimit)) : 100;
                let query = db.collection(collection).orderBy(FieldPath.documentId()).limit(limit + 1);
                const cursor = String(params.cursor || "");
                if (cursor) query = query.startAfter(cursor);
                const snapshot = await query.get();
                const docs = snapshot.docs.slice(0, limit);
                return {
                    success: true,
                    collection,
                    records: docs.map((doc) => ({ id: doc.id, ...doc.data() })),
                    nextCursor: docs.length ? docs[docs.length - 1].id : null,
                    hasMore: snapshot.docs.length > limit
                };
            }
            if (action === "getDeveloperPortalData") {
                const activeLoansCollection = db.collection("activeLoans");
                const [usersCountSnapshot, pendingUsersSnapshot, joinRequestsSnapshot, pendingTransactionsSnapshot, pendingLoansSnapshot, activeLoansSnapshot, interestSnapshot, subscriptionsSnapshot, savingsSnapshot] = await Promise.all([
                    db.collection("users").count().get(),
                    db.collection("users").where("status", "==", "pending").get(),
                    db.collection("registrationRequests").where("status", "==", "pending").get(),
                    db.collection("pendingTransactions").count().get(),
                    db.collection("pendingLoans").count().get(),
                    activeLoansCollection.where("status", "!=", "paid_off").get(),
                    activeLoansCollection.aggregate({ total: AggregateField.sum("interest") }).get(),
                    db.collection("subscriptions").count().get(),
                    db.collection("transactions").where("type", "==", "Savings")
                        .aggregate({ total: AggregateField.sum("amount") }).get()
                ]);
                const activeLoans = activeLoansSnapshot.docs.map((doc) => doc.data());
                const joinRequests = joinRequestsSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
                const pendingUsers = pendingUsersSnapshot.docs.map((doc) => ({ ...doc.data(), email: doc.data().email || doc.id }));
                const pendingUserEmails = new Set(pendingUsers.map((item) => emailKey(item.email)));
                const summary = summarizeData([{
                    type: "Savings",
                    amount: savingsSnapshot.data().total || 0
                }], activeLoans);
                summary.interestEarned = interestSnapshot.data().total || 0;
                return {
                    success: true,
                    stats: {
                        totalUsers: usersCountSnapshot.data().count,
                        pendingRegistrations: pendingUserEmails.size + joinRequests.filter((item) =>
                            item.status === "pending" && !pendingUserEmails.has(emailKey(item.email))
                        ).length,
                        pendingTransactions: pendingTransactionsSnapshot.data().count,
                        pendingLoans: pendingLoansSnapshot.data().count,
                        activeLoans: activeLoansSnapshot.size,
                        pushSubscriptions: subscriptionsSnapshot.data().count,
                        totalSavings: summary.savings,
                        outstandingLoans: summary.outstanding,
                        interestEarned: summary.interestEarned
                    }
                };
            }
            if (action === "getPendingTransactions") return { success: true, transactions: await rows("pendingTransactions") };
            if (action === "getPendingLoans") return { success: true, loans: await rows("pendingLoans") };
            if (action === "getLoansDashboard") {
                const treasurerName = await getTreasurerName();
                const [loans, active, users, awaiting, requestHistory, savingsSnapshot] = await Promise.all([
                    rows("pendingLoans"),
                    rows("activeLoans"),
                    rows("users"),
                    rows("loansAwaitingDueDate"),
                    rows("loanRequests"),
                    db.collection("transactions").where("type", "==", "Savings")
                        .aggregate({ total: AggregateField.sum("amount") }).get()
                ]);
                const approvedUsers = users
                    .filter((item) => item.status === "approved")
                    .map((item) => ({ ...item, email: item.email || item.id }));
                const board = getLoanBoardMembers(approvedUsers, treasurerName);
                const members = approvedUsers.filter((item) => item.name).map((item) => item.name);
                const activeLoans = active.map((loan) => {
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
                const loanCapacity = calculateLoanCapacity(
                    savingsSnapshot.data().total,
                    active,
                    loans,
                    awaiting
                );
                const dueDateTasks = awaiting.filter((loan) => {
                    const setter = getLoanDueDateSetter(loan, board);
                    return setter && setter.email === actorEmail;
                });
                const requestById = new Map(requestHistory.map((request) => [request.id, request]));
                const loanRequests = [...requestHistory];
                const addLegacyRequest = (loan, status) => {
                    const id = String(loan.id || loan.loanId || "");
                    if (!id || requestById.has(id)) return;
                    const principal = asNumber(loan.amount ?? loan.principal);
                    const request = {
                        ...loan,
                        id,
                        principal,
                        interest: Math.round(principal * LOAN_INTEREST_RATE),
                        totalDue: principal + Math.round(principal * LOAN_INTEREST_RATE),
                        approvals: Array.isArray(loan.approvals) ? loan.approvals : [],
                        status
                    };
                    requestById.set(id, request);
                    loanRequests.push(request);
                };
                loans.forEach((loan) => addLegacyRequest(loan, loan.status || "pending"));
                awaiting.forEach((loan) => addLegacyRequest(loan, "approved"));
                active.forEach((loan) => addLegacyRequest(loan, "active"));
                loanRequests.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
                return {
                    success: true,
                    members,
                    loanCapacity,
                    loans: loans.map((loan) => {
                        const principal = asNumber(loan.amount ?? loan.principal);
                        const requiredEmails = eligibleLoanApproverEmails(loan, board);
                        const approvalRecords = getValidLoanApprovals(loan, requiredEmails, approvedUsers);
                        const approvals = approvalRecords.approvals;
                        let requesterEmail = emailKey(loan.requesterEmail);
                        if (!requesterEmail) {
                            const requester = approvedUsers.find((item) => String(item.name || "").trim().toLowerCase() === String(loan.member || "").trim().toLowerCase());
                            requesterEmail = emailKey(requester && requester.email);
                        }
                        const publicLoan = { ...loan };
                        delete publicLoan.requesterEmail;
                        delete publicLoan.approvalEmails;
                        delete publicLoan.requiredApproverEmails;
                        return {
                            ...publicLoan,
                            isRequester: requesterEmail === actorEmail || (!requesterEmail && loan.member === name),
                            viewerHasApproved: approvalRecords.approvalEmails.includes(actorEmail),
                            viewerCanApprove: requiredEmails.includes(actorEmail)
                                && !approvalRecords.approvalEmails.includes(actorEmail),
                            principal,
                            interest: Math.round(principal * LOAN_INTEREST_RATE),
                            totalDue: principal + Math.round(principal * LOAN_INTEREST_RATE),
                            approvals,
                            approvalsRequired: requiredEmails.length || Number(loan.approvalsRequired) || 0
                        };
                    }),
                    activeLoans,
                    loansAwaitingDueDate: dueDateTasks,
                    loanRequests: loanRequests.map((request) => {
                        const requesterProfile = approvedUsers.find((item) => String(item.name || "").trim().toLowerCase() === String(request.member || "").trim().toLowerCase());
                        const requesterEmail = emailKey(request.requesterEmail || (requesterProfile && requesterProfile.email));
                        const principal = asNumber(request.principal ?? request.amount);
                        return {
                            id: request.id,
                            member: request.member || "",
                            isRequester: requesterEmail === actorEmail || (!requesterEmail && request.member === name),
                            principal,
                            amount: asNumber(request.amount ?? request.principal),
                            interest: asNumber(request.interest) || Math.round(principal * LOAN_INTEREST_RATE),
                            totalDue: asNumber(request.totalDue) || (principal + Math.round(principal * LOAN_INTEREST_RATE)),
                            message: request.message || "",
                            date: request.date || "",
                            requestedDueDate: request.requestedDueDate || "",
                            createdAt: request.createdAt || "",
                            approvals: Array.isArray(request.approvals) ? request.approvals : [],
                            approvalsRequired: Number.isFinite(Number(request.approvalsRequired))
                                ? Number(request.approvalsRequired)
                                : approvedUsers.filter((item) => requesterEmail
                                    ? emailKey(item.email) !== requesterEmail
                                    : item.name !== request.member).length,
                            status: request.status || "pending",
                            rejectionReason: request.rejectionReason || "",
                            dueDate: request.dueDate || ""
                        };
                    })
                };
            }
            if (action === "getLoansAwaitingDueDate") return { success: true, loans: await rows("loansAwaitingDueDate") };
            if (action === "getActiveLoans") return { success: true, loans: await rows("activeLoans") };
            if (action === "getMeetingMinutes") {
                const meetings = await rows("meetingMinutes");
                meetings.sort((a, b) => String(a.date).localeCompare(String(b.date)));
                return { success: true, meetings };
            }
            if (action === "getAuditLog" || action === "getDeveloperAuditLog") {
                const limit = Math.min(Number(params.limit) || 50, 200);
                const snapshot = await db.collection("auditLog").orderBy("timestamp", "desc").limit(limit).get();
                return { success: true, entries: snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })) };
            }
            if (action === "exportAuditLog") {
                const entries = await rows("auditLog");
                entries.sort((a, b) => String(b.timestamp || "").localeCompare(String(a.timestamp || "")));
                await audit(user.profile.name || user.email, "Exported complete group audit log", "Admin download");
                return { success: true, entries };
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
            await requireAdmin(user);
            const email = emailKey(params.email);
            const ref = db.collection("users").doc(safeDocId(email));
            const requestRef = db.collection("registrationRequests").doc(safeDocId(email));
            const [snapshot, requestSnapshot] = await Promise.all([ref.get(), requestRef.get()]);
            const hasPendingRequest = requestSnapshot.exists && requestSnapshot.data().status === "pending";
            if (snapshot.exists && snapshot.data().status !== "pending" && !hasPendingRequest) {
                throw new Error("Registration request is no longer pending.");
            }
            const targetName = snapshot.exists
                ? (snapshot.data().displayName || snapshot.data().name || email)
                : (requestSnapshot.exists ? requestSnapshot.data().name || email : email);
            const approvedAt = nowIso();
            const inboxMessageRef = db.collection("groupMessages").doc();
            const batch = db.batch();
            if (snapshot.exists) {
                const updates = { status: "approved", approved_by: name, approved_at: approvedAt };
                batch.update(ref, updates);
                if (requestSnapshot.exists && requestSnapshot.data().status === "pending") {
                    batch.update(requestRef, updates);
                }
            } else if (requestSnapshot.exists && requestSnapshot.data().status === "pending") {
                batch.create(ref, {
                    email,
                    name: requestSnapshot.data().name,
                    role: "member",
                    status: "approved",
                    created_at: requestSnapshot.data().created_at || approvedAt,
                    approved_by: name,
                    approved_at: approvedAt
                });
                batch.update(requestRef, { status: "approved", approved_by: name, approved_at: approvedAt });
            } else {
                throw new Error("Registration request not found.");
            }
            batch.create(inboxMessageRef, {
                id: inboxMessageRef.id,
                message: `${name} approved ${targetName}'s registration request.`,
                member: name,
                email: user.email,
                type: "registration_approved",
                created_at: approvedAt
            });
            await batch.commit();
            await audit(name, "Approved registration", email);
            const pushDelivery = await sendPush(
                "Registration Approved",
                "A membership registration was approved.",
                null,
                emailKey(user.email),
                { type: "registration_approved" }
            );
            return { success: true, pushDelivery };
        }
        case "rejectRegistration": {
            await requireAdmin(user);
            const email = emailKey(params.email);
            const ref = db.collection("users").doc(safeDocId(email));
            const requestRef = db.collection("registrationRequests").doc(safeDocId(email));
            const [snapshot, requestSnapshot] = await Promise.all([ref.get(), requestRef.get()]);
            const hasPendingRequest = requestSnapshot.exists && requestSnapshot.data().status === "pending";
            if (snapshot.exists && snapshot.data().status !== "pending" && !hasPendingRequest) {
                throw new Error("Registration request is no longer pending.");
            }
            const targetName = snapshot.exists
                ? (snapshot.data().displayName || snapshot.data().name || email)
                : (requestSnapshot.exists ? requestSnapshot.data().name || email : email);
            const rejectedAt = nowIso();
            const inboxMessageRef = db.collection("groupMessages").doc();
            const batch = db.batch();
            if (snapshot.exists) {
                const updates = { status: "rejected", rejected_by: name, rejected_at: rejectedAt };
                batch.update(ref, updates);
                if (requestSnapshot.exists && requestSnapshot.data().status === "pending") {
                    batch.update(requestRef, updates);
                }
            } else if (requestSnapshot.exists && requestSnapshot.data().status === "pending") {
                batch.update(requestRef, { status: "rejected", rejected_by: name, rejected_at: rejectedAt });
            } else {
                throw new Error("Registration request not found.");
            }
            batch.create(inboxMessageRef, {
                id: inboxMessageRef.id,
                message: `${name} declined ${targetName}'s registration request.`,
                member: name,
                email: user.email,
                type: "registration_rejected",
                created_at: rejectedAt
            });
            await batch.commit();
            await audit(name, "Rejected registration", email);
            const pushDelivery = await sendPush(
                "Registration Declined",
                "A membership registration was declined.",
                null,
                emailKey(user.email),
                { type: "registration_rejected" }
            );
            return { success: true, pushDelivery };
        }
        case "updateUserRole": {
            // Roles are controlled by the developer so an administrator cannot
            // silently change another administrator's access after assignment.
            requireDeveloper(user);
            const email = emailKey(params.email);
            const role = String(params.role || "").toLowerCase();
            if (!["member", "admin", "developer"].includes(role)) throw new Error("Invalid role.");
            if (email === user.email) throw new Error("You cannot change your own role.");
            const ref = db.collection("users").doc(safeDocId(email));
            const snapshot = await ref.get();
            if (!snapshot.exists) throw new Error("User not found.");
            if (DEVELOPER_EMAILS.has(email)) {
                await audit(name, "CLASSIFIED: blocked protected developer role change", `${email} — requested role ${role}`);
                await notifyDevelopersOfProtectedAccountAttempt(name, email, "role change");
                throw new Error("Developer accounts are protected and cannot be changed.");
            }
            if (!isDeveloper(user) && role === "developer") throw new Error("Only the developer can assign developer access.");
            await ref.update({ role });
            await audit(name, "Updated user role", `${email} → ${role}`);
            return { success: true, message: `User role updated to ${role}` };
        }
        case "setUserPosition": {
            requireDeveloper(user);
            const email = emailKey(params.email);
            const position = String(params.position || "");
            if (!POSITION_TITLES.has(position)) throw new Error("Choose a valid member position.");
            const ref = db.collection("users").doc(safeDocId(email));
            const snapshot = await ref.get();
            if (!snapshot.exists || snapshot.data().status !== "approved") throw new Error("Approved member not found.");
            await ref.update({ position });
            await audit(name, "Updated member position", `${email} → ${position}`);
            return { success: true, email, position };
        }
        case "setUserSalutation": {
            requireDeveloper(user);
            const email = emailKey(params.email);
            const salutation = String(params.salutation || "");
            if (salutation && !PROFILE_SALUTATIONS.has(salutation)) {
                throw new Error("Choose Mr., Mrs., or no salutation.");
            }
            const ref = db.collection("users").doc(safeDocId(email));
            const snapshot = await ref.get();
            if (!snapshot.exists || snapshot.data().status !== "approved") throw new Error("Approved member not found.");
            await ref.update({ salutation, updated_at: nowIso() });
            await audit(name, "Updated member greeting salutation", `${email} → ${salutation || "none"}`);
            return { success: true, email, salutation };
        }
        case "createUser": {
            await requireAdmin(user);
            const email = emailKey(params.email);
            const newName = String(params.name || "").trim();
            if (newName.length < 2 || newName.length > 80) throw new Error("Enter a name between 2 and 80 characters.");
            if (email.length > 254 || !/^\S+@\S+\.\S+$/.test(email)) throw new Error("Enter a valid Google email address.");
            if (DEVELOPER_EMAILS.has(email)) {
                await audit(name, "CLASSIFIED: blocked protected developer creation attempt", email);
                await notifyDevelopersOfProtectedAccountAttempt(name, email, "account creation");
                throw new Error("Developer accounts are protected.");
            }
            const newUserRef = db.collection("users").doc(safeDocId(email));
            if ((await newUserRef.get()).exists) throw new Error("A user with this email already exists.");
            const timestamp = nowIso();
            const newUser = { email, name: newName, role: "member", status: "approved", created_at: timestamp, approved_by: user.email, approved_at: timestamp };
            await newUserRef.create(newUser);
            await audit(name, "Added approved group user", email);
            return { success: true, user: publicUser(newUser) };
        }
        case "deleteUser": {
            requireDeveloper(user);
            const email = emailKey(params.email);
            if (email === user.email) throw new Error("You cannot delete your own account.");
            const ref = db.collection("users").doc(safeDocId(email));
            const snapshot = await ref.get();
            if (!snapshot.exists) throw new Error("User not found.");
            if (DEVELOPER_EMAILS.has(email)) {
                await audit(name, "CLASSIFIED: blocked protected developer deletion attempt", email);
                await notifyDevelopersOfProtectedAccountAttempt(name, email, "account deletion");
                throw new Error("Developer accounts are protected and cannot be deleted.");
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
            await requireAdmin(user);
            const id = crypto.randomUUID();
            const date = String(params.date || "");
            const minutes = {
                id, date: params.date || "", recordedBy: name, agenda: String(params.agenda || ""),
                notes: String(params.notes || ""), decisions: String(params.decisions || ""),
                nextMeeting: params.nextMeeting || ""
            };
            const createdAt = nowIso();
            const inboxMessageRef = db.collection("groupMessages").doc();
            const batch = db.batch();
            batch.create(recordRef("meetingMinutes", id), minutes);
            batch.create(inboxMessageRef, {
                id: inboxMessageRef.id,
                message: `${name} saved meeting minutes${date ? ` for ${date}` : ""}. Open the meeting minutes section to read them.`,
                member: name,
                email: user.email,
                type: "meeting_minutes_saved",
                created_at: createdAt
            });
            await batch.commit();
            await audit(name, "Saved meeting minutes", date);
            const pushDelivery = await sendPush(
                "Meeting minutes available",
                "New meeting minutes are available in NBFA Group.",
                null,
                name,
                { type: "meeting_minutes_saved" }
            );
            return { success: true, id, pushDelivery };
        }
        case "deleteMeeting": {
            await requireAdmin(user);
            const ref = recordRef("meetingMinutes", params.id);
            if (!(await ref.get()).exists) throw new Error("Meeting not found.");
            await ref.delete();
            return { success: true };
        }
        case "scheduleMeeting": {
            await requireAdmin(user);
            const meeting = {
                date: params.date || "",
                agenda: String(params.agenda || ""),
                venue: String(params.venue || ""),
                scheduledBy: name
            };
            const createdAt = nowIso();
            const inboxMessageRef = db.collection("groupMessages").doc();
            const batch = db.batch();
            batch.set(db.collection("scheduledMeeting").doc("current"), meeting);
            batch.create(inboxMessageRef, {
                id: inboxMessageRef.id,
                message: `${name} scheduled a group meeting for ${meeting.date}.${meeting.agenda ? ` Agenda: ${meeting.agenda}.` : ""}${meeting.venue ? ` Venue: ${meeting.venue}.` : ""}`,
                member: name,
                email: user.email,
                type: "meeting_scheduled",
                created_at: createdAt
            });
            await batch.commit();
            const pushDelivery = await sendPush(
                "New Meeting Scheduled",
                "A group meeting was scheduled.",
                null,
                name,
                { type: "meeting_scheduled" }
            );
            return { success: true, pushDelivery };
        }
        case "cancelScheduledMeeting": {
            await requireAdmin(user);
            const scheduledMeetingRef = db.collection("scheduledMeeting").doc("current");
            const inboxMessageRef = db.collection("groupMessages").doc();
            const cancelledAt = nowIso();
            let meeting = null;
            await db.runTransaction(async (tx) => {
                const snapshot = await tx.get(scheduledMeetingRef);
                if (!snapshot.exists) throw new Error("There is no scheduled meeting to cancel.");
                meeting = snapshot.data();
                tx.delete(scheduledMeetingRef);
                tx.create(inboxMessageRef, {
                    id: inboxMessageRef.id,
                    message: `${name} cancelled the group meeting scheduled for ${meeting.date || "an upcoming date"}.`,
                    member: name,
                    email: user.email,
                    type: "meeting_cancelled",
                    created_at: cancelledAt
                });
            });
            const pushDelivery = await sendPush(
                "Meeting Cancelled",
                "A group meeting was cancelled.",
                null,
                name,
                { type: "meeting_cancelled" }
            );
            return { success: true, pushDelivery };
        }
        case "savePushSubscription": {
            const subscription = params.subscription;
            if (!subscription || !subscription.endpoint || !subscription.keys) throw new Error("Valid push subscription is required.");
            const id = crypto.createHash("sha256").update(subscription.endpoint).digest("hex");
            await recordRef("subscriptions", id).set({
                email: user.email, endpoint: subscription.endpoint,
                auth: subscription.keys.auth || "", p256dh: subscription.keys.p256dh || "",
                subscription, timestamp: nowIso()
            }, { merge: true });
            pushSubscriptionsCache = null;
            return { success: true };
        }
        case "sendPushNotification": {
            await requireAdmin(user);
            const title = String(params.title || "NBFA GROUP").trim();
            const body = String(params.body || "").trim();
            if (!body) throw new Error("Write an announcement before sending it.");
            const inboxMessageRef = db.collection("groupMessages").doc();
            const createdAt = nowIso();
            await inboxMessageRef.create({
                id: inboxMessageRef.id,
                message: `${title}\n${body}`,
                member: name,
                email: user.email,
                type: "announcement",
                created_at: createdAt
            });
            const pushDelivery = await sendPush(
                title,
                body,
                params.recipient || null,
                params.sender || name,
                { type: "announcement" }
            );
            return { success: true, pushDelivery };
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
            const requestedAt = nowIso();
            const inboxMessageRef = db.collection("groupMessages").doc();
            const batch = db.batch();
            batch.create(recordRef("pendingEdits", id), {
                id, member, type, originalAmount: Number(amountValue), newAmount,
                originalMessage: matches[0].message || "", newMessage: String(params.newMessage || ""),
                transactionId: matches[0].id, requestedBy: name, requestedAt
            });
            batch.create(recordRef("pendingTransactions", id), {
                id, editId: id, date, member, type, amount: newAmount,
                message: String(params.newMessage || ""), submittedBy: name, submittedAt: requestedAt
            });
            batch.create(inboxMessageRef, {
                id: inboxMessageRef.id,
                message: `${name} requested an update to their ${type} transaction, changing it from KES ${Number(amountValue).toLocaleString()} to KES ${newAmount.toLocaleString()}.`,
                member: name,
                email: user.email,
                type: "transaction_edit_request",
                created_at: requestedAt
            });
            await batch.commit();
            const pushDelivery = await sendPush(
                `Transaction Update Requested by ${name}`,
                `${name} requested an update to a ${type} transaction from KES ${Number(amountValue).toLocaleString()} to KES ${newAmount.toLocaleString()}.`,
                null,
                actorEmail,
                { type: "transaction_edit_request" }
            );
            return { success: true, id, pushDelivery };
        }
        case "rejectTransactionEdit": {
            await requireTransactionApprover(user);
            const ref = recordRef("pendingEdits", params.editId);
            const snapshot = await ref.get();
            if (!snapshot.exists) throw new Error("Pending edit not found.");
            const batch = db.batch();
            batch.delete(ref);
            batch.delete(recordRef("pendingTransactions", params.editId));
            const edit = snapshot.data();
            const inboxMessageRef = db.collection("groupMessages").doc();
            const declinedAt = nowIso();
            batch.create(inboxMessageRef, {
                id: inboxMessageRef.id,
                message: `${name} declined ${edit.member}'s requested update to their ${edit.type} transaction.`,
                member: name,
                email: user.email,
                type: "transaction_edit_rejected",
                created_at: declinedAt
            });
            await batch.commit();
            await audit(name, "Rejected transaction edit", String(params.editId));
            const pushDelivery = await sendPush(
                "Transaction Update Declined",
                `${name} declined ${edit.member}'s requested update to their ${edit.type} transaction.`,
                null,
                actorEmail,
                { type: "transaction_edit_rejected" }
            );
            return { success: true, pushDelivery };
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
    const pushDelivery = alreadySubmitted
        ? { attempted: 0, sent: 0, failed: 0, expired: 0 }
        : combinePushDeliveries(await notifyAdministratorsOfRegistration(name, email));
    return {
        success: true,
        status: "pending",
        alreadySubmitted,
        pushDelivery,
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
        const rawMessage = error && error.message ? error.message : "Unexpected Firebase API error";
        const quotaExceeded = error && (error.code === 8 || error.code === "8" || error.code === "RESOURCE_EXHAUSTED")
            || /RESOURCE_EXHAUSTED|quota exceeded/i.test(rawMessage);
        const backendFailure = quotaExceeded
            || rawMessage.startsWith("Firebase Admin")
            || (error && (typeof error.code === "number"
                || /^(firestore\/|grpc\/|UNAVAILABLE$|DEADLINE_EXCEEDED$|INTERNAL$)/i.test(String(error.code))));
        const message = backendFailure
            ? "This information is temporarily unavailable. Please try again later."
            : rawMessage;
        const unauthenticated = message.includes("Authentication") || message.includes("verified Google");
        if (!unauthenticated) console.error("Firebase API request failed:", error);
        return sendJson(res, backendFailure ? 503 : unauthenticated ? 401 : 200, { success: false, error: message });
    }
}

module.exports = { handleApiRequest };
