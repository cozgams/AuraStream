import { useEffect, useMemo, useRef, useState } from "react";
import { api, type UpdateInfo } from "../api";
import { copyText } from "../clipboard";
import { formatBytes } from "../offline/downloadService";
import {
  canInstallOtaPackages,
  cancelOtaUpdateDownload,
  getCachedOtaApk,
  getOtaRuntimeState,
  installOtaApk,
  isAndroidNativeOtaSupported,
  markOtaInstallResult,
  openOtaInstallPermissionSettings,
  resolveBestUpdateAsset,
  setSkippedUpdateVersion,
  startOtaUpdateDownload,
  subscribeOtaRuntimeState,
  type OtaDownloadStage,
} from "../otaUpdater";
import { useStore } from "../store";
import { IRefresh } from "../icons";
import { Button, Surface } from "./ios/controls";
import { Modal } from "./ui";

function formatEta(remainingBytes: number, speedBps: number): string {
  if (remainingBytes <= 0 || speedBps <= 0) return "";
  const secs = Math.ceil(remainingBytes / speedBps);
  if (secs < 60) return `${secs}s left`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return `${mins}m ${remSecs}s left`;
}

function formatReleaseNotes(raw: string): string {
  return raw
    .replace(/\r\n/g, "\n")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s*[-*]\s+/gm, "• ")
    .trim();
}

export default function UpdateModal({
  info,
  onClose,
  showSkip = false,
}: {
  info: UpdateInfo | null;
  onClose: () => void;
  showSkip?: boolean;
}) {
  const { toast } = useStore();
  const androidOta = isAndroidNativeOtaSupported();
  const asset = resolveBestUpdateAsset(info);
  const expectedFile = asset?.name || "";
  const expectedSize = asset?.size || 0;

  const [runtime, setRuntime] = useState(() => getOtaRuntimeState());
  const [cachedPath, setCachedPath] = useState("");
  const [cachedSize, setCachedSize] = useState(0);
  const prevStageRef = useRef<OtaDownloadStage>(runtime.stage);
  const autoTriggeredForPathRef = useRef<string>("");

  const matchesCurrentAsset = Boolean(
    expectedFile && (!runtime.fileName || runtime.fileName === expectedFile)
  );

  useEffect(() => {
    setRuntime(getOtaRuntimeState());
    return subscribeOtaRuntimeState((next) => setRuntime(next));
  }, []);

  useEffect(() => {
    if (!info?.has_update || !androidOta || !expectedFile) {
      setCachedPath("");
      setCachedSize(0);
      return;
    }
    const cached = getCachedOtaApk(expectedFile, expectedSize);
    if (cached.ready && cached.filePath) {
      setCachedPath(cached.filePath);
      setCachedSize(cached.size || expectedSize || 0);
    } else {
      setCachedPath("");
      setCachedSize(0);
    }
  }, [info?.has_update, info?.latest, androidOta, expectedFile, expectedSize]);

  const effectiveStage: OtaDownloadStage = useMemo(() => {
    if (matchesCurrentAsset && runtime.stage !== "idle") {
      return runtime.stage;
    }
    if (cachedPath) {
      return canInstallOtaPackages() ? "ready" : "need_permission";
    }
    return "idle";
  }, [matchesCurrentAsset, runtime.stage, cachedPath]);

  const activeApkPath =
    (matchesCurrentAsset ? runtime.apkPath : "") || cachedPath;
  const progress = matchesCurrentAsset ? runtime.progress : cachedPath ? 100 : 0;
  const downloadedBytes = matchesCurrentAsset
    ? runtime.downloadedBytes
    : cachedPath
    ? cachedSize
    : 0;
  const totalBytes =
    (matchesCurrentAsset ? runtime.totalBytes : cachedSize) || expectedSize || 0;
  const speedBps = matchesCurrentAsset ? runtime.speedBytesPerSec : 0;
  const errMsg = matchesCurrentAsset ? runtime.error : "";

  useEffect(() => {
    if (!info?.has_update) return;
    const prevStage = prevStageRef.current;
    prevStageRef.current = effectiveStage;

    if (
      prevStage === "downloading" &&
      (effectiveStage === "ready" || effectiveStage === "need_permission") &&
      activeApkPath &&
      autoTriggeredForPathRef.current !== activeApkPath
    ) {
      autoTriggeredForPathRef.current = activeApkPath;
      setCachedPath(activeApkPath);
      if (canInstallOtaPackages()) {
        const res = installOtaApk(activeApkPath);
        markOtaInstallResult(res);
      }
    }
  }, [info?.has_update, effectiveStage, activeApkPath]);

  useEffect(() => {
    if (!info?.has_update || effectiveStage !== "need_permission" || !activeApkPath) return;
    let triggered = false;
    const checkAndResumeInstall = () => {
      if (triggered) return;
      if (canInstallOtaPackages()) {
        triggered = true;
        const res = installOtaApk(activeApkPath);
        markOtaInstallResult(res);
        if (res === "STARTED") {
          setRuntime((prev) => ({ ...prev, stage: "ready", apkPath: activeApkPath }));
        }
      }
    };
    window.addEventListener("aurastream:app-resumed", checkAndResumeInstall);
    const onVis = () => {
      if (document.visibilityState === "visible") checkAndResumeInstall();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("aurastream:app-resumed", checkAndResumeInstall);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [info?.has_update, effectiveStage, activeApkPath]);

  const formattedNotes = useMemo(
    () => (info?.notes ? formatReleaseNotes(info.notes) : ""),
    [info?.notes]
  );

  if (!info || !info.has_update) return null;

  const openReleaseInBrowser = async () => {
    const targetUrl = info.url || asset?.url || "https://github.com/cozgams/AuraStream/releases";
    try {
      await api.openUrl(targetUrl);
    } catch {
      await copyText(targetUrl)
        .then(() => toast("Release URL copied to clipboard", "ok"))
        .catch(() => toast("Failed to open release link", "info"));
    }
  };

  const handlePrimaryAction = async () => {
    if (effectiveStage === "ready" && activeApkPath) {
      const res = installOtaApk(activeApkPath);
      markOtaInstallResult(res);
      return;
    }

    if (effectiveStage === "need_permission") {
      openOtaInstallPermissionSettings();
      return;
    }

    if (androidOta && asset?.url) {
      autoTriggeredForPathRef.current = "";
      startOtaUpdateDownload(asset.url, asset.name, asset.size || 0);
      return;
    }

    await openReleaseInBrowser();
  };

  const speedText =
    speedBps >= 1024 * 1024
      ? `${(speedBps / (1024 * 1024)).toFixed(1)} MB/s`
      : speedBps > 0
      ? `${Math.round(speedBps / 1024)} KB/s`
      : "Connecting...";
  const etaText =
    totalBytes > downloadedBytes ? formatEta(totalBytes - downloadedBytes, speedBps) : "";

  return (
    <Modal
      open={Boolean(info?.has_update)}
      onClose={onClose}
      width={392}
      label="New Version Available"
    >
      <div className="p-5">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-primary/15 text-primary border border-primary/25 flex items-center justify-center shrink-0">
            <IRefresh size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[16px] font-bold text-on leading-tight">New Version Available</div>
            <p className="text-[12px] text-mut mt-0.5">
              v{info.current} to <b className="text-on">v{info.latest}</b>
              {info.published_at ? ` · ${info.published_at.slice(0, 10)}` : ""}
              {asset?.abi ? ` · ${asset.abi}` : ""}
              {asset?.size ? ` · ${formatBytes(asset.size)}` : ""}
            </p>
          </div>
        </div>

        {!!formattedNotes && (
          <Surface className="mt-3.5 max-h-[160px] scroll-y rounded-2xl bg-s2 border border-edge/30 p-3 text-[12px] text-mut whitespace-pre-wrap leading-relaxed">
            {formattedNotes}
          </Surface>
        )}

        {effectiveStage === "downloading" && (
          <div className="mt-3 p-3 rounded-xl bg-s2 border border-edge/30 flex flex-col gap-2">
            <div className="flex items-center justify-between text-[12px] font-semibold text-on">
              <span>Downloading APK ({progress}%)</span>
              <span className="text-primary">
                {speedText}
                {etaText ? ` · ${etaText}` : ""}
              </span>
            </div>
            <div className="w-full h-2 rounded-full bg-s4 overflow-hidden">
              <div
                className="h-full bg-primary rounded-full transition-all duration-300"
                style={{ width: `${Math.max(3, progress)}%` }}
              />
            </div>
            <div className="text-[11px] text-mut tabular-nums">
              {formatBytes(downloadedBytes)}
              {totalBytes > 0 ? ` / ${formatBytes(totalBytes)}` : ""}
            </div>
          </div>
        )}

        {effectiveStage === "need_permission" && (
          <Surface className="mt-3 p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-[12px] text-amber-700 dark:text-amber-300 leading-relaxed">
            Allow AuraStream to install updates from this source in Android settings. Installation will resume automatically when you return.
          </Surface>
        )}

        {effectiveStage === "ready" && (
          <Surface className="mt-3 p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-[12px] text-emerald-700 dark:text-emerald-300 leading-relaxed">
            Update package verified and cached locally. Tap Install Update Now to apply v{info.latest}.
          </Surface>
        )}

        {effectiveStage === "error" && (
          <Surface className="mt-3 p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-[12px] text-red-600 dark:text-red-400 leading-relaxed">
            {errMsg || "Update download failed"}
          </Surface>
        )}

        <div className="flex gap-2 mt-4">
          {effectiveStage === "downloading" ? (
            <>
              <Button
                onClick={onClose}
                className="flex-1 h-9 rounded-(--r-ctl) bg-s3 text-[13.5px] text-on/80 pressable"
              >
                Hide
              </Button>
              <Button
                onClick={() => {
                  cancelOtaUpdateDownload();
                }}
                className="flex-1 h-9 rounded-(--r-ctl) bg-red-500/15 text-[13.5px] font-semibold text-red-600 dark:text-red-400 pressable"
              >
                Cancel
              </Button>
            </>
          ) : (
            <>
              <Button
                onClick={onClose}
                className="flex-1 h-9 rounded-(--r-ctl) bg-s3 text-[13.5px] text-on/80 pressable"
              >
                Later
              </Button>
              {showSkip && effectiveStage === "idle" && (
                <Button
                  onClick={() => {
                    setSkippedUpdateVersion(info.latest);
                    onClose();
                  }}
                  className="px-3 h-9 rounded-(--r-ctl) bg-s3 text-[12.5px] text-mut pressable"
                >
                  Skip v{info.latest}
                </Button>
              )}
              <Button
                onClick={() => void handlePrimaryAction()}
                className="flex-1 h-9 rounded-(--r-ctl) bg-primary text-[13.5px] font-semibold text-on-primary pressable"
              >
                {effectiveStage === "ready"
                  ? "Install Update Now"
                  : effectiveStage === "need_permission"
                  ? "Open Settings"
                  : effectiveStage === "error"
                  ? "Retry Download"
                  : androidOta
                  ? "Download & Install"
                  : "Download"}
              </Button>
            </>
          )}
        </div>

        {effectiveStage === "error" && (
          <Button
            onClick={() => void openReleaseInBrowser()}
            className="mt-2 w-full h-8 rounded-(--r-ctl) bg-s2 text-[12px] font-semibold text-primary pressable"
          >
            Open GitHub Release in Browser
          </Button>
        )}

        <div className="text-[11px] text-dim mt-2.5 break-all">{asset?.url || info.url}</div>
      </div>
    </Modal>
  );
}
