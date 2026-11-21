import React, { useEffect, useMemo, useState } from "react";
import { useStore } from "../store";
import { api, cover as getCoverUrl, isLocalMedia, isMobile } from "../api";
import type { Detail } from "../types";
import { Button } from "./ios/controls";
import { IClose, IPlayF } from "../icons";
import { formatDramaTitle } from "../subtitles/dramaTranslator";
import { getOfflineCoverUrl, getOfflineEpisodes } from "../offline/downloadService";

function fmtTime(sec?: number): string {
  if (!sec || !Number.isFinite(sec) || sec <= 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s < 10 ? "0" : ""}${s}`;
}

const DISMISS_KEY = "aurastream_continue_dismissed_v1";

function getDismissed(): { id: number; at: number } | null {
  try {
    const raw = localStorage.getItem(DISMISS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveDismissed(id: number, at: number) {
  try {
    localStorage.setItem(DISMISS_KEY, JSON.stringify({ id, at }));
  } catch {
    // ignore
  }
}

export default function ContinueWatchingBar() {
  const { history, push, platform, t } = useStore();
  const [dismissed, setDismissedState] = useState<{ id: number; at: number } | null>(() => getDismissed());
  const [drama, setDrama] = useState<Detail | null>(null);
  const [imgError, setImgError] = useState(false);

  // Find most recent watch progress
  const recent = history && history.length > 0 ? history[0] : null;
  const isDismissed = Boolean(
    recent &&
    dismissed &&
    recent.id === dismissed.id &&
    (recent.at || 0) <= dismissed.at
  );

  const totalEpisodes = drama?.episode_count || recent?.episode_count || (drama?.episodes?.length) || 0;
  const isFinishedEp = Boolean(recent && recent.dur && recent.dur > 0 && recent.t / recent.dur >= 0.95);
  const hasNextEp = Boolean(recent && totalEpisodes > 0 && recent.ep < totalEpisodes);

  const shouldShow =
    Boolean(recent &&
    recent.id &&
    !isDismissed &&
    ((recent.t > 3 && recent.dur && recent.dur > 0 && !isFinishedEp) || (isFinishedEp && hasNextEp)));

  useEffect(() => {
    setDrama(null);
    if (!shouldShow || !recent?.id) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    let alive = true;
    api
      .video(recent.id)
      .then((res) => {
        if (alive && res) setDrama(res);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [recent?.id, shouldShow]);

  const offlineItem = useMemo(
    () => (!drama && recent ? getOfflineEpisodes().find((it) => it.videoId === recent.id) ?? null : null),
    [drama, recent]
  );
  const rawTitle = drama?.title || recent?.title || offlineItem?.title;
  const title = rawTitle ? formatDramaTitle(rawTitle) : (recent ? `Drama #${recent.id}` : "");
  const rawCover = drama?.cover || recent?.cover || offlineItem?.cover;
  const coverUrl = useMemo(() => {
    if (offlineItem?.hasLocalCover && offlineItem?.storage === "native") {
      return getOfflineCoverUrl(offlineItem, 240);
    }
    if (!rawCover) return "";
    if (isLocalMedia(rawCover) || rawCover.startsWith("blob:") || rawCover.startsWith("data:")) {
      return rawCover;
    }
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      return "";
    }
    return getCoverUrl(rawCover, 240);
  }, [offlineItem, rawCover]);

  useEffect(() => {
    setImgError(false);
  }, [coverUrl]);

  if (!shouldShow || !recent) return null;

  const pct = isFinishedEp && hasNextEp
    ? 0
    : Math.min(100, Math.max(0, Math.round((recent.t / (recent.dur || 1)) * 100)));
  const targetEp = isFinishedEp && hasNextEp ? recent.ep + 1 : (recent.ep || 1);
  const targetTime = isFinishedEp && hasNextEp ? 0 : recent.t;
  const isNextEpPrompt = isFinishedEp && hasNextEp;

  const handleResume = () => {
    push({
      kind: "feed",
      videoIds: [recent.id],
      index: 0,
      title: title,
      startEp: targetEp,
      startTime: targetTime,
    });
  };
  const handleResumeKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleResume();
    }
  };
  const resumeLabel = isNextEpPrompt
    ? `Play next episode: ${title} Episode ${targetEp}`
    : `Resume watching: ${title} Episode ${targetEp}`;

  const bottomPos = !isMobile
    ? "20px"
    : platform === "android"
      ? "calc(max(var(--sab, 0px), 48px) + 84px)"
      : "calc(var(--sab, 16px) * 0.55 + 84px)";

  return (
    <aside
      aria-label={isNextEpPrompt ? "Play Next Episode" : "Continue Watching"}
      className="fixed inset-x-3 z-40 a-rise pointer-events-auto max-w-xl mx-auto"
      style={{ bottom: bottomPos }}
    >
      <div className="relative overflow-hidden rounded-2xl bg-s1/95 backdrop-blur-2xl border border-edge/70 shadow-[0_16px_40px_rgba(0,0,0,0.35)] p-2.5 flex items-center gap-3">
        {/* Cover / Thumbnail with mini play badge & error fallback */}
        <div
          role="button"
          tabIndex={0}
          aria-label={resumeLabel}
          onClick={handleResume}
          onKeyDown={handleResumeKeyDown}
          className="relative w-12 h-14 rounded-xl overflow-hidden bg-gradient-to-br from-s2 to-s3 border border-edge/50 shrink-0 cursor-pointer elev-1 group flex items-center justify-center focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
        >
          {coverUrl && !imgError ? (
            <img
              src={coverUrl}
              alt=""
              loading="lazy"
              decoding="async"
              onError={() => setImgError(true)}
              className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
            />
          ) : (
            <div className="w-full h-full flex flex-col items-center justify-center bg-primary/15 text-primary text-[10px] font-bold p-1 text-center">
              <span className="text-[13px] font-black uppercase tracking-tight">{title.charAt(0) || "A"}</span>
              <span className="text-[9px] opacity-80">Ep.{targetEp}</span>
            </div>
          )}
          <div className="absolute inset-0 bg-black/25 flex items-center justify-center group-hover:bg-black/15 transition-colors pointer-events-none">
            <div className="w-5 h-5 rounded-full bg-primary text-on-primary flex items-center justify-center shadow">
              <IPlayF size={10} className="ml-0.5" />
            </div>
          </div>
        </div>

        {/* Drama Info & Progress */}
        <div
          role="button"
          tabIndex={0}
          aria-label={resumeLabel}
          onClick={handleResume}
          onKeyDown={handleResumeKeyDown}
          className="flex-1 min-w-0 cursor-pointer rounded-lg focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
        >
          <div className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
            <span className="text-[10px] font-bold uppercase tracking-wider text-primary">
              {isNextEpPrompt ? (t("player.next_episode") || "Up Next") : t("player.continue_watching")}
            </span>
          </div>
          <div className="text-[13px] font-bold text-on truncate mt-0.5 leading-tight">{title}</div>
          <div className="flex items-center gap-1.5 text-[11px] text-mut mt-0.5 truncate whitespace-nowrap">
            <span className="font-semibold text-on/90 shrink-0 whitespace-nowrap">Ep. {targetEp}</span>
            <span className="shrink-0">•</span>
            {isNextEpPrompt ? (
              <span className="text-primary font-medium shrink-0">Ready to play</span>
            ) : (
              <span className="tabular-nums truncate">
                {fmtTime(recent.t)} / {fmtTime(recent.dur)} ({pct}%)
              </span>
            )}
          </div>
        </div>

        {/* Actions: Resume & Dismiss */}
        <div className="flex items-center gap-1.5 shrink-0">
          <Button
            onClick={handleResume}
            className="px-3 h-8 rounded-xl bg-primary text-on-primary text-[12px] font-bold flex items-center gap-1 pressable shadow-sm"
          >
            <IPlayF size={12} />
            <span>{isNextEpPrompt ? (t("player.play_next") || "Play Next") : t("player.resume")}</span>
          </Button>
          <Button
            onClick={(e) => {
              e.stopPropagation();
              const at = Date.now();
              saveDismissed(recent.id, at);
              setDismissedState({ id: recent.id, at });
            }}
            aria-label={t("player.dismiss_continue")}
            className="w-7 h-7 rounded-full flex items-center justify-center text-mut hover:text-on hover:bg-on/10 transition-colors pressable"
          >
            <IClose size={14} />
          </Button>
        </div>

        {/* Bottom progress bar line */}
        <div className="absolute bottom-0 inset-x-0 h-1 bg-edge">
          <div className="h-full bg-primary transition-all duration-300" style={{ width: `${pct}%` }} />
        </div>
      </div>
    </aside>
  );
}
