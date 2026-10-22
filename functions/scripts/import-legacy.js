const admin = require("firebase-admin");
const ExcelJS = require("exceljs");
const crypto = require("node:crypto");
const path = require("node:path");

const args = process.argv.slice(2);
const sources = [];
let commit = false;
for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--source" && args[index + 1]) sources.push(path.resolve(args[++index]));
    else if (args[index] === "--commit") commit = true;
    else if (args[index] === "--dry-run") commit = false;
    else throw new Error(`Unknown or incomplete argument: ${args[index]}`);
}

if (!sources.length) {
    throw new Error('Pass one or more exports with --source "C:\\path\\to\\export.xlsx".');
}

admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "legacy-builders-group" });
const db = admin.firestore();
const DEVELOPER_EMAILS = new Set(["info.onchari@gmail.com"]);
const byCollection = new Map();
let treasurerName = "Mrs. Kithinji";

function clean(value) {
    if (value instanceof Date && !Number.isNaN(value.valueOf())) return value.toISOString().slice(0, 10);
    if (value === undefined || value === null) return "";
    return value;
}

function normalize(row) {
    const result = {};
    for (const [key, value] of Object.entries(row)) result[String(key).trim()] = clean(value);
    return result;
}

function docId(...parts) {
    return parts.map((part) => encodeURIComponent(String(part || "").trim())).join("_").replace(/\./g, "%2E");
}

function deterministicId(data) {
    return crypto.createHash("sha256").update(JSON.stringify(data)).digest("hex").slice(0, 40);
}

function add(collection, id, data) {
    if (!data || Object.values(data).every((value) => value === "" || value === null)) return;
    if (!byCollection.has(collection)) byCollection.set(collection, new Map());
    const key = id || deterministicId(data);
    const existing = byCollection.get(collection).get(key);
    if (!existing) {
        byCollection.get(collection).set(key, data);
        return;
    }
    const nonEmpty = Object.fromEntries(Object.entries(data).filter(([, value]) => value !== "" && value !== null));
    byCollection.get(collection).set(key, { ...existing, ...nonEmpty });
}

async function importWorkbook(filename) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filename);
    for (const worksheet of workbook.worksheets) {
        const sheetName = worksheet.name;
        const headerRow = worksheet.getRow(1);
        const headers = headerRow.values.slice(1).map((value) => String(value || "").trim());
        const occurrences = new Map();
        for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber += 1) {
            const sourceRow = worksheet.getRow(rowNumber);
            const values = headers.map((_, index) => {
                const cellValue = sourceRow.getCell(index + 1).value;
                if (cellValue && typeof cellValue === "object") {
                    if (cellValue.result !== undefined) return cellValue.result;
                    if (cellValue.text !== undefined) return cellValue.text;
                    if (Array.isArray(cellValue.richText)) return cellValue.richText.map((part) => part.text).join("");
                }
                return cellValue;
            });
            if (!values.some((value) => value !== undefined && value !== null && value !== "")) continue;
            const row = normalize(Object.fromEntries(headers.map((header, index) => [header, values[index]])));
            const occurrenceKey = JSON.stringify([sheetName, row]);
            const occurrence = occurrences.get(occurrenceKey) || 0;
            occurrences.set(occurrenceKey, occurrence + 1);
            const rowId = deterministicId({ sheetName, row, occurrence });
            switch (sheetName) {
                case "Transactions":
                    add("transactions", rowId, {
                        date: row.Date, member: row["Member Name"], type: row["Transaction Type"],
                        amount: Number(row["Amount (KES)"]) || 0, message: row["Transaction Message"] || "",
                        balanceAfter: Number(row["Balance After"]) || 0, status: row.Status || "",
                        approvedBy: row["Approved By"] || "", rejectionReason: row["Rejection Reason"] || "",
                        submittedBy: row["Submitted By"] || "", approvalDate: row["Approval Date"] || ""
                    });
                    break;
                case "Users": {
                    const email = String(row.email || "").trim().toLowerCase();
                    if (!email) break;
                    const treasurer = String(row.name || "").trim() === treasurerName;
                    const status = row.status ? String(row.status).trim().toLowerCase() : "";
                    const role = row.role
                        ? String(row.role).trim().toLowerCase()
                        : (DEVELOPER_EMAILS.has(email) ? "developer" : (treasurer ? "admin" : ""));
                    add("users", docId(email), {
                        email, name: row.name || "", role, status,
                        created_at: row.created_at || "",
                        approved_by: row.approved_by || "",
                        approved_at: row.approved_at || ""
                    });
                    break;
                }
                case "PendingLoans": {
                    const id = row.ID || deterministicId(row);
                    add("pendingLoans", docId(id), {
                        id, date: row.Date || "", member: row.Member || "",
                        amount: Number(row.Amount) || 0, message: row.Description || "",
                        notes: row.Notes || "",
                        approvals: String(row.Approvals || "").split(",").map((value) => value.trim()).filter(Boolean),
                        status: "pending"
                    });
                    break;
                }
                case "PendingTransactions": {
                    const id = row.ID || deterministicId(row);
                    add("pendingTransactions", docId(id), {
                        id, date: row.Date || "", member: row.Member || "", type: row.Type || "",
                        amount: Number(row.Amount) || 0, message: row.Message || "",
                        submittedBy: row.SubmittedBy || row.Member || "",
                        submittedAt: row.SubmittedAt || "", loanId: row.LoanID || ""
                    });
                    break;
                }
                case "ActiveLoans": {
                    const id = row.LoanID || deterministicId(row);
                    add("activeLoans", docId(id), {
                        loanId: id, member: row.Member || "", principal: Number(row.Principal) || 0,
                        interest: Number(row.Interest) || 0, totalDue: Number(row.TotalDue) || 0,
                        amountRepaid: Number(row.AmountRepaid) || 0, dueDate: row.DueDate || "",
                        dateTaken: row.DateTaken || "", status: row.Status || "active"
                    });
                    break;
                }
                case "LoansAwaitingDueDate": {
                    const id = row.ID || deterministicId(row);
                    add("loansAwaitingDueDate", docId(id), {
                        id, date: row.Date || "", member: row.Member || "",
                        principal: Number(row.Principal) || 0, message: row.Description || "",
                        approvedBy: row.ApprovedBy || ""
                    });
                    break;
                }
                case "MeetingMinutes": {
                    const id = row.ID || deterministicId(row);
                    add("meetingMinutes", docId(id), {
                        id, date: row.Date || "", recordedBy: row.RecordedBy || "",
                        agenda: row.Agenda || "", notes: row.Notes || "",
                        decisions: row.Decisions || "", nextMeeting: row.NextMeeting || ""
                    });
                    break;
                }
                case "ScheduledMeeting":
                    if (row.Date) add("scheduledMeeting", "current", {
                        date: row.Date, agenda: row.Agenda || "", venue: row.Venue || "",
                        scheduledBy: row.ScheduledBy || ""
                    });
                    break;
                case "AuditLog":
                    add("auditLog", rowId, {
                        timestamp: row.Timestamp || "", actor: row.Actor || "Unknown",
                        action: row.Action || "", details: row.Details || ""
                    });
                    break;
                case "Settings": {
                    const key = String(row.Key || "").trim().toLowerCase();
                    if (key) {
                        if (key === "treasurer" && row.Value) treasurerName = String(row.Value).trim();
                        add("settings", docId(key), { key, value: row.Value || "" });
                    }
                    break;
                }
                case "ProfileImages": {
                    const email = String(row.email || "").trim().toLowerCase();
                    if (email && row.image) add("profileImages", docId(email), {
                        email, name: row.name || "", image: row.image, updated_at: row.updated_at || ""
                    });
                    break;
                }
                case "Subscriptions": {
                    const email = String(row.Email || "").trim().toLowerCase();
                    if (!email || !row.Endpoint) break;
                    const subscription = {
                        endpoint: row.Endpoint,
                        keys: { auth: row.Auth || "", p256dh: row.P256DH || "" }
                    };
                    const subscriptionId = crypto.createHash("sha256").update(subscription.endpoint).digest("hex");
                    add("subscriptions", subscriptionId, {
                        email, endpoint: row.Endpoint, auth: row.Auth || "",
                        p256dh: row.P256DH || "", subscription, timestamp: row.Timestamp || ""
                    });
                    break;
                }
                default:
                    break;
            }
        }
    }
}

async function main() {
    for (const source of sources) await importWorkbook(source);
    const importedUsers = byCollection.get("users");
    if (importedUsers) {
        for (const [id, user] of importedUsers.entries()) {
            importedUsers.set(id, {
                ...user,
                role: user.role || (DEVELOPER_EMAILS.has(user.email) ? "developer" : "member"),
                status: user.status || "approved"
            });
        }
    }
    const counts = {};
    for (const [collection, documents] of byCollection.entries()) counts[collection] = documents.size;
    console.log(`${commit ? "Import mode" : "Dry run — no Firebase records changed"}`);
    console.log(JSON.stringify(counts, null, 2));
    if (!commit) {
        console.log('Review the counts, then rerun with --commit to add missing records. Existing documents are never overwritten or deleted.');
        return;
    }

    let created = 0;
    let skipped = 0;
    for (const [collection, documents] of byCollection.entries()) {
        for (const [id, data] of documents.entries()) {
            const ref = db.collection(collection).doc(id);
            try {
                await ref.create(data);
                created += 1;
            } catch (error) {
                if (error.code === 6 || error.code === "already-exists") {
                    skipped += 1;
                    continue;
                }
                throw error;
            }
        }
    }
    console.log(`Import complete: ${created} added, ${skipped} already present and preserved.`);
    console.log("Legacy password fields were not imported.");
}

main().catch((error) => {
    console.error("Legacy import failed:", error.message);
    process.exitCode = 1;
});
