export const STORAGE_KEYS = {
  app: "aurastream_app_v1",
  swipeEp: "aurastream_swipe_ep_v2",
  theme: "aurastream_theme",
  accent: "aurastream_accent",
  autoLine: "aurastream_auto_line",
  lang: "aurastream_language",
  subtitleMode: "aurastream_subtitle_mode",
  subtitleSize: "aurastream_subtitle_size",
  downloads: "aurastream_offline_episodes_v1",
  activeDownloads: "aurastream_active_downloads_v1",
  localUser: "aurastream_local_user_v1",
  firebaseConfig: "aurastream_firebase_config",
  firebaseSession: "aurastream_has_firebase_auth",
  vaultAccounts: "aurastream_accounts_vault_v1",
  vaultActiveUser: "aurastream_active_vault_user_v1",
} as const;

export type StorageKey = typeof STORAGE_KEYS[keyof typeof STORAGE_KEYS];

// Legacy keys for migration from older HGhub / HGhubX installations.
const LEGACY_KEYS: Record<StorageKey, string[]> = {
  aurastream_app_v1: ["hghubx_app_v1", "hghub_app_v1"],
  aurastream_swipe_ep_v2: ["hghubx_swipe_ep_v2", "hghub_swipe_ep_v2"],
  aurastream_theme: ["hghubx_theme", "hghub_theme"],
  aurastream_accent: [],
  aurastream_auto_line: ["hghubx_auto_line", "hg.autoLine"],
  aurastream_language: ["hghubx_language"],
  aurastream_subtitle_mode: [],
  aurastream_subtitle_size: [],
  aurastream_offline_episodes_v1: ["hghubx_offline_episodes_v1", "hghub_offline_episodes_v1"],
  aurastream_active_downloads_v1: ["hghubx_active_downloads_v1"],
  aurastream_local_user_v1: [],
  aurastream_firebase_config: [],
  aurastream_has_firebase_auth: [],
  aurastream_accounts_vault_v1: [],
  aurastream_active_vault_user_v1: [],
};

const NATIVE_SAVE_DEBOUNCE_MS = 800;
let nativeCache: Record<string, string> | null = null;
let nativeDirty = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function getNativeBridge(): { loadAppState?: () => string; saveAppState?: (data: string) => boolean } | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { AuraNativeExport?: { loadAppState?: () => string; saveAppState?: (data: string) => boolean } }).AuraNativeExport ?? null;
}

function ensureNativeCache(): Record<string, string> | null {
  if (nativeCache !== null) return nativeCache;
  const bridge = getNativeBridge();
  if (typeof bridge?.loadAppState !== "function") return null;
  const parsed: Record<string, string> = {};
  try {
    const raw = bridge.loadAppState();
    if (raw) {
      const stateObj = JSON.parse(raw);
      if (stateObj && typeof stateObj === "object") {
        for (const [k, v] of Object.entries(stateObj)) {
          if (v === undefined || v === null) continue;
          parsed[k] = typeof v === "string" ? v : JSON.stringify(v);
        }
      }
    }
  } catch {
    // ignore corrupt native backup
  }
  nativeCache = parsed;
  return nativeCache;
}

export function flushNativeStateSync(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!nativeDirty || !nativeCache) return;
  const bridge = getNativeBridge();
  if (typeof bridge?.saveAppState !== "function") return;
  nativeDirty = false;
  try {
    const ok = bridge.saveAppState(JSON.stringify(nativeCache));
    if (ok === false) {
      nativeDirty = true;
    }
  } catch {
    nativeDirty = true;
  }
}

function scheduleNativeFlush(): void {
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushNativeStateSync();
  }, NATIVE_SAVE_DEBOUNCE_MS);
}

/**
 * Proactively verifies and synchronizes all persisted keys from native disk backup
 * ensuring that clearing cache or exiting app never wipes user favorites, history or downloads.
 */
export function initStorageBackupSync(): void {
  if (typeof window === "undefined") return;
  try {
    const cache = ensureNativeCache();
    if (!cache) return;
    for (const [k, v] of Object.entries(cache)) {
      if (!v) continue;
      try {
        if (localStorage.getItem(k) === null) {
          localStorage.setItem(k, v);
        }
      } catch { /* ignore */ }
    }
  } catch {
    // ignore
  }
}

// Automatically invoke on module load so early readers have disk backup data restored
if (typeof window !== "undefined") {
  initStorageBackupSync();
  window.addEventListener("focus", initStorageBackupSync);
  window.addEventListener("visibilitychange", () => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      flushNativeStateSync();
    }
  });
  window.addEventListener("pagehide", flushNativeStateSync);
  window.addEventListener("beforeunload", flushNativeStateSync);
}

/** Reads with new key priority, smoothly migrating previous version storage and native disk backup. */
export function readStorage(key: StorageKey): string | null {
  try {
    const current = localStorage.getItem(key);
    const legacyList = LEGACY_KEYS[key] || [];
    if (current !== null) {
      // Clean up orphaned legacy keys if new key already exists
      for (const legacyKey of legacyList) {
        if (localStorage.getItem(legacyKey) !== null) {
          try {
            localStorage.removeItem(legacyKey);
          } catch { /* ignore */ }
        }
      }
      return current;
    }
    for (const legacyKey of legacyList) {
      const val = localStorage.getItem(legacyKey);
      if (val !== null) {
        try {
          localStorage.setItem(key, val);
          localStorage.removeItem(legacyKey);
        } catch { /* storage full fallback */ }
        return val;
      }
    }

    // Native internal disk backup fallback if localStorage was cleared
    const cache = ensureNativeCache();
    if (cache && cache[key] !== undefined) {
      const val = cache[key];
      try {
        localStorage.setItem(key, val);
      } catch { /* ignore */ }
      return val;
    }

    return null;
  } catch {
    return null;
  }
}

/** Persistently saves key-value pair to localStorage and Android native disk backup. */
export function writeStorage(key: StorageKey, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch { /* ignore */ }

  try {
    const bridge = getNativeBridge();
    if (typeof bridge?.saveAppState === "function") {
      const cache = ensureNativeCache() ?? (nativeCache = {});
      if (cache[key] !== value) {
        cache[key] = value;
        nativeDirty = true;
        scheduleNativeFlush();
      }
    }
  } catch { /* ignore */ }
}

/** Removes key from localStorage and schedules removal from Android native disk backup. */
export function removeStorage(key: StorageKey): void {
  try {
    localStorage.removeItem(key);
  } catch { /* ignore */ }

  try {
    const bridge = getNativeBridge();
    if (typeof bridge?.saveAppState === "function") {
      const cache = ensureNativeCache();
      if (cache && key in cache) {
        delete cache[key];
        nativeDirty = true;
        scheduleNativeFlush();
      }
    }
  } catch { /* ignore */ }
}
