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

export function getStoredConfig(): FirebaseConfig | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_FIREBASE_CONFIG);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.apiKey && parsed?.projectId) return parsed;
  } catch {}
  return null;
}

let app: FirebaseApp | null = null;
let auth: Auth | null = null;
let db: Firestore | null = null;

export function initFirebase(config?: FirebaseConfig | null): {
  app: FirebaseApp | null;
  auth: Auth | null;
  db: Firestore | null;
} {
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

export async function signInWithGoogle(): Promise<FirebaseUser | null> {
  if (!auth) initFirebase();
  if (!auth) throw new Error("Firebase is not configured yet");
  const provider = new GoogleAuthProvider();
  const res = await signInWithPopup(auth, provider);
  return res.user;
}

export async function signInAsGuest(): Promise<FirebaseUser | null> {
  if (!auth) initFirebase();
  if (!auth) throw new Error("Firebase is not configured yet");
  const res = await signInAnonymously(auth);
  return res.user;
}

export async function logOutFirebase(): Promise<void> {
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
