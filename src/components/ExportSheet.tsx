import React, { useEffect, useRef, useState } from "react";
import { Sheet } from "./ui";
import { Button } from "./ios/controls";
import { Loader } from "./ios/effects";
import {
  IAlertTriangle,
  ICheck,
  IClose,
  IDownload,
  IExport,
  IFilm,
  IFolder,
  ISdCard,
  IShare,
} from "../icons";
import { useStore } from "../store";
import {
  processEpisodeExport,
  openInGallery,
  getDeviceStorageInfo,
  isNativeExportSupported,
  type ExportAction,
  type StorageInfo,
} from "../offline/exportService";
import { formatDramaTitle } from "../dramaTranslator";

export interface ExportTarget {
  id: ExportAction;
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  badge?: string;
  available: boolean;
}

export interface ExportBatchItem {
  videoId: number;
  episode: number;
  title: string;
}

interface ExportSheetProps {
  isOpen: boolean;
  onClose: () => void;
  videoId: number;
  episode?: number;
  title: string;
  batchEpisodes?: number[];
  batchItems?: ExportBatchItem[];
}

interface ExportBannerStatus {
  kind: "success" | "error";
  message: string;
  showGallery: boolean;
}

export default function ExportSheet({
  isOpen,
  onClose,
  videoId,
  episode,
  title,
  batchEpisodes,
  batchItems,
}: ExportSheetProps) {
  const { toast } = useStore();
  const [storageInfo, setStorageInfo] = useState<StorageInfo>(() => getDeviceStorageInfo());
  const [exporting, setExporting] = useState<boolean>(false);
  const [progress, setProgress] = useState<number>(0);
  const [currentEpIndex, setCurrentEpIndex] = useState<number>(0);
  const [exportStatus, setExportStatus] = useState<ExportBannerStatus | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const itemsToExport: ExportBatchItem[] =
    batchItems && batchItems.length > 0
      ? batchItems
      : batchEpisodes && batchEpisodes.length > 0
        ? batchEpisodes.map((ep) => ({ videoId, episode: ep, title }))
        : episode != null
          ? [{ videoId, episode, title }]
          : [];

  const isBatch = itemsToExport.length > 1;
  const epCount = itemsToExport.length;

  useEffect(() => {
    if (isOpen) {
      setStorageInfo(getDeviceStorageInfo());
      setExportStatus(null);
      setProgress(0);
      setCurrentEpIndex(0);
      setExporting(false);
    } else {
      abortRef.current?.abort();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const targets: ExportTarget[] = [
    {
      id: "save_movies",
      title: "Phone Gallery & Movies",
      subtitle: "Movies/AuraStream · Visible in Gallery, Google Photos & Video Players",
      icon: <IFilm size={20} className="text-primary" />,
      badge: "Recommended",
      available: true,
    },
    {
      id: "save_downloads",
      title: "Phone Downloads Folder",
      subtitle: "Download/AuraStream · Easily accessible in Files / My Files app",
      icon: <IFolder size={20} className="text-cyan-500" />,
      badge: "Standard",
      available: true,
    },
    {
      id: "save_sdcard",
      title: "MicroSD Card Storage",
      subtitle: storageInfo.hasSdCard
        ? `Direct SD Card / AuraStream · ${(storageInfo.sdFreeBytes / (1024 * 1024 * 1024)).toFixed(1)} GB Free`
        : "No physical MicroSD card found · Will fallback to Downloads",
      icon: <ISdCard size={20} className="text-amber-500" />,
      badge: storageInfo.hasSdCard ? "SD Card" : "Fallback",
      available: true,
    },
    {
      id: "share",
      title: "Share to Other Apps",
      subtitle: "Send via WhatsApp, Telegram, Quick Share, Google Drive or File Managers",
      icon: <IShare size={20} className="text-emerald-500" />,
      available: !isBatch, // Single episode share
    },
  ];

  const handleCancelExport = () => {
    abortRef.current?.abort();
  };

  const handleExecuteExport = async (action: ExportAction) => {
    if (exporting) return;
    if (itemsToExport.length === 0) {
      toast("No episode available to export", "info");
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setExporting(true);
    setProgress(0);
    setCurrentEpIndex(0);
    setExportStatus(null);

    const nativeActive = isNativeExportSupported();
    const isGalleryEligibleAction =
      nativeActive && (action === "save" || action === "save_movies" || action === "save_downloads" || action === "save_sdcard");

    try {
      let savedPathResult = "";
      let succeededCount = 0;
      const failures: Array<{ episode: number; error: string }> = [];

      for (let i = 0; i < itemsToExport.length; i++) {
        if (controller.signal.aborted || !mountedRef.current) {
          throw new DOMException("Export cancelled", "AbortError");
        }
        const item = itemsToExport[i];
        if (mountedRef.current) setCurrentEpIndex(i + 1);
        const epProgressBase = (i / itemsToExport.length) * 100;

        try {
          const res = await processEpisodeExport(
            item.videoId,
            item.episode,
            action,
            (pct) => {
              if (mountedRef.current) {
                setProgress(Math.round(epProgressBase + pct / itemsToExport.length));
              }
            },
            { signal: controller.signal }
          );
          if (res.cancelled) {
            throw new DOMException(res.error || "Export cancelled", "AbortError");
          }
          if (!res.success) {
            failures.push({ episode: item.episode, error: res.error || "Failed" });
          } else {
            succeededCount++;
            savedPathResult = res.savedPath || "Storage";
          }
        } catch (epErr: any) {
          if (epErr?.name === "AbortError" || controller.signal.aborted) {
            throw epErr;
          }
          failures.push({ episode: item.episode, error: epErr?.message || "Failed" });
        }
      }

      if (!mountedRef.current) return;

      if (succeededCount === 0) {
        const errMsg = failures[0]?.error || "Failed to export";
        setExportStatus({
          kind: "error",
          message: `Export error: ${errMsg}`,
          showGallery: false,
        });
        toast(errMsg, "info");
        return;
      }

      setProgress(100);
      if (failures.length > 0) {
        const msg = `Exported ${succeededCount} of ${itemsToExport.length} episodes (${failures.length} failed)`;
        setExportStatus({
          kind: "success",
          message: msg,
          showGallery: isGalleryEligibleAction,
        });
        toast(msg, "info");
      } else {
        const msg =
          action === "share"
            ? `Shared ${savedPathResult || "episode"}`
            : itemsToExport.length > 1
              ? `Successfully exported ${itemsToExport.length} episodes to ${savedPathResult}`
              : `Saved to ${savedPathResult}`;
        setExportStatus({
          kind: "success",
          message: msg,
          showGallery: isGalleryEligibleAction,
        });
        toast(msg, "ok");
      }
    } catch (e: any) {
      if (!mountedRef.current) return;
      if (e?.name === "AbortError" || controller.signal.aborted) {
        setExportStatus({
          kind: "error",
          message: "Export cancelled",
          showGallery: false,
        });
        toast("Export cancelled", "info");
      } else {
        const errText = e?.message || "Failed";
        toast(errText, "info");
        setExportStatus({
          kind: "error",
          message: `Export error: ${errText}`,
          showGallery: false,
        });
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
      if (mountedRef.current) {
        setExporting(false);
      }
    }
  };

  const cleanTitle = formatDramaTitle(title);

  return (
    <Sheet
      open={isOpen}
      onClose={exporting ? () => toast("Export in progress...", "info") : onClose}
      label={isBatch ? "Export Series" : "Export Episode"}
    >
      <div className="flex flex-col max-h-[85dvh] overflow-hidden bg-s1 text-on">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-edge/30 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-full bg-primary/15 text-primary flex items-center justify-center text-sm font-bold">
              <IExport size={16} />
            </div>
            <div>
              <div className="text-[15px] font-bold text-on">
                {isBatch ? `Export Series (${epCount} Episodes)` : "Export Episode to Phone / SD Card"}
              </div>
              <div className="text-[12px] text-mut truncate max-w-[240px]">
                {isBatch
                  ? `${cleanTitle} · ${epCount} Episodes`
                  : `${cleanTitle}${episode != null ? ` · Ep. ${episode}` : ""}`}
              </div>
            </div>
          </div>
          <Button
            disabled={exporting}
            onClick={onClose}
            className="w-10 h-10 rounded-full bg-s3 flex items-center justify-center text-mut pressable disabled:opacity-40"
            aria-label="Close"
          >
            <IClose size={16} />
          </Button>
        </div>

        {/* Progress or Status */}
        {exporting && (
          <div className="p-4 bg-primary/10 border-b border-primary/20 flex flex-col gap-2 shrink-0">
            <div className="flex items-center justify-between gap-2 text-[12px]">
              <span className="font-semibold text-primary flex items-center gap-1.5 min-w-0 truncate">
                <Loader className="w-4 h-4 spinner shrink-0" />
                <span className="truncate">
                  {isBatch
                    ? `Exporting episode ${currentEpIndex} of ${itemsToExport.length}...`
                    : "Writing video file to device storage..."}
                </span>
              </span>
              <div className="flex items-center gap-2 shrink-0">
                <span className="font-bold text-primary tabular-nums">{progress}%</span>
                <Button
                  onClick={handleCancelExport}
                  className="px-2.5 py-1 rounded-lg bg-red-500/15 text-red-500 text-[11px] font-bold pressable"
                >
                  Cancel
                </Button>
              </div>
            </div>
            <div className="w-full h-2 rounded-full bg-black/10 dark:bg-white/10 overflow-hidden">
              <div
                className="h-full bg-primary transition-all duration-200"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        )}

        {exportStatus && !exporting && (
          <div className="mx-4 mt-3 flex flex-col gap-2 shrink-0">
            {exportStatus.kind === "success" ? (
              <div
                role="status"
                className="p-3 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-800 dark:text-emerald-300 text-[12px] flex items-center gap-2"
              >
                <ICheck size={16} className="shrink-0" strokeWidth={2.5} />
                <span className="truncate flex-1 font-semibold">{exportStatus.message}</span>
              </div>
            ) : (
              <div
                role="alert"
                className="p-3 rounded-xl bg-red-500/15 border border-red-500/30 text-red-700 dark:text-red-300 text-[12px] flex items-center gap-2"
              >
                <IAlertTriangle size={16} className="shrink-0 text-red-500" />
                <span className="flex-1 font-semibold break-words">{exportStatus.message}</span>
              </div>
            )}
            <div className="flex items-center gap-2">
              {exportStatus.kind === "success" && exportStatus.showGallery && isNativeExportSupported() && (
                <Button
                  onClick={() => {
                    const ok = openInGallery();
                    if (ok) {
                      toast("Opening in Gallery / Player...", "ok");
                    } else {
                      toast("No compatible gallery app available", "info");
                    }
                  }}
                  className="flex-1 h-10 rounded-xl bg-primary text-on-primary font-bold text-[13px] flex items-center justify-center gap-2 pressable shadow-md hover:brightness-110"
                >
                  <IFilm size={15} />
                  <span>Open in Gallery</span>
                </Button>
              )}
              <Button
                onClick={onClose}
                className="h-10 px-4 rounded-xl bg-s3 text-on font-semibold text-[13px] pressable ml-auto"
              >
                Done
              </Button>
            </div>
          </div>
        )}

        {/* Export Destinations */}
        <div className="p-4 flex-1 min-h-0 flex flex-col gap-2.5 overflow-y-auto">
          <div className="text-[11px] font-bold uppercase tracking-wider text-mut px-1 mt-1">
            Video Destinations
          </div>

          {targets.filter((t) => t.available).map((t) => (
            <button
              key={t.id}
              type="button"
              disabled={exporting}
              onClick={() => void handleExecuteExport(t.id)}
              className="p-3.5 rounded-2xl border border-edge/60 bg-s2/60 hover:bg-s2 text-left flex items-center gap-3 transition-all pressable disabled:opacity-50"
            >
              <div className="w-10 h-10 rounded-xl bg-s3 flex items-center justify-center text-xl shrink-0">
                {t.icon}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[14px] font-bold text-on">{t.title}</span>
                  {t.badge && (
                    <span className="px-1.5 py-0.5 rounded-md bg-primary/10 text-primary text-[10px] font-bold">
                      {t.badge}
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-mut mt-0.5 line-clamp-2 leading-snug">{t.subtitle}</div>
              </div>
              <div className="shrink-0 text-mut">
                <IDownload size={16} />
              </div>
            </button>
          ))}
        </div>

        {/* Footer info */}
        <div className="px-4 pt-3 pb-3.5 border-t border-edge/30 bg-s1 text-center text-[11px] text-mut shrink-0">
          Exported MP4 files can be played anywhere offline without internet
        </div>
      </div>
    </Sheet>
  );
}
