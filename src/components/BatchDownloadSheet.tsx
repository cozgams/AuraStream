/**
 * AuraStream Series Batch Downloader Sheet
 * Enables 1-click bulk downloading of short drama series on Android phones
 * Features: Next 5 / Next 10 / All Unsaved presets, custom episode selector,
 * total MB estimation, cellular data guard, and sequential queue execution.
 */

import React, { useEffect, useState } from "react";
import { Sheet } from "./ui";
import { Button } from "./ios/controls";
import { Loader } from "./ios/effects";
import { IAlertTriangle, IBoltF, ICheck, IClose, IDiamond, IDownload, ITrash } from "../icons";
import { useStore } from "../store";
import {
  executeBatchDownload,
  cancelBatchDownload,
  subscribeBatchProgress,
  isEpisodeDownloaded,
  isCellularConnection,
  isWifiOnlyDownloadEnabled,
  formatBytes,
  getDownloadQualityPreference,
  setDownloadQualityPreference,
  checkStorageAvailableForBatch,
  type BatchProgressState,
  type DownloadQuality,
} from "../offline/downloadService";
import { formatDramaTitle } from "../subtitles/dramaTranslator";

interface BatchDownloadSheetProps {
  videoId: number;
  title: string;
  cover: string;
  totalEpisodes: number;
  isOpen: boolean;
  onClose: () => void;
}

export default function BatchDownloadSheet({
  videoId,
  title,
  cover,
  totalEpisodes,
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

  const isCellular = isCellularConnection();
  const wifiOnly = isWifiOnlyDownloadEnabled();
  const cellularBlocked = isCellular && wifiOnly && !allowCellular;

  // Initialize all episode numbers safely
  const epCount = Math.max(1, totalEpisodes || 1);
  const allEpisodes = Array.from({ length: epCount }, (_, i) => i + 1);
  const downloadedSet = new Set(
    allEpisodes.filter((ep) => isEpisodeDownloaded(videoId, ep))
  );

  useEffect(() => {
    return subscribeBatchProgress((st) => setBatchProgress(st));
  }, []);

  // Pre-select next 5 undownloaded on open
  useEffect(() => {
    if (isOpen) {
      const undownloaded = allEpisodes.filter((ep) => !downloadedSet.has(ep));
      setSelectedEps(new Set(undownloaded.slice(0, 5)));
    }
  }, [isOpen, videoId, totalEpisodes]);

  if (!isOpen) return null;

  const toggleEp = (ep: number) => {
    if (downloadedSet.has(ep)) return;
    const next = new Set(selectedEps);
    if (next.has(ep)) next.delete(ep);
    else next.add(ep);
    setSelectedEps(next);
  };

  const selectNext = (count: number) => {
    const undownloaded = allEpisodes.filter((ep) => !downloadedSet.has(ep));
    setSelectedEps(new Set(undownloaded.slice(0, count)));
  };

  const selectAllUnsaved = () => {
    const undownloaded = allEpisodes.filter((ep) => !downloadedSet.has(ep));
    setSelectedEps(new Set(undownloaded));
  };

  const clearSelection = () => {
    setSelectedEps(new Set());
  };

  const avgMb = downloadQuality === "standard" ? 18.0 : 14.5;
  const estBytes = Math.round(selectedEps.size * avgMb * 1024 * 1024);
  const estFormatted = formatBytes(estBytes);

  const startBatch = async () => {
    if (selectedEps.size === 0) return;
    if (cellularBlocked) {
      toast("Cellular network detected. Allow cellular or connect to Wi-Fi", "info");
      return;
    }
    const storageCheck = await checkStorageAvailableForBatch(estBytes);
    if (!storageCheck.sufficient) {
      toast(storageCheck.reason || t("batch.low_storage_warning"), "info");
      return;
    }
    const list = Array.from(selectedEps).sort((a, b) => a - b);
    const safeTitle = formatDramaTitle(title) || title || `Drama #${videoId}`;
    toast(`Queued ${list.length} episodes for batch download`, "ok");
    try {
      const res = await executeBatchDownload(videoId, safeTitle, cover, list, allowCellular, downloadQuality);
      toast(`Batch download complete: ${res.success} saved (${res.failed} failed)`, res.failed ? "info" : "ok");
    } catch (e) {
      toast((e as Error).message || "Batch download failed", "info");
    }
  };

  const isCurrentBatchActive = batchProgress.active && batchProgress.videoId === videoId;

  return (
    <Sheet open={isOpen} onClose={onClose} label={t("batch.title")}>
      <div className="flex flex-col max-h-[85vh] overflow-hidden bg-canvas text-on">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-edge/30 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 flex items-center justify-center">
              <IDownload size={17} />
            </div>
            <div>
              <div className="text-[15px] font-bold text-on">{t("batch.title")}</div>
              <div className="text-[12px] text-mut truncate max-w-[240px]">
                {formatDramaTitle(title)} · {t("player.total_episodes", { count: totalEpisodes })}
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
            onClick={() => selectNext(5)}
            className="px-3 py-1.5 rounded-xl bg-s3 text-[12px] font-semibold text-on pressable"
          >
            + {t("batch.next_5")}
          </Button>
          <Button
            onClick={() => selectNext(10)}
            className="px-3 py-1.5 rounded-xl bg-s3 text-[12px] font-semibold text-on pressable"
          >
            + {t("batch.next_10")}
          </Button>
          <Button
            onClick={selectAllUnsaved}
            className="px-3 py-1.5 rounded-xl bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 text-[12px] font-bold pressable"
          >
            {t("batch.all_unsaved", { count: Math.max(0, allEpisodes.length - downloadedSet.size) })}
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
              return (
                <button
                  key={ep}
                  type="button"
                  aria-label={`Episode ${ep}`}
                  disabled={isDownloaded || isCurrentBatchActive}
                  onClick={() => toggleEp(ep)}
                  className={`h-11 rounded-xl text-[13px] font-semibold flex items-center justify-center relative transition-all ${
                    isDownloaded
                      ? "bg-emerald-500/15 border border-emerald-500/30 text-emerald-700 dark:text-emerald-400 cursor-default font-bold"
                      : isSelected
                      ? "bg-primary text-on-primary shadow-sm font-bold scale-[0.98]"
                      : "bg-s3/90 text-on/80 hover:bg-s4/60 border border-edge/30"
                  }`}
                >
                  {isDownloaded ? (
                    <span className="flex items-center gap-0.5">
                      <ICheck size={11} strokeWidth={3} />
                      <span className="text-[11px]">{ep}</span>
                    </span>
                  ) : (
                    <span>{ep}</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Active Batch Progress Banner (if downloading) */}
        {isCurrentBatchActive && (
          <div className="p-3 bg-primary/10 border-t border-primary/20 flex flex-col gap-1.5 shrink-0">
            <div className="flex items-center justify-between text-[12px]">
              <span className="font-semibold text-primary flex items-center gap-1.5">
                <Loader className="w-4 h-4 spinner" />
                {t("batch.downloading", {
                  current: batchProgress.currentEpisode,
                  completed: batchProgress.completed,
                  total: batchProgress.total,
                })}
              </span>
              <Button
                onClick={() => cancelBatchDownload()}
                className="text-[11px] text-red-500 hover:underline pressable"
              >
                {t("batch.cancel_batch")}
              </Button>
            </div>
            <div className="w-full h-1.5 rounded-full bg-black/10 dark:bg-white/10 overflow-hidden">
              <div
                className="h-full bg-primary transition-all duration-300"
                style={{
                  width: `${Math.round((batchProgress.completed / Math.max(1, batchProgress.total)) * 100)}%`,
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
                  ? "bg-white text-on shadow-xs border border-black/5"
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
                  ? "bg-white text-on shadow-xs border border-black/5"
                  : "text-mut hover:text-on"
              }`}
            >
              <IDiamond size={12} className="shrink-0 text-sky-500" />
              <span>{t("batch.quality_standard")}</span>
            </button>
          </div>
        </div>

        {/* Footer Summary & Action Button */}
        <div className="px-4 pt-3 pb-[calc(var(--sab,48px)+14px)] border-t border-edge/30 flex items-center justify-between gap-3 shrink-0 bg-s1">
          <div className="flex flex-col">
            <span className="text-[13px] font-bold text-on">
              {t("batch.selected_count", { count: selectedEps.size })}
            </span>
            <span className="text-[11px] text-mut">
              {t("batch.est_size", { size: estFormatted })}
            </span>
          </div>

          <Button
            disabled={selectedEps.size === 0 || batchProgress.active}
            onClick={startBatch}
            className={`px-5 h-10 rounded-xl text-[13px] font-bold flex items-center gap-2 pressable ${
              selectedEps.size > 0 && !batchProgress.active
                ? "bg-primary text-on-primary shadow-lg shadow-primary/25"
                : "bg-s3 text-mut cursor-not-allowed opacity-50"
            }`}
          >
            <IDownload size={15} />
            {batchProgress.active && !isCurrentBatchActive
              ? "Batch in progress..."
              : t("batch.download_selected", { count: selectedEps.size })}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
