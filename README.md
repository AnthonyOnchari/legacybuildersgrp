# NBFA GROUP

The app uses Firebase Authentication (Google sign-in), Cloud Firestore, and a Vercel serverless API backed by the Firebase Admin SDK. The old Apps Script proxy is removed; the Google Sheet and the supplied Excel workbook are not modified by the app or importer.

## Deployment setup

1. In Firebase project `legacy-builders-group`, confirm Google is enabled under Authentication → Sign-in method.
2. Add the deployed website hostname under Authentication → Settings → Authorized domains.
3. In Google Cloud Console, add the production HTTPS origin (currently `https://legacybuildersgroup.vercel.app`) to the Web OAuth client's **Authorized JavaScript origins**. Add `http://localhost:3000` for local testing. The in-page Google account chooser requires a secure origin and a browser with FedCM support.
4. Create a Cloud Firestore database in Native mode.
5. In Google Cloud IAM, create a service account for the app and grant it the **Cloud Datastore User** role for Firestore access. Create a JSON key and store it securely; never commit or share the key. Firebase Authentication ID tokens are verified against Google's signing certificates.
6. In Vercel Project Settings → Environment Variables, add `FIREBASE_SERVICE_ACCOUNT` with the full service-account JSON as its value for Production and Preview. Redeploy after adding it. The Vercel `/api` endpoint uses this credential to verify Firebase ID tokens and access Firestore.
7. Deploy Firestore rules with `firebase deploy --only firestore:rules --project legacy-builders-group`. Import and verify legacy data **before allowing members to sign in** so existing Gmail accounts receive migrated roles and approvals instead of starting as pending registrations.
8. In Cloudinary Settings → Upload Presets, configure the unsigned preset named in `firebase-config.js` to allow raw file uploads. Allow the company's supported PDF, Office, text, CSV, JPEG, and PNG formats and a maximum upload size of 20 MB. Payment receipts are limited in the app to 5 MB.

The web app config is in `firebase-config.js`. Its API key identifies the public web app; restrict it to the website's authorized referrers in Google Cloud. Never put service-account credentials in frontend files or commit them to this repository.

The Vercel API allows `https://legacybuildersgroup.vercel.app` and localhost on port 3000 by default. Set the non-secret `ALLOWED_ORIGINS` environment variable in Vercel if the site uses another origin.

## Company files

Only the developer can add or remove PDF, Office, text, CSV, JPEG, and PNG company files up to 20 MB from Connect → Company files. The upload controls appear in the shared-documents view after email verification. Approved members request a six-digit access code at their registered email; each code expires after 10 minutes. Configure `RESEND_API_KEY` and `RESEND_FROM_EMAIL` in Vercel, using a sender address verified with Resend, before enabling email codes. Never put the Resend API key in frontend configuration or commit it to the repository. Cloudinary links are public and do not expire. Removing a file from the app does not delete the asset from Cloudinary; delete it separately from the Cloudinary Media Library.

Company files upload directly to Cloudinary as raw assets through the unsigned preset. Access-code checks control whether the app displays links, but anyone with a file URL can open it.

## Local dashboard preview

Open `http://localhost:3000/?preview=1` on a local static server to view the dashboard without signing in. This preview is enabled only on `localhost` or `127.0.0.1`, uses fictional sample data, and disables API calls; it does not read or modify Firebase data.

## Cloudinary photos and group inbox

Profile photos, shared group memories, company files, and payment receipts use direct unsigned Cloudinary uploads. Configure the unsigned preset in the `qopne8fk` account to allow JPG, PNG, WebP, PDF, Office, text, and CSV uploads, up to 20 MB. The app expects image uploads under `legacy-builders/profiles/` and `legacy-builders/memories/`, and file uploads under `legacy-builders/company-files/` or `legacy-builders/payment-evidence/`. The cloud name and preset name are public frontend settings in `firebase-config.js`.

Approved members can post memories and use the group inbox. Group messages are retained until an administrator, treasurer, or developer deletes them; older messages are loaded in bounded pages. Join requests contain only a name and email address and are visible to administrators and the treasurer, who can approve or reject them from the operations portal. Only developers can assign member positions (Chairman, Vice-Chairman, Treasurer, Secretary, or Member); Treasurer position holders receive the same operational permissions as administrators. Never request or send passwords in group messages.

Payment receipts are optional PDF, JPEG, or PNG files up to 5 MB. They are attached to the transaction after upload. Only the submitting member and authorized approvers can request the link through the app, but the Cloudinary URL itself is public and does not expire. Receipts are not included in the developer system backup.

The developer sets each approved member's optional Mr. or Mrs. greeting salutation in Developer → User management. The dashboard greeting uses that salutation and the member's assigned position (for example, “Good morning, Mrs. Secretary”); without a salutation, it shows the position alone.


## Non-destructive legacy data import

The importer supports Excel exports with the existing tab names. Run it from the repository root after authenticating Firebase Admin SDK access for the target project:

```powershell
npm --prefix functions install
npm --prefix functions run import -- --source "C:\path\to\NBFA GROUP - Data.xlsx"
```

The command is a **dry run** and prints collection counts only. To add missing records, rerun with `--commit`. To merge multiple exports, pass `--source` once for each file. It only creates documents; it does not update or delete existing Firestore documents, and existing documents are preserved. Keep the original workbook and Sheet as backups until Firebase data is verified.

The balances shown by the app are calculated from the imported `Transactions` and `ActiveLoans` records. A newly created Firestore database starts empty, so import and verify the legacy workbook before members rely on the displayed balances.

For `--commit`, authenticate the local Firebase Admin SDK with Google Application Default Credentials (for example, `gcloud auth application-default login`) or set `GOOGLE_APPLICATION_CREDENTIALS` to a service-account file stored outside this repository. Do not upload or commit that file.

Legacy `Users` rows are matched by Gmail address. Password columns are deliberately excluded; users sign in with Google using the same email. Existing users without a status are imported as approved, and the configured developer email retains developer role. A new account not included in the import becomes a pending registration at first Google sign-in.

The Vercel API derives identity and roles from verified Firebase ID tokens and Firestore profiles. Browser clients are denied direct Firestore reads and writes by `firestore.rules`.

## Firestore read usage

Summary-only requests use Firestore aggregate queries instead of downloading every transaction to calculate totals. The main dashboard still loads transaction records because its history and member-stat views use them. Pending-registration views query only pending records, and background group-message polling runs only while the chat is open. The app uses one-time API reads rather than Firestore snapshot listeners. Quota errors are recorded in server logs and shown to users as a generic temporary-unavailability message. If the quota is exhausted, the administrator must check Firebase/Google Cloud billing and usage; code changes cannot bypass or immediately restore an exhausted project quota.
