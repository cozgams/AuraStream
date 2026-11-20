/**
 * Firebase Client Integration for AuraStream
 * Provides Firebase Authentication, Cloud Firestore sync, and Remote Config.
 * Gracefully operates in 100% offline/local mode if Firebase is not connected or offline.
 */
import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import {
  getAuth,
  signInWithPopup,
  GoogleAuthProvider,
  signInAnonymously,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  updateProfile,
  signOut,
  onAuthStateChanged,
  type Auth,
  type User as FirebaseUser,
} from "firebase/auth";
import {
  getFirestore,
  doc,
  setDoc,
  getDoc,
  type Firestore,
} from "firebase/firestore";

export interface FirebaseConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket?: string;
  messagingSenderId?: string;
  appId: string;
}

export interface CloudUserData {
  favorites?: number[];
  watchLater?: number[];
  history?: Array<{
    id: number;
    ep: number;
    t: number;
    dur: number;
    updatedAt: number;
    title?: string;
    cover?: string;
  }>;
  updatedAt?: number;
}

const STORAGE_KEY_FIREBASE_CONFIG = "aurastream_firebase_config";

const DEFAULT_FIREBASE_CONFIG: FirebaseConfig = {
  apiKey: "aurastream-local-vault-placeholder",
  authDomain: "aurastream-app.firebaseapp.com",
  projectId: "aurastream-app",
  storageBucket: "aurastream-app.appspot.com",
  messagingSenderId: "389274910283",
  appId: "1:389274910283:web:7f6a5b4c3d2e1f0a",
};

export function getStoredConfig(): FirebaseConfig | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_FIREBASE_CONFIG);
    if (!raw) return DEFAULT_FIREBASE_CONFIG;
    const parsed = JSON.parse(raw);
    if (parsed?.apiKey && parsed?.projectId) return parsed;
  } catch {}
  return DEFAULT_FIREBASE_CONFIG;
}

let app: FirebaseApp | null = null;
let auth: Auth | null = null;
let db: Firestore | null = null;

export function initFirebase(config?: FirebaseConfig | null): {
  app: FirebaseApp | null;
  auth: Auth | null;
  db: Firestore | null;
} {
  if (typeof window !== "undefined" && window.location.pathname.startsWith("/tests/")) {
    return { app: null, auth: null, db: null };
  }
  const activeConfig = config || getStoredConfig();
  if (!activeConfig || !activeConfig.apiKey || !activeConfig.projectId) {
    return { app: null, auth: null, db: null };
  }

  try {
    if (!getApps().length) {
      app = initializeApp(activeConfig);
    } else {
      app = getApps()[0];
    }
    auth = getAuth(app);
    db = getFirestore(app);
    return { app, auth, db };
  } catch (err) {
    console.warn("Firebase initialization skipped or offline:", err);
    return { app: null, auth: null, db: null };
  }
}

export function saveFirebaseConfig(config: FirebaseConfig) {
  try {
    localStorage.setItem(STORAGE_KEY_FIREBASE_CONFIG, JSON.stringify(config));
    return initFirebase(config);
  } catch {}
  return null;
}

export function isFirebaseConfigured(): boolean {
  return !!(auth && db);
}

// -------------------------------------------------------------
// Authentication Helpers (Free Tier)
// -------------------------------------------------------------

const SESSION_ACTIVE_KEY = "aurastream_has_firebase_auth";

export function hasActiveFirebaseSession(): boolean {
  try {
    return localStorage.getItem(SESSION_ACTIVE_KEY) === "true";
  } catch {
    return false;
  }
}

export function setActiveFirebaseSession(active: boolean): void {
  try {
    if (active) {
      localStorage.setItem(SESSION_ACTIVE_KEY, "true");
    } else {
      localStorage.removeItem(SESSION_ACTIVE_KEY);
    }
  } catch {}
}

export async function signInWithGoogle(): Promise<FirebaseUser | null> {
  if (!auth) initFirebase();
  if (!auth) throw new Error("Firebase is not configured yet");
  const provider = new GoogleAuthProvider();
  const res = await signInWithPopup(auth, provider);
  if (res.user) setActiveFirebaseSession(true);
  return res.user;
}

export async function signInAsGuest(): Promise<FirebaseUser | null> {
  if (!auth) initFirebase();
  if (!auth) throw new Error("Firebase is not configured yet");
  const res = await signInAnonymously(auth);
  if (res.user) setActiveFirebaseSession(true);
  return res.user;
}

export async function signInWithEmail(email: string, pass: string): Promise<FirebaseUser | null> {
  if (!auth) initFirebase();
  if (!auth) throw new Error("Firebase Authentication is not initialized");
  const res = await signInWithEmailAndPassword(auth, email.trim(), pass);
  if (res.user) setActiveFirebaseSession(true);
  return res.user;
}

export async function signUpWithEmail(
  email: string,
  pass: string,
  displayName?: string
): Promise<FirebaseUser | null> {
  if (!auth) initFirebase();
  if (!auth) throw new Error("Firebase Authentication is not initialized");
  const res = await createUserWithEmailAndPassword(auth, email.trim(), pass);
  if (displayName && res.user) {
    try {
      await updateProfile(res.user, { displayName: displayName.trim() });
    } catch {
      // ignore non-fatal profile update failure
    }
  }
  if (res.user) setActiveFirebaseSession(true);
  return res.user;
}

export async function sendPasswordReset(email: string): Promise<void> {
  if (!auth) initFirebase();
  if (!auth) throw new Error("Firebase Authentication is not initialized");
  await sendPasswordResetEmail(auth, email.trim());
}

export async function logOutFirebase(): Promise<void> {
  setActiveFirebaseSession(false);
  if (!auth) return;
  await signOut(auth);
}

export function subscribeAuthState(callback: (user: FirebaseUser | null) => void) {
  if (!auth) initFirebase();
  if (!auth) {
    callback(null);
    return () => {};
  }
  return onAuthStateChanged(auth, callback);
}

// -------------------------------------------------------------
// Cloud Firestore Sync (Free Tier: 1GB Storage, 50k reads/day)
// -------------------------------------------------------------

export async function saveUserDataToCloud(userId: string, data: Partial<CloudUserData>): Promise<void> {
  if (!db) initFirebase();
  if (!db) return;
  try {
    const userRef = doc(db, "users", userId);
    await setDoc(userRef, { ...data, updatedAt: Date.now() }, { merge: true });
  } catch (err) {
    console.warn("Failed to sync data to Firestore:", err);
  }
}

export async function loadUserDataFromCloud(userId: string): Promise<CloudUserData | null> {
  if (!db) initFirebase();
  if (!db) return null;
  try {
    const userRef = doc(db, "users", userId);
    const snap = await getDoc(userRef);
    if (snap.exists()) {
      return snap.data() as CloudUserData;
    }
  } catch (err) {
    console.warn("Failed to load user data from Firestore:", err);
  }
  return null;
}

export { auth, db };
