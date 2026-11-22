/**
 * AuraStream Offline Download Manager
 * Uses IndexedDB to store video blobs and subtitle tracks for zero-data offline playback on Android.
 * Features: live speed (MB/s), ETA calculation, cancel/pause controls, Smart Downloads (auto-download next ep),
 * Phone Storage visualizer, "Download on Wi-Fi Only" cellular guard, and 1-Click Series Batch Downloader.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { api, cover as getRemoteCoverUrl, isLocalMedia, LOCAL, logLine } from "../api";
import { readStorage, writeStorage, STORAGE_KEYS } from "../storage";
import { getSubtitlesForEpisode } from "../subtitles/aiSubtitleService";
import type { SubtitleCue } from "../subtitles/types";
import type { PlayInfo } from "../types";
import type { NativeExportBridge } from "./exportService";

export type DownloadQuality = "auto" | "hevc" | "standard";

export interface OfflineEpisode {
  id: string; // `${videoId}_${episode}`
  videoId: number;
  episode: number;
  title: string;
  cover: string;
  sizeBytes: number;
  duration?: number;
  downloadedAt: number;
  cues?: SubtitleCue[];
  quality?: DownloadQuality;
  isHevc?: boolean;
  isHls?: boolean;
  hasLocalCover?: boolean;
  storage?: "native" | "idb";
}

export interface ActiveDownloadProgress {
  id: string; // `${videoId}_${episode}`
  videoId: number;
  episode: number;
  title: string;
  cover?: string;
  progress: number; // 0 to 100
  downloadedBytes: number;
  totalBytes: number;
  speedBytesPerSec: number;
  speedFormatted: string; // e.g. "2.4 MB/s"
  etaSeconds: number;
  etaFormatted: string; // e.g. "14s"
  status: "queued" | "downloading" | "paused" | "completed" | "error";
  error?: string;
  streamUrl?: string;
  quality?: DownloadQuality;
  isHevc?: boolean;
  autoResume?: boolean;
}

const DB_NAME = "AuraStreamOfflineDB";
const LEGACY_DB_NAME = "aurastream_offline_db";
const DB_VERSION = 1;
const STORE_NAME = "episodes";
const SMART_DOWNLOAD_KEY = "aurastream_smart_download_v1";
const AUTO_DELETE_KEY = "aurastream_auto_delete_watched_v1";
const WIFI_ONLY_KEY = "aurastream_wifi_only_download_v1";
const CELLULAR_SAVER_KEY = "aurastream_cellular_data_saver_v1";
const DOWNLOAD_QUALITY_KEY = "aurastream_download_quality_preference_v1";

// Request persistent storage on mobile WebView so Android never wipes IndexedDB/localStorage
if (typeof navigator !== "undefined" && navigator.storage && typeof navigator.storage.persist === "function") {
  navigator.storage.persist().catch(() => {});
}

const activeProgress = new Map<string, ActiveDownloadProgress>();
const activeAbortControllers = new Map<string, AbortController>();
const activeDownloadPromises = new Map<string, Promise<void>>();
const activeRunTokens = new Map<string, number>();
let runTokenSeq = 0;

const progressListeners = new Set<(progress: Map<string, ActiveDownloadProgress>) => void>();
const triggeringSmartDownloads = new Set<string>();

let lastPersistTime = 0;
let lastNativeActiveState: boolean | null = null;

// Forward-declared batch token/state references used by syncNativeDownloadCount
let batchTokenSeq = 0;
let activeBatchToken = 0;

export interface BatchProgressState {
  active: boolean;
  videoId: number;
  title: string;
  total: number;
  completed: number;
  currentEpisode: number;
  failedCount: number;
  episodeIds?: string[];
}

let batchState: BatchProgressState = {
  active: false,
  videoId: 0,
  title: "",
  total: 0,
  completed: 0,
  currentEpisode: 0,
  failedCount: 0,
};

function getNativeBridge(): NativeExportBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return window.AuraNativeExport;
}

export function isNativeRustDownloaderAvailable(): boolean {
  if (typeof window === "undefined") return false;
  if (window.location?.pathname?.startsWith("/tests/")) return false;
  if ((window as unknown as { mobileLayoutFixture?: unknown }).mobileLayoutFixture) return false;
  const hasTauri = Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
  if (!hasTauri) return false;
  const isDev = Boolean((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV);
  return Boolean(getNativeBridge()?.isAvailable?.()) || !isDev;
}

export function getOfflineCoverUrl(
  ep: Pick<OfflineEpisode, "id" | "cover" | "storage" | "hasLocalCover"> | null | undefined,
  width = 200
): string {
  if (!ep) return "";
  if (ep.storage === "native" && ep.hasLocalCover) {
    return `${LOCAL}/offline/${ep.id}/cover.img`;
  }
  const raw = (ep.cover || "").trim();
  if (!raw) return "";
  if (raw.startsWith("blob:") || raw.startsWith("data:") || isLocalMedia(raw)) {
    return raw;
  }
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return "";
  }
  return getRemoteCoverUrl(raw, width);
}

let nativeListenerStarted = false;
let nativeSyncPromise: Promise<void> | null = null;
const initialReadyPromise: { p: Promise<void> | null } = { p: null };

function normalizeOfflineEpisodeList(rawList: unknown): OfflineEpisode[] {
  if (!Array.isArray(rawList)) return [];
  const seen = new Set<string>();
  const out: OfflineEpisode[] = [];
  for (const raw of rawList) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as OfflineEpisode;
    if (!item.id || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push({
      ...item,
      storage: item.storage || "idb",
    });
  }
  return out;
}

function applyNativeDownloadSnapshot(payload: { queue?: unknown[]; completed?: unknown[] } | null | undefined): void {
  if (!payload) return;

  if (Array.isArray(payload.queue)) {
    activeProgress.clear();
    for (const raw of payload.queue) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as ActiveDownloadProgress;
      if (!item.id) continue;
      activeProgress.set(item.id, {
        id: item.id,
        videoId: Number(item.videoId),
        episode: Number(item.episode),
        title: item.title || `Episode ${item.episode}`,
        cover: item.cover || "",
        progress: Number(item.progress) || 0,
        downloadedBytes: Number(item.downloadedBytes) || 0,
        totalBytes: Number(item.totalBytes) || 0,
        speedBytesPerSec: Number(item.speedBytesPerSec) || 0,
        speedFormatted: item.speedFormatted || (item.status === "queued" ? "Queued" : "-- KB/s"),
        etaSeconds: Number(item.etaSeconds) || 0,
        etaFormatted: item.etaFormatted || "--",
        status: item.status || "queued",
        error: item.error,
        quality: item.quality,
        isHevc: item.isHevc,
        autoResume: item.autoResume,
      });
    }
  }

  if (Array.isArray(payload.completed)) {
    const nativeCompleted = payload.completed
      .filter((c): c is OfflineEpisode => Boolean(c && typeof c === "object" && (c as OfflineEpisode).id))
      .map((c) => ({ ...c, storage: "native" as const }));
    const nativeIds = new Set(nativeCompleted.map((c) => c.id));
    const current = getOfflineEpisodes();
    const legacyNonNative = current.filter((c) => c.storage !== "native" && !nativeIds.has(c.id));
    const merged = [...nativeCompleted, ...legacyNonNative];
    if (
      merged.length !== current.length ||
      merged.some(
        (m, i) =>
          m.id !== current[i]?.id ||
          m.sizeBytes !== current[i]?.sizeBytes ||
          m.storage !== current[i]?.storage ||
          m.hasLocalCover !== current[i]?.hasLocalCover
      )
    ) {
      saveOfflineEpisodesList(merged);
    }
  }

  // Keep batchState synchronized for any active batch dialog
  if (batchState.active && batchState.videoId > 0) {
    const trackedIds = batchState.episodeIds?.length ? new Set(batchState.episodeIds) : null;
    const seriesQueue = Array.from(activeProgress.values()).filter(
      (q) =>
        (trackedIds ? trackedIds.has(q.id) : q.videoId === batchState.videoId) &&
        (q.status === "downloading" || q.status === "queued")
    );
    const downloadingItem = seriesQueue.find((q) => q.status === "downloading") || seriesQueue[0];
    if (downloadingItem) {
      batchState.currentEpisode = downloadingItem.episode;
      batchState.completed = Math.max(0, batchState.total - seriesQueue.length);
      notifyBatchProgress();
    } else {
      batchState.active = false;
      activeBatchToken = 0;
      notifyBatchProgress();
    }
  }

  notifyProgress(true);
}

export async function syncNativeDownloadState(): Promise<void> {
  if (!isNativeRustDownloaderAvailable()) return;
  if (nativeSyncPromise) return nativeSyncPromise;
  nativeSyncPromise = (async () => {
    try {
      const snap = await invoke<{ queue?: unknown[]; completed?: unknown[] }>("native_download_status");
      applyNativeDownloadSnapshot(snap);
    } catch {
      // ignore on fallback environments
    } finally {
      nativeSyncPromise = null;
    }
  })();
  return nativeSyncPromise;
}

function startNativeDownloadListener(): void {
  if (nativeListenerStarted || !isNativeRustDownloaderAvailable()) return;
  nativeListenerStarted = true;
  void listen<{ queue?: unknown[]; completed?: unknown[] }>("aurastream:native-download-progress", (ev) => {
    applyNativeDownloadSnapshot(ev.payload);
  }).catch(() => {
    nativeListenerStarted = false;
  });
}

// Restore active or paused downloads from previous JS session (Web/Dev fallback only)
if (!isNativeRustDownloaderAvailable()) {
  try {
    const raw = readStorage(STORAGE_KEYS.activeDownloads);
    if (raw) {
      const list = JSON.parse(raw);
      if (Array.isArray(list)) {
        for (const item of list) {
          if (item && item.id) {
            activeProgress.set(item.id, {
              ...item,
              status: "paused",
              autoResume: item.status === "downloading" || item.status === "queued" || item.autoResume === true,
              speedBytesPerSec: 0,
              speedFormatted: "Paused",
              etaFormatted: "--",
            });
          }
        }
      }
    }
  } catch {
    // ignore
  }
}

function persistActiveDownloads() {
  try {
    const list: ActiveDownloadProgress[] = [];
    for (const item of activeProgress.values()) {
      if (item.status === "downloading" || item.status === "queued" || item.status === "paused") {
        list.push({ ...item });
      }
    }
    writeStorage(STORAGE_KEYS.activeDownloads, JSON.stringify(list));
  } catch {
    // ignore
  }
}

function syncNativeDownloadCount() {
  const bridge = getNativeBridge();
  if (!bridge) return;
  const activeOrQueuedCount = Array.from(activeProgress.values()).filter(
    (p) => p.status === "downloading" || p.status === "queued"
  ).length;
  const activeCount = activeOrQueuedCount > 0 ? activeOrQueuedCount : (batchState.active && activeBatchToken > 0 ? 1 : 0);

  if (typeof bridge.setDownloadActiveCount === "function") {
    bridge.setDownloadActiveCount(activeCount);
  } else if (typeof bridge.setDownloadActive === "function") {
    const nextActive = activeCount > 0;
    if (nextActive !== lastNativeActiveState) {
      lastNativeActiveState = nextActive;
      bridge.setDownloadActive(nextActive);
    }
  }
}

function notifyProgress(immediatePersist = false) {
  const now = Date.now();
  if (immediatePersist || now - lastPersistTime >= 2000) {
    lastPersistTime = now;
    persistActiveDownloads();
  }
  syncNativeDownloadCount();
  for (const listener of progressListeners) {
    try {
      listener(new Map(activeProgress));
    } catch {
      // ignore
    }
  }
}

export function isDownloadNotificationEnabled(): boolean {
  try {
    const val = localStorage.getItem("aurastream_download_notif_enabled");
    return val !== "false";
  } catch {
    return true;
  }
}

export function setDownloadNotificationEnabled(enabled: boolean): void {
  try {
    localStorage.setItem("aurastream_download_notif_enabled", enabled ? "true" : "false");
  } catch {
    // ignore
  }
}

function notifyNativeDownloadProgress(
  videoId: number,
  episode: number,
  title: string,
  pct: number,
  speedFormatted: string,
  fileSizeFormatted: string = ""
) {
  const bridge = getNativeBridge();
  if (bridge && typeof bridge.updateDownloadNotification === "function") {
    const notifId = ((Math.abs(videoId) % 10000) * 100 + (episode % 100)) & 0x7fffffff;
    const cleanTitle = title || `Series #${videoId}`;
    bridge.updateDownloadNotification(notifId, cleanTitle, `Episode ${episode}`, pct, speedFormatted, fileSizeFormatted);
  }
}

function notifyNativeDownloadComplete(videoId: number, episode: number, title: string, fileSizeFormatted: string = "") {
  syncNativeDownloadCount();
  if (!isDownloadNotificationEnabled()) return;
  const bridge = getNativeBridge();
  if (bridge && typeof bridge.showDownloadCompleteNotification === "function") {
    const notifId = ((Math.abs(videoId) % 10000) * 100 + (episode % 100)) & 0x7fffffff;
    const cleanTitle = title || `Series #${videoId}`;
    bridge.showDownloadCompleteNotification(notifId, cleanTitle, `Episode ${episode}`, fileSizeFormatted);
  }
}

function notifyNativeDownloadCancel(videoId: number, episode: number) {
  const bridge = getNativeBridge();
  if (bridge && typeof bridge.cancelDownloadNotification === "function") {
    const notifId = ((Math.abs(videoId) % 10000) * 100 + (episode % 100)) & 0x7fffffff;
    bridge.cancelDownloadNotification(notifId);
  }
  syncNativeDownloadCount();
}

export function subscribeDownloadProgress(
  listener: (progress: Map<string, ActiveDownloadProgress>) => void
): () => void {
  progressListeners.add(listener);
  listener(new Map(activeProgress));
  return () => progressListeners.delete(listener);
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is not supported on this device"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("IndexedDB open blocked"));
  });
}

async function dbExists(dbName: string): Promise<boolean> {
  if (typeof indexedDB === "undefined") return false;
  if (typeof indexedDB.databases === "function") {
    try {
      const list = await indexedDB.databases();
      return list.some((d) => d.name === dbName);
    } catch {
      // fallback below
    }
  }
  return true;
}

async function openExistingDB(dbName: string): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return null;
  if (!(await dbExists(dbName))) return null;

  return new Promise((resolve) => {
    let abortedNew = false;
    const req = indexedDB.open(dbName);
    req.onupgradeneeded = (ev) => {
      if (ev.oldVersion === 0) {
        abortedNew = true;
        try {
          req.transaction?.abort();
        } catch {
          // ignore
        }
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      if (abortedNew || !db.objectStoreNames.contains(STORE_NAME)) {
        db.close();
        resolve(null);
        return;
      }
      resolve(db);
    };
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

function isValidOfflineRecord(rec: any): boolean {
  if (!rec || !rec.id) return false;
  if (rec.isHls) {
    return Boolean(rec.playlistText) && Array.isArray(rec.segments) && rec.segments.length > 0;
  }
  if (!rec.blob) return false;
  if (rec.blob instanceof Blob) return rec.blob.size > 0;
  if (typeof rec.blob.byteLength === "number") return rec.blob.byteLength > 0;
  return false;
}

/**
 * Returns metadata list for all downloaded episodes (strictly deduplicated)
 */
export function getOfflineEpisodes(): OfflineEpisode[] {
  try {
    const raw = readStorage(STORAGE_KEYS.downloads);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const unique: OfflineEpisode[] = [];
    for (const item of parsed) {
      if (item && item.id && !seen.has(item.id)) {
        seen.add(item.id);
        unique.push(item);
      }
    }
    return unique;
  } catch {
    return [];
  }
}

function pruneStaleOfflineMetadata(id: string): void {
  const current = getOfflineEpisodes();
  if (current.some((it) => it.id === id)) {
    saveOfflineEpisodesList(current.filter((it) => it.id !== id));
  }
}

async function scanDbRecords(
  dbName: string,
  createPrimaryIfMissing: boolean,
  into: Map<string, OfflineEpisode>
): Promise<boolean> {
  let db: IDBDatabase | null = null;
  try {
    db = createPrimaryIfMissing ? await openDB() : await openExistingDB(dbName);
  } catch {
    return false;
  }
  if (!db) return !createPrimaryIfMissing;

  const database = db;
  return new Promise((resolve) => {
    try {
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.close();
        resolve(true);
        return;
      }
      const tx = database.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.openCursor();
      req.onsuccess = (e: any) => {
        const cursor: IDBCursorWithValue | null = e.target.result;
        if (cursor) {
          const rec = cursor.value;
          if (isValidOfflineRecord(rec) && !into.has(rec.id)) {
            into.set(rec.id, {
              id: rec.id,
              videoId: rec.videoId,
              episode: rec.episode,
              title: rec.title,
              cover: rec.cover || "",
              sizeBytes: rec.sizeBytes || 0,
              downloadedAt: rec.downloadedAt || Date.now(),
              cues: rec.cues || [],
              quality: rec.quality,
              isHevc: rec.isHevc,
              isHls: Boolean(rec.isHls),
              storage: "idb",
            });
          }
          cursor.continue();
        } else {
          database.close();
          resolve(true);
        }
      };
      req.onerror = () => {
        database.close();
        resolve(false);
      };
    } catch {
      database.close();
      resolve(false);
    }
  });
}

/**
 * Bidirectionally synchronizes records between persistent native/IndexedDB storage and metadata list
 * so downloaded episodes survive app exit and evicted IDB records do not leave ghosts.
 */
export async function syncOfflineEpisodesFromIndexedDB(): Promise<OfflineEpisode[]> {
  try {
    let nativeCompleted: OfflineEpisode[] = [];
    let nativeOk = !isNativeRustDownloaderAvailable();
    if (isNativeRustDownloaderAvailable()) {
      try {
        const res = await invoke<OfflineEpisode[]>("native_offline_list");
        if (Array.isArray(res)) {
          nativeOk = true;
          nativeCompleted = res
            .filter((c) => c && c.id)
            .map((c) => ({ ...c, storage: "native" as const }));
        }
      } catch {
        // fallback if native command unavailable
      }
    }
    const nativeMap = new Map<string, OfflineEpisode>(nativeCompleted.map((c) => [c.id, c]));

    const idbRecords = new Map<string, OfflineEpisode>();
    const primaryOk = await scanDbRecords(DB_NAME, true, idbRecords);
    const legacyOk = await scanDbRecords(LEGACY_DB_NAME, false, idbRecords);

    // Read fresh localStorage after async scans to avoid clobbering concurrent finishes/deletes
    const currentList = normalizeOfflineEpisodeList(getOfflineEpisodes());
    if (!primaryOk || !legacyOk) {
      const mergedMap = new Map<string, OfflineEpisode>();
      for (const it of currentList) mergedMap.set(it.id, it);
      let changed = false;
      for (const [id, ep] of nativeMap) {
        if (!mergedMap.has(id) || mergedMap.get(id)?.storage !== "native") {
          mergedMap.set(id, ep);
          changed = true;
        }
      }
      for (const [id, ep] of idbRecords) {
        if (!mergedMap.has(id)) {
          mergedMap.set(id, ep);
          changed = true;
        }
      }
      const merged = Array.from(mergedMap.values());
      if (changed) saveOfflineEpisodesList(merged);
      return merged;
    }

    const mergedMap = new Map<string, OfflineEpisode>();
    let changed = false;

    for (const [id, nativeEp] of nativeMap) {
      mergedMap.set(id, nativeEp);
      const existing = currentList.find((c) => c.id === id);
      if (
        !existing ||
        existing.storage !== "native" ||
        existing.sizeBytes !== nativeEp.sizeBytes ||
        existing.hasLocalCover !== nativeEp.hasLocalCover
      ) {
        changed = true;
      }
    }

    for (const it of currentList) {
      if (mergedMap.has(it.id)) continue;
      const st = activeProgress.get(it.id)?.status;
      if (
        idbRecords.has(it.id) ||
        st === "downloading" ||
        st === "queued" ||
        (it.storage === "native" && !nativeOk)
      ) {
        mergedMap.set(it.id, it);
      } else {
        changed = true;
      }
    }

    for (const [id, recMeta] of idbRecords) {
      if (!mergedMap.has(id)) {
        mergedMap.set(id, recMeta);
        changed = true;
      }
    }

    const merged = Array.from(mergedMap.values());
    if (changed) {
      saveOfflineEpisodesList(merged);
    }
    return merged;
  } catch {
    return getOfflineEpisodes();
  }
}

export async function ensureOfflineSyncReady(): Promise<void> {
  if (typeof window === "undefined") return;
  if (window.location?.pathname?.startsWith("/tests/")) return;
  if ((window as unknown as { mobileLayoutFixture?: unknown }).mobileLayoutFixture) return;
  if (initialReadyPromise.p) return initialReadyPromise.p;
  initialReadyPromise.p = (async () => {
    startNativeDownloadListener();
    if (isNativeRustDownloaderAvailable()) {
      await syncNativeDownloadState().catch(() => {});
    }
    await syncOfflineEpisodesFromIndexedDB().catch(() => {});
    void resumeAllDownloads(false, true).catch(() => {});
  })();
  return initialReadyPromise.p;
}

// Auto-sync persistent storage first, then auto-resume interrupted downloads (never runs during /tests/ fixtures)
if (typeof window !== "undefined" && !window.location?.pathname?.startsWith("/tests/")) {
  void ensureOfflineSyncReady();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      if (isNativeRustDownloaderAvailable()) void syncNativeDownloadState();
      void syncOfflineEpisodesFromIndexedDB();
    }
  });
  window.addEventListener("focus", () => {
    if (isNativeRustDownloaderAvailable()) void syncNativeDownloadState();
    void syncOfflineEpisodesFromIndexedDB();
  });
  window.addEventListener("aurastream:app-resumed", () => {
    if (isNativeRustDownloaderAvailable()) void syncNativeDownloadState();
    void syncOfflineEpisodesFromIndexedDB();
  });
  window.addEventListener("online", () => {
    void (async () => {
      if (isNativeRustDownloaderAvailable()) await syncNativeDownloadState();
      await syncOfflineEpisodesFromIndexedDB();
      await resumeAllDownloads(false, true);
    })();
  });
}

function saveOfflineEpisodesList(list: OfflineEpisode[]): void {
  try {
    writeStorage(STORAGE_KEYS.downloads, JSON.stringify(list));
    window.dispatchEvent(new CustomEvent("aurastream:downloads-changed"));
  } catch {
    // ignore
  }
}

/**
 * Checks whether an episode is currently downloaded and ready for offline playback
 */
export function isEpisodeDownloaded(videoId: number, episode: number): boolean {
  const id = `${videoId}_${episode}`;
  return getOfflineEpisodes().some((item) => item.id === id);
}

/**
 * Checks whether an episode is currently downloading or queued
 */
export function isEpisodeDownloading(videoId: number, episode: number): boolean {
  const id = `${videoId}_${episode}`;
  const st = activeProgress.get(id)?.status;
  return st === "downloading" || st === "queued";
}

/**
 * Gets the current download progress percentage of an episode
 */
export function getEpisodeDownloadProgress(videoId: number, episode: number): number {
  const id = `${videoId}_${episode}`;
  return activeProgress.get(id)?.progress || 0;
}

/**
 * Formats bytes per second into human-readable transfer speed
 */
export function formatSpeed(bytesPerSec: number): string {
  if (!bytesPerSec || bytesPerSec <= 0 || !Number.isFinite(bytesPerSec)) return "-- KB/s";
  if (bytesPerSec >= 1024 * 1024) {
    return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
  }
  return `${Math.round(bytesPerSec / 1024)} KB/s`;
}

/**
 * Formats estimated time remaining into readable duration (e.g. "12s", "1m 30s")
 */
export function formatEta(seconds: number): string {
  if (!seconds || seconds <= 0 || !Number.isFinite(seconds)) return "--";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${s}s`;
}

/**
 * Formats raw byte count into standard units
 */
export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0 || !Number.isFinite(bytes)) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const val = (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1);
  return `${val} ${units[i]}`;
}

/**
 * Sanitizes raw Rust/network/URL error strings into short, readable messages.
 */
export function formatDownloadError(raw?: string | null): string {
  const input = (raw || "").trim();
  if (!input) return "Download failed. Tap Retry to try again.";

  const lower = input.toLowerCase();
  if (lower.includes("dns resolution") || (lower.includes("dns") && lower.includes("timed out"))) {
    return "Network DNS timed out. Check connection and tap Retry.";
  }
  if (lower.includes("timed out") || lower.includes("timeout")) {
    return "Connection timed out. Tap Retry to resume.";
  }
  if (
    lower.includes("connection reset") ||
    lower.includes("broken pipe") ||
    lower.includes("eof") ||
    lower.includes("error sending request") ||
    lower.includes("client error (connect)")
  ) {
    return "Connection interrupted. Tap Retry to resume.";
  }
  if (lower.includes("401") || lower.includes("403") || lower.includes("410") || lower.includes("expired")) {
    return "Download link expired. Tap Retry to refresh.";
  }
  if (lower.includes("no stream url") || lower.includes("404") || lower.includes("not found")) {
    return "Episode stream temporarily unavailable. Tap Retry.";
  }
  if (lower.includes("429") || lower.includes("http 5")) {
    return "Server busy. Wait a moment and tap Retry.";
  }

  const sanitized = input
    .replace(/https?:\/\/[^\s)]+/gi, "")
    .replace(/\(\s*\)/g, "")
    .replace(/error sending request for url\s*/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!sanitized) return "Network request failed. Tap Retry to try again.";
  return sanitized.length > 110 ? `${sanitized.slice(0, 107).trimEnd()}...` : sanitized;
}

/**
 * Detects whether the current device connection is on cellular (mobile data)
 */
export function isCellularConnection(): boolean {
  const bridge = getNativeBridge();
  if (bridge && typeof bridge.isCellularNetwork === "function") {
    try {
      return Boolean(bridge.isCellularNetwork());
    } catch {
      // fallback to web API
    }
  }
  if (typeof navigator !== "undefined" && "connection" in navigator) {
    const conn = (navigator as unknown as { connection?: { type?: string; effectiveType?: string } }).connection;
    if (conn) {
      if (conn.type === "cellular") return true;
    }
  }
  return false;
}

/**
 * Detects whether the device is on a slow or cellular connection
 */
export function isSlowOrCellularConnection(): boolean {
  if (isCellularConnection()) return true;
  if (typeof navigator !== "undefined" && "connection" in navigator) {
    const conn = (navigator as unknown as {
      connection?: {
        type?: string;
        effectiveType?: string;
        saveData?: boolean;
      };
    }).connection;
    if (conn) {
      if (conn.type === "cellular" || conn.saveData) return true;
      if (conn.effectiveType === "slow-2g" || conn.effectiveType === "2g" || conn.effectiveType === "3g") return true;
    }
  }
  return false;
}

/**
 * Detects whether device battery is critically low (< 20%) and not charging
 */
export async function isLowBattery(): Promise<boolean> {
  if (typeof navigator !== "undefined" && "getBattery" in navigator) {
    try {
      const b: any = await (navigator as any).getBattery();
      if (b && !b.charging && b.level < 0.20) {
        return true;
      }
    } catch {
      // ignore
    }
  }
  return false;
}

export function isWifiOnlyDownloadEnabled(): boolean {
  try {
    const val = localStorage.getItem(WIFI_ONLY_KEY);
    return val === null ? true : val === "true"; // default on to protect phone data plan
  } catch {
    return true;
  }
}

export function setWifiOnlyDownloadEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(WIFI_ONLY_KEY, String(enabled));
    window.dispatchEvent(new CustomEvent("aurastream:storage-config-changed"));
  } catch {
    // ignore
  }
}

export function isCellularDataSaverEnabled(): boolean {
  try {
    const val = localStorage.getItem(CELLULAR_SAVER_KEY);
    return val === null ? true : val === "true"; // default on
  } catch {
    return true;
  }
}

export function setCellularDataSaverEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(CELLULAR_SAVER_KEY, String(enabled));
    window.dispatchEvent(new CustomEvent("aurastream:storage-config-changed"));
  } catch {
    // ignore
  }
}

export function getDownloadQualityPreference(): DownloadQuality {
  try {
    const val = localStorage.getItem(DOWNLOAD_QUALITY_KEY);
    return (val === "hevc" || val === "standard" || val === "auto") ? val : "auto";
  } catch {
    return "auto";
  }
}

export function setDownloadQualityPreference(quality: DownloadQuality): void {
  try {
    localStorage.setItem(DOWNLOAD_QUALITY_KEY, quality);
    window.dispatchEvent(new CustomEvent("aurastream:storage-config-changed"));
  } catch {
    // ignore
  }
}

/**
 * Resolves the optimal stream URL based on user quality preference (HEVC saves ~40% space)
 */
export function resolveStreamUrlForQuality(
  info: PlayInfo | undefined | null,
  qualityPreference: DownloadQuality = getDownloadQualityPreference()
): { url: string; quality: DownloadQuality; isHevc: boolean } | null {
  if (!info) return null;

  const hevcUrl = info.streams?.hevc || info.video_url_hevc;
  const standardUrl = info.streams?.main || info.video_url;

  if (qualityPreference === "hevc") {
    if (hevcUrl) return { url: hevcUrl, quality: "hevc", isHevc: true };
    if (standardUrl) return { url: standardUrl, quality: "standard", isHevc: false };
  } else if (qualityPreference === "standard") {
    if (standardUrl) return { url: standardUrl, quality: "standard", isHevc: false };
    if (hevcUrl) return { url: hevcUrl, quality: "hevc", isHevc: true };
  } else {
    // "auto" — prefer HEVC for ~40% space savings if present
    if (hevcUrl) return { url: hevcUrl, quality: "hevc", isHevc: true };
    if (standardUrl) return { url: standardUrl, quality: "standard", isHevc: false };
  }

  const fallback = info.video_url || info.streams?.preview;
  if (fallback) return { url: fallback, quality: "standard", isHevc: false };
  return null;
}

async function fetchRecordFromDB(dbName: string, id: string): Promise<any> {
  const db = await openExistingDB(dbName);
  if (!db) return null;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        db.close();
        resolve(getReq.result || null);
      };
      getReq.onerror = () => {
        db.close();
        resolve(null);
      };
    } catch {
      db.close();
      resolve(null);
    }
  });
}

async function fetchRecordFromAnyDB(id: string): Promise<any> {
  let rec = await fetchRecordFromDB(DB_NAME, id);
  if (!rec) {
    rec = await fetchRecordFromDB(LEGACY_DB_NAME, id);
  }
  return rec;
}

const offlineUrlSessions = new Map<string, Set<string>>();
const sessionKeyToPlaylistUrl = new Map<string, string>();

function revokeUrlSet(urls: Set<string>): void {
  for (const url of urls) {
    try {
      URL.revokeObjectURL(url.split("#")[0]);
    } catch {
      // ignore
    }
  }
}

/**
 * Revokes previously created Object URLs for offline playback to free RAM.
 * Supports revoking a specific sessionKey or playlist/object URL, or all sessions when omitted.
 */
export function revokeOfflinePlaybackUrls(targetUrlOrSessionKey?: string): void {
  if (!targetUrlOrSessionKey) {
    for (const urls of offlineUrlSessions.values()) {
      revokeUrlSet(urls);
    }
    offlineUrlSessions.clear();
    sessionKeyToPlaylistUrl.clear();
    return;
  }

  const mappedUrl = sessionKeyToPlaylistUrl.get(targetUrlOrSessionKey);
  if (mappedUrl) {
    sessionKeyToPlaylistUrl.delete(targetUrlOrSessionKey);
    const urls = offlineUrlSessions.get(mappedUrl);
    if (urls) {
      revokeUrlSet(urls);
      offlineUrlSessions.delete(mappedUrl);
    }
    return;
  }

  const directUrls = offlineUrlSessions.get(targetUrlOrSessionKey);
  if (directUrls) {
    revokeUrlSet(directUrls);
    offlineUrlSessions.delete(targetUrlOrSessionKey);
    for (const [k, v] of sessionKeyToPlaylistUrl.entries()) {
      if (v === targetUrlOrSessionKey) sessionKeyToPlaylistUrl.delete(k);
    }
  }
}

function splitHlsAttrs(attrList: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < attrList.length; i++) {
    const ch = attrList[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if (ch === "," && !inQuotes) {
      parts.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function parseHlsTagAttrs(line: string): Record<string, string> {
  const colonIdx = line.indexOf(":");
  if (colonIdx < 0) return {};
  const attrs = splitHlsAttrs(line.slice(colonIdx + 1));
  const out: Record<string, string> = {};
  for (const attr of attrs) {
    const eqIdx = attr.indexOf("=");
    if (eqIdx < 0) continue;
    const k = attr.slice(0, eqIdx).trim().toUpperCase();
    let v = attr.slice(eqIdx + 1).trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

/**
 * Retrieves the local playback Object URL for a downloaded episode.
 * Optional sessionKey isolates Blob URL lifecycles between concurrent player instances.
 */
export async function getOfflinePlaybackUrl(
  videoId: number,
  episode: number,
  sessionKey?: string
): Promise<string | null> {
  const id = `${videoId}_${episode}`;
  try {
    const meta = getOfflineEpisodes().find((it) => it.id === id);
    if (meta?.storage === "native") {
      if (sessionKey) {
        revokeOfflinePlaybackUrls(sessionKey);
      }
      return `${LOCAL}/offline/${id}/${meta.isHls ? "index.m3u8" : "video.mp4"}`;
    }

    const record = await fetchRecordFromAnyDB(id);
    if (!record) {
      pruneStaleOfflineMetadata(id);
      return null;
    }

    if (sessionKey) {
      revokeOfflinePlaybackUrls(sessionKey);
    }

    const sessionUrls = new Set<string>();

    if (record.isHls && record.playlistText && Array.isArray(record.segments) && record.segments.length > 0) {
      let fallbackKeyUrl = "";
      if (record.keyBuffer) {
        const keyBlob =
          record.keyBuffer instanceof Blob
            ? record.keyBuffer
            : new Blob([record.keyBuffer], { type: "application/octet-stream" });
        fallbackKeyUrl = URL.createObjectURL(keyBlob);
        sessionUrls.add(fallbackKeyUrl);
      }

      const keyUrlMap = new Map<string, string>();
      if (record.keyBuffers && typeof record.keyBuffers === "object") {
        for (const [origUri, buf] of Object.entries(record.keyBuffers)) {
          if (buf) {
            const kb =
              buf instanceof Blob
                ? buf
                : new Blob([buf as BlobPart], { type: "application/octet-stream" });
            const kbUrl = URL.createObjectURL(kb);
            sessionUrls.add(kbUrl);
            keyUrlMap.set(origUri, kbUrl);
          }
        }
      }

      let fallbackMapUrl = "";
      const mapUrlByOrigUri = new Map<string, string>();
      if (Array.isArray(record.mapSegments)) {
        for (const entry of record.mapSegments) {
          if (entry && entry.uri && entry.blob) {
            const mb = entry.blob instanceof Blob ? entry.blob : new Blob([entry.blob], { type: "video/mp4" });
            const mbUrl = URL.createObjectURL(mb);
            sessionUrls.add(mbUrl);
            mapUrlByOrigUri.set(entry.uri, mbUrl);
            if (!fallbackMapUrl) fallbackMapUrl = mbUrl;
          }
        }
      } else if (record.initSegment) {
        const ib =
          record.initSegment instanceof Blob
            ? record.initSegment
            : new Blob([record.initSegment], { type: "video/mp4" });
        fallbackMapUrl = URL.createObjectURL(ib);
        sessionUrls.add(fallbackMapUrl);
      }

      const lines = record.playlistText.split(/\r?\n/);
      let segIndex = 0;
      const newLines: string[] = [];

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("#EXT-X-KEY:")) {
          const attrs = parseHlsTagAttrs(trimmed);
          const origUri = attrs.URI;
          const mappedKeyUrl = (origUri && keyUrlMap.get(origUri)) || fallbackKeyUrl;
          if (mappedKeyUrl && /URI="[^"]+"/.test(line)) {
            newLines.push(line.replace(/URI="[^"]+"/, `URI="${mappedKeyUrl}"`));
          } else {
            newLines.push(line);
          }
          continue;
        }
        if (trimmed.startsWith("#EXT-X-MAP:")) {
          const attrs = parseHlsTagAttrs(trimmed);
          const origUri = attrs.URI;
          const mappedInitUrl = (origUri && mapUrlByOrigUri.get(origUri)) || fallbackMapUrl;
          if (!mappedInitUrl) {
            revokeUrlSet(sessionUrls);
            pruneStaleOfflineMetadata(id);
            return null;
          }
          newLines.push(line.replace(/URI="[^"]+"/, `URI="${mappedInitUrl}"`));
          continue;
        }
        if (trimmed && !trimmed.startsWith("#")) {
          const segData = record.segments[segIndex++];
          if (!segData) {
            revokeUrlSet(sessionUrls);
            pruneStaleOfflineMetadata(id);
            return null;
          }
          const segBlob =
            segData instanceof Blob
              ? segData
              : new Blob([segData], { type: "video/mp2t" });
          if (segBlob.size <= 0) {
            revokeUrlSet(sessionUrls);
            pruneStaleOfflineMetadata(id);
            return null;
          }
          const segUrl = URL.createObjectURL(segBlob);
          sessionUrls.add(segUrl);
          newLines.push(segUrl);
          continue;
        }
        newLines.push(line);
      }

      if (segIndex === 0) {
        revokeUrlSet(sessionUrls);
        pruneStaleOfflineMetadata(id);
        return null;
      }

      const rewritten = newLines.join("\n");
      const plBlob = new Blob([rewritten], { type: "application/vnd.apple.mpegurl" });
      const rawUrl = URL.createObjectURL(plBlob);
      sessionUrls.add(rawUrl);
      const plUrl = rawUrl + "#.m3u8";
      offlineUrlSessions.set(plUrl, sessionUrls);
      if (sessionKey) sessionKeyToPlaylistUrl.set(sessionKey, plUrl);
      return plUrl;
    } else if (record.blob) {
      const blob =
        record.blob instanceof Blob
          ? record.blob
          : new Blob([record.blob], { type: "video/mp4" });
      if (blob.size <= 0) {
        pruneStaleOfflineMetadata(id);
        return null;
      }
      const singleUrl = URL.createObjectURL(blob);
      sessionUrls.add(singleUrl);
      offlineUrlSessions.set(singleUrl, sessionUrls);
      if (sessionKey) sessionKeyToPlaylistUrl.set(sessionKey, singleUrl);
      return singleUrl;
    } else {
      pruneStaleOfflineMetadata(id);
      return null;
    }
  } catch {
    return null;
  }
}

/**
 * Retrieves cached subtitle cues for an offline episode
 */
export function getOfflineSubtitles(videoId: number, episode: number): SubtitleCue[] | null {
  const id = `${videoId}_${episode}`;
  const item = getOfflineEpisodes().find((it) => it.id === id);
  return item?.cues || null;
}

/**
 * Cancels an active or queued download and cleans up memory/disk
 */
export function cancelDownload(id: string): void {
  const prog = activeProgress.get(id);
  pendingJsBatchQueue = pendingJsBatchQueue.filter((item) => `${item.videoId}_${item.episode}` !== id);

  if (isNativeRustDownloaderAvailable()) {
    activeProgress.delete(id);
    notifyProgress(true);
    void invoke("native_download_cancel", { id })
      .then(() => syncNativeDownloadState())
      .catch(() => {});
    return;
  }

  activeRunTokens.delete(id);
  const ctrl = activeAbortControllers.get(id);
  if (ctrl) {
    activeAbortControllers.delete(id);
    ctrl.abort("cancelled");
  }
  activeProgress.delete(id);
  notifyProgress(true);
  if (prog) {
    notifyNativeDownloadCancel(prog.videoId, prog.episode);
  }
}

/**
 * Cancels all queued, downloading, and paused items
 */
export function cancelAllDownloads(): void {
  pendingJsBatchQueue = [];
  activeBatchToken = ++batchTokenSeq;
  batchState.active = false;
  notifyBatchProgress();

  if (isNativeRustDownloaderAvailable()) {
    activeProgress.clear();
    notifyProgress(true);
    void invoke("native_download_cancel_all")
      .then(() => syncNativeDownloadState())
      .catch(() => {});
    return;
  }

  for (const id of Array.from(activeProgress.keys())) {
    cancelDownload(id);
  }
}

/**
 * Pauses an active or queued download
 */
export function pauseDownload(id: string): void {
  if (isNativeRustDownloaderAvailable()) {
    const prog = activeProgress.get(id);
    if (prog) {
      activeProgress.set(id, {
        ...prog,
        status: "paused",
        autoResume: false,
        speedBytesPerSec: 0,
        speedFormatted: "Paused",
        etaFormatted: "--",
      });
      notifyProgress(true);
    }
    void invoke("native_download_pause", { id })
      .then(() => syncNativeDownloadState())
      .catch(() => {});
    return;
  }

  activeRunTokens.delete(id);
  const ctrl = activeAbortControllers.get(id);
  if (ctrl) {
    activeAbortControllers.delete(id);
    ctrl.abort("paused");
  }
  const prog = activeProgress.get(id);
  if (prog) {
    activeProgress.set(id, {
      ...prog,
      status: "paused",
      autoResume: false,
      speedBytesPerSec: 0,
      speedFormatted: "Paused",
      etaFormatted: "--",
    });
    notifyProgress(true);
  }
}

/**
 * Resumes a paused or errored download
 */
export async function resumeDownload(id: string, forceAllowCellular = false): Promise<void> {
  const item = activeProgress.get(id);
  if (!item) return;
  if (isEpisodeDownloaded(item.videoId, item.episode)) {
    activeProgress.delete(id);
    notifyProgress(true);
    return;
  }
  if (!forceAllowCellular && isWifiOnlyDownloadEnabled() && isCellularConnection()) {
    return;
  }
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return;
  }

  if (isNativeRustDownloaderAvailable()) {
    await invoke("native_download_resume", { id, cellular: isCellularConnection() });
    syncNativeDownloadCount();
    await syncNativeDownloadState();
    return;
  }

  if (!item.streamUrl) {
    // Re-resolve stream URL if item came from a batch queue before resolution
    try {
      const info = await api.play(item.videoId, item.episode);
      const resolved = resolveStreamUrlForQuality(info, item.quality || getDownloadQualityPreference());
      if (!resolved?.url) throw new Error("No playback stream available");
      item.streamUrl = resolved.url;
      item.quality = resolved.quality;
      item.isHevc = resolved.isHevc;
    } catch {
      return;
    }
  }
  await startEpisodeDownload(
    item.videoId,
    item.episode,
    item.title,
    item.cover || "",
    item.streamUrl,
    forceAllowCellular,
    item.quality || getDownloadQualityPreference(),
    item.isHevc || false
  );
}

/**
 * Pauses all currently active and queued downloads
 */
export function pauseAllDownloads(): void {
  if (isNativeRustDownloaderAvailable()) {
    for (const [id, prog] of activeProgress.entries()) {
      if (prog.status === "downloading" || prog.status === "queued") {
        activeProgress.set(id, {
          ...prog,
          status: "paused",
          autoResume: false,
          speedBytesPerSec: 0,
          speedFormatted: "Paused",
          etaFormatted: "--",
        });
      }
    }
    notifyProgress(true);
    void invoke("native_download_pause_all")
      .then(() => syncNativeDownloadState())
      .catch(() => {});
    return;
  }

  for (const [id, prog] of activeProgress.entries()) {
    if (prog.status === "downloading" || prog.status === "queued") {
      pauseDownload(id);
    }
  }
}

/**
 * Resumes all paused downloads sequentially (or via native Rust queue)
 */
export async function resumeAllDownloads(forceAllowCellular = false, onlyAutoResumable = false): Promise<void> {
  if (isNativeRustDownloaderAvailable()) {
    if (!forceAllowCellular && isWifiOnlyDownloadEnabled() && isCellularConnection()) {
      return;
    }
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      return;
    }
    await invoke("native_download_resume_all", {
      onlyAutoResumable,
      cellular: isCellularConnection(),
    }).catch(() => {});
    syncNativeDownloadCount();
    await syncNativeDownloadState();
    return;
  }

  const pausedIds = Array.from(activeProgress.entries())
    .filter(
      ([_, prog]) =>
        (prog.status === "paused" || (!onlyAutoResumable && prog.status === "error")) &&
        (!onlyAutoResumable || prog.autoResume === true)
    )
    .map(([id]) => id);

  for (const id of pausedIds) {
    try {
      await resumeDownload(id, forceAllowCellular);
    } catch {
      // continue next
    }
  }
}

/**
 * Returns an aggregated summary of active downloads for UI badges
 */
export function getActiveDownloadsSummary(): {
  activeCount: number;
  queuedCount: number;
  pausedCount: number;
  aggregateSpeedFormatted: string;
  aggregateSpeedBytesPerSec: number;
  totalDownloadedBytes: number;
  totalExpectedBytes: number;
  overallProgressPercent: number;
} {
  let activeCount = 0;
  let queuedCount = 0;
  let pausedCount = 0;
  let totalSpeed = 0;
  let totalDownloaded = 0;
  let totalExpected = 0;

  for (const prog of activeProgress.values()) {
    if (prog.status === "downloading") {
      activeCount++;
      totalSpeed += prog.speedBytesPerSec;
      totalDownloaded += prog.downloadedBytes;
      totalExpected += prog.totalBytes;
    } else if (prog.status === "queued") {
      activeCount++;
      queuedCount++;
    } else if (prog.status === "paused") {
      pausedCount++;
      totalDownloaded += prog.downloadedBytes;
      totalExpected += prog.totalBytes;
    }
  }

  const overallProgressPercent = totalExpected > 0 ? Math.round((totalDownloaded / totalExpected) * 100) : 0;

  return {
    activeCount,
    queuedCount,
    pausedCount,
    aggregateSpeedFormatted: formatSpeed(totalSpeed),
    aggregateSpeedBytesPerSec: totalSpeed,
    totalDownloadedBytes: totalDownloaded,
    totalExpectedBytes: totalExpected,
    overallProgressPercent,
  };
}

/**
 * Returns a snapshot array of all active and paused downloads
 */
export function getActiveDownloads(): ActiveDownloadProgress[] {
  return Array.from(activeProgress.values());
}

function resolveProxyMediaUrl(rawUrl: string): string {
  if (rawUrl.startsWith("http://") || rawUrl.startsWith("https://") || rawUrl.startsWith("hg://")) {
    return rawUrl;
  }
  return rawUrl.startsWith("/") ? `${LOCAL}${rawUrl}` : `${LOCAL}/${rawUrl}`;
}

async function fetchWithRetry(
  url: string,
  signal?: AbortSignal,
  maxRetries = 3,
  baseDelay = 250,
  timeoutMs = 60000
): Promise<Response> {
  let lastError: any = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) throw new Error("aborted");

    const timeoutCtrl = new AbortController();
    const timer = setTimeout(() => {
      timeoutCtrl.abort("timeout");
    }, timeoutMs);

    let onAbort: (() => void) | null = null;
    if (signal) {
      onAbort = () => timeoutCtrl.abort("aborted");
      signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      const res = await fetch(url, { signal: timeoutCtrl.signal });
      clearTimeout(timer);
      if (onAbort && signal) signal.removeEventListener("abort", onAbort);
      if (res.ok) return res;
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        throw new Error(`HTTP ${res.status}`);
      }
      lastError = new Error(`HTTP ${res.status}`);
    } catch (err: any) {
      clearTimeout(timer);
      if (onAbort && signal) signal.removeEventListener("abort", onAbort);
      if (signal?.aborted || err === "aborted" || (err?.name === "AbortError" && signal?.aborted)) {
        throw new Error("aborted");
      }
      lastError = err;
    }

    if (attempt < maxRetries) {
      const delay = baseDelay * Math.pow(1.5, attempt) + Math.random() * 150;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError || new Error("Request failed after retries");
}

/**
 * Downloads a video segment via the local proxy handler with retries and adaptive timeouts
 */
async function fetchSegmentData(
  segUrl: string,
  signal: AbortSignal | undefined,
  onChunk?: (chunkLength: number) => void
): Promise<ArrayBuffer> {
  const targetUrl = resolveProxyMediaUrl(segUrl);

  let lastError: any = null;
  const maxAttempts = 5;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal?.aborted) throw new Error("aborted");

    const timeoutCtrl = new AbortController();
    const timeoutTimer = setTimeout(() => {
      timeoutCtrl.abort("timeout");
    }, 25000);

    let onAbort: (() => void) | null = null;
    if (signal) {
      onAbort = () => timeoutCtrl.abort("aborted");
      signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      const res = await fetch(targetUrl, { signal: timeoutCtrl.signal });

      if (!res.ok) {
        clearTimeout(timeoutTimer);
        if (onAbort && signal) signal.removeEventListener("abort", onAbort);
        throw new Error(`HTTP ${res.status}`);
      }

      // Segments are individual chunks (0.5 - 2MB). Using res.arrayBuffer() reads directly
      // from the native WebResourceResponse bridge without ReadableStream pipeline stalls.
      const buf = await res.arrayBuffer();
      clearTimeout(timeoutTimer);
      if (onAbort && signal) signal.removeEventListener("abort", onAbort);

      if (buf.byteLength <= 0) {
        throw new Error("Empty segment received (0 bytes)");
      }

      if (onChunk) {
        onChunk(buf.byteLength);
      }
      return buf;
    } catch (err: any) {
      clearTimeout(timeoutTimer);
      if (onAbort && signal) signal.removeEventListener("abort", onAbort);
      if (signal?.aborted || err === "aborted" || (err?.name === "AbortError" && signal?.aborted)) {
        throw new Error("aborted");
      }
      lastError = err;
      if (attempt + 1 < maxAttempts) {
        const backoffMs = Math.min(3000, 300 * Math.pow(1.6, attempt));
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
  }

  throw lastError || new Error("Failed to download segment after retries");
}

function selectBestHlsVariant(playlistText: string): string | null {
  const lines = playlistText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let bestUrl: string | null = null;
  let bestBandwidth = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      const attrs = parseHlsTagAttrs(line);
      const avgBw = Number(attrs["AVERAGE-BANDWIDTH"]);
      const bw = Number(attrs.BANDWIDTH);
      const score = Number.isFinite(bw) ? bw : (Number.isFinite(avgBw) ? avgBw : 0);

      for (let j = i + 1; j < lines.length; j++) {
        if (!lines[j].startsWith("#")) {
          if (score > bestBandwidth || bestUrl === null) {
            bestBandwidth = score;
            bestUrl = lines[j];
          }
          i = j;
          break;
        }
      }
    }
  }

  if (bestUrl) return bestUrl;
  const fallback = lines.find((l) => !l.startsWith("#"));
  return fallback || null;
}

/**
 * Downloads a video stream into local storage for offline playback
 */
export async function startEpisodeDownload(
  videoId: number,
  episode: number,
  title: string,
  cover: string,
  streamUrl: string,
  forceAllowCellular = false,
  quality: DownloadQuality = getDownloadQualityPreference(),
  isHevc = false
): Promise<void> {
  const id = `${videoId}_${episode}`;
  if (isEpisodeDownloaded(videoId, episode)) {
    return;
  }

  // If this exact episode is already actively downloading, await the in-flight promise instead of restarting from 0%
  const existingCtrlCheck = activeAbortControllers.get(id);
  const existingPromise = activeDownloadPromises.get(id);
  if (
    existingPromise &&
    existingCtrlCheck &&
    !existingCtrlCheck.signal.aborted &&
    activeProgress.get(id)?.status === "downloading"
  ) {
    return existingPromise;
  }

  // Guard mobile data plan on Android
  if (!forceAllowCellular && isWifiOnlyDownloadEnabled() && isCellularConnection()) {
    throw new Error("Cellular connection detected. 'Download on Wi-Fi Only' is enabled.");
  }

  // Guard battery on Android
  if (await isLowBattery()) {
    throw new Error("Battery is low (< 20%). Connect charger to download.");
  }

  if (isEpisodeDownloaded(videoId, episode)) {
    return;
  }

  // Guard storage space on device (ensure at least 120 MB free)
  try {
    const bridge = getNativeBridge();
    if (bridge && typeof bridge.getStorageInfo === "function") {
      const raw = bridge.getStorageInfo();
      const parsed = JSON.parse(raw);
      if (parsed.primaryFreeBytes && parsed.primaryFreeBytes < 120 * 1024 * 1024) {
        throw new Error("Device storage is critically low (< 120 MB free). Please free space before downloading.");
      }
    }
  } catch (storageErr: any) {
    if (storageErr?.message?.includes("Device storage is critically low")) {
      throw storageErr;
    }
  }

  // Native Rust background downloader path (survives app switch / backgrounding cleanly)
  if (isNativeRustDownloaderAvailable()) {
    let cues: SubtitleCue[] = [];
    try {
      const track = await getSubtitlesForEpisode(videoId, episode, title);
      if (track && track.source !== "none" && track.cues.length > 0) {
        cues = track.cues;
      }
    } catch {
      // ignore subtitle fetch error
    }
    await invoke("native_download_enqueue", {
      items: [
        {
          videoId,
          episode,
          title: title || `Episode ${episode}`,
          cover: cover || "",
          streamUrl: streamUrl || null,
          quality,
          isHevc,
          cues,
        },
      ],
      cellular: isCellularConnection(),
    });
    syncNativeDownloadCount();
    await syncNativeDownloadState();
    return;
  }

  // Cancel any existing controller for this item before assigning new run token
  const existingCtrl = activeAbortControllers.get(id);
  const runToken = ++runTokenSeq;
  activeRunTokens.set(id, runToken);
  if (existingCtrl) {
    existingCtrl.abort("restarted");
  }

  const controller = new AbortController();
  activeAbortControllers.set(id, controller);

  const runPromise = (async () => {
    const isStillOwner = () => activeRunTokens.get(id) === runToken;
    const isCurrentRun = () => isStillOwner() && !controller.signal.aborted;

  activeProgress.set(id, {
    id,
    videoId,
    episode,
    title,
    cover,
    progress: 1,
    downloadedBytes: 0,
    totalBytes: 0,
    speedBytesPerSec: 0,
    speedFormatted: "Connecting...",
    etaSeconds: 0,
    etaFormatted: "--",
    status: "downloading",
    autoResume: true,
    streamUrl,
    quality,
    isHevc,
  });
  // Sync native activeDownloadCount BEFORE emitting initial notification update
  notifyProgress(true);

  const speedSamples: Array<{ t: number; bytes: number }> = [];
  let emaSpeedBps = 0;
  let lastNotifPct = 1;
  let lastNotifTime = Date.now();

  notifyNativeDownloadProgress(videoId, episode, title, 1, "Connecting...", "");

  const maybeNotifyNative = (pct: number, speedText: string, downloadedBytes: number, totalExpectedBytes: number) => {
    if (!isCurrentRun()) return;
    const now = Date.now();
    if (pct !== lastNotifPct && (pct - lastNotifPct >= 1 || now - lastNotifTime > 700 || pct >= 99 || pct <= 2)) {
      lastNotifPct = pct;
      lastNotifTime = now;
      const sizeText = totalExpectedBytes > 0
        ? `${formatBytes(downloadedBytes)} / ${formatBytes(totalExpectedBytes)}`
        : formatBytes(downloadedBytes);
      notifyNativeDownloadProgress(videoId, episode, title, pct, speedText, sizeText);
    }
  };

  const computeSpeedAndEta = (receivedBytes: number, totalExpectedBytes: number) => {
    const now = performance.now();
    speedSamples.push({ t: now, bytes: receivedBytes });
    const cutoff = now - 5000;
    while (speedSamples.length > 2 && speedSamples[0].t < cutoff) {
      speedSamples.shift();
    }
    const first = speedSamples[0];
    const dtSec = first ? (now - first.t) / 1000 : 0;
    if (dtSec >= 0.35 && first && receivedBytes >= first.bytes) {
      const winBps = (receivedBytes - first.bytes) / dtSec;
      emaSpeedBps = emaSpeedBps > 0 ? emaSpeedBps * 0.6 + winBps * 0.4 : winBps;
    }
    const remainingBytes = Math.max(0, totalExpectedBytes - receivedBytes);
    const etaSec = emaSpeedBps > 100 && remainingBytes > 0 ? Math.round(remainingBytes / emaSpeedBps) : 0;
    return {
      speedBytesPerSec: emaSpeedBps,
      speedFormatted: formatSpeed(emaSpeedBps),
      etaSeconds: etaSec,
      etaFormatted: formatEta(etaSec),
    };
  };

  try {
    // 1. Fetch real subtitle track in parallel if present so subtitles work offline (never fake cues)
    let cues: SubtitleCue[] = [];
    try {
      const track = await getSubtitlesForEpisode(videoId, episode, title);
      if (track && track.source !== "none" && track.cues.length > 0) {
        cues = track.cues;
      }
    } catch {
      // Subtitle fallback if offline or request failed
    }

    if (!isCurrentRun()) return;

    // 2. Fetch the video stream (support HLS .m3u8 & direct stream via local proxy)
    const blobParts: BlobPart[] = [];
    let segmentBlobs: Blob[] = [];
    let mapSegments: Array<{ uri: string; blob: Blob }> = [];
    let receivedBytes = 0;
    let mime = "video/mp4";
    const isHls = /\.m3u8(\?|$)/i.test(streamUrl) || streamUrl.includes("/hls?u=");
    let playlistText = "";

    let keyBlob: Blob | undefined = undefined;
    let keyBuffers: Record<string, Blob> | undefined = undefined;
    let keyMethod: string | undefined = undefined;
    let keyIv: string | undefined = undefined;

    if (isHls) {
      mime = "video/mp2t";
      const plUrl = streamUrl.startsWith(`${LOCAL}/hls`) || streamUrl.startsWith(`${LOCAL}/seg`)
        ? streamUrl
        : `${LOCAL}/hls?u=${encodeURIComponent(streamUrl)}`;

      let plRes = await fetchWithRetry(plUrl, controller.signal, 3, 300, 15000);
      if (!plRes.ok) {
        throw new Error(`Failed to load playlist: HTTP ${plRes.status}`);
      }
      playlistText = await plRes.text();

      // Master Playlist support: select highest bandwidth child variant
      if (playlistText.includes("#EXT-X-STREAM-INF")) {
        const chosenVariant = selectBestHlsVariant(playlistText);
        if (!chosenVariant) {
          throw new Error("Master playlist contains no playable variant streams");
        }
        const variantUrl = resolveProxyMediaUrl(chosenVariant);
        plRes = await fetchWithRetry(variantUrl, controller.signal, 3, 300, 15000);
        if (!plRes.ok) {
          throw new Error(`Failed to load HLS variant playlist: HTTP ${plRes.status}`);
        }
        playlistText = await plRes.text();
        if (!playlistText.trim() || playlistText.includes("#EXT-X-STREAM-INF")) {
          throw new Error("Invalid HLS media playlist returned by variant");
        }
      }

      const lines = playlistText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

      // Parse & download all #EXT-X-KEY entries (fail cleanly if AES-128 key fetch fails)
      const keyLines = lines.filter((l) => l.startsWith("#EXT-X-KEY:"));
      const downloadedKeys = new Map<string, Blob>();
      for (const kl of keyLines) {
        const attrs = parseHlsTagAttrs(kl);
        const method = (attrs.METHOD || "").toUpperCase();
        if (!keyMethod && method) keyMethod = method;
        if (!keyIv && attrs.IV) keyIv = attrs.IV;

        if (!method || method === "NONE") continue;
        if (!attrs.URI) {
          throw new Error(`HLS ${method} key tag is missing URI`);
        }
        if (!downloadedKeys.has(attrs.URI)) {
          const rawKeyUrl = resolveProxyMediaUrl(attrs.URI);
          const keyRes = await fetchWithRetry(rawKeyUrl, controller.signal, 3, 250, 12000);
          if (!keyRes.ok) {
            throw new Error(`Failed to fetch HLS decryption key: HTTP ${keyRes.status}`);
          }
          const keyAb = await keyRes.arrayBuffer();
          if (keyAb.byteLength <= 0) {
            throw new Error("Empty HLS decryption key received (0 bytes)");
          }
          const kb = new Blob([keyAb], { type: "application/octet-stream" });
          downloadedKeys.set(attrs.URI, kb);
          if (!keyBlob) keyBlob = kb;
        }
      }
      if (downloadedKeys.size > 0) {
        keyBuffers = Object.fromEntries(downloadedKeys.entries());
      }

      // Parse & download any #EXT-X-MAP init segments (fMP4 / CMAF / HEVC)
      const mapLines = lines.filter((l) => l.startsWith("#EXT-X-MAP:"));
      const seenMapUris = new Set<string>();
      for (const ml of mapLines) {
        const attrs = parseHlsTagAttrs(ml);
        if (attrs.URI && !seenMapUris.has(attrs.URI)) {
          seenMapUris.add(attrs.URI);
          const initBuf = await fetchSegmentData(attrs.URI, controller.signal, (delta) => {
            receivedBytes += delta;
          });
          mapSegments.push({
            uri: attrs.URI,
            blob: new Blob([initBuf], { type: "video/mp4" }),
          });
        }
      }

      // Find media segment URLs
      const segUrls = lines.filter((l) => !l.startsWith("#"));
      if (segUrls.length === 0) {
        throw new Error("No media segments found in playlist");
      }

      const totalSegments = segUrls.length;
      segmentBlobs = new Array(totalSegments);
      let completedSegments = 0;
      let nextIndex = 0;

      // Parallel segment downloading: 6 workers on Wi-Fi, 3 on cellular/slow connections
      const CONCURRENCY = isSlowOrCellularConnection() ? 3 : 6;

      // Provide immediate feedback with initial total size estimation (~1.8MB per segment)
      const initialEstBytes = totalSegments * 1.8 * 1024 * 1024;
      if (!isCurrentRun()) return;
      activeProgress.set(id, {
        id,
        videoId,
        episode,
        title,
        cover,
        progress: 1,
        downloadedBytes: receivedBytes,
        totalBytes: initialEstBytes,
        speedBytesPerSec: 0,
        speedFormatted: "Connecting...",
        etaSeconds: Math.round(initialEstBytes / (1.5 * 1024 * 1024)),
        etaFormatted: formatEta(Math.round(initialEstBytes / (1.5 * 1024 * 1024))),
        status: "downloading",
        autoResume: true,
        streamUrl,
        quality,
        isHevc,
      });
      notifyProgress(false);
      maybeNotifyNative(1, "Connecting...", receivedBytes, initialEstBytes);
      logLine(`[download] start id=${id} ep=${episode} segments=${totalSegments} estBytes=${initialEstBytes}`);

      const failedIndices: number[] = [];

      const updateSegmentProgress = () => {
        if (!isCurrentRun()) return;
        const avgSegBytes = receivedBytes / Math.max(1, completedSegments);
        const estTotalBytes = Math.max(receivedBytes, Math.round(avgSegBytes * totalSegments));
        const { speedBytesPerSec, speedFormatted, etaSeconds, etaFormatted } = computeSpeedAndEta(
          receivedBytes,
          estTotalBytes
        );
        const pct = Math.min(99, Math.max(1, Math.round((completedSegments / totalSegments) * 100)));
        activeProgress.set(id, {
          id,
          videoId,
          episode,
          title,
          cover,
          progress: pct,
          downloadedBytes: receivedBytes,
          totalBytes: estTotalBytes,
          speedBytesPerSec,
          speedFormatted,
          etaSeconds,
          etaFormatted,
          status: "downloading",
          autoResume: true,
          streamUrl,
          quality,
          isHevc,
        });
        notifyProgress(false);
        maybeNotifyNative(pct, speedFormatted, receivedBytes, estTotalBytes);
      };

      const worker = async () => {
        while (nextIndex < totalSegments && isCurrentRun()) {
          const i = nextIndex++;
          const segUrl = segUrls[i];
          try {
            const segBuf = await fetchSegmentData(segUrl, controller.signal, (chunkDelta) => {
              receivedBytes += chunkDelta;
            });
            // Wrap immediately as disk-backed Blob so V8 heap and IndexedDB put() never hit DataCloneError OOM
            segmentBlobs[i] = new Blob([segBuf], { type: "video/mp2t" });
            completedSegments++;
            updateSegmentProgress();
          } catch (segErr) {
            if (!isCurrentRun()) return;
            logLine(`[download] seg failed id=${id} ep=${episode} seg=${i + 1}/${totalSegments} err=${segErr}`);
            failedIndices.push(i);
          }
        }
      };

      const workers = Array.from({ length: Math.min(CONCURRENCY, totalSegments) }, () => worker());
      await Promise.all(workers);

      // Retry any segments that failed during parallel worker phase
      if (failedIndices.length > 0 && isCurrentRun()) {
        logLine(`[download] retrying ${failedIndices.length} failed segments id=${id}`);
        for (const i of failedIndices) {
          if (!isCurrentRun()) break;
          const segUrl = segUrls[i];
          const segBuf = await fetchSegmentData(segUrl, controller.signal, (chunkDelta) => {
            receivedBytes += chunkDelta;
          });
          segmentBlobs[i] = new Blob([segBuf], { type: "video/mp2t" });
          completedSegments++;
          updateSegmentProgress();
        }
      }

      if (!isCurrentRun()) return;

      if (completedSegments < totalSegments) {
        throw new Error(`Incomplete download: ${completedSegments}/${totalSegments} segments retrieved`);
      }
      if (segmentBlobs.some((b) => !(b instanceof Blob) || b.size <= 0)) {
        throw new Error("Incomplete or empty HLS video segment");
      }
    } else {
      // Direct video stream (mp4 / m4v / webm) with 4 MiB Blob part flushing
      const downloadUrl = streamUrl.startsWith(`${LOCAL}/`) || streamUrl.startsWith("hg://")
        ? streamUrl
        : `${LOCAL}/seg?u=${encodeURIComponent(streamUrl)}`;

      const response = await fetchWithRetry(downloadUrl, controller.signal, 3, 400, 60000);
      if (!response.ok) {
        throw new Error(`Failed to download stream: HTTP ${response.status}`);
      }

      mime = response.headers.get("content-type") || "video/mp4";
      const contentLength = Number(response.headers.get("content-length") || 0);

      let bufferedChunks: Uint8Array[] = [];
      let bufferedBytes = 0;
      const FLUSH_THRESHOLD = 4 * 1024 * 1024;
      const flushBuffered = () => {
        if (bufferedChunks.length > 0) {
          blobParts.push(new Blob(bufferedChunks as BlobPart[], { type: mime }));
          bufferedChunks = [];
          bufferedBytes = 0;
        }
      };

      if (response.body && typeof response.body.getReader === "function") {
        const reader = response.body.getReader();
        while (true) {
          if (!isCurrentRun()) {
            try { await reader.cancel(); } catch {}
            return;
          }
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.byteLength > 0) {
            bufferedChunks.push(value);
            bufferedBytes += value.byteLength;
            if (bufferedBytes >= FLUSH_THRESHOLD) {
              flushBuffered();
            }
            receivedBytes += value.byteLength;
            const estTotal = contentLength > 0
              ? Math.max(contentLength, receivedBytes)
              : Math.max(15 * 1024 * 1024, Math.round(receivedBytes * 1.25));
            const pct = Math.min(99, Math.max(1, Math.round((receivedBytes / estTotal) * 100)));
            const { speedBytesPerSec, speedFormatted, etaSeconds, etaFormatted } = computeSpeedAndEta(
              receivedBytes,
              estTotal
            );
            if (!isCurrentRun()) {
              try { await reader.cancel(); } catch {}
              return;
            }
            activeProgress.set(id, {
              id,
              videoId,
              episode,
              title,
              cover,
              progress: pct,
              downloadedBytes: receivedBytes,
              totalBytes: estTotal,
              speedBytesPerSec,
              speedFormatted,
              etaSeconds,
              etaFormatted,
              status: "downloading",
              autoResume: true,
              streamUrl,
              quality,
              isHevc,
            });
            notifyProgress(false);
            maybeNotifyNative(pct, speedFormatted, receivedBytes, estTotal);
          }
        }
        flushBuffered();
      } else {
        const buf = await response.arrayBuffer();
        if (buf.byteLength > 0) {
          blobParts.push(new Blob([buf], { type: mime }));
          receivedBytes = buf.byteLength;
        }
      }

      if (!isCurrentRun()) return;

      const { speedBytesPerSec, speedFormatted, etaSeconds, etaFormatted } = computeSpeedAndEta(
        receivedBytes,
        receivedBytes
      );

      activeProgress.set(id, {
        id,
        videoId,
        episode,
        title,
        cover,
        progress: 99,
        downloadedBytes: receivedBytes,
        totalBytes: receivedBytes,
        speedBytesPerSec,
        speedFormatted,
        etaSeconds,
        etaFormatted,
        status: "downloading",
        autoResume: true,
        streamUrl,
        quality,
        isHevc,
      });
      notifyProgress(false);
      maybeNotifyNative(99, speedFormatted, receivedBytes, receivedBytes);
    }

    if (!isCurrentRun()) return;

    const finalBlob = isHls ? null : new Blob(blobParts, { type: mime });
    const totalSize = isHls ? receivedBytes : (finalBlob?.size || 0);
    if (totalSize <= 0) {
      throw new Error("Empty download received (0 bytes)");
    }

    // 3. Save to IndexedDB using disk-backed Blob segments and wait for transaction commit
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      try {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        const record = {
          id,
          videoId,
          episode,
          title: title || `Episode ${episode}`,
          cover: cover || "",
          isHls,
          playlistText: isHls ? playlistText : undefined,
          segments: isHls ? segmentBlobs : undefined,
          mapSegments: isHls && mapSegments.length > 0 ? mapSegments : undefined,
          initSegment: isHls && mapSegments.length > 0 ? mapSegments[0].blob : undefined,
          keyBuffer: keyBlob,
          keyBuffers,
          keyMethod,
          keyIv,
          blob: finalBlob || undefined,
          sizeBytes: totalSize,
          cues,
          quality,
          isHevc,
        };
        store.put(record);
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error || new Error("IndexedDB transaction failed"));
        };
        tx.onabort = () => {
          db.close();
          reject(tx.error || new Error("IndexedDB transaction aborted"));
        };
      } catch (txErr) {
        db.close();
        reject(txErr);
      }
    });

    if (!isCurrentRun()) {
      await deleteFromDb(DB_NAME, id).catch(() => {});
      return;
    }

    // 4. Update metadata
    const list = getOfflineEpisodes().filter((it) => it.id !== id);
    list.unshift({
      id,
      videoId,
      episode,
      title: title || `Episode ${episode}`,
      cover,
      sizeBytes: totalSize,
      downloadedAt: Date.now(),
      cues,
      quality,
      isHevc,
      isHls,
      storage: "idb",
    });
    saveOfflineEpisodesList(list);

    if (activeAbortControllers.get(id) === controller) {
      activeAbortControllers.delete(id);
    }
    if (!isStillOwner()) return;

    activeProgress.set(id, {
      id,
      videoId,
      episode,
      title,
      cover,
      progress: 100,
      downloadedBytes: totalSize,
      totalBytes: totalSize,
      speedBytesPerSec: 0,
      speedFormatted: "Finished",
      etaSeconds: 0,
      etaFormatted: "Done",
      status: "completed",
      autoResume: false,
      streamUrl,
      quality,
      isHevc,
    });
    notifyProgress(true);
    notifyNativeDownloadComplete(videoId, episode, title, formatBytes(totalSize));
    logLine(`[download] finished id=${id} ep=${episode} size=${formatBytes(totalSize)}`);

    setTimeout(() => {
      if (activeRunTokens.get(id) === runToken && activeProgress.get(id)?.status === "completed") {
        activeProgress.delete(id);
        activeRunTokens.delete(id);
        notifyProgress(true);
      }
    }, 2500);
  } catch (err: unknown) {
    if (activeAbortControllers.get(id) === controller) {
      activeAbortControllers.delete(id);
    }
    if (!isStillOwner()) {
      return;
    }

    logLine(`[download] error id=${id} ep=${episode} err=${(err as Error)?.message || String(err)}`);
    const error = err as { name?: string };
    if (error?.name === "AbortError" || controller.signal.aborted) {
      if (controller.signal.reason === "paused" || activeProgress.get(id)?.status === "paused") {
        return;
      }
      activeRunTokens.delete(id);
      activeProgress.delete(id);
      notifyProgress(true);
      notifyNativeDownloadCancel(videoId, episode);
      return;
    }

    activeRunTokens.delete(id);
    activeProgress.set(id, {
      id,
      videoId,
      episode,
      title,
      cover,
      progress: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      speedBytesPerSec: 0,
      speedFormatted: "--",
      etaSeconds: 0,
      etaFormatted: "--",
      status: "error",
      autoResume: false,
      error: (err as Error).message || "Download failed",
      streamUrl,
      quality,
      isHevc,
    });
    notifyProgress(true);
    notifyNativeDownloadCancel(videoId, episode);
    throw err;
  } finally {
    if (isStillOwner()) {
      activeDownloadPromises.delete(id);
    }
  }
  })();

  activeDownloadPromises.set(id, runPromise);
  return runPromise;
}

async function deleteFromDb(dbName: string, id: string): Promise<void> {
  const db = await openExistingDB(dbName);
  if (!db) return;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const delReq = store.delete(id);
      delReq.onsuccess = () => { db.close(); resolve(); };
      delReq.onerror = () => { db.close(); resolve(); };
    } catch {
      db.close();
      resolve();
    }
  });
}

async function clearDb(dbName: string): Promise<void> {
  const db = await openExistingDB(dbName);
  if (!db) return;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const clearReq = store.clear();
      clearReq.onsuccess = () => { db.close(); resolve(); };
      clearReq.onerror = () => { db.close(); resolve(); };
    } catch {
      db.close();
      resolve();
    }
  });
}

/**
 * Deletes an offline episode from storage
 */
export async function deleteOfflineEpisode(videoId: number, episode: number): Promise<void> {
  const id = `${videoId}_${episode}`;
  if (isNativeRustDownloaderAvailable()) {
    try {
      await invoke("native_offline_delete", { ids: [id] });
    } catch {
      // ignore
    }
  }
  try {
    await deleteFromDb(DB_NAME, id);
    await deleteFromDb(LEGACY_DB_NAME, id);
  } catch {
    // ignore
  }

  const list = getOfflineEpisodes().filter((it) => it.id !== id);
  saveOfflineEpisodesList(list);
}

/**
 * Deletes multiple offline episodes in a batch
 */
export async function deleteOfflineEpisodesBatch(
  items: Array<{ videoId: number; episode: number }>
): Promise<void> {
  const idsToDelete = new Set(items.map((it) => `${it.videoId}_${it.episode}`));
  if (isNativeRustDownloaderAvailable() && idsToDelete.size > 0) {
    try {
      await invoke("native_offline_delete", { ids: Array.from(idsToDelete) });
    } catch {
      // ignore
    }
  }
  for (const id of idsToDelete) {
    try {
      await deleteFromDb(DB_NAME, id);
      await deleteFromDb(LEGACY_DB_NAME, id);
    } catch {
      // ignore
    }
  }

  const list = getOfflineEpisodes().filter((it) => !idsToDelete.has(it.id));
  saveOfflineEpisodesList(list);
}

/**
 * Wipes all downloaded episodes from native storage, IndexedDB and metadata
 */
export async function clearAllOfflineDownloads(): Promise<void> {
  if (isNativeRustDownloaderAvailable()) {
    try {
      await invoke("native_offline_clear");
    } catch {
      // ignore
    }
  }
  try {
    await clearDb(DB_NAME);
    await clearDb(LEGACY_DB_NAME);
  } catch {
    // ignore
  }
  saveOfflineEpisodesList([]);
}

/**
 * Calculates total offline storage used in megabytes
 */
export function getOfflineStorageTotal(): { count: number; sizeMB: string } {
  const list = getOfflineEpisodes();
  const totalBytes = list.reduce((acc, it) => acc + (it.sizeBytes || 0), 0);
  const sizeMB = (totalBytes / (1024 * 1024)).toFixed(1);
  return { count: list.length, sizeMB };
}

/* ── Smart Downloads Configuration & Engine ─────────────────────── */

export function isSmartDownloadEnabled(): boolean {
  try {
    const val = localStorage.getItem(SMART_DOWNLOAD_KEY);
    return val === "true"; // Default OFF so playing offline/online never secretly consumes extra data
  } catch {
    return false;
  }
}

export function setSmartDownloadEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(SMART_DOWNLOAD_KEY, String(enabled));
    window.dispatchEvent(new CustomEvent("aurastream:storage-config-changed"));
  } catch {
    // ignore
  }
}

export function isAutoDeleteWatchedEnabled(): boolean {
  // Always disabled so that downloads are NEVER automatically deleted on exit or watched
  return false;
}

export function setAutoDeleteWatchedEnabled(_enabled: boolean): void {
  try {
    localStorage.setItem(AUTO_DELETE_KEY, "false");
    window.dispatchEvent(new CustomEvent("aurastream:storage-config-changed"));
  } catch {
    // ignore
  }
}

/**
 * Proactively checks and downloads the next episode when watching
 */
export async function checkSmartDownloadNextEpisode(
  currentVideoId: number,
  currentEp: number,
  totalEp: number,
  meta: { title: string; cover: string }
): Promise<void> {
  if (!isSmartDownloadEnabled()) return;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  // Guard mobile data plan on Android
  if (isWifiOnlyDownloadEnabled() && isCellularConnection()) return;

  const nextEp = currentEp + 1;
  if (nextEp > totalEp) return;
  const nextId = `${currentVideoId}_${nextEp}`;
  if (isEpisodeDownloaded(currentVideoId, nextEp) || activeProgress.has(nextId) || triggeringSmartDownloads.has(nextId)) {
    return;
  }

  triggeringSmartDownloads.add(nextId);
  try {
    const info = await api.play(currentVideoId, nextEp);
    const streamRes = resolveStreamUrlForQuality(info);
    if (streamRes?.url) {
      void startEpisodeDownload(
        currentVideoId,
        nextEp,
        meta.title || `Episode ${nextEp}`,
        meta.cover || "",
        streamRes.url,
        false,
        streamRes.quality,
        streamRes.isHevc
      ).catch(() => {});
    }
  } catch {
    // quiet background fail
  } finally {
    triggeringSmartDownloads.delete(nextId);
  }
}

/**
 * Deletes watched episode after it finishes playing if Auto-Delete is active
 * (Permanently disabled: downloads are NEVER automatically deleted on playback finish or app exit)
 */
export async function checkAutoDeleteFinishedEpisode(
  _currentVideoId: number,
  _currentEp: number
): Promise<void> {
  // Never auto-delete downloads: user downloads are permanent until manually deleted.
  return;
}

/* ── Series Batch Downloader Engine ─────────────────────────────── */

export interface BatchDownloadPlan {
  videoId: number;
  title: string;
  cover: string;
  episodesToDownload: number[];
  estimatedTotalBytes: number;
  estimatedFormatted: string;
}

export function planBatchDownload(
  videoId: number,
  title: string,
  cover: string,
  episodes: number[]
): BatchDownloadPlan {
  const unDownloaded = episodes.filter((ep) => !isEpisodeDownloaded(videoId, ep));
  const estBytes = Math.round(unDownloaded.length * 5.5 * 1024 * 1024); // avg ~5.5MB
  return {
    videoId,
    title,
    cover,
    episodesToDownload: unDownloaded,
    estimatedTotalBytes: estBytes,
    estimatedFormatted: formatBytes(estBytes),
  };
}

const batchListeners = new Set<(state: BatchProgressState) => void>();

function notifyBatchProgress() {
  for (const listener of batchListeners) {
    try {
      listener({ ...batchState });
    } catch {
      // ignore
    }
  }
}

export function subscribeBatchProgress(listener: (state: BatchProgressState) => void): () => void {
  batchListeners.add(listener);
  listener({ ...batchState });
  return () => batchListeners.delete(listener);
}

export function getBatchProgress(): BatchProgressState {
  return { ...batchState };
}

type QueuedJsBatchEntry = {
  videoId: number;
  episode: number;
  title: string;
  cover: string;
  forceAllowCellular: boolean;
  qualityPreference: DownloadQuality;
};

let pendingJsBatchQueue: QueuedJsBatchEntry[] = [];
let jsBatchDrainPromise: Promise<{ success: number; failed: number }> | null = null;

export function cancelBatchDownload(videoId?: number): void {
  if (typeof videoId === "number") {
    pendingJsBatchQueue = pendingJsBatchQueue.filter((item) => item.videoId !== videoId);
    for (const [id, prog] of Array.from(activeProgress.entries())) {
      if (
        prog.videoId === videoId &&
        (prog.status === "downloading" || prog.status === "queued" || prog.status === "paused" || prog.status === "error")
      ) {
        cancelDownload(id);
      }
    }
    if (batchState.videoId === videoId) {
      activeBatchToken = ++batchTokenSeq;
      batchState.active = false;
      notifyBatchProgress();
      syncNativeDownloadCount();
    }
    return;
  }

  pendingJsBatchQueue = [];
  activeBatchToken = ++batchTokenSeq;
  batchState.active = false;
  if (isNativeRustDownloaderAvailable()) {
    void invoke("native_download_cancel_all").then(() => syncNativeDownloadState()).catch(() => {});
  } else {
    for (const [id, prog] of Array.from(activeProgress.entries())) {
      if (prog.status === "downloading" || prog.status === "queued") {
        cancelDownload(id);
      }
    }
  }
  notifyBatchProgress();
  syncNativeDownloadCount();
}

export async function executeBatchDownload(
  videoId: number,
  title: string,
  cover: string,
  episodeNumbers: number[],
  forceAllowCellular = false,
  qualityPreference: DownloadQuality = getDownloadQualityPreference()
): Promise<{ success: number; failed: number; queued?: number }> {
  const uniqueSorted = Array.from(
    new Set(episodeNumbers.filter((n) => Number.isFinite(n) && n > 0))
  ).sort((a, b) => a - b);

  const unDownloaded = uniqueSorted.filter((ep) => {
    if (isEpisodeDownloaded(videoId, ep)) return false;
    const st = activeProgress.get(`${videoId}_${ep}`)?.status;
    return st !== "downloading" && st !== "queued";
  });

  if (unDownloaded.length === 0) {
    return { success: 0, failed: 0, queued: 0 };
  }

  if (!forceAllowCellular && isWifiOnlyDownloadEnabled() && isCellularConnection()) {
    throw new Error("Cellular connection detected. 'Download on Wi-Fi Only' is enabled.");
  }

  // Native Rust Tokio background queue: enqueue ALL episodes at once so Ep 2..N run natively even when WebView sleeps
  if (isNativeRustDownloaderAvailable()) {
    const preferHevc = qualityPreference === "hevc" || qualityPreference === "auto";
    const loadCachedCues = (vid: number, ep: number): SubtitleCue[] => {
      try {
        const raw = localStorage.getItem(`aurastream_sub_${vid}_${ep}`);
        if (!raw || raw.includes('"procedural"') || raw.includes('"mock"')) return [];
        const parsed = JSON.parse(raw);
        if (parsed && parsed.source !== "procedural" && parsed.source !== "mock" && Array.isArray(parsed.cues)) {
          return parsed.cues;
        }
      } catch {
        // ignore
      }
      return [];
    };
    const episodeIds = unDownloaded.map((ep) => `${videoId}_${ep}`);
    await invoke("native_download_enqueue", {
      items: unDownloaded.map((ep) => ({
        videoId,
        episode: ep,
        title: title || `Series #${videoId}`,
        cover: cover || "",
        streamUrl: null,
        quality: qualityPreference,
        isHevc: preferHevc,
        cues: loadCachedCues(videoId, ep),
      })),
      cellular: isCellularConnection(),
    });

    batchState = {
      active: true,
      videoId,
      title,
      total: unDownloaded.length,
      completed: 0,
      currentEpisode: unDownloaded[0],
      failedCount: 0,
      episodeIds,
    };
    notifyBatchProgress();
    syncNativeDownloadCount();
    await syncNativeDownloadState();
    return { success: 0, failed: 0, queued: unDownloaded.length };
  }

  // Web / Dev fallback: register ALL episodes into activeProgress immediately as "queued" so the full list shows up at once
  for (const ep of unDownloaded) {
    const id = `${videoId}_${ep}`;
    activeProgress.set(id, {
      id,
      videoId,
      episode: ep,
      title,
      cover,
      progress: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      speedBytesPerSec: 0,
      speedFormatted: "Queued",
      etaSeconds: 0,
      etaFormatted: "--",
      status: "queued",
      autoResume: true,
      quality: qualityPreference,
      isHevc: qualityPreference === "hevc" || qualityPreference === "auto",
    });
    pendingJsBatchQueue.push({
      videoId,
      episode: ep,
      title,
      cover,
      forceAllowCellular,
      qualityPreference,
    });
  }
  notifyProgress(true);

  if (jsBatchDrainPromise) {
    batchState = {
      ...batchState,
      active: true,
      total: batchState.total + unDownloaded.length,
      episodeIds: [...(batchState.episodeIds || []), ...unDownloaded.map((ep) => `${videoId}_${ep}`)],
    };
    notifyBatchProgress();
    return jsBatchDrainPromise;
  }

  const myBatchToken = ++batchTokenSeq;
  activeBatchToken = myBatchToken;
  batchState = {
    active: true,
    videoId,
    title,
    total: unDownloaded.length,
    completed: 0,
    currentEpisode: unDownloaded[0],
    failedCount: 0,
    episodeIds: unDownloaded.map((ep) => `${videoId}_${ep}`),
  };
  notifyBatchProgress();
  syncNativeDownloadCount();

  jsBatchDrainPromise = (async () => {
    let success = 0;
    let failed = 0;
    try {
      while (pendingJsBatchQueue.length > 0 && activeBatchToken === myBatchToken) {
        const next = pendingJsBatchQueue.shift()!;
        const id = `${next.videoId}_${next.episode}`;
        if (isEpisodeDownloaded(next.videoId, next.episode)) {
          activeProgress.delete(id);
          notifyProgress(true);
          continue;
        }
        batchState.videoId = next.videoId;
        batchState.title = next.title;
        batchState.currentEpisode = next.episode;
        notifyBatchProgress();

        let downloaded = false;
        for (let attempt = 0; attempt < 2; attempt++) {
          if (activeBatchToken !== myBatchToken) break;
          try {
            const info = await api.play(next.videoId, next.episode);
            if (activeBatchToken !== myBatchToken) break;
            const streamRes = resolveStreamUrlForQuality(info, next.qualityPreference);
            if (!streamRes?.url) throw new Error("No stream URL");
            if (activeBatchToken !== myBatchToken) break;

            await startEpisodeDownload(
              next.videoId,
              next.episode,
              next.title,
              next.cover,
              streamRes.url,
              next.forceAllowCellular,
              streamRes.quality,
              streamRes.isHevc
            );

            if (activeBatchToken !== myBatchToken) break;
            if (isEpisodeDownloaded(next.videoId, next.episode)) {
              downloaded = true;
              success++;
              batchState.completed = success;
              break;
            }
          } catch {
            if (attempt === 0 && activeBatchToken === myBatchToken) {
              logLine(`[batch] retrying episode ${next.episode} once after pause`);
              await new Promise((r) => setTimeout(r, 1200));
            }
          }
        }

        if (activeBatchToken !== myBatchToken) break;
        if (!downloaded) {
          failed++;
          batchState.failedCount = failed;
        }
        notifyBatchProgress();
      }
    } finally {
      jsBatchDrainPromise = null;
      if (activeBatchToken === myBatchToken) {
        batchState.active = false;
        activeBatchToken = 0;
        notifyBatchProgress();
        syncNativeDownloadCount();
      }
    }
    return { success, failed };
  })();

  return jsBatchDrainPromise;
}

/**
 * Verifies if device has sufficient storage space before initiating batch downloads
 */
export async function checkStorageAvailableForBatch(estimatedBytes: number): Promise<{
  sufficient: boolean;
  freeBytes: number;
  freeFormatted: string;
  estimatedFormatted: string;
  reason?: string;
}> {
  let freeBytes = 800 * 1024 * 1024; // Default fallback: 800MB
  try {
    const bridge = getNativeBridge();
    if (bridge && typeof bridge.getStorageInfo === "function") {
      const raw = bridge.getStorageInfo();
      const parsed = JSON.parse(raw);
      if (parsed.primaryFreeBytes && parsed.primaryFreeBytes > 0) {
        freeBytes = parsed.primaryFreeBytes;
      }
    } else if (typeof navigator !== "undefined" && navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      if (est.quota !== undefined && est.usage !== undefined) {
        freeBytes = Math.max(0, est.quota - est.usage);
      }
    }
  } catch {
    // fallback
  }

  const safetyMargin = 150 * 1024 * 1024; // 150 MB safety margin
  const sufficient = freeBytes > (estimatedBytes + safetyMargin);

  return {
    sufficient,
    freeBytes,
    freeFormatted: formatBytes(freeBytes),
    estimatedFormatted: formatBytes(estimatedBytes),
    reason: sufficient
      ? undefined
      : `Low storage space: only ${formatBytes(freeBytes)} available. Batch download requires ${formatBytes(estimatedBytes)} + 150 MB buffer.`,
  };
}

/* ── Device Storage Space Estimation ────────────────────────────── */

export interface DeviceStorageStats {
  offlineCount: number;
  offlineBytes: number;
  offlineFormatted: string;
  quotaBytes: number | null;
  quotaFormatted: string;
  usageBytes: number;
  usageFormatted: string;
  freeBytes: number | null;
  freeFormatted: string;
  percentUsed: number | null;
}

export async function getDetailedStorageStats(): Promise<DeviceStorageStats> {
  const list = getOfflineEpisodes();
  const offlineBytes = list.reduce((acc, item) => acc + (item.sizeBytes || 0), 0);
  const offlineFormatted = formatBytes(offlineBytes);

  let nativeFreeBytes = 0;
  const bridge = getNativeBridge();
  if (bridge && typeof bridge.getStorageInfo === "function") {
    try {
      const raw = bridge.getStorageInfo();
      const parsed = JSON.parse(raw);
      if (parsed.primaryFreeBytes && parsed.primaryFreeBytes > 0) {
        nativeFreeBytes = parsed.primaryFreeBytes;
      }
    } catch {
      // ignore
    }
  }

  let quotaBytes: number | null = null;
  let usageBytes = offlineBytes;

  if (typeof navigator !== "undefined" && navigator.storage && navigator.storage.estimate) {
    try {
      const est = await navigator.storage.estimate();
      if (est.quota && est.quota > 0) {
        quotaBytes = est.quota;
        usageBytes = est.usage ?? offlineBytes;
      }
    } catch {
      // ignore
    }
  }

  const freeBytes: number | null = nativeFreeBytes > 0
    ? nativeFreeBytes
    : quotaBytes != null
      ? Math.max(0, quotaBytes - usageBytes)
      : null;

  const percentUsed: number | null =
    nativeFreeBytes > 0
      ? offlineBytes + nativeFreeBytes > 0
        ? Math.min(100, Math.round((offlineBytes / (offlineBytes + nativeFreeBytes)) * 100))
        : 0
      : quotaBytes != null && quotaBytes > 0
        ? Math.min(100, Math.round((usageBytes / quotaBytes) * 100))
        : null;

  return {
    offlineCount: list.length,
    offlineBytes,
    offlineFormatted,
    quotaBytes,
    quotaFormatted: quotaBytes != null ? formatBytes(quotaBytes) : "--",
    usageBytes,
    usageFormatted: formatBytes(usageBytes),
    freeBytes,
    freeFormatted: freeBytes != null ? formatBytes(freeBytes) : "Available",
    percentUsed,
  };
}
