import { getApp, getApps, initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";

// Firebase web configuration. These values identify the public client app;
// access to user data is protected by Firebase Authentication and security rules.
const firebaseConfig = {
  apiKey: "AIzaSyAGE6dfKGsqcqPlRYIyEBjtglq3HGi_znU",
  authDomain: "rtm-intelligence.firebaseapp.com",
  projectId: "rtm-intelligence",
  storageBucket: "rtm-intelligence.firebasestorage.app",
  messagingSenderId: "1049645750476",
  appId: "1:1049645750476:web:5e21591dfc569fee340a69",
  measurementId: "G-RX3WLBNHCF",
};

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);
