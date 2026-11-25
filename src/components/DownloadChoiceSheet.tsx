/**
 * AuraStream Download Choice Sheet
 * Modern iOS frosted-glass bottom sheet with warm light theme accents.
 * Features:
 * 1. Hero drama header with cover artwork, episode pill, quality badge, and close button.
 * 2. Interactive quick episode strip to switch the single download target.
 * 3. Elevated single episode download card with live progress, pause/resume/cancel/retry, and export action.
 * 4. High-contrast full season batch download card with total size estimation.
 * 5. Device storage meter with high-speed turbo engine status.
 */

import { useEffect, useState } from "react";
import { Sheet } from "./ui";
import { Button } from "./ios/controls";
import { Loader } from "./ios/effects";
import {
  IAlertTriangle,
  IBoltF,
  ICheck,
  IClose,
  IDownload,
  IExport,
  IFilm,
  IHardDrive,
  IPauseF,
  IPlayF,
} from "../icons";
import { useStore } from "../store";
import {
  isCellularConnection,
  isWifiOnlyDownloadEnabled,
  getDownloadQualityPreference,
  getDetailedStorageStats,
  isEpisodeDownloaded,
  isEpisodeDownloading,
  getEpisodeDownloadProgress,
  subscribeDownloadProgress,
  pauseDownload,
  resumeDownload,
  cancelDownload,
  formatBytes,
  type ActiveDownloadProgress,
} from "../offline/downloadService";
import { formatDramaTitle } from "../subtitles/dramaTranslator";
import { cover } from "../api";

interface DownloadChoiceSheetProps {
  isOpen: boolean;
  onClose: () => void;
  videoId: number;
  currentEpisode: number;
  totalEpisodes: number;
  title: string;
  coverUrl: string;
  isDownloaded: boolean;
  isDownloading: boolean;
  downloadProgress?: number;
  onStartSingleDownload: (targetEp?: number) => void;
  onOpenBatchDownload: () => void;
  onOpenExport?: (episode?: number) => void;
}

export default function DownloadChoiceSheet({
  isOpen,
  onClose,
  videoId,
  currentEpisode,
  totalEpisodes,
  title,
  coverUrl,
  isDownloaded: propIsDownloaded,
  isDownloading: propIsDownloading,
  downloadProgress: propDownloadProgress = 0,
  onStartSingleDownload,
  onOpenBatchDownload,
  onOpenExport,
}: DownloadChoiceSheetProps) {
  const { t, toast } = useStore();
  const [freeSpaceFormatted, setFreeSpaceFormatted] = useState<string>("");
  const [usedPercent, setUsedPercent] = useState<number | null>(null);
  const [targetEpisode, setTargetEpisode] = useState<number>(currentEpisode);
  const [activeMap, setActiveMap] = useState<Map<string, ActiveDownloadProgress>>(() => new Map());

  const isCellular = isCellularConnection();
  const wifiOnly = isWifiOnlyDownloadEnabled();
  const quality = getDownloadQualityPreference();
  const totalEps = Math.max(1, totalEpisodes || Math.max(10, currentEpisode));
  const allEpisodes = Array.from({ length: totalEps }, (_, i) => i + 1);

  useEffect(() => {
    if (!isOpen) return;
    return subscribeDownloadProgress((map) => setActiveMap(new Map(map)));
  }, [isOpen]);

  // Sync targetEpisode and honest storage metrics when sheet opens
  useEffect(() => {
    if (!isOpen) return;
    let alive = true;
    setTargetEpisode(currentEpisode);
    void getDetailedStorageStats().then((stats) => {
      if (!alive) return;
      setFreeSpaceFormatted(stats.freeFormatted || "Available");
      setUsedPercent(
        stats.percentUsed != null && Number.isFinite(stats.percentUsed)
          ? Math.min(98, Math.max(0, Math.round(stats.percentUsed)))
          : null
      );
    });
    return () => {
      alive = false;
    };
  }, [isOpen, currentEpisode]);

  if (!isOpen) return null;

  const targetKey = `${videoId}_${targetEpisode}`;
  const targetActiveProg = activeMap.get(targetKey);
  const isTargetDownloaded =
    (targetEpisode === currentEpisode && propIsDownloaded) || isEpisodeDownloaded(videoId, targetEpisode);
  const isTargetQueued = !isTargetDownloaded && targetActiveProg?.status === "queued";
  const isTargetDownloading =
    Boolean(targetActiveProg && targetActiveProg.status === "downloading") ||
    (!targetActiveProg && (targetEpisode === currentEpisode ? propIsDownloading : isEpisodeDownloading(videoId, targetEpisode)));
  const isTargetPaused = !isTargetDownloaded && targetActiveProg?.status === "paused";
  const isTargetError = !isTargetDownloaded && targetActiveProg?.status === "error";
  const targetProgress =
    targetActiveProg?.progress ??
    (targetEpisode === currentEpisode ? propDownloadProgress : getEpisodeDownloadProgress(videoId, targetEpisode));

  const estEpMbNum = quality === "standard" ? 18.0 : 14.5;
  const estEpMb = estEpMbNum.toFixed(1);
  const qualityLabel = quality === "standard" ? "H.264 HD" : quality === "hevc" ? "HEVC HD" : "Auto HD";
  const estimatedBatchFormatted = formatBytes(totalEps * estEpMbNum * 1024 * 1024);

  const handleSingleAction = () => {
    if (isTargetDownloaded) {
      onClose();
      onOpenExport?.(targetEpisode);
      return;
    }
    if (isTargetDownloading || isTargetQueued) {
      onClose();
      return;
    }
    if (isTargetPaused && targetActiveProg) {
      if (isCellular && wifiOnly) {
        toast("Cellular connection detected. 'Download on Wi-Fi Only' is enabled.", "info");
        return;
      }
      void resumeDownload(targetActiveProg.id, false).catch((e) => {
        toast((e as Error)?.message || "Failed to resume download", "info");
      });
      return;
    }

    onClose();
    onStartSingleDownload(targetEpisode);
  };

  return (
    <Sheet open={isOpen} onClose={onClose} label="Offline Downloads">
      <div className="flex flex-col bg-s1 text-on p-4 sm:p-5 pb-4 gap-3.5 max-h-[82dvh] overflow-y-auto">
        {/* Hero Header with Artwork & Metadata */}
        <div className="flex items-center justify-between pb-3.5 border-b border-border/80">
          <div className="flex items-center gap-3.5 min-w-0">
            {coverUrl && (typeof navigator === "undefined" || navigator.onLine !== false || coverUrl.startsWith("blob:") || coverUrl.startsWith("data:") || coverUrl.includes("/offline/")) ? (
              <img
                src={coverUrl.startsWith("blob:") || coverUrl.startsWith("data:") || coverUrl.includes("/offline/") ? coverUrl : cover(coverUrl, 160)}
                alt={title}
                className="w-13 h-17 object-cover rounded-2xl shadow-md border border-border shrink-0"
                onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
              />
            ) : (
              <div className="w-13 h-17 rounded-2xl bg-amber-500/15 text-amber-600 flex items-center justify-center shrink-0 border border-amber-500/20">
                <IFilm size={26} />
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-amber-600 dark:text-amber-400">
                <IBoltF size={12} />
                <span>Turbo Downloads</span>
              </div>
              <h3 className="text-[16px] font-bold text-on truncate leading-tight mt-0.5">
                {formatDramaTitle(title) || `Drama #${videoId}`}
              </h3>
              <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                <span className="px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-500/20 text-[11px] font-semibold">
                  Ep. {targetEpisode} of {totalEps}
                </span>
                <span className="px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/20 text-[11px] font-semibold">
                  {qualityLabel}
                </span>
                <span className="text-[11.5px] text-mut">~{estEpMb} MB</span>
              </div>
            </div>
          </div>
          <Button
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-s3 hover:bg-s4/20 flex items-center justify-center text-on/70 hover:text-on pressable shrink-0 ml-2"
            aria-label={t("common.close")}
          >
            <IClose size={16} />
          </Button>
        </div>

        {/* Quick Episode Horizontal Strip */}
        <div className="flex flex-col gap-1.5 pt-0.5">
          <div className="flex items-center justify-between text-[11px] font-bold uppercase tracking-wider text-mut">
            <span>Select Episode</span>
            <span className="text-amber-600 dark:text-amber-400 font-semibold lowercase">tap to switch target</span>
          </div>
          <div className="flex gap-1.5 overflow-x-auto py-1 scrollbar-none snap-x">
            {allEpisodes.map((ep) => {
              const active = ep === targetEpisode;
              const saved = isEpisodeDownloaded(videoId, ep);
              return (
                <button
                  key={ep}
                  type="button"
                  onClick={() => setTargetEpisode(ep)}
                  className={`min-w-[44px] h-8 rounded-xl text-[12.5px] font-bold flex items-center justify-center gap-1 shrink-0 transition-all pressable ${
                    active
                      ? "bg-amber-500 text-white shadow-xs scale-105"
                      : saved
                      ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30"
                      : "bg-white dark:bg-neutral-800 text-on border border-border hover:bg-s2"
                  }`}
                >
                  <span>{ep}</span>
                  {saved && <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block" />}
                </button>
              );
            })}
          </div>
        </div>

        {/* 2 Primary Interactive Option Cards */}
        <div className="flex flex-col gap-3 pt-1">
          {/* CARD 1: Single Episode Download */}
          <div
            role="button"
            tabIndex={0}
            onClick={handleSingleAction}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                handleSingleAction();
              }
            }}
            className={`w-full p-4 rounded-[20px] border text-left pressable transition-all flex items-center justify-between gap-3.5 shadow-xs cursor-pointer active:scale-[0.985] ${
              isTargetDownloaded
                ? "bg-emerald-500/10 border-emerald-500/40 text-on hover:bg-emerald-500/15"
                : isTargetDownloading
                ? "bg-amber-500/10 border-amber-500/40 text-on hover:bg-amber-500/15"
                : isTargetError
                ? "bg-red-500/10 border-red-500/35 text-on hover:bg-red-500/15"
                : isTargetPaused
                ? "bg-s2/90 border-amber-500/30 text-on hover:bg-s2"
                : "bg-white dark:bg-neutral-800/90 border-amber-500/35 hover:border-amber-500/60 hover:bg-amber-500/5 text-on"
            }`}
          >
            <div className="flex items-center gap-3.5 min-w-0 flex-1">
              <div
                className={`w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 shadow-xs ${
                  isTargetDownloaded
                    ? "bg-emerald-500/20 text-emerald-600 dark:text-emerald-400"
                    : isTargetDownloading
                    ? "bg-amber-500/20 text-amber-600"
                    : isTargetError
                    ? "bg-red-500/20 text-red-500"
                    : isTargetPaused
                    ? "bg-amber-500/15 text-amber-600"
                    : "bg-gradient-to-br from-amber-500 to-amber-600 text-white shadow-amber-500/25"
                }`}
              >
                {isTargetDownloaded ? (
                  <ICheck size={24} strokeWidth={2.8} />
                ) : isTargetDownloading ? (
                  <Loader className="w-6 h-6 spinner text-amber-600" />
                ) : isTargetError ? (
                  <IAlertTriangle size={22} />
                ) : isTargetPaused ? (
                  <IPauseF size={20} />
                ) : (
                  <IDownload size={22} />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[15px] font-bold text-on flex items-center gap-2">
                  <span>
                    {isTargetDownloaded
                      ? `Episode ${targetEpisode} Saved`
                      : isTargetQueued
                      ? `Queued Ep. ${targetEpisode}`
                      : isTargetDownloading
                      ? `Downloading Ep. ${targetEpisode}`
                      : isTargetPaused
                      ? `Episode ${targetEpisode} Paused`
                      : isTargetError
                      ? `Episode ${targetEpisode} Failed`
                      : `Download Episode ${targetEpisode}`}
                  </span>
                  {isTargetDownloaded ? (
                    <span className="px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 text-[10px] font-bold uppercase tracking-wide shrink-0">
                      Offline
                    </span>
                  ) : (
                    targetEpisode === currentEpisode && (
                      <span className="px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-300 text-[10px] font-bold uppercase tracking-wide shrink-0">
                        Current
                      </span>
                    )
                  )}
                </div>
                <div className="text-[12px] text-mut mt-0.5 leading-snug">
                  {isTargetDownloaded
                    ? "Saved permanently · Tap to export MP4 to gallery"
                    : isTargetQueued
                    ? "Waiting in background queue · Tap pause or cancel"
                    : isTargetDownloading
                    ? targetActiveProg && targetActiveProg.downloadedBytes > 0
                      ? `Downloading · ${targetProgress}% (${formatBytes(targetActiveProg.downloadedBytes)}${
                          targetActiveProg.totalBytes > 0 ? ` / ${formatBytes(targetActiveProg.totalBytes)}` : ""
                        } · ${targetActiveProg.speedFormatted}${
                          targetActiveProg.etaFormatted && targetActiveProg.etaFormatted !== "--"
                            ? ` · ${targetActiveProg.etaFormatted} left`
                            : ""
                        })`
                      : "Connecting to stream..."
                    : isTargetPaused
                    ? `Paused · ${targetProgress}%${
                        targetActiveProg?.downloadedBytes ? ` (${formatBytes(targetActiveProg.downloadedBytes)})` : ""
                      } · Tap to resume`
                    : isTargetError
                    ? targetActiveProg?.error || "Download failed · Tap to retry"
                    : `Ultra-fast single episode download (~${estEpMb} MB)`}
                </div>
              </div>
            </div>

            <div className="shrink-0 flex items-center gap-1.5 ml-2">
              {isTargetDownloaded ? (
                <div className="px-3.5 py-2 rounded-xl bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 text-[12.5px] font-bold flex items-center gap-1.5 shadow-xs whitespace-nowrap">
                  <IExport size={14} /> Export
                </div>
              ) : isTargetDownloading || isTargetQueued ? (
                <>
                  <div className="text-amber-600 text-[13px] font-bold tabular-nums whitespace-nowrap bg-amber-500/15 px-2.5 py-1.5 rounded-xl">
                    {isTargetQueued ? "Queued" : targetActiveProg && targetActiveProg.downloadedBytes > 0 ? `${targetProgress}%` : "..."}
                  </div>
                  <button
                    type="button"
                    aria-label="Pause download"
                    onClick={(e) => {
                      e.stopPropagation();
                      pauseDownload(targetKey);
                    }}
                    className="w-8 h-8 rounded-xl bg-s3 hover:bg-s4/30 text-on flex items-center justify-center pressable"
                  >
                    <IPauseF size={13} />
                  </button>
                  <button
                    type="button"
                    aria-label="Cancel download"
                    onClick={(e) => {
                      e.stopPropagation();
                      cancelDownload(targetKey);
                    }}
                    className="w-8 h-8 rounded-xl bg-red-500/15 hover:bg-red-500/25 text-red-500 flex items-center justify-center pressable"
                  >
                    <IClose size={13} />
                  </button>
                </>
              ) : isTargetPaused ? (
                <>
                  <button
                    type="button"
                    aria-label="Resume download"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleSingleAction();
                    }}
                    className="px-3 py-1.5 rounded-xl bg-amber-500 text-white text-[12px] font-bold flex items-center gap-1 pressable"
                  >
                    <IPlayF size={12} /> Resume
                  </button>
                  <button
                    type="button"
                    aria-label="Cancel download"
                    onClick={(e) => {
                      e.stopPropagation();
                      cancelDownload(targetKey);
                    }}
                    className="w-8 h-8 rounded-xl bg-red-500/15 hover:bg-red-500/25 text-red-500 flex items-center justify-center pressable"
                  >
                    <IClose size={13} />
                  </button>
                </>
              ) : isTargetError ? (
                <div className="px-3.5 py-2 rounded-xl bg-red-500 text-white text-[12.5px] font-bold flex items-center gap-1.5 shadow-sm whitespace-nowrap">
                  Retry
                </div>
              ) : (
                <div className="px-4 py-2 rounded-xl bg-gradient-to-r from-amber-500 to-amber-600 text-white text-[13px] font-bold flex items-center gap-1.5 shadow-sm whitespace-nowrap">
                  <IDownload size={14} /> Download
                </div>
              )}
            </div>
          </div>

          {/* CARD 2: Batch Download (Full Season) */}
          <div
            role="button"
            tabIndex={0}
            onClick={() => {
              onClose();
              onOpenBatchDownload();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClose();
                onOpenBatchDownload();
              }
            }}
            className="w-full p-4 rounded-[20px] border border-border/90 bg-white dark:bg-neutral-800/90 hover:bg-s2 text-on text-left pressable transition-all flex items-center justify-between gap-3.5 shadow-xs cursor-pointer active:scale-[0.985]"
          >
            <div className="flex items-center gap-3.5 min-w-0 flex-1">
              <div className="w-12 h-12 rounded-2xl bg-s3 text-on flex items-center justify-center shrink-0 border border-border">
                <IDownload size={22} className="text-on" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[15px] font-bold text-on flex items-center gap-2">
                  <span>Download Full Season</span>
                  <span className="px-2 py-0.5 rounded-full bg-s3 text-on/80 text-[10px] font-bold uppercase tracking-wide shrink-0">
                    Batch
                  </span>
                </div>
                <div className="text-[12px] text-mut mt-0.5 leading-snug">
                  All {totalEps} episodes (~{estimatedBatchFormatted}) · Background sequential queue
                </div>
              </div>
            </div>

            <div className="shrink-0 ml-2">
              <div className="px-3.5 py-2 rounded-xl bg-[#1c1c1e] dark:bg-white text-white dark:text-black hover:bg-black text-[12.5px] font-bold flex items-center gap-1.5 shadow-xs whitespace-nowrap">
                <IDownload size={13} /> All ({totalEps})
              </div>
            </div>
          </div>
        </div>

        {/* Network & Device Storage Status Banner */}
        <div className="mt-1 p-3.5 rounded-[18px] bg-white dark:bg-neutral-800/80 border border-border shadow-xs flex flex-col gap-2">
          <div className="flex items-center justify-between text-[12px] text-mut">
            <div className="flex items-center gap-1.5">
              <IHardDrive size={14} className="text-amber-500 shrink-0" />
              <span>
                Free Space: <strong className="text-on font-bold">{freeSpaceFormatted || "Available"}</strong>
              </span>
            </div>
            {isCellular && wifiOnly ? (
              <div className="text-amber-600 dark:text-amber-400 font-semibold flex items-center gap-1 text-[11.5px]">
                <IAlertTriangle size={13} className="shrink-0" />
                <span>Wi-Fi Only Active</span>
              </div>
            ) : (
              <div className="text-emerald-600 dark:text-emerald-400 font-semibold flex items-center gap-1 text-[11.5px]">
                <IBoltF size={13} className="shrink-0" />
                <span>Turbo High-Speed Ready</span>
              </div>
            )}
          </div>
          <div className="w-full h-2 rounded-full bg-s4/60 overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-amber-500 to-amber-600 rounded-full transition-all duration-300"
              style={{ width: `${usedPercent ?? 0}%` }}
            />
          </div>
          <div className="text-[10.5px] text-mut leading-tight flex items-center gap-1.5">
            <IBoltF size={12} className="text-amber-500 shrink-0" />
            <span><strong>Permanent Offline Storage:</strong> Downloads are kept safely on device and never auto-deleted on app exit.</span>
          </div>
        </div>
      </div>
    </Sheet>
  );
}
