import React, { useEffect, useState } from "react";
import {
  subscribeDownloadProgress,
  formatBytes,
  type ActiveDownloadProgress,
} from "../offline/downloadService";
import { ICheck, IClose, IDownload, IPlayF } from "../icons";
import { useStore } from "../store";
import { formatDramaTitle } from "../subtitles/dramaTranslator";

export default function DownloadNotificationBanner() {
  const { setTab, push } = useStore();
  const [activeItems, setActiveItems] = useState<ActiveDownloadProgress[]>([]);
  const [completedItem, setCompletedItem] = useState<{
    id: string;
    videoId: number;
    episode: number;
    title: string;
    sizeFormatted?: string;
  } | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    return subscribeDownloadProgress((progressMap) => {
      const list = Array.from(progressMap.values());
      const active = list.filter(
        (it) => it.status === "downloading" || it.status === "paused"
      );
      setActiveItems(active);

      // Check if any recently completed
      const justCompleted = list.find((it) => it.status === "completed" && it.progress === 100);
      if (justCompleted) {
        setCompletedItem({
          id: justCompleted.id,
          videoId: justCompleted.videoId,
          episode: justCompleted.episode,
          title: justCompleted.title,
          sizeFormatted: justCompleted.totalBytes > 0 ? formatBytes(justCompleted.totalBytes) : undefined,
        });
        setDismissed(false);
      }
    });
  }, []);

  // Auto-dismiss completed notification after 4.5s
  useEffect(() => {
    if (completedItem) {
      const timer = window.setTimeout(() => {
        setCompletedItem(null);
      }, 4500);
      return () => window.clearTimeout(timer);
    }
  }, [completedItem?.id]);

  if (dismissed) return null;

  // 1. Show Completed Notification
  if (completedItem && activeItems.length === 0) {
    return (
      <div
        className="fixed top-3 left-3 right-3 sm:left-auto sm:right-4 sm:w-96 z-50 a-rise transition-all"
        style={{ marginTop: "var(--sat, 12px)" }}
        role="alert"
      >
        <div className="p-3 rounded-2xl bg-white/95 dark:bg-neutral-900/95 backdrop-blur-xl border border-emerald-500/40 shadow-xl flex items-center justify-between gap-3 text-on">
          <div
            onClick={() => {
              push({
                kind: "feed",
                videoIds: [completedItem.videoId],
                index: 0,
                title: formatDramaTitle(completedItem.title) || `Episode ${completedItem.episode}`,
                startEp: completedItem.episode,
              });
              setCompletedItem(null);
            }}
            className="flex items-center gap-3 min-w-0 flex-1 cursor-pointer pressable"
          >
            <div className="w-9 h-9 rounded-xl bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 flex items-center justify-center shrink-0">
              <ICheck size={18} strokeWidth={3} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-bold text-on truncate">
                Download Complete!
              </div>
              <div className="text-[11.5px] text-mut truncate">
                {formatDramaTitle(completedItem.title)} · Ep. {completedItem.episode} {completedItem.sizeFormatted ? `(${completedItem.sizeFormatted})` : ""} ready offline
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <button
              onClick={() => {
                push({
                  kind: "feed",
                  videoIds: [completedItem.videoId],
                  index: 0,
                  title: formatDramaTitle(completedItem.title) || `Episode ${completedItem.episode}`,
                  startEp: completedItem.episode,
                });
                setCompletedItem(null);
              }}
              className="px-2.5 py-1 rounded-lg bg-emerald-500 text-white text-[11px] font-bold flex items-center gap-1 pressable"
            >
              <IPlayF size={10} /> Watch
            </button>
            <button
              onClick={() => setCompletedItem(null)}
              className="w-7 h-7 rounded-lg text-mut hover:text-on flex items-center justify-center pressable"
              aria-label="Dismiss Notification"
            >
              <IClose size={14} />
            </button>
          </div>
        </div>
      </div>
    );
  }

  // 2. Show Active Downloading Notification
  if (activeItems.length === 0) return null;

  const current = activeItems[0];
  const sizeProgress =
    current.totalBytes > 0
      ? `${formatBytes(current.downloadedBytes)} / ${formatBytes(current.totalBytes)}`
      : formatBytes(current.downloadedBytes);

  return (
    <div
      className="fixed top-3 left-3 right-3 sm:left-auto sm:right-4 sm:w-96 z-50 a-rise transition-all"
      style={{ marginTop: "var(--sat, 12px)" }}
      role="status"
    >
      <div className="p-3 rounded-2xl bg-white/95 dark:bg-neutral-900/95 backdrop-blur-xl border border-primary/30 shadow-xl flex flex-col gap-2 text-on">
        <div className="flex items-center justify-between gap-2.5">
          <div
            onClick={() => setTab("profile")}
            className="flex items-center gap-2.5 min-w-0 flex-1 cursor-pointer pressable"
          >
            <div className="w-8 h-8 rounded-xl bg-primary/15 text-primary flex items-center justify-center shrink-0">
              <IDownload size={16} className="animate-pulse" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[12.5px] font-bold text-on truncate">
                {current.title ? `${formatDramaTitle(current.title)} · ` : ""}Ep. {current.episode} ({current.progress}%)
              </div>
              <div className="text-[11px] text-mut truncate flex items-center gap-1.5 tabular-nums">
                <span>{sizeProgress}</span>
                <span>·</span>
                <span className="text-primary font-semibold">
                  {current.status === "paused" ? "Paused" : current.speedFormatted}
                </span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => setTab("profile")}
              className="px-2 py-1 rounded-lg bg-s3 text-[11px] font-semibold text-on pressable"
            >
              View
            </button>
            <button
              onClick={() => setDismissed(true)}
              className="w-6 h-6 rounded-lg text-mut hover:text-on flex items-center justify-center pressable"
              aria-label="Hide download banner"
            >
              <IClose size={13} />
            </button>
          </div>
        </div>

        {/* Progress Bar */}
        <div className="w-full h-1.5 rounded-full bg-s3/80 overflow-hidden">
          <div
            className={`h-full transition-all duration-300 ${
              current.status === "paused" ? "bg-amber-400" : "bg-primary"
            }`}
            style={{ width: `${Math.max(2, current.progress)}%` }}
          />
        </div>
      </div>
    </div>
  );
}
