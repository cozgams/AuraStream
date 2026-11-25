import type { UpdateInfo } from "./api";
import type { NativeExportBridge } from "./offline/exportService";

const AUTO_UPDATE_KEY = "aurastream_auto_update_check_v1";
const SKIPPED_VERSION_KEY = "aurastream_skipped_update_v1";
let availableUpdateInfo: UpdateInfo | null = null;

export function getAvailableUpdateInfo(): UpdateInfo | null {
  return availableUpdateInfo;
}

export type OtaDownloadStage = "idle" | "downloading" | "need_permission" | "ready" | "error";

export interface OtaRuntimeState {
  stage: OtaDownloadStage;
  fileName: string;
  progress: number;
  downloadedBytes: number;
  totalBytes: number;
  speedBytesPerSec: number;
  apkPath: string;
  error: string;
}

const DEFAULT_RUNTIME_STATE: OtaRuntimeState = {
  stage: "idle",
  fileName: "",
  progress: 0,
  downloadedBytes: 0,
  totalBytes: 0,
  speedBytesPerSec: 0,
  apkPath: "",
  error: "",
};

let otaRuntimeState: OtaRuntimeState = { ...DEFAULT_RUNTIME_STATE };
const runtimeListeners = new Set<(state: OtaRuntimeState) => void>();

function emitOtaRuntimeState(): void {
  const snapshot = { ...otaRuntimeState };
  for (const listener of runtimeListeners) {
    try {
      listener(snapshot);
    } catch {
      // ignore listener errors
    }
  }
}

export function getOtaRuntimeState(): OtaRuntimeState {
  return { ...otaRuntimeState };
}

export function subscribeOtaRuntimeState(listener: (state: OtaRuntimeState) => void): () => void {
  runtimeListeners.add(listener);
  return () => {
    runtimeListeners.delete(listener);
  };
}

export function setAvailableUpdateInfo(info: UpdateInfo | null): void {
  availableUpdateInfo = info?.has_update ? info : null;
  if (info && !info.has_update) {
    setSkippedUpdateVersion("");
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("aurastream:update-available", { detail: availableUpdateInfo }));
  }
}

export function subscribeAvailableUpdate(listener: (info: UpdateInfo | null) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (ev: Event) => {
    listener((ev as CustomEvent<UpdateInfo | null>).detail ?? availableUpdateInfo);
  };
  window.addEventListener("aurastream:update-available", handler);
  return () => window.removeEventListener("aurastream:update-available", handler);
}

export type OtaProgressEvent = {
  status: "downloading" | "downloaded" | "cancelled" | "error";
  progress?: number;
  downloadedBytes?: number;
  totalBytes?: number;
  speedBytesPerSec?: number;
  filePath?: string;
  error?: string;
};

export interface ResolvedUpdateAsset {
  name: string;
  url: string;
  size?: number | null;
  abi?: string;
}

function getNativeBridge(): NativeExportBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return window.AuraNativeExport;
}

export function isAutoUpdateCheckEnabled(): boolean {
  try {
    return localStorage.getItem(AUTO_UPDATE_KEY) !== "false";
  } catch {
    return true;
  }
}

export function setAutoUpdateCheckEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(AUTO_UPDATE_KEY, enabled ? "true" : "false");
    window.dispatchEvent(new CustomEvent("aurastream:ota-config-changed"));
  } catch {
    // ignore
  }
}

export function getSkippedUpdateVersion(): string {
  try {
    return localStorage.getItem(SKIPPED_VERSION_KEY) || "";
  } catch {
    return "";
  }
}

export function setSkippedUpdateVersion(version: string): void {
  try {
    if (!version) localStorage.removeItem(SKIPPED_VERSION_KEY);
    else localStorage.setItem(SKIPPED_VERSION_KEY, version.trim());
  } catch {
    // ignore
  }
}

export function isAndroidNativeOtaSupported(): boolean {
  const bridge = getNativeBridge();
  return Boolean(bridge && typeof bridge.startOtaDownload === "function" && typeof bridge.installDownloadedApk === "function");
}

function normalizeAbiFromDevice(rawAbi?: string, arch?: string): "arm64" | "arm" | "x86_64" {
  const candidate = (rawAbi || "").toLowerCase();
  if (candidate === "arm64" || candidate.includes("arm64") || candidate.includes("aarch64")) return "arm64";
  if (candidate === "x86_64" || candidate.includes("x86_64")) return "x86_64";
  if (candidate === "arm" || candidate.includes("armeabi")) return "arm";

  const a = (arch || "").toLowerCase();
  if (a.includes("x86_64")) return "x86_64";
  if (a === "arm" || a.includes("armv7")) return "arm";
  return "arm64";
}

function assetMatchesAbi(assetName: string, abi: "arm64" | "arm" | "x86_64"): boolean {
  const lower = assetName.toLowerCase();
  if (!lower.endsWith(".apk")) return false;
  if (abi === "arm64") return lower.includes("arm64") || lower.includes("aarch64");
  if (abi === "x86_64") return lower.includes("x86_64");
  return lower.includes("_arm.") || (!lower.includes("arm64") && !lower.includes("x86"));
}

/**
 * Resolves the exact downloadable release asset (always matching device ABI on Android,
 * even when GitHub API rate-limited and fell back to release tag redirect).
 */
export function resolveBestUpdateAsset(
  info: UpdateInfo | null | undefined,
  explicitAbi?: string
): ResolvedUpdateAsset | null {
  if (!info || !info.latest) return null;

  const deviceAbi = explicitAbi || getNativeBridge()?.getDeviceAbi?.();
  const isAndroidEnv = Boolean(deviceAbi || isAndroidNativeOtaSupported() || (typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent)));

  if (!isAndroidEnv) {
    return info.asset?.url ? { name: info.asset.name, url: info.asset.url, size: info.asset.size ?? null } : null;
  }

  const abi = normalizeAbiFromDevice(deviceAbi, info.arch);
  if (info.asset?.url && assetMatchesAbi(info.asset.name, abi)) {
    return {
      name: info.asset.name,
      url: info.asset.url,
      size: info.asset.size ?? null,
      abi,
    };
  }

  const matched = (info.assets || []).find((item) => item?.url && assetMatchesAbi(item.name, abi));
  if (matched) {
    return {
      name: matched.name,
      url: matched.url,
      size: matched.size ?? null,
      abi,
    };
  }

  const tag = info.tag?.trim() || (info.latest.startsWith("v") ? info.latest : `v${info.latest}`);
  const cleanVer = info.latest.replace(/^v/i, "");
  const fallbackName = `AuraStream_${cleanVer}_${abi}.apk`;
  return {
    name: fallbackName,
    url: `https://github.com/cozgams/AuraStream/releases/download/${tag}/${fallbackName}`,
    size: null,
    abi,
  };
}

export function subscribeOtaProgress(listener: (event: OtaProgressEvent) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (ev: Event) => {
    const detail = (ev as CustomEvent<OtaProgressEvent>).detail;
    if (detail) listener(detail);
  };
  window.addEventListener("aurastream:ota-progress", handler);
  return () => window.removeEventListener("aurastream:ota-progress", handler);
}

export function getCachedOtaApk(fileName: string, expectedSize = 0): { ready: boolean; filePath?: string; size?: number } {
  const bridge = getNativeBridge();
  if (!bridge || typeof bridge.getCachedOtaApkInfo !== "function" || !fileName) {
    return { ready: false };
  }
  try {
    const raw = bridge.getCachedOtaApkInfo(fileName, expectedSize > 0 ? expectedSize : 0);
    const parsed = JSON.parse(raw || "{}") as { ready?: boolean; filePath?: string; size?: number };
    if (parsed?.ready && parsed.filePath) {
      return { ready: true, filePath: parsed.filePath, size: parsed.size };
    }
  } catch {
    // ignore malformed bridge output
  }
  return { ready: false };
}

export function startOtaUpdateDownload(url: string, fileName: string, expectedSize = 0): boolean {
  const cached = getCachedOtaApk(fileName, expectedSize);
  if (cached.ready && cached.filePath) {
    otaRuntimeState = {
      stage: canInstallOtaPackages() ? "ready" : "need_permission",
      fileName,
      progress: 100,
      downloadedBytes: cached.size || expectedSize || 0,
      totalBytes: cached.size || expectedSize || 0,
      speedBytesPerSec: 0,
      apkPath: cached.filePath,
      error: "",
    };
    emitOtaRuntimeState();
    return true;
  }

  const bridge = getNativeBridge();
  if (!bridge || typeof bridge.startOtaDownload !== "function") return false;
  otaRuntimeState = {
    stage: "downloading",
    fileName,
    progress: 0,
    downloadedBytes: 0,
    totalBytes: expectedSize > 0 ? expectedSize : 0,
    speedBytesPerSec: 0,
    apkPath: "",
    error: "",
  };
  emitOtaRuntimeState();
  const ok = Boolean(bridge.startOtaDownload(url, fileName));
  if (!ok) {
    otaRuntimeState = {
      ...otaRuntimeState,
      stage: "error",
      error: "Could not start in-app update download",
    };
    emitOtaRuntimeState();
  }
  return ok;
}

export function cancelOtaUpdateDownload(): boolean {
  const bridge = getNativeBridge();
  otaRuntimeState = { ...DEFAULT_RUNTIME_STATE };
  emitOtaRuntimeState();
  if (!bridge || typeof bridge.cancelOtaDownload !== "function") return false;
  return Boolean(bridge.cancelOtaDownload());
}

export function markOtaInstallResult(res: string): void {
  if (res.startsWith("NEED_PERMISSION")) {
    otaRuntimeState = { ...otaRuntimeState, stage: "need_permission" };
    emitOtaRuntimeState();
  } else if (res.startsWith("ERROR:")) {
    otaRuntimeState = { ...otaRuntimeState, stage: "error", error: res.replace("ERROR:", "") };
    emitOtaRuntimeState();
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("aurastream:ota-progress", (ev: Event) => {
    const detail = (ev as CustomEvent<OtaProgressEvent>).detail;
    if (!detail) return;
    if (detail.status === "downloading") {
      otaRuntimeState = {
        ...otaRuntimeState,
        stage: "downloading",
        progress: Math.max(0, Math.min(100, detail.progress ?? 0)),
        downloadedBytes: detail.downloadedBytes ?? otaRuntimeState.downloadedBytes,
        totalBytes: detail.totalBytes || otaRuntimeState.totalBytes,
        speedBytesPerSec: detail.speedBytesPerSec ?? 0,
        error: "",
      };
      emitOtaRuntimeState();
    } else if (detail.status === "downloaded") {
      const apkPath = (detail.filePath || "").trim();
      if (!apkPath) {
        otaRuntimeState = {
          ...otaRuntimeState,
          stage: "error",
          error: "Downloaded APK path is missing",
        };
      } else {
        otaRuntimeState = {
          ...otaRuntimeState,
          stage: canInstallOtaPackages() ? "ready" : "need_permission",
          progress: 100,
          downloadedBytes: detail.downloadedBytes ?? otaRuntimeState.downloadedBytes,
          totalBytes: detail.totalBytes || detail.downloadedBytes || otaRuntimeState.totalBytes,
          speedBytesPerSec: 0,
          apkPath,
          error: "",
        };
      }
      emitOtaRuntimeState();
    } else if (detail.status === "cancelled") {
      otaRuntimeState = { ...DEFAULT_RUNTIME_STATE };
      emitOtaRuntimeState();
    } else if (detail.status === "error") {
      otaRuntimeState = {
        ...otaRuntimeState,
        stage: "error",
        speedBytesPerSec: 0,
        error: detail.error || "Update download failed",
      };
      emitOtaRuntimeState();
    }
  });
}

export function canInstallOtaPackages(): boolean {
  const bridge = getNativeBridge();
  if (!bridge || typeof bridge.canInstallPackages !== "function") return true;
  return Boolean(bridge.canInstallPackages());
}

export function openOtaInstallPermissionSettings(): boolean {
  const bridge = getNativeBridge();
  if (!bridge || typeof bridge.openInstallPermissionSettings !== "function") return false;
  return Boolean(bridge.openInstallPermissionSettings());
}

export function installOtaApk(filePath: string): "STARTED" | "NEED_PERMISSION" | string {
  const bridge = getNativeBridge();
  if (!bridge || typeof bridge.installDownloadedApk !== "function") {
    return "ERROR:Native installer unavailable";
  }
  return bridge.installDownloadedApk(filePath);
}
