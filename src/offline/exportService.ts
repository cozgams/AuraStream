import { formatDramaTitle } from "../subtitles/dramaTranslator";
import { getOfflineEpisodes } from "./downloadService";
import { exportToSrt, exportToVtt, getSubtitlesForEpisode } from "../subtitles/aiSubtitleService";

export interface StorageInfo {
  hasSdCard: boolean;
  sdCardPath: string;
  sdFreeBytes: number;
  primaryFreeBytes: number;
}

interface NativeExportBridge {
  isAvailable(): boolean;
  getStorageInfo?(): string;
  beginExport(fileName: string): boolean;
  writeChunk(base64Chunk: string): boolean;
  finishExport(fileName: string, dramaTitle: string, action: string): string;
  openInGallery?(pathOrUri: string): boolean;
  getLastExportedUri?(): string;
  exportSubtitleText?(fileName: string, content: string, action: string): string;
  updateDownloadNotification?(id: number, title: string, subtitle: string, progress: number, speedFormatted: string): void;
  showDownloadCompleteNotification?(id: number, title: string, subtitle: string): void;
  cancelDownloadNotification?(id: number): void;
  isPictureInPictureSupported?(): boolean;
  enterPictureInPicture?(): boolean;
  enterPictureInPictureWithAspect?(num: number, den: number): boolean;
  setAutoPip?(enabled: boolean): void;
  vibrateHaptic?(type: string): void;
  setKeepScreenOn?(keepOn: boolean): void;
}

declare global {
  interface Window {
    AuraNativeExport?: NativeExportBridge;
  }
}

export function openInGallery(pathOrUri?: string): boolean {
  if (typeof window !== "undefined" && typeof window.AuraNativeExport?.openInGallery === "function") {
    return window.AuraNativeExport.openInGallery(pathOrUri || "");
  }
  return false;
}

export function getLastExportedUri(): string {
  if (typeof window !== "undefined" && typeof window.AuraNativeExport?.getLastExportedUri === "function") {
    return window.AuraNativeExport.getLastExportedUri() || "";
  }
  return "";
}

export async function processSubtitleExport(
  videoId: number,
  episode: number,
  format: "srt" | "vtt" = "srt",
  title?: string,
  lang: "en" = "en",
  action: "save_movies" | "save_downloads" = "save_movies"
): Promise<{ success: boolean; fileName: string; savedPath?: string; error?: string }> {
  try {
    const track = await getSubtitlesForEpisode(videoId, episode, title);
    const cleanTitle = formatDramaTitle(title || `Episode_${episode}`);
    const safeTitle = sanitizeFileName(cleanTitle);
    const ext = format === "srt" ? "srt" : "vtt";
    const fileName = `${safeTitle}_Ep${episode}.${ext}`;
    const content = format === "srt" ? exportToSrt(track, lang) : exportToVtt(track, lang);

    if (isNativeExportSupported() && typeof window.AuraNativeExport?.exportSubtitleText === "function") {
      const result = window.AuraNativeExport.exportSubtitleText(fileName, content, action);
      if (result.startsWith("ERROR:")) {
        return { success: false, fileName, error: result.replace("ERROR:", "") };
      }
      const savedPath = result.startsWith("SUCCESS:") ? result.replace("SUCCESS:", "") : result;
      return { success: true, fileName, savedPath };
    }

    // Web / Desktop Fallback
    const mime = format === "srt" ? "application/x-subrip" : "text/vtt";
    const blob = new Blob([content], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    setTimeout(() => URL.revokeObjectURL(url), 10000);

    return { success: true, fileName, savedPath: `Downloads/${fileName}` };
  } catch (e: any) {
    return { success: false, fileName: `Episode_${episode}.${format}`, error: e?.message || "Failed to export subtitle" };
  }
}

export function getDeviceStorageInfo(): StorageInfo {
  if (typeof window !== "undefined" && typeof window.AuraNativeExport?.getStorageInfo === "function") {
    try {
      const raw = window.AuraNativeExport.getStorageInfo();
      return JSON.parse(raw);
    } catch {
      // fallback
    }
  }
  return { hasSdCard: false, sdCardPath: "", sdFreeBytes: 0, primaryFreeBytes: 0 };
}

const DB_NAME = "AuraStreamOfflineDB";
const STORE_NAME = "episodes";

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is not supported on this device"));
      return;
    }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("IndexedDB open blocked"));
  });
}

export function isNativeExportSupported(): boolean {
  return typeof window !== "undefined" && typeof window.AuraNativeExport?.isAvailable === "function";
}

function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || "Episode";
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000; // 32KB chunks for high performance without call stack overflow
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return btoa(binary);
}

async function getRecordFromDB(dbName: string, id: string): Promise<any> {
  return new Promise((resolve) => {
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
}

async function getEpisodeBlob(videoId: number, episode: number): Promise<{ blob: Blob; fileName: string; title: string }> {
  const id = `${videoId}_${episode}`;
  let record = await getRecordFromDB(DB_NAME, id);
  if (!record) {
    // Check legacy database
    record = await getRecordFromDB("aurastream_offline_db", id);
  }

  if (!record) {
    throw new Error(`Episode ${episode} not found in offline storage`);
  }

  let blob: Blob;
  if (record.isHls && record.segments && record.segments.length > 0) {
    blob = new Blob(record.segments, { type: "video/mp4" });
  } else if (record.blob) {
    blob = record.blob;
  } else {
    throw new Error(`No video data stored for episode ${episode}`);
  }

  const meta = getOfflineEpisodes().find((it) => it.id === id);
  const rawTitle = meta?.title || record.title || `Episode_${episode}`;
  const cleanTitle = formatDramaTitle(rawTitle);
  const safeTitle = sanitizeFileName(cleanTitle);
  const fileName = `${safeTitle}_Ep${episode}.mp4`;

  return { blob, fileName, title: cleanTitle };
}

export type ExportAction = "save" | "save_movies" | "save_downloads" | "save_sdcard" | "share" | "open";

export interface ExportResult {
  success: boolean;
  fileName: string;
  action: ExportAction;
  savedPath?: string;
  error?: string;
}

export async function processEpisodeExport(
  videoId: number,
  episode: number,
  action: ExportAction,
  onProgress?: (progressPct: number) => void,
  options?: { includeSubtitles?: boolean; subtitleFormat?: "srt" | "vtt" }
): Promise<ExportResult> {
  const { blob, fileName, title } = await getEpisodeBlob(videoId, episode);

  if (isNativeExportSupported()) {
    const bridge = window.AuraNativeExport!;
    const started = bridge.beginExport(fileName);
    if (!started) {
      throw new Error("Native storage bridge failed to initialize file export");
    }

    const CHUNK_SIZE = 1024 * 1024; // 1 MB slices
    const totalBytes = blob.size;
    let offset = 0;

    while (offset < totalBytes) {
      const slice = blob.slice(offset, offset + CHUNK_SIZE);
      const arrayBuf = await slice.arrayBuffer();
      const base64Chunk = arrayBufferToBase64(arrayBuf);

      const ok = bridge.writeChunk(base64Chunk);
      if (!ok) {
        throw new Error("Failed to write video stream chunk to native storage");
      }

      offset += slice.size;
      const pct = Math.min(99, Math.round((offset / totalBytes) * 100));
      onProgress?.(pct);
    }

    const result = bridge.finishExport(fileName, title, action);
    onProgress?.(100);

    if (result.startsWith("ERROR:")) {
      return { success: false, fileName, action, error: result.replace("ERROR:", "") };
    }

    let savedPath = fileName;
    if (result.startsWith("SUCCESS:")) {
      savedPath = result.replace("SUCCESS:", "");
    } else if (result.startsWith("SAVED_LOCAL:")) {
      savedPath = result.replace("SAVED_LOCAL:", "");
    }

    // Auto-export matching subtitles alongside video if enabled
    if (options?.includeSubtitles && (action === "save_movies" || action === "save" || action === "save_downloads")) {
      try {
        await processSubtitleExport(
          videoId,
          episode,
          options.subtitleFormat || "srt",
          title,
          "en",
          action === "save_downloads" ? "save_downloads" : "save_movies"
        );
      } catch {
        // non-fatal
      }
    }

    return {
      success: true,
      fileName,
      action,
      savedPath,
    };
  }

  // Desktop / Browser Fallback
  onProgress?.(50);
  if (action === "share" && typeof navigator !== "undefined" && typeof navigator.share === "function") {
    try {
      const file = new File([blob], fileName, { type: "video/mp4" });
      await navigator.share({
        title,
        text: `Watch ${title} - Episode ${episode}`,
        files: [file],
      });
      onProgress?.(100);
      return { success: true, fileName, action };
    } catch (e: any) {
      if (e?.name === "AbortError") {
        return { success: true, fileName, action };
      }
      // fallback to download
    }
  }

  // Trigger standard browser/desktop download
  const url = URL.createObjectURL(blob);
  if (action === "open") {
    window.open(url, "_blank");
    onProgress?.(100);
    setTimeout(() => {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // ignore
      }
    }, 60000);
    return { success: true, fileName, action, savedPath: url };
  }

  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 10000);

  onProgress?.(100);
  return {
    success: true,
    fileName,
    action: "save",
    savedPath: `Downloads/${fileName}`,
  };
}
