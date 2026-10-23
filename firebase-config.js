// Firebase web configuration. The API key identifies the web app; it is not a
// service-account credential. Restrict it to the app's authorized domains.
window.firebaseConfig = {
    apiKey: "AIzaSyAIyPCsF7eV6x5BC11rW0HrUqU2VWTGMA0",
    authDomain: "legacy-builders-group.firebaseapp.com",
    projectId: "legacy-builders-group",
    storageBucket: "legacy-builders-group.firebasestorage.app",
    messagingSenderId: "394999400788",
    appId: "1:394999400788:web:3ad6a5e8a1f69d837ba0c1",
    measurementId: "G-XWVK9P2F6K"
};

window.FIREBASE_API_URL = "/api";
window.cloudinaryConfig = {
    cloudName: "qopne8fk",
    uploadPreset: "legacybuilders_unsigned"
};

if (!window.firebase) {
    window.firebaseInitializationError = new Error("Firebase SDK did not load. Check your internet connection and try again.");
} else {
    firebase.initializeApp(window.firebaseConfig);
    window.firebaseAuth = firebase.auth();
    window.firebaseGoogleProvider = new firebase.auth.GoogleAuthProvider();
}
