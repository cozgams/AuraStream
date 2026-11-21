import { invoke } from "@tauri-apps/api/core";
import { LOCAL } from "../api";
import { formatDramaTitle } from "../subtitles/dramaTranslator";
import { getOfflineEpisodes } from "./downloadService";
import { exportToSrt, exportToVtt, getSubtitlesForEpisode } from "../subtitles/aiSubtitleService";

export interface StorageInfo {
  hasSdCard: boolean;
  sdCardPath: string;
  sdFreeBytes: number;
  primaryFreeBytes: number;
}

export interface AndroidPermissionsStatus {
  notificationsGranted: boolean;
  batteryOptimizationIgnored: boolean;
  canInstallPackages: boolean;
  storageGranted: boolean;
  androidSdk: number;
  manufacturer: string;
}

export interface NativeExportBridge {
  isAvailable(): boolean;
  isCellularNetwork?(): boolean;
  setDownloadActiveCount?(count: number): void;
  setDownloadActive?(active: boolean): void;
  updateDownloadNotification?(
    id: number,
    title: string,
    subtitle: string,
    progress: number,
    speedFormatted: string,
    fileSizeFormatted?: string
  ): void;
  showDownloadCompleteNotification?(
    id: number,
    title: string,
    subtitle: string,
    fileSizeFormatted?: string
  ): void;
  cancelDownloadNotification?(id: number): void;
  getStorageInfo?(): string;
  saveAppState?(data: string): boolean;
  loadAppState?(): string;
  setKeepScreenOn?(keepOn: boolean): void;
  vibrateHaptic?(type: string): void;
  setOrientation?(landscape: boolean): void;
  beginExport(fileName: string): boolean;
  writeChunk(base64Chunk: string): boolean;
  finishExport(fileName: string, dramaTitle: string, action: string): string;
  exportLocalFile?(sourcePath: string, fileName: string, dramaTitle: string, action: string): string;
  exportSubtitleText?(fileName: string, content: string, action: string): string;
  getLastExportedUri?(): string;
  openInGallery?(pathOrUri?: string): boolean;
  isPictureInPictureSupported?(): boolean;
  enterPictureInPicture?(): boolean;
  enterPictureInPictureWithAspect?(num: number, den: number): boolean;
  setAutoPip?(enabled: boolean): void;
  getDeviceAbi?(): string;
  canInstallPackages?(): boolean;
  openInstallPermissionSettings?(): boolean;
  startOtaDownload?(url: string, fileName: string): boolean;
  cancelOtaDownload?(): boolean;
  installDownloadedApk?(filePath: string): string;
  getPermissionsStatus?(): string;
  requestNotificationPermissionNow?(): boolean;
  requestIgnoreBatteryOptimizations?(): boolean;
  requestLegacyStoragePermission?(): boolean;
  openAppSettings?(): boolean;
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
  action: "save_movies" | "save_downloads" = "save_downloads",
  streamUrl?: string,
  fallbackCues?: { id: number; start: number; end: number; en?: string; zh?: string }[]
): Promise<{ success: boolean; fileName: string; savedPath?: string; error?: string }> {
  try {
    let track = await getSubtitlesForEpisode(videoId, episode, title, undefined, streamUrl);
    if ((!track?.cues?.length) && fallbackCues && fallbackCues.length > 0) {
      track = {
        videoId,
        episode,
        cues: fallbackCues.map((c, idx) => ({
          id: c.id || idx + 1,
          start: c.start,
          end: c.end,
          en: c.en || c.zh || "",
          zh: c.zh || c.en || "",
        })),
        source: "native_track",
        generatedAt: Date.now(),
      };
    }
    const cleanTitle = formatDramaTitle(title || `Episode_${episode}`);
    const safeTitle = sanitizeFileName(cleanTitle);
    const ext = format === "srt" ? "srt" : "vtt";
    const fileName = `${safeTitle}_Ep${episode}.${ext}`;
    if (!track?.cues?.length) {
      return { success: false, fileName, error: "No subtitle track available for this episode" };
    }
    const content = format === "srt" ? exportToSrt(track, lang) : exportToVtt(track, lang);

    if (isNativeExportSupported() && typeof window.AuraNativeExport?.exportSubtitleText === "function") {
      const result = window.AuraNativeExport.exportSubtitleText(fileName, content, action);
      if (result.startsWith("ERROR:")) {
        return { success: false, fileName, error: result.replace("ERROR:", "") };
      }
      if (result === "UNKNOWN_ACTION") {
        return { success: false, fileName, error: "Unsupported subtitle export action" };
      }
      let savedPath = result;
      if (result.startsWith("SUCCESS:")) {
        savedPath = result.replace("SUCCESS:", "");
      } else if (result.startsWith("SAVED_LOCAL:")) {
        savedPath = result.replace("SAVED_LOCAL:", "");
      }
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
    return {
      success: false,
      fileName: `Episode_${episode}.${format}`,
      error: e?.message || "Failed to export subtitle",
    };
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

export function getAndroidPermissionsStatus(): AndroidPermissionsStatus | null {
  if (typeof window === "undefined") return null;
  const bridge = window.AuraNativeExport;
  if (!bridge || typeof bridge.getPermissionsStatus !== "function") return null;
  try {
    const raw = bridge.getPermissionsStatus();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AndroidPermissionsStatus>;
    return {
      notificationsGranted: Boolean(parsed.notificationsGranted),
      batteryOptimizationIgnored: Boolean(parsed.batteryOptimizationIgnored),
      canInstallPackages: Boolean(parsed.canInstallPackages),
      storageGranted: parsed.storageGranted !== false,
      androidSdk: Number(parsed.androidSdk) || 0,
      manufacturer: String(parsed.manufacturer || ""),
    };
  } catch {
    return null;
  }
}

const DB_NAME = "AuraStreamOfflineDB";
const LEGACY_DB_NAME = "aurastream_offline_db";
const STORE_NAME = "episodes";

export function isNativeExportSupported(): boolean {
  if (typeof window === "undefined") return false;
  const bridge = window.AuraNativeExport;
  if (!bridge || typeof bridge.isAvailable !== "function") return false;
  try {
    return Boolean(bridge.isAvailable());
  } catch {
    return false;
  }
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

async function getRecordFromDB(dbName: string, id: string): Promise<any> {
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
    };
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

function splitHlsAttributes(attrList: string): string[] {
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

export function parseExtXKey(line: string): { method: string; uri?: string; iv?: string } {
  const colonIdx = line.indexOf(":");
  if (colonIdx < 0) return { method: "" };
  const attrs = splitHlsAttributes(line.slice(colonIdx + 1));
  let method = "";
  let uri: string | undefined;
  let iv: string | undefined;

  for (const attr of attrs) {
    const eqIdx = attr.indexOf("=");
    if (eqIdx < 0) continue;
    const k = attr.slice(0, eqIdx).trim().toUpperCase();
    let v = attr.slice(eqIdx + 1).trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
      v = v.slice(1, -1);
    }
    if (k === "METHOD") method = v.toUpperCase();
    else if (k === "URI") uri = v;
    else if (k === "IV") iv = v;
  }

  return { method, uri, iv };
}

export function parseHlsIv(ivStr: string): Uint8Array {
  let hex = ivStr.trim();
  if (hex.startsWith("0x") || hex.startsWith("0X")) {
    hex = hex.slice(2);
  }
  if (!/^[0-9a-fA-F]{1,32}$/.test(hex)) {
    throw new Error(`Invalid HLS AES-128 IV: ${ivStr}`);
  }
  const padded = hex.padStart(32, "0");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function sequenceToIv(seq: number): Uint8Array {
  const iv = new Uint8Array(16);
  const view = new DataView(iv.buffer);
  const high = Math.floor(seq / 0x100000000) >>> 0;
  const low = seq >>> 0;
  view.setUint32(8, high, false);
  view.setUint32(12, low, false);
  return iv;
}

async function toArrayBuffer(data: unknown): Promise<ArrayBuffer> {
  if (data instanceof Blob) {
    return await data.arrayBuffer();
  }
  if (data instanceof ArrayBuffer) {
    return data;
  }
  if (ArrayBuffer.isView(data)) {
    const copy = new Uint8Array(data.byteLength);
    copy.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    return copy.buffer;
  }
  throw new Error("Unsupported offline media segment format");
}

async function buildHlsExportBlob(record: any, episode: number): Promise<Blob> {
  const segments: unknown[] = record.segments || [];
  if (segments.length === 0) {
    throw new Error(`No video segments stored for episode ${episode}`);
  }

  const lines = typeof record.playlistText === "string"
    ? record.playlistText.split(/\r?\n/).map((l: string) => l.trim()).filter(Boolean)
    : [];

  let mediaSequence = 0;
  let currentMethod = "";
  let currentIv: string | undefined;
  let currentKeyUri: string | undefined;
  let sawPlaylistKeyTag = false;

  const segmentKeyMeta: Array<{ method: string; iv?: string; keyUri?: string }> = [];

  for (const line of lines) {
    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      const parsedSeq = parseInt(line.slice("#EXT-X-MEDIA-SEQUENCE:".length).trim(), 10);
      if (Number.isFinite(parsedSeq) && parsedSeq >= 0) {
        mediaSequence = parsedSeq;
      }
    } else if (line.startsWith("#EXT-X-KEY:")) {
      sawPlaylistKeyTag = true;
      const parsedKey = parseExtXKey(line);
      currentMethod = parsedKey.method;
      currentIv = parsedKey.iv;
      currentKeyUri = parsedKey.uri;
    } else if (!line.startsWith("#")) {
      segmentKeyMeta.push({
        method: currentMethod,
        iv: currentIv,
        keyUri: currentKeyUri,
      });
    }
  }

  const fallbackMethod = typeof record.keyMethod === "string" ? record.keyMethod.trim().toUpperCase() : "";
  const fallbackIv = typeof record.keyIv === "string" ? record.keyIv.trim() : undefined;

  const resolveSegMeta = (index: number): { method: string; iv?: string; keyUri?: string } => {
    if (sawPlaylistKeyTag && index < segmentKeyMeta.length) {
      return segmentKeyMeta[index];
    }
    return {
      method: fallbackMethod || (record.keyBuffer ? "AES-128" : "NONE"),
      iv: fallbackIv,
      keyUri: undefined,
    };
  };

  let needsAes128 = false;
  const distinctAesKeyUris = new Set<string>();

  for (let i = 0; i < segments.length; i++) {
    const meta = resolveSegMeta(i);
    const method = meta.method || "NONE";
    if (method === "NONE" || method === "") {
      continue;
    }
    if (method === "AES-128") {
      needsAes128 = true;
      if (meta.keyUri) distinctAesKeyUris.add(meta.keyUri);
      continue;
    }
    throw new Error(`Unsupported HLS encryption method "${method}" cannot be exported`);
  }

  const cryptoKeyCache = new Map<string, CryptoKey>();
  if (needsAes128) {
    if (typeof crypto === "undefined" || !crypto.subtle) {
      throw new Error("WebCrypto AES-128 decryption is unavailable in this environment");
    }

    const keyBuffersMap: Record<string, unknown> | undefined =
      record.keyBuffers && typeof record.keyBuffers === "object" ? record.keyBuffers : undefined;

    if (distinctAesKeyUris.size > 1 && !keyBuffersMap) {
      throw new Error("Multi-key encrypted HLS export is not supported without per-key buffers");
    }

    const loadCryptoKey = async (keyUri?: string): Promise<CryptoKey> => {
      const cacheId = keyUri || "__default__";
      const existing = cryptoKeyCache.get(cacheId);
      if (existing) return existing;

      const rawKey = (keyUri && keyBuffersMap ? keyBuffersMap[keyUri] : undefined) ?? record.keyBuffer;
      if (!rawKey) {
        throw new Error("Missing AES-128 decryption key for offline HLS export");
      }
      const keyBytes = await toArrayBuffer(rawKey);
      if (keyBytes.byteLength !== 16) {
        throw new Error(`Invalid AES-128 decryption key length (${keyBytes.byteLength} bytes)`);
      }
      const imported = await crypto.subtle.importKey(
        "raw",
        keyBytes,
        { name: "AES-CBC" },
        false,
        ["decrypt"]
      );
      cryptoKeyCache.set(cacheId, imported);
      return imported;
    };

    if (distinctAesKeyUris.size === 0) {
      await loadCryptoKey(undefined);
    } else {
      for (const uri of distinctAesKeyUris) {
        await loadCryptoKey(uri);
      }
    }
  }

  const parts: BlobPart[] = [];

  // Prepend initialization segment (#EXT-X-MAP) if present (unencrypted per RFC 8216)
  if (record.initSegment) {
    const initBuf = await toArrayBuffer(record.initSegment);
    if (initBuf.byteLength > 0) {
      parts.push(new Blob([initBuf], { type: "video/mp4" }));
    }
  } else if (Array.isArray(record.mapSegments) && record.mapSegments.length > 0 && record.mapSegments[0]?.blob) {
    const initBuf = await toArrayBuffer(record.mapSegments[0].blob);
    if (initBuf.byteLength > 0) {
      parts.push(new Blob([initBuf], { type: "video/mp4" }));
    }
  }

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg == null) {
      throw new Error(`Missing segment ${i + 1} of ${segments.length} for episode ${episode}`);
    }

    const meta = resolveSegMeta(i);
    const method = meta.method || "NONE";

    if (method === "AES-128") {
      const cacheId = meta.keyUri || "__default__";
      const cryptoKey = cryptoKeyCache.get(cacheId);
      if (!cryptoKey) {
        throw new Error("Missing AES-128 decryption key for offline HLS export");
      }
      const segBuf = await toArrayBuffer(seg);
      if (segBuf.byteLength === 0) continue;
      const iv = meta.iv ? parseHlsIv(meta.iv) : sequenceToIv(mediaSequence + i);
      try {
        const decryptedBuf = await crypto.subtle.decrypt(
          { name: "AES-CBC", iv: iv as BufferSource },
          cryptoKey,
          segBuf
        );
        if (decryptedBuf.byteLength > 0) {
          parts.push(new Blob([decryptedBuf], { type: "video/mp2t" }));
        }
      } catch (err: any) {
        throw new Error(
          `Failed to decrypt HLS segment ${i + 1}: ${err?.message || "AES-128-CBC decryption error"}`
        );
      }
    } else {
      if (seg instanceof Blob) {
        if (seg.size > 0) parts.push(seg);
      } else {
        const buf = await toArrayBuffer(seg);
        if (buf.byteLength > 0) {
          parts.push(new Blob([buf], { type: "video/mp2t" }));
        }
      }
    }
  }

  const blob = new Blob(parts, { type: "video/mp4" });
  if (blob.size <= 0) {
    throw new Error(`Exported video for episode ${episode} is empty (0 bytes)`);
  }
  return blob;
}

async function getEpisodeBlob(videoId: number, episode: number): Promise<{ blob: Blob; fileName: string; title: string }> {
  const id = `${videoId}_${episode}`;
  const meta = getOfflineEpisodes().find((it) => it.id === id);
  let record = await getRecordFromDB(DB_NAME, id);
  if (!record) {
    record = await getRecordFromDB(LEGACY_DB_NAME, id);
  }

  let blob: Blob;
  if (record) {
    if (record.isHls && record.segments && record.segments.length > 0) {
      blob = await buildHlsExportBlob(record, episode);
    } else if (record.blob) {
      blob = record.blob instanceof Blob ? record.blob : new Blob([await toArrayBuffer(record.blob)], { type: "video/mp4" });
      if (blob.size <= 0) {
        throw new Error(`Stored video for episode ${episode} is empty (0 bytes)`);
      }
    } else {
      throw new Error(`No video data stored for episode ${episode}`);
    }
  } else if (meta?.storage === "native") {
    // Native-stored episode fallback (e.g. desktop Tauri without Android exportLocalFile bridge)
    if (!meta.isHls) {
      const res = await fetch(`${LOCAL}/offline/${id}/video.mp4`);
      if (!res.ok) {
        throw new Error(`Offline video fetch failed: HTTP ${res.status}`);
      }
      blob = await res.blob();
      if (blob.size <= 0) {
        throw new Error(`Stored video for episode ${episode} is empty (0 bytes)`);
      }
    } else {
      const plRes = await fetch(`${LOCAL}/offline/${id}/index.m3u8`);
      if (!plRes.ok) {
        throw new Error(`Offline playlist fetch failed: HTTP ${plRes.status}`);
      }
      const playlistText = await plRes.text();
      const lines = playlistText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const segUris = lines.filter((l) => !l.startsWith("#"));
      if (segUris.length === 0) {
        throw new Error(`No video segments stored for episode ${episode}`);
      }
      const resolveNativeFile = (rawUri: string) =>
        rawUri.startsWith("http://") || rawUri.startsWith("https://") || rawUri.startsWith("hg://")
          ? rawUri
          : `${LOCAL}/offline/${id}/${rawUri.replace(/^\/+/, "")}`;

      const keyBuffers: Record<string, ArrayBuffer> = {};
      let firstKeyBuf: ArrayBuffer | undefined;
      for (const line of lines) {
        if (line.startsWith("#EXT-X-KEY:")) {
          const parsed = parseExtXKey(line);
          if (parsed.method === "AES-128" && parsed.uri && !keyBuffers[parsed.uri]) {
            const kRes = await fetch(resolveNativeFile(parsed.uri));
            if (!kRes.ok) throw new Error(`Failed loading decryption key (${kRes.status})`);
            const kBuf = await kRes.arrayBuffer();
            keyBuffers[parsed.uri] = kBuf;
            if (!firstKeyBuf) firstKeyBuf = kBuf;
          }
        }
      }

      let initSegment: ArrayBuffer | undefined;
      for (const line of lines) {
        if (line.startsWith("#EXT-X-MAP:")) {
          const parsed = parseExtXKey(line);
          if (parsed.uri) {
            const mRes = await fetch(resolveNativeFile(parsed.uri));
            if (mRes.ok) initSegment = await mRes.arrayBuffer();
          }
          break;
        }
      }

      const segments: Blob[] = [];
      for (const seg of segUris) {
        const sRes = await fetch(resolveNativeFile(seg));
        if (!sRes.ok) throw new Error(`Failed reading offline segment (${sRes.status})`);
        segments.push(await sRes.blob());
      }
      blob = await buildHlsExportBlob(
        {
          isHls: true,
          playlistText,
          segments,
          initSegment,
          keyBuffer: firstKeyBuf,
          keyBuffers,
        },
        episode
      );
    }
  } else {
    throw new Error(`Episode ${episode} not found in offline storage`);
  }

  const rawTitle = meta?.title || record?.title || `Episode_${episode}`;
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
  cancelled?: boolean;
}

function parseNativeExportResult(
  result: string,
  fileName: string,
  action: ExportAction
): { ok: true; savedPath: string } | { ok: false; error: string } {
  if (result.startsWith("ERROR:")) {
    return { ok: false, error: result.replace("ERROR:", "") };
  }
  if (result === "UNKNOWN_ACTION") {
    return { ok: false, error: "Unsupported export action" };
  }
  let savedPath = fileName;
  if (result.startsWith("SUCCESS:")) {
    savedPath = result.replace("SUCCESS:", "");
  } else if (result.startsWith("SAVED_LOCAL:")) {
    savedPath = result.replace("SAVED_LOCAL:", "");
  } else if (result.startsWith("SHARED:")) {
    savedPath = result.replace("SHARED:", "") || fileName;
  } else if (result.startsWith("OPENED:")) {
    savedPath = result.replace("OPENED:", "") || fileName;
  }
  return { ok: true, savedPath };
}

export async function processEpisodeExport(
  videoId: number,
  episode: number,
  action: ExportAction,
  onProgress?: (progressPct: number) => void,
  options?: { includeSubtitles?: boolean; subtitleFormat?: "srt" | "vtt"; signal?: AbortSignal }
): Promise<ExportResult> {
  const signal = options?.signal;
  if (signal?.aborted) {
    throw new DOMException("Export cancelled", "AbortError");
  }

  const id = `${videoId}_${episode}`;
  const meta = getOfflineEpisodes().find((it) => it.id === id);
  const shouldBundleSubtitles =
    Boolean(options?.includeSubtitles) &&
    (action === "save" || action === "save_movies" || action === "save_downloads" || action === "save_sdcard");

  // Fast zero-Base64-copy native path for episodes stored by Rust downloader on Android
  if (
    meta?.storage === "native" &&
    isNativeExportSupported() &&
    typeof window.AuraNativeExport?.exportLocalFile === "function"
  ) {
    const cleanTitle = formatDramaTitle(meta.title || `Episode_${episode}`);
    const safeTitle = sanitizeFileName(cleanTitle);
    const fileName = `${safeTitle}_Ep${episode}.mp4`;

    onProgress?.(15);
    const preparedPath = await invoke<string>("native_offline_prepare_export", { id, fileName });
    if (signal?.aborted) {
      throw new DOMException("Export cancelled", "AbortError");
    }
    onProgress?.(65);
    const result = window.AuraNativeExport.exportLocalFile(preparedPath, fileName, cleanTitle, action);
    onProgress?.(100);

    const parsed = parseNativeExportResult(result, fileName, action);
    if (!parsed.ok) {
      return { success: false, fileName, action, error: parsed.error };
    }

    if (shouldBundleSubtitles) {
      try {
        await processSubtitleExport(
          videoId,
          episode,
          options?.subtitleFormat || "srt",
          cleanTitle,
          "en",
          "save_downloads"
        );
      } catch {
        // non-fatal
      }
    }

    return {
      success: true,
      fileName,
      action,
      savedPath: parsed.savedPath,
    };
  }

  const { blob, fileName, title } = await getEpisodeBlob(videoId, episode);

  if (signal?.aborted) {
    throw new DOMException("Export cancelled", "AbortError");
  }

  if (
    isNativeExportSupported() &&
    typeof window.AuraNativeExport?.beginExport === "function" &&
    typeof window.AuraNativeExport?.writeChunk === "function" &&
    typeof window.AuraNativeExport?.finishExport === "function"
  ) {
    const bridge = window.AuraNativeExport;
    const started = bridge.beginExport(fileName);
    if (!started) {
      throw new Error("Native storage bridge failed to initialize file export");
    }

    const CHUNK_SIZE = 1024 * 1024; // 1 MB slices
    const totalBytes = blob.size;
    let offset = 0;

    try {
      while (offset < totalBytes) {
        if (signal?.aborted) {
          throw new DOMException("Export cancelled", "AbortError");
        }
        const slice = blob.slice(offset, offset + CHUNK_SIZE);
        const arrayBuf = await slice.arrayBuffer();
        if (signal?.aborted) {
          throw new DOMException("Export cancelled", "AbortError");
        }
        const base64Chunk = arrayBufferToBase64(arrayBuf);

        const ok = bridge.writeChunk(base64Chunk);
        if (!ok) {
          throw new Error("Failed to write video stream chunk to native storage");
        }

        offset += slice.size;
        const pct = Math.min(99, Math.round((offset / totalBytes) * 100));
        onProgress?.(pct);
      }
    } catch (err) {
      try {
        bridge.finishExport(fileName, title, "__abort");
      } catch {
        // ignore cleanup failure
      }
      throw err;
    }

    const result = bridge.finishExport(fileName, title, action);
    onProgress?.(100);

    const parsed = parseNativeExportResult(result, fileName, action);
    if (!parsed.ok) {
      return { success: false, fileName, action, error: parsed.error };
    }

    if (shouldBundleSubtitles) {
      try {
        await processSubtitleExport(
          videoId,
          episode,
          options?.subtitleFormat || "srt",
          title,
          "en",
          "save_downloads"
        );
      } catch {
        // non-fatal
      }
    }

    return {
      success: true,
      fileName,
      action,
      savedPath: parsed.savedPath,
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
      return { success: true, fileName, action, savedPath: fileName };
    } catch (e: any) {
      if (e?.name === "AbortError") {
        return {
          success: false,
          fileName,
          action,
          cancelled: true,
          error: "Share cancelled",
        };
      }
      // fallback to download
    }
  }

  if (signal?.aborted) {
    throw new DOMException("Export cancelled", "AbortError");
  }

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

  if (shouldBundleSubtitles) {
    try {
      await processSubtitleExport(
        videoId,
        episode,
        options?.subtitleFormat || "srt",
        title,
        "en",
        "save_downloads"
      );
    } catch {
      // non-fatal
    }
  }

  onProgress?.(100);
  return {
    success: true,
    fileName,
    action,
    savedPath: `Downloads/${fileName}`,
  };
}
