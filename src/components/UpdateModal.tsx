import { useEffect, useState } from "react";
import { api, type UpdateInfo } from "../api";
import { copyText } from "../clipboard";
import { formatBytes } from "../offline/downloadService";
import {
  canInstallOtaPackages,
  cancelOtaUpdateDownload,
  installOtaApk,
  isAndroidNativeOtaSupported,
  openOtaInstallPermissionSettings,
  resolveBestUpdateAsset,
  setSkippedUpdateVersion,
  startOtaUpdateDownload,
  subscribeOtaProgress,
  type OtaProgressEvent,
} from "../otaUpdater";
import { useStore } from "../store";
import { Button, Surface } from "./ios/controls";
import { Modal } from "./ui";

type UpdateStage = "idle" | "downloading" | "need_permission" | "ready" | "error";

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
  const [stage, setStage] = useState<UpdateStage>("idle");
  const [progress, setProgress] = useState(0);
  const [downloadedBytes, setDownloadedBytes] = useState(0);
  const [totalBytes, setTotalBytes] = useState(0);
  const [speedBps, setSpeedBps] = useState(0);
  const [apkPath, setApkPath] = useState("");
  const [errMsg, setErrMsg] = useState("");

  const androidOta = isAndroidNativeOtaSupported();
  const asset = resolveBestUpdateAsset(info);

  useEffect(() => {
    setStage("idle");
    setProgress(0);
    setDownloadedBytes(0);
    setTotalBytes(asset?.size || 0);
    setSpeedBps(0);
    setApkPath("");
    setErrMsg("");
  }, [info?.latest, info?.has_update]);

  useEffect(() => {
    if (!info?.has_update) return;
    return subscribeOtaProgress((ev: OtaProgressEvent) => {
      if (ev.status === "downloading") {
        setStage("downloading");
        setProgress(Math.max(0, Math.min(100, ev.progress ?? 0)));
        setDownloadedBytes(ev.downloadedBytes ?? 0);
        setTotalBytes(ev.totalBytes ?? (asset?.size || 0));
        setSpeedBps(ev.speedBytesPerSec ?? 0);
      } else if (ev.status === "downloaded") {
        const path = ev.filePath || "";
        setApkPath(path);
        setProgress(100);
        if (!canInstallOtaPackages()) {
          setStage("need_permission");
        } else {
          setStage("ready");
          const res = installOtaApk(path);
          if (res.startsWith("NEED_PERMISSION")) {
            setStage("need_permission");
          } else if (res.startsWith("ERROR:")) {
            setErrMsg(res.replace("ERROR:", ""));
            setStage("error");
          }
        }
      } else if (ev.status === "cancelled") {
        setStage("idle");
      } else if (ev.status === "error") {
        setErrMsg(ev.error || "Update download failed");
        setStage("error");
      }
    });
  }, [info?.has_update, asset?.size]);

  useEffect(() => {
    if (stage !== "need_permission" || !apkPath) return;
    const checkAndResumeInstall = () => {
      if (canInstallOtaPackages()) {
        setStage("ready");
        const res = installOtaApk(apkPath);
        if (res.startsWith("ERROR:")) {
          setErrMsg(res.replace("ERROR:", ""));
          setStage("error");
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
  }, [stage, apkPath]);

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
    if (stage === "ready" && apkPath) {
      const res = installOtaApk(apkPath);
      if (res.startsWith("NEED_PERMISSION")) {
        setStage("need_permission");
      } else if (res.startsWith("ERROR:")) {
        setErrMsg(res.replace("ERROR:", ""));
        setStage("error");
      }
      return;
    }

    if (stage === "need_permission") {
      openOtaInstallPermissionSettings();
      return;
    }

    if (androidOta && asset?.url) {
      setErrMsg("");
      setProgress(0);
      setDownloadedBytes(0);
      setTotalBytes(asset.size || 0);
      setStage("downloading");
      const started = startOtaUpdateDownload(asset.url, asset.name);
      if (!started) {
        setErrMsg("Could not start in-app update download");
        setStage("error");
      }
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

  return (
    <Modal
      open={Boolean(info?.has_update)}
      onClose={() => {
        if (stage === "downloading") {
          cancelOtaUpdateDownload();
        }
        onClose();
      }}
      width={392}
      label="New Version Available"
    >
      <div className="p-5">
        <div className="text-[16px] font-bold text-on">New Version Available</div>
        <p className="text-[12px] text-mut mt-1.5">
          v{info.current} to <b className="text-on">v{info.latest}</b>
          {info.published_at ? ` · ${info.published_at.slice(0, 10)}` : ""}
          {asset?.abi ? ` · ${asset.abi}` : ""}
          {asset?.size ? ` · ${formatBytes(asset.size)}` : ""}
        </p>

        {!!info.notes && (
          <Surface className="mt-3 max-h-[160px] scroll-y rounded-(--r-sm) bg-s2 p-3 text-[12px] text-mut whitespace-pre-wrap leading-relaxed">
            {info.notes}
          </Surface>
        )}

        {stage === "downloading" && (
          <div className="mt-3 p-3 rounded-xl bg-s2 border border-edge/30 flex flex-col gap-2">
            <div className="flex items-center justify-between text-[12px] font-semibold text-on">
              <span>Downloading APK ({progress}%)</span>
              <span className="text-primary">{speedText}</span>
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

        {stage === "need_permission" && (
          <Surface className="mt-3 p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-[12px] text-amber-700 dark:text-amber-300 leading-relaxed">
            Allow AuraStream to install updates from this source in Android settings. Installation will resume automatically when you return.
          </Surface>
        )}

        {stage === "ready" && (
          <Surface className="mt-3 p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-[12px] text-emerald-700 dark:text-emerald-300 leading-relaxed">
            Update package downloaded and ready. Tap Install Update Now to apply v{info.latest}.
          </Surface>
        )}

        {stage === "error" && (
          <Surface className="mt-3 p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-[12px] text-red-600 dark:text-red-400 leading-relaxed">
            {errMsg || "Update download failed"}
          </Surface>
        )}

        <div className="flex gap-2 mt-4">
          {stage === "downloading" ? (
            <Button
              onClick={() => {
                cancelOtaUpdateDownload();
                setStage("idle");
              }}
              className="flex-1 h-9 rounded-(--r-ctl) bg-s3 text-[13.5px] font-semibold text-on/85 pressable"
            >
              Cancel Download
            </Button>
          ) : (
            <>
              <Button
                onClick={onClose}
                className="flex-1 h-9 rounded-(--r-ctl) bg-s3 text-[13.5px] text-on/80 pressable"
              >
                Later
              </Button>
              {showSkip && stage === "idle" && (
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
                {stage === "ready"
                  ? "Install Update Now"
                  : stage === "need_permission"
                  ? "Open Settings"
                  : stage === "error"
                  ? "Retry Download"
                  : androidOta
                  ? "Download & Install"
                  : "Download"}
              </Button>
            </>
          )}
        </div>

        {stage === "error" && (
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
