/**
 * AuraStream Offline Download Manager
 * Uses IndexedDB to store video blobs and subtitle tracks for zero-data offline playback on Android.
 * Features: live speed (MB/s), ETA calculation, cancel/pause controls, Smart Downloads (auto-download next ep, auto-delete watched),
 * Phone Storage visualizer, "Download on Wi-Fi Only" cellular guard, and 1-Click Series Batch Downloader.
 */

import { api, LOCAL, logLine } from "../api";
import { readStorage, writeStorage, STORAGE_KEYS } from "../storage";
import { getSubtitlesForEpisode } from "../subtitles/aiSubtitleService";
import type { SubtitleCue } from "../subtitles/types";
import type { PlayInfo } from "../types";

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
  status: "downloading" | "paused" | "completed" | "error";
  error?: string;
  streamUrl?: string;
  quality?: DownloadQuality;
  isHevc?: boolean;
}

const DB_NAME = "AuraStreamOfflineDB";
const DB_VERSION = 1;
const STORE_NAME = "episodes";
const META_KEY = "aurastream_offline_episodes_v1";
const SMART_DOWNLOAD_KEY = "aurastream_smart_download_v1";
const AUTO_DELETE_KEY = "aurastream_auto_delete_watched_v1";
const WIFI_ONLY_KEY = "aurastream_wifi_only_download_v1";
const CELLULAR_SAVER_KEY = "aurastream_cellular_data_saver_v1";
const DOWNLOAD_QUALITY_KEY = "aurastream_download_quality_preference_v1";
const ACTIVE_DOWNLOADS_KEY = "aurastream_active_downloads_v1";

// Request persistent storage on mobile WebView so Android never wipes IndexedDB/localStorage
if (typeof navigator !== "undefined" && navigator.storage && typeof navigator.storage.persist === "function") {
  navigator.storage.persist().catch(() => {});
}

const activeProgress = new Map<string, ActiveDownloadProgress>();
const activeAbortControllers = new Map<string, AbortController>();
const progressListeners = new Set<(progress: Map<string, ActiveDownloadProgress>) => void>();
const triggeringSmartDownloads = new Set<string>();

// Restore any active or paused downloads from previous session so exiting app never deletes them
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

function persistActiveDownloads() {
  try {
    const list: ActiveDownloadProgress[] = [];
    for (const item of activeProgress.values()) {
      if (item.status === "downloading" || item.status === "paused") {
        list.push({ ...item });
      }
    }
    writeStorage(STORAGE_KEYS.activeDownloads, JSON.stringify(list));
  } catch {
    // ignore
  }
}

function notifyProgress() {
  persistActiveDownloads();
  for (const listener of progressListeners) {
    try {
      listener(new Map(activeProgress));
    } catch {
      // ignore
    }
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
  if (typeof window !== "undefined" && typeof (window as any).AuraNativeExport?.updateDownloadNotification === "function") {
    const notifId = ((Math.abs(videoId) % 10000) * 100 + (episode % 100)) & 0x7fffffff;
    (window as any).AuraNativeExport.updateDownloadNotification(notifId, title, `Episode ${episode}`, pct, speedFormatted, fileSizeFormatted);
  }
}

function notifyNativeDownloadComplete(videoId: number, episode: number, title: string, fileSizeFormatted: string = "") {
  if (typeof window !== "undefined" && typeof (window as any).AuraNativeExport?.showDownloadCompleteNotification === "function") {
    const notifId = ((Math.abs(videoId) % 10000) * 100 + (episode % 100)) & 0x7fffffff;
    (window as any).AuraNativeExport.showDownloadCompleteNotification(notifId, title, `Episode ${episode}`, fileSizeFormatted);
  }
  if (typeof window !== "undefined" && typeof (window as any).AuraNativeExport?.setDownloadActive === "function") {
    (window as any).AuraNativeExport.setDownloadActive(false);
  }
}

function notifyNativeDownloadCancel(videoId: number, episode: number) {
  if (typeof window !== "undefined" && typeof (window as any).AuraNativeExport?.cancelDownloadNotification === "function") {
    const notifId = ((Math.abs(videoId) % 10000) * 100 + (episode % 100)) & 0x7fffffff;
    (window as any).AuraNativeExport.cancelDownloadNotification(notifId);
  }
  if (typeof window !== "undefined" && typeof (window as any).AuraNativeExport?.setDownloadActive === "function") {
    (window as any).AuraNativeExport.setDownloadActive(false);
  }
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

/**
 * Synchronizes records from persistent IndexedDB to metadata list on boot
 * ensuring downloaded episodes survive app exit and are never lost.
 */
export async function syncOfflineEpisodesFromIndexedDB(): Promise<OfflineEpisode[]> {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const currentList = getOfflineEpisodes();
      const map = new Map<string, OfflineEpisode>();
      for (const it of currentList) map.set(it.id, it);
      let changed = false;

      const req = store.openCursor();
      req.onsuccess = (e: any) => {
        const cursor: IDBCursorWithValue | null = e.target.result;
        if (cursor) {
          const rec = cursor.value;
          if (rec && rec.id && !map.has(rec.id)) {
            map.set(rec.id, {
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
            });
            changed = true;
          }
          cursor.continue();
        } else {
          // Completed cursor scan
          db.close();
          const merged = Array.from(map.values());
          if (changed) {
            saveOfflineEpisodesList(merged);
          }
          resolve(merged);
        }
      };
      req.onerror = () => {
        db.close();
        resolve(getOfflineEpisodes());
      };
    });
  } catch {
    return getOfflineEpisodes();
  }
}

// Auto-sync persistent storage and auto-resume downloads so exiting app never deletes or interrupts them
if (typeof window !== "undefined") {
  void syncOfflineEpisodesFromIndexedDB();
  void resumeAllDownloads();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      void syncOfflineEpisodesFromIndexedDB();
    }
  });
  window.addEventListener("focus", () => {
    void syncOfflineEpisodesFromIndexedDB();
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
 * Checks whether an episode is currently downloading
 */
export function isEpisodeDownloading(videoId: number, episode: number): boolean {
  const id = `${videoId}_${episode}`;
  return activeProgress.get(id)?.status === "downloading";
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
 * Detects whether the current device connection is on cellular (mobile data)
 */
export function isCellularConnection(): boolean {
  if (typeof window !== "undefined" && typeof (window as any).AuraNativeExport?.isCellularNetwork === "function") {
    try {
      return Boolean((window as any).AuraNativeExport.isCellularNetwork());
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

async function fetchRecordFromAnyDB(id: string): Promise<any> {
  const check = (dbName: string): Promise<any> =>
    new Promise((resolve) => {
      if (typeof indexedDB === "undefined") {
        resolve(null);
        return;
      }
      const req = indexedDB.open(dbName);
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.close();
          resolve(null);
          return;
        }
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
      };
      req.onerror = () => resolve(null);
    });

  let rec = await check(DB_NAME);
  if (!rec) {
    rec = await check("aurastream_offline_db");
  }
  return rec;
}

const activeOfflineUrls = new Set<string>();

/**
 * Revokes previously created Object URLs for offline playback to free RAM
 */
export function revokeOfflinePlaybackUrls(): void {
  for (const url of activeOfflineUrls) {
    try {
      URL.revokeObjectURL(url.split("#")[0]);
    } catch {
      // ignore
    }
  }
  activeOfflineUrls.clear();
}

/**
 * Retrieves the local playback Object URL for a downloaded episode
 */
export async function getOfflinePlaybackUrl(videoId: number, episode: number): Promise<string | null> {
  const id = `${videoId}_${episode}`;
  try {
    const record = await fetchRecordFromAnyDB(id);
    if (!record) return null;

    // Revoke previous URLs before allocating new ones
    revokeOfflinePlaybackUrls();

    if (record.isHls && record.playlistText && record.segments) {
      // Recreate blob URLs for AES-128 key (if encrypted) and each segment
      let offlineKeyUrl = "";
      if (record.keyBuffer) {
        const keyBlob = new Blob([record.keyBuffer], { type: "application/octet-stream" });
        offlineKeyUrl = URL.createObjectURL(keyBlob);
        activeOfflineUrls.add(offlineKeyUrl);
      }

      const lines = record.playlistText.split("\n");
      let segIndex = 0;
      const newLines = lines.map((line: string) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("#EXT-X-KEY:") && offlineKeyUrl) {
          return line.replace(/URI="[^"]+"/, `URI="${offlineKeyUrl}"`);
        }
        if (trimmed && !trimmed.startsWith("#")) {
          const segData = record.segments[segIndex++];
          if (segData) {
            const segBlob = new Blob([segData], { type: "video/mp2t" });
            const segUrl = URL.createObjectURL(segBlob);
            activeOfflineUrls.add(segUrl);
            return segUrl;
          }
        }
        return line;
      });
      const rewritten = newLines.join("\n");
      const plBlob = new Blob([rewritten], { type: "application/vnd.apple.mpegurl" });
      const rawUrl = URL.createObjectURL(plBlob);
      activeOfflineUrls.add(rawUrl);
      const plUrl = rawUrl + "#.m3u8";
      return plUrl;
    } else if (record.blob) {
      const singleUrl = URL.createObjectURL(record.blob);
      activeOfflineUrls.add(singleUrl);
      return singleUrl;
    } else {
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
 * Cancels an active download and cleans up memory
 */
export function cancelDownload(id: string): void {
  const prog = activeProgress.get(id);
  if (prog) {
    notifyNativeDownloadCancel(prog.videoId, prog.episode);
  }
  const ctrl = activeAbortControllers.get(id);
  if (ctrl) {
    ctrl.abort("cancelled");
    activeAbortControllers.delete(id);
  }
  activeProgress.delete(id);
  notifyProgress();
}

/**
 * Pauses an active download
 */
export function pauseDownload(id: string): void {
  const ctrl = activeAbortControllers.get(id);
  if (ctrl) {
    ctrl.abort("paused");
    activeAbortControllers.delete(id);
  }
  const prog = activeProgress.get(id);
  if (prog) {
    prog.status = "paused";
    prog.speedBytesPerSec = 0;
    prog.speedFormatted = "Paused";
    prog.etaFormatted = "--";
    activeProgress.set(id, { ...prog });
    notifyProgress();
  }
}

/**
 * Resumes a paused download
 */
export async function resumeDownload(id: string, forceAllowCellular = false): Promise<void> {
  const item = activeProgress.get(id);
  if (!item || !item.streamUrl) return;
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
 * Pauses all currently active downloads
 */
export function pauseAllDownloads(): void {
  for (const [id, prog] of activeProgress.entries()) {
    if (prog.status === "downloading") {
      pauseDownload(id);
    }
  }
}

/**
 * Resumes all paused downloads sequentially
 */
export async function resumeAllDownloads(forceAllowCellular = false): Promise<void> {
  const pausedIds = Array.from(activeProgress.entries())
    .filter(([_, prog]) => prog.status === "paused")
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
  pausedCount: number;
  aggregateSpeedFormatted: string;
  aggregateSpeedBytesPerSec: number;
  totalDownloadedBytes: number;
  totalExpectedBytes: number;
  overallProgressPercent: number;
} {
  let activeCount = 0;
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
    } else if (prog.status === "paused") {
      pausedCount++;
      totalDownloaded += prog.downloadedBytes;
      totalExpected += prog.totalBytes;
    }
  }

  const overallProgressPercent = totalExpected > 0 ? Math.round((totalDownloaded / totalExpected) * 100) : 0;

  return {
    activeCount,
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
 * Downloads a video segment with automatic proxy fallback and live chunk streaming
 */
async function fetchSegmentData(
  segUrl: string,
  signal: AbortSignal | undefined,
  onChunk?: (chunkLength: number) => void
): Promise<ArrayBuffer> {
  const urlsToTry: string[] = [segUrl];

  // If URL is a proxied URL like `${LOCAL}/seg?u=...`, compute the direct target URL as fallback
  if (segUrl.includes("/seg?u=")) {
    try {
      const match = /[?&]u=([^&]+)/.exec(segUrl);
      if (match && match[1]) {
        const directUrl = decodeURIComponent(match[1]);
        if (directUrl.startsWith("http://") || directUrl.startsWith("https://")) {
          urlsToTry.push(directUrl);
        }
      }
    } catch {
      // ignore
    }
  }

  let lastError: any = null;

  for (const url of urlsToTry) {
    if (signal?.aborted) throw new Error("aborted");
    for (let attempt = 0; attempt <= 2; attempt++) {
      if (signal?.aborted) throw new Error("aborted");

      const timeoutCtrl = new AbortController();
      const timer = setTimeout(() => {
        timeoutCtrl.abort("timeout");
      }, 60000);

      let onAbort: (() => void) | null = null;
      if (signal) {
        onAbort = () => timeoutCtrl.abort("aborted");
        signal.addEventListener("abort", onAbort, { once: true });
      }

      let bytesFromThisAttempt = 0;

      try {
        const res = await fetch(url, { signal: timeoutCtrl.signal });
        if (!res.ok) {
          clearTimeout(timer);
          if (onAbort && signal) signal.removeEventListener("abort", onAbort);
          throw new Error(`HTTP ${res.status}`);
        }

        const reader = res.body?.getReader();
        if (reader) {
          const chunks: Uint8Array[] = [];
          while (true) {
            if (signal?.aborted) {
              void reader.cancel();
              clearTimeout(timer);
              if (onAbort && signal) signal.removeEventListener("abort", onAbort);
              throw new Error("aborted");
            }
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              chunks.push(value);
              bytesFromThisAttempt += value.length;
              if (onChunk) onChunk(value.length);
            }
          }
          clearTimeout(timer);
          if (onAbort && signal) signal.removeEventListener("abort", onAbort);

          const totalLen = chunks.reduce((acc, c) => acc + c.byteLength, 0);
          const combined = new Uint8Array(totalLen);
          let offset = 0;
          for (const c of chunks) {
            combined.set(c, offset);
            offset += c.byteLength;
          }
          return combined.buffer;
        } else {
          const buf = await res.arrayBuffer();
          clearTimeout(timer);
          if (onAbort && signal) signal.removeEventListener("abort", onAbort);
          if (onChunk) onChunk(buf.byteLength);
          return buf;
        }
      } catch (err: any) {
        clearTimeout(timer);
        if (onAbort && signal) signal.removeEventListener("abort", onAbort);
        if (bytesFromThisAttempt > 0 && onChunk) {
          onChunk(-bytesFromThisAttempt);
        }
        if (signal?.aborted || err === "aborted" || (err?.name === "AbortError" && signal?.aborted)) {
          throw new Error("aborted");
        }
        lastError = err;
        await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
      }
    }
  }

  throw lastError || new Error("Failed to download segment after retries");
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

  // Guard mobile data plan on Android
  if (!forceAllowCellular && isWifiOnlyDownloadEnabled() && isCellularConnection()) {
    throw new Error("Cellular connection detected. 'Download on Wi-Fi Only' is enabled.");
  }

  // Guard battery on Android
  if (await isLowBattery()) {
    throw new Error("Battery is low (< 20%). Connect charger to download.");
  }

  // Cancel any existing controller for this item
  const existingCtrl = activeAbortControllers.get(id);
  if (existingCtrl) {
    existingCtrl.abort("restarted");
  }

  const controller = new AbortController();
  activeAbortControllers.set(id, controller);

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
    speedFormatted: "-- KB/s",
    etaSeconds: 0,
    etaFormatted: "--",
    status: "downloading",
    streamUrl,
    quality,
    isHevc,
  });
  notifyProgress();

  let lastSampleTime = performance.now();
  let lastSampleBytes = 0;
  let currentSpeed = 0;
  let lastNotifPct = -1;
  let lastNotifTime = 0;

  if (typeof window !== "undefined" && typeof (window as any).AuraNativeExport?.setDownloadActive === "function") {
    (window as any).AuraNativeExport.setDownloadActive(true);
  }

  const maybeNotifyNative = (pct: number, speedText: string, downloadedBytes: number, totalExpectedBytes: number) => {
    const now = Date.now();
    if (pct !== lastNotifPct && (pct - lastNotifPct >= 2 || now - lastNotifTime > 1200 || pct >= 99)) {
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
    const elapsedSec = (now - lastSampleTime) / 1000;
    if (elapsedSec >= 0.5) {
      currentSpeed = Math.max(0, (receivedBytes - lastSampleBytes) / elapsedSec);
      lastSampleTime = now;
      lastSampleBytes = receivedBytes;
    }
    const remainingBytes = Math.max(0, totalExpectedBytes - receivedBytes);
    const etaSec = currentSpeed > 0 ? Math.round(remainingBytes / currentSpeed) : 0;
    return {
      speedBytesPerSec: currentSpeed,
      speedFormatted: formatSpeed(currentSpeed),
      etaSeconds: etaSec,
      etaFormatted: formatEta(etaSec),
    };
  };

  try {
    // 1. Fetch subtitle track in parallel so subtitles work offline
    let cues: SubtitleCue[] = [];
    try {
      const track = await getSubtitlesForEpisode(videoId, episode, title);
      cues = track.cues;
    } catch {
      // Subtitle fallback if offline or request failed
    }

    if (controller.signal.aborted) return;

    // 2. Fetch the video stream (support HLS .m3u8 & direct stream via local proxy)
    const chunks: Uint8Array[] = [];
    let segmentBuffers: ArrayBuffer[] = [];
    let receivedBytes = 0;
    let mime = "video/mp4";
    const isHls = /\.m3u8(\?|$)/i.test(streamUrl) || streamUrl.includes("/hls?u=");
    let playlistText = "";

    let keyBuffer: ArrayBuffer | undefined = undefined;
    let keyMethod: string | undefined = undefined;
    let keyIv: string | undefined = undefined;

    if (isHls) {
      mime = "video/mp2t";
      let plUrl = streamUrl.startsWith(`${LOCAL}/hls`) || streamUrl.startsWith(`${LOCAL}/seg`)
        ? streamUrl
        : `${LOCAL}/hls?u=${encodeURIComponent(streamUrl)}`;

      let plRes = await fetchWithRetry(plUrl, controller.signal, 3, 300, 15000);
      if (!plRes.ok) {
        throw new Error(`Failed to load playlist: HTTP ${plRes.status}`);
      }
      playlistText = await plRes.text();

      // Master Playlist support: if child variants are present, follow the best variant
      if (playlistText.includes("#EXT-X-STREAM-INF")) {
        const lines = playlistText.split("\n").map((l) => l.trim()).filter(Boolean);
        const variantUrls = lines.filter((l) => !l.startsWith("#"));
        if (variantUrls.length > 0) {
          let variantUrl = variantUrls[0];
          if (!variantUrl.startsWith("http://") && !variantUrl.startsWith("https://") && !variantUrl.startsWith("hg://")) {
            variantUrl = variantUrl.startsWith("/") ? `${LOCAL}${variantUrl}` : `${LOCAL}/${variantUrl}`;
          }
          plRes = await fetchWithRetry(variantUrl, controller.signal, 3, 300, 15000);
          if (plRes.ok) {
            playlistText = await plRes.text();
          }
        }
      }

      const lines = playlistText.split("\n").map((l) => l.trim()).filter(Boolean);

      // Check for AES-128 Encryption Key in the HLS playlist
      const keyLine = lines.find((l) => l.startsWith("#EXT-X-KEY:"));
      if (keyLine) {
        const matchUri = /URI="([^"]+)"/.exec(keyLine);
        const matchMethod = /METHOD=([^,]+)/.exec(keyLine);
        const matchIv = /IV=([^,]+)/.exec(keyLine);
        if (matchMethod) keyMethod = matchMethod[1];
        if (matchIv) keyIv = matchIv[1];
        if (matchUri && matchUri[1]) {
          let rawKeyUrl = matchUri[1];
          if (!rawKeyUrl.startsWith("http://") && !rawKeyUrl.startsWith("https://") && !rawKeyUrl.startsWith("hg://")) {
            rawKeyUrl = rawKeyUrl.startsWith("/") ? `${LOCAL}${rawKeyUrl}` : `${LOCAL}/${rawKeyUrl}`;
          }
          try {
            const keyRes = await fetchWithRetry(rawKeyUrl, controller.signal, 3, 250, 12000);
            if (keyRes.ok) {
              keyBuffer = await keyRes.arrayBuffer();
            }
          } catch {
            // key fallback if network issue
          }
        }
      }

      // Find segment URLs
      const segUrls = lines.filter((l) => !l.startsWith("#"));
      if (segUrls.length === 0) {
        throw new Error("No media segments found in playlist");
      }

      const totalSegments = segUrls.length;
      segmentBuffers = new Array(totalSegments);
      let completedSegments = 0;
      let nextIndex = 0;

      // Mobile network stability: prioritize completion with reliable serial/dual worker
      const CONCURRENCY = isCellularConnection() ? 1 : 2;

      // Provide immediate feedback with initial total size estimation (~1.8MB per segment)
      const initialEstBytes = totalSegments * 1.8 * 1024 * 1024;
      activeProgress.set(id, {
        id,
        videoId,
        episode,
        title,
        cover,
        progress: 1,
        downloadedBytes: 0,
        totalBytes: initialEstBytes,
        speedBytesPerSec: 0,
        speedFormatted: "Connecting...",
        etaSeconds: Math.round(initialEstBytes / (1.5 * 1024 * 1024)),
        etaFormatted: formatEta(Math.round(initialEstBytes / (1.5 * 1024 * 1024))),
        status: "downloading",
        streamUrl,
      });
      notifyProgress();
      maybeNotifyNative(1, "Connecting...", 0, initialEstBytes);
      logLine(`[download] start id=${id} ep=${episode} segments=${totalSegments} estBytes=${initialEstBytes}`);

      const failedIndices: number[] = [];

      const worker = async () => {
        while (nextIndex < totalSegments && !controller.signal.aborted) {
          const i = nextIndex++;
          let segUrl = segUrls[i];
          if (!segUrl.startsWith("http://") && !segUrl.startsWith("https://") && !segUrl.startsWith("hg://")) {
            segUrl = segUrl.startsWith("/") ? `${LOCAL}${segUrl}` : `${LOCAL}/${segUrl}`;
          }
          try {
            const segBuf = await fetchSegmentData(segUrl, controller.signal, (chunkDelta) => {
              receivedBytes += chunkDelta;
              const avgSegBytes = receivedBytes / Math.max(1, completedSegments + 0.5);
              const estTotalBytes = Math.max(receivedBytes, Math.round(avgSegBytes * totalSegments));
              const { speedBytesPerSec, speedFormatted, etaSeconds, etaFormatted } = computeSpeedAndEta(
                receivedBytes,
                estTotalBytes
              );
              const pct = Math.min(99, Math.max(1, Math.round((receivedBytes / estTotalBytes) * 100)));
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
                streamUrl,
              });
              notifyProgress();
              maybeNotifyNative(pct, speedFormatted, receivedBytes, estTotalBytes);
            });
            segmentBuffers[i] = segBuf;
            completedSegments++;

            // Estimated total bytes based on average segment size so far
            const avgSegBytes = receivedBytes / completedSegments;
            const estTotalBytes = Math.round(avgSegBytes * totalSegments);

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
              streamUrl,
            });
            notifyProgress();
            maybeNotifyNative(pct, speedFormatted, receivedBytes, estTotalBytes);
          } catch (segErr) {
            if (controller.signal.aborted) return;
            logLine(`[download] seg failed id=${id} ep=${episode} seg=${i + 1}/${totalSegments} err=${segErr}`);
            failedIndices.push(i);
          }
        }
      };

      const workers = Array.from({ length: Math.min(CONCURRENCY, totalSegments) }, () => worker());
      await Promise.all(workers);

      // Retry any segments that failed during parallel worker phase
      if (failedIndices.length > 0 && !controller.signal.aborted) {
        logLine(`[download] retrying ${failedIndices.length} failed segments id=${id}`);
        for (const i of failedIndices) {
          if (controller.signal.aborted) break;
          let segUrl = segUrls[i];
          if (!segUrl.startsWith("http://") && !segUrl.startsWith("https://") && !segUrl.startsWith("hg://")) {
            segUrl = segUrl.startsWith("/") ? `${LOCAL}${segUrl}` : `${LOCAL}/${segUrl}`;
          }
          const segBuf = await fetchSegmentData(segUrl, controller.signal, (chunkDelta) => {
            receivedBytes += chunkDelta;
          });
          segmentBuffers[i] = segBuf;
          completedSegments++;
        }
      }

      if (completedSegments < totalSegments && !controller.signal.aborted) {
        throw new Error(`Incomplete download: ${completedSegments}/${totalSegments} segments retrieved`);
      }
    } else {
      // Direct video stream (mp4 / m4v / webm)
      const downloadUrl = streamUrl.startsWith(`${LOCAL}/`) || streamUrl.startsWith("hg://")
        ? streamUrl
        : `${LOCAL}/seg?u=${encodeURIComponent(streamUrl)}`;

      const response = await fetchWithRetry(downloadUrl, controller.signal, 3, 400, 60000);
      if (!response.ok) {
        throw new Error(`Failed to download stream: HTTP ${response.status}`);
      }

      const contentLength = Number(response.headers.get("content-length")) || 0;
      mime = response.headers.get("content-type") || "video/mp4";
      const reader = response.body?.getReader();

      if (reader) {
        while (true) {
          if (controller.signal.aborted) {
            void reader.cancel();
            return;
          }
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            chunks.push(value);
            receivedBytes += value.length;
            const pct = contentLength ? Math.min(99, Math.round((receivedBytes / contentLength) * 100)) : 50;

            const { speedBytesPerSec, speedFormatted, etaSeconds, etaFormatted } = computeSpeedAndEta(
              receivedBytes,
              contentLength || receivedBytes
            );

            activeProgress.set(id, {
              id,
              videoId,
              episode,
              title,
              cover,
              progress: pct,
              downloadedBytes: receivedBytes,
              totalBytes: contentLength || receivedBytes,
              speedBytesPerSec,
              speedFormatted,
              etaSeconds,
              etaFormatted,
              status: "downloading",
              streamUrl,
            });
            notifyProgress();
            maybeNotifyNative(pct, speedFormatted, receivedBytes, contentLength || receivedBytes);
          }
        }
      } else {
        const blob = await response.blob();
        chunks.push(new Uint8Array(await blob.arrayBuffer()));
        receivedBytes = blob.size;
      }
    }

    if (controller.signal.aborted) return;

    const finalBlob = isHls ? null : new Blob(chunks as BlobPart[], { type: mime });
    const totalSize = isHls ? receivedBytes : (finalBlob?.size || 0);

    // 3. Save to IndexedDB
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
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
        segments: isHls ? segmentBuffers : undefined,
        keyBuffer,
        keyMethod,
        keyIv,
        blob: finalBlob || undefined,
        sizeBytes: totalSize,
        cues,
        quality,
        isHevc,
      };
      const req = store.put(record);
      req.onsuccess = () => {
        db.close();
        resolve();
      };
      req.onerror = () => {
        db.close();
        reject(req.error);
      };
    });

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
    });
    saveOfflineEpisodesList(list);

    activeAbortControllers.delete(id);
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
      streamUrl,
    });
    notifyProgress();
    notifyNativeDownloadComplete(videoId, episode, title, formatBytes(totalSize));
    logLine(`[download] finished id=${id} ep=${episode} size=${formatBytes(totalSize)}`);

    setTimeout(() => {
      activeProgress.delete(id);
      notifyProgress();
    }, 2500);
  } catch (err: unknown) {
    activeAbortControllers.delete(id);
    notifyNativeDownloadCancel(videoId, episode);
    logLine(`[download] error id=${id} ep=${episode} err=${(err as Error)?.message || String(err)}`);
    const error = err as { name?: string };
    if (error?.name === "AbortError" || controller.signal.aborted) {
      if (controller.signal.reason === "paused") {
        return;
      }
      activeProgress.delete(id);
      notifyProgress();
      return;
    }

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
      error: (err as Error).message || "Download failed",
      streamUrl,
    });
    notifyProgress();
    throw err;
  }
}

async function deleteFromDb(dbName: string, id: string): Promise<void> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve();
      return;
    }
    const req = indexedDB.open(dbName);
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.close();
        resolve();
        return;
      }
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const delReq = store.delete(id);
      delReq.onsuccess = () => { db.close(); resolve(); };
      delReq.onerror = () => { db.close(); resolve(); };
    };
    req.onerror = () => resolve();
  });
}

async function clearDb(dbName: string): Promise<void> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve();
      return;
    }
    const req = indexedDB.open(dbName);
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.close();
        resolve();
        return;
      }
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const clearReq = store.clear();
      clearReq.onsuccess = () => { db.close(); resolve(); };
      clearReq.onerror = () => { db.close(); resolve(); };
    };
    req.onerror = () => resolve();
  });
}

/**
 * Deletes an offline episode from storage
 */
export async function deleteOfflineEpisode(videoId: number, episode: number): Promise<void> {
  const id = `${videoId}_${episode}`;
  try {
    await deleteFromDb(DB_NAME, id);
    await deleteFromDb("aurastream_offline_db", id);
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
  for (const id of idsToDelete) {
    try {
      await deleteFromDb(DB_NAME, id);
      await deleteFromDb("aurastream_offline_db", id);
    } catch {
      // ignore
    }
  }

  const list = getOfflineEpisodes().filter((it) => !idsToDelete.has(it.id));
  saveOfflineEpisodesList(list);
}

/**
 * Wipes all downloaded episodes from IndexedDB and metadata
 */
export async function clearAllOfflineDownloads(): Promise<void> {
  try {
    await clearDb(DB_NAME);
    await clearDb("aurastream_offline_db");
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
    return val === null ? true : val === "true"; // default on
  } catch {
    return true;
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
    const streamUrl = info?.streams?.main || info?.video_url;
    if (streamUrl) {
      void startEpisodeDownload(
        currentVideoId,
        nextEp,
        meta.title || `Episode ${nextEp}`,
        meta.cover || "",
        streamUrl
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

export interface BatchProgressState {
  active: boolean;
  videoId: number;
  title: string;
  total: number;
  completed: number;
  currentEpisode: number;
  failedCount: number;
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

let batchCancelled = false;
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

export function cancelBatchDownload(): void {
  batchCancelled = true;
  if (batchState.active && batchState.videoId && batchState.currentEpisode) {
    cancelDownload(`${batchState.videoId}_${batchState.currentEpisode}`);
  }
  batchState.active = false;
  notifyBatchProgress();
}

export async function executeBatchDownload(
  videoId: number,
  title: string,
  cover: string,
  episodeNumbers: number[],
  forceAllowCellular = false,
  qualityPreference: DownloadQuality = getDownloadQualityPreference()
): Promise<{ success: number; failed: number }> {
  if (batchState.active) {
    throw new Error("A batch download is already in progress");
  }

  const unDownloaded = episodeNumbers.filter((ep) => !isEpisodeDownloaded(videoId, ep));
  if (unDownloaded.length === 0) {
    return { success: 0, failed: 0 };
  }

  batchCancelled = false;
  batchState = {
    active: true,
    videoId,
    title,
    total: unDownloaded.length,
    completed: 0,
    currentEpisode: unDownloaded[0],
    failedCount: 0,
  };
  notifyBatchProgress();

  let success = 0;
  let failed = 0;

  for (let i = 0; i < unDownloaded.length; i++) {
    if (batchCancelled) break;
    const ep = unDownloaded[i];
    batchState.currentEpisode = ep;
    notifyBatchProgress();

    try {
      const info = await api.play(videoId, ep);
      const streamRes = resolveStreamUrlForQuality(info, qualityPreference);
      if (!streamRes?.url) throw new Error("No stream URL");

      await startEpisodeDownload(
        videoId,
        ep,
        title,
        cover,
        streamRes.url,
        forceAllowCellular,
        streamRes.quality,
        streamRes.isHevc
      );
      success++;
      batchState.completed = success;
    } catch {
      failed++;
      batchState.failedCount = failed;
    }
    notifyBatchProgress();
  }

  batchState.active = false;
  notifyBatchProgress();
  return { success, failed };
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
    if (typeof window !== "undefined" && typeof window.AuraNativeExport?.getStorageInfo === "function") {
      const raw = window.AuraNativeExport.getStorageInfo();
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
  quotaBytes: number;
  quotaFormatted: string;
  usageBytes: number;
  usageFormatted: string;
  freeBytes: number;
  freeFormatted: string;
  percentUsed: number;
}

export async function getDetailedStorageStats(): Promise<DeviceStorageStats> {
  const list = getOfflineEpisodes();
  const offlineBytes = list.reduce((acc, item) => acc + (item.sizeBytes || 0), 0);
  const offlineFormatted = formatBytes(offlineBytes);

  let quotaBytes = 0;
  let usageBytes = 0;

  if (typeof navigator !== "undefined" && navigator.storage && navigator.storage.estimate) {
    try {
      const est = await navigator.storage.estimate();
      quotaBytes = est.quota || 0;
      usageBytes = est.usage || 0;
    } catch {
      // ignore
    }
  }

  if (quotaBytes === 0) {
    quotaBytes = 64 * 1024 * 1024 * 1024; // 64 GB standard Android phone baseline
    usageBytes = offlineBytes;
  }

  const freeBytes = Math.max(0, quotaBytes - usageBytes);
  const percentUsed = Math.min(100, Math.round((usageBytes / quotaBytes) * 100));

  return {
    offlineCount: list.length,
    offlineBytes,
    offlineFormatted,
    quotaBytes,
    quotaFormatted: formatBytes(quotaBytes),
    usageBytes,
    usageFormatted: formatBytes(usageBytes),
    freeBytes,
    freeFormatted: formatBytes(freeBytes),
    percentUsed,
  };
}
