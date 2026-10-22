# Legacy Builders Group

The app uses Firebase Authentication (Google sign-in), Cloud Firestore, and a Firebase HTTPS function. The old Apps Script proxy is removed; the Google Sheet and the supplied Excel workbook are not modified by the app or importer.

## Firebase setup

1. In Firebase project `legacy-builders-group`, confirm Google is enabled under Authentication → Sign-in method.
2. Add the deployed website hostname under Authentication → Settings → Authorized domains.
3. Create a Cloud Firestore database in Native mode.
4. Install Firebase CLI, sign in with an account authorized for this project, and run `firebase deploy --only firestore:rules,functions`.
5. Firebase Functions deployment may require a billing plan that supports Cloud Functions. Deploy the function, then import and verify the data **before publishing this frontend or allowing members to sign in**. Import first so existing Gmail accounts receive migrated roles and approvals instead of starting as pending registrations.

The web app config is in `firebase-config.js`. Its API key identifies the public web app; restrict it to the website's authorized referrers in Google Cloud. Never put service-account credentials in frontend files or commit them to this repository.

The HTTPS function allows `https://legacybuildersgroup.vercel.app` and localhost on port 3000 by default. Set the non-secret `ALLOWED_ORIGINS` environment variable in the Functions deployment if the site uses another origin.

## Non-destructive legacy data import

The importer supports Excel exports with the existing tab names. Run it from the repository root after authenticating Firebase Admin SDK access for the target project:

```powershell
npm --prefix functions install
npm --prefix functions run import -- --source "C:\path\to\Legacy Builders Group - Data.xlsx"
```

The command is a **dry run** and prints collection counts only. To add missing records, rerun with `--commit`. To merge multiple exports, pass `--source` once for each file. It only creates documents; it does not update or delete existing Firestore documents, and existing documents are preserved. Keep the original workbook and Sheet as backups until Firebase data is verified.

For `--commit`, authenticate the local Firebase Admin SDK with Google Application Default Credentials (for example, `gcloud auth application-default login`) or set `GOOGLE_APPLICATION_CREDENTIALS` to a service-account file stored outside this repository. Do not upload or commit that file.

Legacy `Users` rows are matched by Gmail address. Password columns are deliberately excluded; users sign in with Google using the same email. Existing users without a status are imported as approved, and the configured developer email retains developer role. A new account not included in the import becomes a pending registration at first Google sign-in.

Cloud Functions derive identity and roles from verified Firebase ID tokens and Firestore profiles. Browser clients are denied direct Firestore reads and writes by `firestore.rules`.
