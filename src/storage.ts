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
};

/**
 * Proactively verifies and synchronizes all persisted keys from native disk backup
 * ensuring that clearing cache or exiting app never wipes user favorites, history or downloads.
 */
export function initStorageBackupSync(): void {
  if (typeof window === "undefined") return;
  try {
    const bridge = (window as any).AuraNativeExport;
    if (typeof bridge?.loadAppState === "function") {
      const raw = bridge.loadAppState();
      if (!raw) return;
      const stateObj = JSON.parse(raw);
      if (!stateObj || typeof stateObj !== "object") return;
      for (const [k, v] of Object.entries(stateObj)) {
        if (!v) continue;
        const strVal = typeof v === "string" ? v : JSON.stringify(v);
        try {
          if (localStorage.getItem(k) === null) {
            localStorage.setItem(k, strVal);
          }
        } catch { /* ignore */ }
      }
    }
  } catch {
    // ignore
  }
}

// Automatically invoke on module load so early readers have disk backup data restored
if (typeof window !== "undefined") {
  initStorageBackupSync();
  window.addEventListener("focus", initStorageBackupSync);
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
    if (typeof window !== "undefined") {
      const bridge = (window as any).AuraNativeExport;
      if (typeof bridge?.loadAppState === "function") {
        const raw = bridge.loadAppState();
        if (raw) {
          try {
            const stateObj = JSON.parse(raw);
            if (stateObj && stateObj[key] !== undefined) {
              const val = typeof stateObj[key] === "string" ? stateObj[key] : JSON.stringify(stateObj[key]);
              try {
                localStorage.setItem(key, val);
              } catch { /* ignore */ }
              return val;
            }
          } catch { /* ignore */ }
        }
      }
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
    if (typeof window !== "undefined") {
      const bridge = (window as any).AuraNativeExport;
      if (typeof bridge?.saveAppState === "function") {
        let stateObj: Record<string, string> = {};
        try {
          const raw = bridge.loadAppState();
          if (raw) stateObj = JSON.parse(raw);
        } catch { /* ignore */ }
        stateObj[key] = value;
        bridge.saveAppState(JSON.stringify(stateObj));
      }
    }
  } catch { /* ignore */ }
}
