/**
 * AuraStream Download Choice Sheet
 * Modern iOS frosted-glass bottom sheet with warm light theme accents.
 * Features:
 * 1. Hero drama header with cover artwork, episode pill, quality badge, and close button.
 * 2. Interactive quick episode strip to switch the single download target.
 * 3. Elevated single episode download card with live progress and export action.
 * 4. High-contrast full season batch download card with total size estimation.
 * 5. Device storage meter with high-speed turbo engine status.
 */

import React, { useEffect, useState } from "react";
import { Sheet } from "./ui";
import { Button } from "./ios/controls";
import { Loader } from "./ios/effects";
import { IAlertTriangle, IBoltF, ICheck, IClose, IDownload, IExport, IHardDrive, IFilm } from "../icons";
import { useStore } from "../store";
import {
  isCellularConnection,
  isWifiOnlyDownloadEnabled,
  getDownloadQualityPreference,
  getDetailedStorageStats,
  isEpisodeDownloaded,
  isEpisodeDownloading,
  getEpisodeDownloadProgress,
  startEpisodeDownload,
} from "../offline/downloadService";
import { formatDramaTitle } from "../subtitles/dramaTranslator";
import { cover, api } from "../api";
import { resolveStreamUrlForQuality } from "../offline/downloadService";

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
  const [usedPercent, setUsedPercent] = useState<number>(45);
  const [targetEpisode, setTargetEpisode] = useState<number>(currentEpisode);

  const isCellular = isCellularConnection();
  const wifiOnly = isWifiOnlyDownloadEnabled();
  const quality = getDownloadQualityPreference();
  const totalEps = Math.max(1, totalEpisodes || 10);
  const allEpisodes = Array.from({ length: totalEps }, (_, i) => i + 1);

  // Sync targetEpisode when sheet opens with current episode
  useEffect(() => {
    if (isOpen) {
      setTargetEpisode(currentEpisode);
      void getDetailedStorageStats().then((stats) => {
        setFreeSpaceFormatted(stats.freeFormatted || "Available");
        setUsedPercent(Math.min(98, Math.max(5, stats.percentUsed || 40)));
      });
    }
  }, [isOpen, currentEpisode]);

  if (!isOpen) return null;

  const isTargetDownloaded =
    targetEpisode === currentEpisode ? propIsDownloaded : isEpisodeDownloaded(videoId, targetEpisode);
  const isTargetDownloading =
    targetEpisode === currentEpisode ? propIsDownloading : isEpisodeDownloading(videoId, targetEpisode);
  const targetProgress =
    targetEpisode === currentEpisode ? propDownloadProgress : getEpisodeDownloadProgress(videoId, targetEpisode);

  const handleSingleAction = async () => {
    if (isTargetDownloaded) {
      onClose();
      onOpenExport?.(targetEpisode);
      return;
    }
    if (isTargetDownloading) {
      onClose();
      return;
    }

    onClose();
    onStartSingleDownload(targetEpisode);
  };

  const estimatedBatchGb = ((totalEps * 14.5) / 1024).toFixed(1);

  return (
    <Sheet open={isOpen} onClose={onClose} label="Offline Downloads">
      <div className="flex flex-col bg-canvas text-on p-4 sm:p-5 pb-[calc(var(--sab,48px)+16px)] gap-3.5 max-h-[82dvh] overflow-y-auto">
        {/* Top subtle drag indicator */}
        <div className="w-10 h-1 rounded-full bg-border/70 mx-auto -mt-1 mb-1" />

        {/* Hero Header with Artwork & Metadata */}
        <div className="flex items-center justify-between pb-3.5 border-b border-border/80">
          <div className="flex items-center gap-3.5 min-w-0">
            {coverUrl ? (
              <img
                src={cover(coverUrl, 160)}
                alt={title}
                className="w-13 h-17 object-cover rounded-2xl shadow-md border border-border shrink-0"
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
                  {quality.toUpperCase()} Full HD
                </span>
                <span className="text-[11.5px] text-mut">~14.5 MB</span>
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
            {allEpisodes.slice(0, 40).map((ep) => {
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
            onClick={handleSingleAction}
            className={`w-full p-4 rounded-[20px] border text-left pressable transition-all flex items-center justify-between gap-3.5 shadow-xs cursor-pointer active:scale-[0.985] ${
              isTargetDownloaded
                ? "bg-emerald-500/10 border-emerald-500/40 text-on hover:bg-emerald-500/15"
                : isTargetDownloading
                ? "bg-amber-500/10 border-amber-500/40 text-on hover:bg-amber-500/15"
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
                    : "bg-gradient-to-br from-amber-500 to-amber-600 text-white shadow-amber-500/25"
                }`}
              >
                {isTargetDownloaded ? (
                  <ICheck size={24} strokeWidth={2.8} />
                ) : isTargetDownloading ? (
                  <Loader className="w-6 h-6 spinner text-amber-600" />
                ) : (
                  <IDownload size={22} />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[15px] font-bold text-on flex items-center gap-2">
                  <span>
                    {isTargetDownloaded
                      ? `Episode ${targetEpisode} Saved`
                      : isTargetDownloading
                      ? `Downloading Ep. ${targetEpisode}`
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
                    : isTargetDownloading
                    ? `Downloading · ${targetProgress}% completed`
                    : "Ultra-fast single episode download (~14.5 MB)"}
                </div>
              </div>
            </div>

            <div className="shrink-0 flex items-center ml-2">
              {isTargetDownloaded ? (
                <div className="px-3.5 py-2 rounded-xl bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 text-[12.5px] font-bold flex items-center gap-1.5 shadow-xs whitespace-nowrap">
                  <IExport size={14} /> Export
                </div>
              ) : isTargetDownloading ? (
                <div className="text-amber-600 text-[13px] font-bold tabular-nums whitespace-nowrap bg-amber-500/15 px-3 py-1.5 rounded-xl">
                  {targetProgress}%
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
            onClick={() => {
              onClose();
              onOpenBatchDownload();
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
                  All {totalEps} episodes (~{estimatedBatchGb} GB) · Background sequential queue
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
              style={{ width: `${usedPercent}%` }}
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