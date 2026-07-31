// Firebase project config — public web config, safe to expose client-side.
// (Access is controlled by Firestore/Storage security rules, not by hiding this.)
export const firebaseConfig = {
  apiKey: "AIzaSyBOxeVoQ-HDhIQ4RYUEjPOo8_htsywfLbA",
  authDomain: "interview-3f9f3.firebaseapp.com",
  projectId: "interview-3f9f3",
  storageBucket: "interview-3f9f3.firebasestorage.app",
  messagingSenderId: "652127634966",
  appId: "1:652127634966:web:f3f88a9f46544c6c965737",
};

// One-time setup key used only to bootstrap the FIRST admin account
// (see #admin-setup route). Change this before deploying if you want.
export const ADMIN_SETUP_KEY = "sonbola-admin-2026";
