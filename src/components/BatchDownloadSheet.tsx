/**
 * AuraStream Series Batch Downloader Sheet
 * Enables 1-click bulk downloading of short drama series on Android phones
 * Features: Next 5 / Next 10 / All Unsaved presets, custom episode selector,
 * total MB estimation, cellular data guard, and sequential queue execution.
 */

import React, { useEffect, useRef, useState } from "react";
import { Sheet } from "./ui";
import { Button } from "./ios/controls";
import { Loader } from "./ios/effects";
import { IAlertTriangle, IBoltF, ICheck, IClose, IDiamond, IDownload } from "../icons";
import { useStore } from "../store";
import {
  executeBatchDownload,
  cancelBatchDownload,
  subscribeBatchProgress,
  subscribeDownloadProgress,
  isEpisodeDownloaded,
  isCellularConnection,
  isWifiOnlyDownloadEnabled,
  formatBytes,
  getDownloadQualityPreference,
  setDownloadQualityPreference,
  checkStorageAvailableForBatch,
  type ActiveDownloadProgress,
  type BatchProgressState,
  type DownloadQuality,
} from "../offline/downloadService";
import { formatDramaTitle } from "../subtitles/dramaTranslator";

interface BatchDownloadSheetProps {
  videoId: number;
  title: string;
  cover: string;
  totalEpisodes: number;
  episodeNumbers?: number[];
  preselectAll?: boolean;
  isOpen: boolean;
  onClose: () => void;
}

export default function BatchDownloadSheet({
  videoId,
  title,
  cover,
  totalEpisodes,
  episodeNumbers,
  preselectAll = false,
  isOpen,
  onClose,
}: BatchDownloadSheetProps) {
  const { toast, t } = useStore();
  const [selectedEps, setSelectedEps] = useState<Set<number>>(new Set());
  const [allowCellular, setAllowCellular] = useState(false);
  const [downloadQuality, setDownloadQuality] = useState<DownloadQuality>(() => getDownloadQualityPreference());
  const [batchProgress, setBatchProgress] = useState<BatchProgressState>({
    active: false,
    videoId: 0,
    title: "",
    total: 0,
    completed: 0,
    currentEpisode: 0,
    failedCount: 0,
  });
  const [activeMap, setActiveMap] = useState<Map<string, ActiveDownloadProgress>>(() => new Map());

  const prevOpenRef = useRef(false);
  const prevVideoIdRef = useRef(videoId);
  const maxBatchPctRef = useRef(0);
  const prevBatchKeyRef = useRef("");

  const isCellular = isCellularConnection();
  const wifiOnly = isWifiOnlyDownloadEnabled();
  const cellularBlocked = isCellular && wifiOnly && !allowCellular;

  // Initialize episode numbers accurately from episode list when provided
  const sortedExplicitEps = Array.isArray(episodeNumbers) && episodeNumbers.length > 0
    ? Array.from(new Set(episodeNumbers.filter((n) => Number.isFinite(n) && n > 0))).sort((a, b) => a - b)
    : [];
  const epCount = Math.max(1, totalEpisodes || sortedExplicitEps.length || 1);
  const allEpisodes = sortedExplicitEps.length > 0
    ? sortedExplicitEps
    : Array.from({ length: epCount }, (_, i) => i + 1);
  const downloadedSet = new Set(
    allEpisodes.filter((ep) => isEpisodeDownloaded(videoId, ep))
  );

  useEffect(() => {
    const unsubBatch = subscribeBatchProgress((st) => setBatchProgress(st));
    const unsubDl = subscribeDownloadProgress((map) => setActiveMap(new Map(map)));
    return () => {
      unsubBatch();
      unsubDl();
    };
  }, []);

  // Pre-select all unsaved (when launched from Full Season) or next 5 undownloaded when sheet opens
  useEffect(() => {
    const justOpened = isOpen && !prevOpenRef.current;
    const videoChangedWhileOpen = isOpen && prevVideoIdRef.current !== videoId;
    prevOpenRef.current = isOpen;
    prevVideoIdRef.current = videoId;

    const undownloaded = allEpisodes.filter((ep) => !isEpisodeDownloaded(videoId, ep));
    const preset = () => new Set(preselectAll ? undownloaded : undownloaded.slice(0, 5));
    if (justOpened || videoChangedWhileOpen) {
      setSelectedEps(preset());
      setDownloadQuality(getDownloadQualityPreference());
    } else if (isOpen) {
      // Episode list may resolve asynchronously: drop stale picks and refill if empty
      const valid = new Set(allEpisodes);
      setSelectedEps((prev) => {
        const kept = Array.from(prev).filter((ep) => valid.has(ep));
        if (kept.length === prev.size && kept.length > 0) return prev;
        return kept.length > 0 ? new Set(kept) : preset();
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, videoId, totalEpisodes, preselectAll, sortedExplicitEps.length]);

  const seriesQueueItems = Array.from(activeMap.values()).filter(
    (item) => item.videoId === videoId && (item.status === "downloading" || item.status === "queued")
  );
  const downloadingItems = seriesQueueItems.filter((item) => item.status === "downloading");
  const isCurrentBatchActive =
    seriesQueueItems.length > 0 || (batchProgress.active && batchProgress.videoId === videoId);
  const batchSessionKey = isCurrentBatchActive ? `${videoId}:${Math.max(batchProgress.total, seriesQueueItems.length)}` : "";

  const activeDownloadingItem =
    downloadingItems[0] ||
    seriesQueueItems[0] ||
    (batchProgress.videoId === videoId ? activeMap.get(`${videoId}_${batchProgress.currentEpisode}`) : undefined);
  const activeEpProgress = activeDownloadingItem;
  const activeEpNum = activeEpProgress?.episode || batchProgress.currentEpisode;
  const activeEpPct = activeEpProgress?.progress || 0;
  const activeFractionSum = downloadingItems.reduce(
    (sum, item) => sum + Math.min(99, Math.max(0, item.progress || 0)) / 100,
    0
  );
  const displayBatchTotal =
    batchProgress.videoId === videoId && batchProgress.total > 0
      ? Math.max(batchProgress.total, seriesQueueItems.length)
      : Math.max(1, seriesQueueItems.length);
  const processedCount =
    batchProgress.videoId === videoId && batchProgress.total > 0
      ? batchProgress.completed + batchProgress.failedCount
      : Math.max(0, displayBatchTotal - seriesQueueItems.length);
  const rawBatchPct = Math.min(
    100,
    Math.max(
      activeEpPct > 0 || processedCount > 0 ? 2 : 0,
      Math.round(((processedCount + activeFractionSum) / Math.max(1, displayBatchTotal)) * 100)
    )
  );
  const sessionChanged = prevBatchKeyRef.current !== batchSessionKey;
  const overallBatchPct = isCurrentBatchActive
    ? Math.max(rawBatchPct, sessionChanged ? 0 : maxBatchPctRef.current)
    : 0;

  useEffect(() => {
    prevBatchKeyRef.current = batchSessionKey;
    maxBatchPctRef.current = overallBatchPct;
  }, [batchSessionKey, overallBatchPct]);

  if (!isOpen) return null;

  const selectableEpisodes = allEpisodes.filter((ep) => {
    if (downloadedSet.has(ep)) return false;
    const st = activeMap.get(`${videoId}_${ep}`)?.status;
    return st !== "downloading" && st !== "queued";
  });
  const selectableCount = selectableEpisodes.length;

  const effectiveSelected = Array.from(selectedEps).filter((ep) => {
    if (downloadedSet.has(ep)) return false;
    const st = activeMap.get(`${videoId}_${ep}`)?.status;
    return st !== "downloading" && st !== "queued";
  });

  const toggleEp = (ep: number) => {
    const st = activeMap.get(`${videoId}_${ep}`)?.status;
    if (downloadedSet.has(ep) || st === "downloading" || st === "queued") return;
    const next = new Set(selectedEps);
    if (next.has(ep)) next.delete(ep);
    else next.add(ep);
    setSelectedEps(next);
  };

  const selectNext = (count: number) => {
    const candidatePool = allEpisodes.filter((ep) => {
      if (downloadedSet.has(ep)) return false;
      const st = activeMap.get(`${videoId}_${ep}`)?.status;
      return st !== "downloading" && st !== "queued";
    });
    const unselected = candidatePool.filter((ep) => !selectedEps.has(ep));
    if (unselected.length > 0) {
      const next = new Set(selectedEps);
      for (const ep of unselected.slice(0, count)) {
        next.add(ep);
      }
      setSelectedEps(next);
    } else {
      setSelectedEps(new Set(candidatePool.slice(0, count)));
    }
  };

  const selectAllUnsaved = () => {
    const undownloaded = allEpisodes.filter((ep) => {
      if (downloadedSet.has(ep)) return false;
      const st = activeMap.get(`${videoId}_${ep}`)?.status;
      return st !== "downloading" && st !== "queued";
    });
    setSelectedEps(new Set(undownloaded));
  };

  const clearSelection = () => {
    setSelectedEps(new Set());
  };

  const avgMb = downloadQuality === "standard" ? 18.0 : 14.5;
  const estBytes = Math.round(effectiveSelected.length * avgMb * 1024 * 1024);
  const estFormatted = formatBytes(estBytes);

  const startBatch = async () => {
    if (effectiveSelected.length === 0) return;
    if (cellularBlocked) {
      toast("Cellular network detected. Allow cellular or connect to Wi-Fi", "info");
      return;
    }
    const storageCheck = await checkStorageAvailableForBatch(estBytes);
    if (!storageCheck.sufficient) {
      toast(storageCheck.reason || t("batch.low_storage_warning"), "info");
      return;
    }
    const list = [...effectiveSelected].sort((a, b) => a - b);
    const safeTitle = formatDramaTitle(title) || title || `Drama #${videoId}`;
    try {
      const res = await executeBatchDownload(videoId, safeTitle, cover, list, allowCellular, downloadQuality);
      setSelectedEps((prev) =>
        new Set(
          Array.from(prev).filter((ep) => {
            if (isEpisodeDownloaded(videoId, ep)) return false;
            const st = activeMap.get(`${videoId}_${ep}`)?.status;
            return st !== "downloading" && st !== "queued";
          })
        )
      );
      if (typeof res.queued === "number" && res.queued > 0) {
        toast(`Queued ${res.queued} ${res.queued === 1 ? "episode" : "episodes"} for background download`, "ok");
      } else {
        toast(`Batch download complete: ${res.success} saved (${res.failed} failed)`, res.failed ? "info" : "ok");
      }
    } catch (e) {
      toast((e as Error).message || "Batch download failed", "info");
    }
  };

  return (
    <Sheet open={isOpen} onClose={onClose} label={t("batch.title")}>
      <div className="flex flex-col max-h-[85vh] overflow-hidden bg-s1 text-on">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-edge/30 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 flex items-center justify-center">
              <IDownload size={17} />
            </div>
            <div>
              <div className="text-[15px] font-bold text-on">{t("batch.title")}</div>
              <div className="text-[12px] text-mut truncate max-w-[240px]">
                {formatDramaTitle(title) || title || `Drama #${videoId}`} · {t("player.total_episodes", { count: epCount })}
              </div>
            </div>
          </div>
          <Button
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-s3 flex items-center justify-center text-mut pressable"
            aria-label={t("common.close")}
          >
            <IClose size={14} />
          </Button>
        </div>

        {/* Cellular Warning (if applicable) */}
        {isCellular && wifiOnly && (
          <div className="mx-4 mt-3 p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-between shrink-0">
            <div className="text-[12px] text-amber-700 dark:text-amber-300 pr-2 flex items-center gap-1.5">
              <IAlertTriangle size={14} className="shrink-0 text-amber-500" />
              <span>{t("batch.cellular_warning")}</span>
            </div>
            <label className="flex items-center gap-1.5 text-[11px] text-on cursor-pointer shrink-0">
              <input
                type="checkbox"
                checked={allowCellular}
                onChange={(e) => setAllowCellular(e.target.checked)}
                className="rounded accent-emerald-500"
              />
              <span>{t("batch.allow_cellular")}</span>
            </label>
          </div>
        )}

        {/* Quick Presets */}
        <div className="flex items-center gap-2 p-3 border-b border-edge/30 shrink-0 overflow-x-auto scrollbar-none">
          <Button
            disabled={selectableCount === 0}
            onClick={() => selectNext(5)}
            className="px-3 py-1.5 rounded-xl bg-s3 text-[12px] font-semibold text-on pressable disabled:opacity-45"
          >
            + {t("batch.next_5")}
          </Button>
          <Button
            disabled={selectableCount === 0}
            onClick={() => selectNext(10)}
            className="px-3 py-1.5 rounded-xl bg-s3 text-[12px] font-semibold text-on pressable disabled:opacity-45"
          >
            + {t("batch.next_10")}
          </Button>
          <Button
            disabled={selectableCount === 0}
            onClick={selectAllUnsaved}
            className="px-3 py-1.5 rounded-xl bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 text-[12px] font-bold pressable disabled:opacity-45"
          >
            {t("batch.all_unsaved", { count: selectableCount })}
          </Button>
          <Button
            onClick={clearSelection}
            className="ml-auto px-2.5 py-1.5 rounded-xl bg-s3 text-[11px] text-mut hover:text-red-500 pressable"
          >
            {t("batch.clear")}
          </Button>
        </div>

        {/* Episode Checkbox Grid */}
        <div className="flex-1 overflow-y-auto p-4">
          <div className="grid grid-cols-5 gap-2">
            {allEpisodes.map((ep) => {
              const isDownloaded = downloadedSet.has(ep);
              const isSelected = selectedEps.has(ep);
              const epProg = activeMap.get(`${videoId}_${ep}`);
              const isCurrentDownloading = epProg?.status === "downloading";
              const isQueued = epProg?.status === "queued";
              return (
                <button
                  key={ep}
                  type="button"
                  aria-label={`Episode ${ep}`}
                  disabled={isDownloaded || isCurrentDownloading || isQueued}
                  onClick={() => toggleEp(ep)}
                  className={`h-11 rounded-xl text-[13px] font-semibold flex items-center justify-center relative overflow-hidden transition-all ${
                    isDownloaded
                      ? "bg-emerald-500/15 border border-emerald-500/30 text-emerald-700 dark:text-emerald-400 cursor-default font-bold"
                      : isCurrentDownloading
                      ? "bg-primary/20 border-2 border-primary text-primary font-bold"
                      : isQueued
                      ? "bg-blue-500/15 border border-blue-500/30 text-blue-600 dark:text-blue-400 font-bold"
                      : isSelected
                      ? "bg-primary text-on-primary shadow-sm font-bold scale-[0.98]"
                      : "bg-s3/90 text-on/80 hover:bg-s4/60 border border-edge/30"
                  }`}
                >
                  {isCurrentDownloading && (epProg?.progress || 0) > 0 && (
                    <span
                      className="absolute inset-y-0 left-0 bg-primary/25 transition-all duration-300 pointer-events-none"
                      style={{ width: `${epProg?.progress || 0}%` }}
                    />
                  )}
                  {isDownloaded ? (
                    <span className="flex items-center gap-0.5 relative z-10">
                      <ICheck size={11} strokeWidth={3} />
                      <span className="text-[11px]">{ep}</span>
                    </span>
                  ) : isCurrentDownloading ? (
                    <span className="text-[11px] relative z-10">
                      {ep} · {epProg?.progress || 0}%
                    </span>
                  ) : isQueued ? (
                    <span className="text-[10.5px] relative z-10">
                      {ep} · Q
                    </span>
                  ) : (
                    <span className="relative z-10">{ep}</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Active Batch Progress Banner (if downloading or queued) */}
        {isCurrentBatchActive && (
          <div className="p-3 bg-primary/10 border-t border-primary/20 flex flex-col gap-1.5 shrink-0">
            <div className="flex items-center justify-between text-[12px]">
              <span className="font-semibold text-primary flex items-center gap-1.5">
                <Loader className="w-4 h-4 spinner" />
                <span>
                  {downloadingItems.length > 1
                    ? `Downloading ${downloadingItems.length} episodes (${processedCount}/${displayBatchTotal}) · ${overallBatchPct}%`
                    : `${t("batch.downloading", {
                        current: activeEpNum,
                        completed: processedCount,
                        total: displayBatchTotal,
                      })}${activeEpPct > 0 ? ` · ${activeEpPct}%` : ""}`}
                </span>
              </span>
              <Button
                onClick={() => cancelBatchDownload(videoId)}
                className="text-[11px] text-red-500 hover:underline pressable"
              >
                {t("batch.cancel_batch")}
              </Button>
            </div>
            {activeEpProgress && (
              <div className="flex items-center justify-between text-[11px] text-mut">
                <span>
                  {activeEpProgress.downloadedBytes > 0
                    ? `${formatBytes(activeEpProgress.downloadedBytes)}${
                        activeEpProgress.totalBytes > 0 ? ` / ${formatBytes(activeEpProgress.totalBytes)}` : ""
                      }`
                    : "Connecting to stream..."}
                </span>
                {activeEpProgress.downloadedBytes > 0 &&
                  activeEpProgress.speedFormatted &&
                  !/connecting|--/i.test(activeEpProgress.speedFormatted) && (
                    <span>
                      {activeEpProgress.speedFormatted}
                      {activeEpProgress.etaFormatted && activeEpProgress.etaFormatted !== "--"
                        ? ` · ETA ${activeEpProgress.etaFormatted}`
                        : ""}
                    </span>
                  )}
              </div>
            )}
            <div className="w-full h-2 rounded-full bg-black/10 dark:bg-white/10 overflow-hidden relative">
              <div
                data-testid="batch-overall-progress"
                className="h-full bg-primary transition-all duration-300"
                style={{
                  width: `${overallBatchPct}%`,
                }}
              />
            </div>
          </div>
        )}

        {/* Quality Selector Segment */}
        <div className="flex items-center justify-between px-4 py-2 border-t border-edge/30 bg-s2/50 shrink-0">
          <span className="text-[11px] font-semibold text-mut flex items-center gap-1">
            {t("batch.quality_title")}
          </span>
          <div className="flex items-center gap-1 bg-s3/80 p-0.5 rounded-lg border border-edge/30">
            <button
              type="button"
              onClick={() => {
                setDownloadQuality("hevc");
                setDownloadQualityPreference("hevc");
              }}
              className={`px-2.5 py-1 rounded-md text-[11px] font-bold transition-all flex items-center gap-1.5 ${
                downloadQuality === "hevc" || downloadQuality === "auto"
                  ? "bg-white dark:bg-neutral-800 text-slate-900 dark:text-white shadow-xs border border-black/5 dark:border-white/15"
                  : "text-mut hover:text-on"
              }`}
            >
              <IBoltF size={12} className="shrink-0 text-amber-500" />
              <span>{t("batch.quality_hevc")}</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setDownloadQuality("standard");
                setDownloadQualityPreference("standard");
              }}
              className={`px-2.5 py-1 rounded-md text-[11px] font-bold transition-all flex items-center gap-1.5 ${
                downloadQuality === "standard"
                  ? "bg-white dark:bg-neutral-800 text-slate-900 dark:text-white shadow-xs border border-black/5 dark:border-white/15"
                  : "text-mut hover:text-on"
              }`}
            >
              <IDiamond size={12} className="shrink-0 text-sky-500" />
              <span>{t("batch.quality_standard")}</span>
            </button>
          </div>
        </div>

        {/* Footer Summary & Action Button */}
        <div className="px-4 pt-3 pb-4 border-t border-edge/30 flex items-center justify-between gap-3 shrink-0 bg-s1">
          <div className="flex flex-col">
            <span className="text-[13px] font-bold text-on">
              {effectiveSelected.length > 0
                ? t("batch.selected_count", { count: effectiveSelected.length })
                : isCurrentBatchActive
                ? `${seriesQueueItems.length} in queue (${downloadingItems.length || 1} active)`
                : t("batch.selected_count", { count: 0 })}
            </span>
            <span className="text-[11px] text-mut">
              {effectiveSelected.length > 0
                ? t("batch.est_size", { size: estFormatted })
                : isCurrentBatchActive
                ? "Tap episodes above to add more"
                : t("batch.est_size", { size: estFormatted })}
            </span>
          </div>

          <Button
            disabled={effectiveSelected.length === 0}
            onClick={startBatch}
            className={`px-5 h-10 rounded-xl text-[13px] font-bold flex items-center gap-2 pressable ${
              effectiveSelected.length > 0
                ? "bg-primary text-on-primary shadow-lg shadow-primary/25"
                : "bg-s3 text-mut cursor-not-allowed opacity-50"
            }`}
          >
            <IDownload size={15} />
            {batchProgress.active && !isCurrentBatchActive
              ? `Add to queue (${effectiveSelected.length})`
              : effectiveSelected.length > 0
              ? t("batch.download_selected", { count: effectiveSelected.length })
              : isCurrentBatchActive
              ? "Select Episodes"
              : t("batch.download_selected", { count: 0 })}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
