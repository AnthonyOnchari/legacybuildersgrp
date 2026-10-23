# Legacy Builders Group

The app uses Firebase Authentication (Google sign-in), Cloud Firestore, and a Vercel serverless API backed by the Firebase Admin SDK. The old Apps Script proxy is removed; the Google Sheet and the supplied Excel workbook are not modified by the app or importer.

## Deployment setup

1. In Firebase project `legacy-builders-group`, confirm Google is enabled under Authentication → Sign-in method.
2. Add the deployed website hostname under Authentication → Settings → Authorized domains.
3. Create a Cloud Firestore database in Native mode.
4. In Google Cloud IAM, create a service account for the app and grant it the **Cloud Datastore User** role for Firestore access. Create a JSON key and store it securely; never commit or share the key. Firebase Authentication ID tokens are verified against Google's signing certificates.
5. In Vercel Project Settings → Environment Variables, add `FIREBASE_SERVICE_ACCOUNT` with the full service-account JSON as its value for Production and Preview. Redeploy after adding it. The Vercel `/api` endpoint uses this credential to verify Firebase ID tokens and access Firestore.
6. Deploy Firestore rules with `firebase deploy --only firestore:rules --project legacy-builders-group`. Import and verify legacy data **before allowing members to sign in** so existing Gmail accounts receive migrated roles and approvals instead of starting as pending registrations.

The web app config is in `firebase-config.js`. Its API key identifies the public web app; restrict it to the website's authorized referrers in Google Cloud. Never put service-account credentials in frontend files or commit them to this repository.

The Vercel API allows `https://legacybuildersgroup.vercel.app` and localhost on port 3000 by default. Set the non-secret `ALLOWED_ORIGINS` environment variable in Vercel if the site uses another origin.

## Cloudinary photos and group inbox

Profile photos and shared group memories use direct unsigned Cloudinary uploads. Configure an unsigned upload preset named `legacybuilders_unsigned` in the `qopne8fk` Cloudinary account. Allow JPG, PNG, and WebP uploads, set the preset's maximum file size to 5 MB, and verify it honors the upload `folder` parameter. The app expects uploads under `legacy-builders/profiles/` and `legacy-builders/memories/`; it also checks the image size in the browser. The cloud name and preset name are public frontend settings in `firebase-config.js`; do not add a Cloudinary API secret there. `CLOUDINARY_CLOUD_NAME` is an optional Vercel environment variable if the backend should validate a different cloud name.

Approved members can post memories and use the group inbox. Join requests contain only a name and email address and are visible to approved members; administrators can approve or reject them from Pending. Never request or send passwords in group messages.

If a Cloudinary API secret was shared in a screenshot or message, rotate it in the Cloudinary dashboard. This integration does not need that secret.

## Non-destructive legacy data import

The importer supports Excel exports with the existing tab names. Run it from the repository root after authenticating Firebase Admin SDK access for the target project:

```powershell
npm --prefix functions install
npm --prefix functions run import -- --source "C:\path\to\Legacy Builders Group - Data.xlsx"
```

The command is a **dry run** and prints collection counts only. To add missing records, rerun with `--commit`. To merge multiple exports, pass `--source` once for each file. It only creates documents; it does not update or delete existing Firestore documents, and existing documents are preserved. Keep the original workbook and Sheet as backups until Firebase data is verified.

The balances shown by the app are calculated from the imported `Transactions` and `ActiveLoans` records. A newly created Firestore database starts empty, so import and verify the legacy workbook before members rely on the displayed balances.

For `--commit`, authenticate the local Firebase Admin SDK with Google Application Default Credentials (for example, `gcloud auth application-default login`) or set `GOOGLE_APPLICATION_CREDENTIALS` to a service-account file stored outside this repository. Do not upload or commit that file.

Legacy `Users` rows are matched by Gmail address. Password columns are deliberately excluded; users sign in with Google using the same email. Existing users without a status are imported as approved, and the configured developer email retains developer role. A new account not included in the import becomes a pending registration at first Google sign-in.

The Vercel API derives identity and roles from verified Firebase ID tokens and Firestore profiles. Browser clients are denied direct Firestore reads and writes by `firestore.rules`.
