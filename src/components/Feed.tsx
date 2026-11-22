import { Button, Image, SegmentedControl, Surface } from "./ios/controls";
import { Loader } from "./ios/effects";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { api, APP_VERSION, cover, fmt, fmtTime, isMobile, logLine, mediaUrl } from "../api";
import type { Detail, Episode, Post, VideoCard } from "../types";
import { useStore } from "../store";
import { Avatar, Img, Sheet } from "./ui";
import VideoSurface, { type VideoHandle } from "./VideoSurface";
import PlayerControls from "./PlayerControls";
import PlaybackLock from "./PlaybackLock";
import LinePicker from "./LinePicker";
import { ArticlePanel, CommentsPanel, EpisodesPanel } from "./Panels";
import { RowCard } from "./cards";
import { setBackHandler } from "../back";
import { copyText } from "../clipboard";
import { tracePlayback } from "../playbackDiagnostics";
import { createPlaybackClock } from "../playbackClock";
import SubtitleOverlay from "./SubtitleOverlay";
import SubtitleSheet from "./SubtitleSheet";
import ExportSheet from "./ExportSheet";
import BatchDownloadSheet from "./BatchDownloadSheet";
import DownloadChoiceSheet from "./DownloadChoiceSheet";
import type { SubtitleMode, SubtitleTrackStatus } from "../subtitles/types";
import { formatDramaAuthor, formatDramaDesc, formatDramaTag, formatDramaTitle } from "../subtitles/dramaTranslator";
import {
  ensureOfflineSyncReady,
  isEpisodeDownloaded,
  startEpisodeDownload,
  getOfflineCoverUrl,
  getOfflinePlaybackUrl,
  getOfflineEpisodes,
  revokeOfflinePlaybackUrls,
  subscribeDownloadProgress,
  checkSmartDownloadNextEpisode,
  checkAutoDeleteFinishedEpisode,
  resolveStreamUrlForQuality,
  getDownloadQualityPreference,
  type ActiveDownloadProgress,
} from "../offline/downloadService";
import { localizeError } from "../i18n";
import {
  getAutoSkipIntroSec,
  setAutoSkipIntroSec,
  checkSleepTimerEpisodeEnd,
  subscribeSleepTimer,
  setSleepTimer,
  getSleepTimerOption,
  type SleepTimerOption,
  preloadEpisode,
  markEpisodeActive,
} from "../playbackFeatures";
import { processEpisodeExport } from "../offline/exportService";
import { useMediaSession } from "../useMediaSession";
import {
  IBack, IBoltF, ICaptions, ICaptionsF, ICheck, IChevR, IChevronDown, IChevronUp, IClock, IClose, ICommentF, ICompress, IDownload, IEye, IExpand, IExport, IFileText,
  IFastForwardF, ILink, IList, ILockF, IMore, IPauseF, IPip, IPlayF, IRewindF, ISearch, IStar, IStarF, ISun, IVertSwap, IVol, IVolMute,
} from "../icons";

type Props = {
  videoIds: number[];
  startIndex?: number;
  title?: string;
  mode: "home" | "context";
  kind?: "video" | "post";
  active: boolean;
  bottomInset: number;
  offlineOnly?: boolean;
  onBack?: () => void;
  onNearEnd?: () => void;
  /** Resume playback from history: starting episode and timestamp */
  startEp?: number;
  startTime?: number;
};

const RATES = [1, 1.25, 1.5, 2];

const stripHtml = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

const setNativeOrientation = (landscape: boolean) => {
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    invoke("set_orientation", { landscape }).catch(() => {});
  }
};

export default function Feed({ videoIds, startIndex = 0, title = "", mode, kind = "video", active, bottomInset, offlineOnly = false, onBack, onNearEnd, startEp, startTime }: Props) {
  const store = useStore();
  const { isLiked, isFav, toggleLikeLocal, toggleFavLocal, toggleFollowLocal, muted, setMuted, volume, setVolume, toast, addHistory, history, user, setLoginOpen, swipeEp, setSwipeEp, preferHevc, setPreferHevc, t } = store;
  const isDesktop = !isMobile;

  const boxRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<VideoHandle>(null);
  const [index, setIndex] = useState(startIndex);
  const [renderIndex, setRenderIndex] = useState(startIndex);
  const [epMap, setEpMap] = useState<Record<number, number>>(() => (startEp ? { [videoIds[startIndex]]: startEp } : {}));
  const [details, setDetails] = useState<Record<number, Detail>>({});
  const [offlineUrls, setOfflineUrls] = useState<Record<string, string>>({});
  const [playUrls, setPlayUrls] = useState<Record<string, string>>({});
  const [hevcUrls, setHevcUrls] = useState<Record<string, string>>({});
  const [proxyRetry, setProxyRetry] = useState(0);
  const [cards, setCards] = useState<Record<number, VideoCard>>({});
  const [posts, setPosts] = useState<Record<number, Post>>({});
  const [related, setRelated] = useState<VideoCard[]>([]);

  const [time, setTime] = useState(0);
  const playbackClock = useMemo(() => createPlaybackClock(), []);
  const [duration, setDuration] = useState(0);
  const [vsize, setVsize] = useState({ w: 0, h: 0 });
  const bufferedRef = useRef(0);
  const sessionKeyRef = useRef(`feed_${Math.random().toString(36).slice(2)}`);
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const [paused, setPaused] = useState(false);
  const [controlsLocked, setControlsLocked] = useState(false);
  const [rate, setRate] = useState(1);
  const [waiting, setWaiting] = useState(false);
  const [videoStarted, setVideoStarted] = useState(false);
  const [err, setErr] = useState("");
  const [panel, setPanel] = useState<"episodes" | "comments" | "article" | "detail" | "captions" | "more" | null>(null);
  const [lineOpen, setLineOpen] = useState(false);
  const [descOpen, setDescOpen] = useState(false);
  const [cancelAutoNext, setCancelAutoNext] = useState(false);
  const cancelAutoNextRef = useRef(false);
  const [autoSkipSec, setAutoSkipSecState] = useState<number>(() => getAutoSkipIntroSec());
  /* Resume playback: seek to saved timestamp after duration is available */
  const resumeRef = useRef<{ key: string; t: number } | null>(
    startTime && startTime > 1 ? { key: `${videoIds[startIndex]}:${startEp || 1}`, t: startTime } : null,
  );
  /* Watch progress: throttled writeback to store on time update */
  const liveRef = useRef({ id: 0, ep: 1, dur: 0, t: 0 });
  const lastSaveRef = useRef(0);
  const ccTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ccLongPressedRef = useRef(false);
  const theater = store.theater;
  const setTheater = store.setTheater;
  const fs = store.fs;
  const clean = store.clean;
  const setClean = store.setClean;
  const setFs = store.setFs;

  /* Desktop: auto-hide player chrome after 2.8s idle */
  const [idle, setIdle] = useState(false);
  const idleTimer = useRef<number | undefined>(undefined);
  const wake = useCallback(() => {
    setIdle(false);
    window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => setIdle(true), 2800);
  }, []);
  useEffect(() => {
    if (!isDesktop) return undefined;
    if (active) wake();
    else {
      setIdle(false);
      window.clearTimeout(idleTimer.current);
    }
    return () => window.clearTimeout(idleTimer.current);
  }, [isDesktop, active, wake]);
  useEffect(() => {
    if (paused || waiting) {
      setIdle(false);
      window.clearTimeout(idleTimer.current);
    } else if (isDesktop && active) {
      wake();
    }
  }, [paused, waiting, isDesktop, active, wake]);

  /* Keep Android Screen Awake while actively playing video */
  useEffect(() => {
    const isPlaying = active && !paused && !waiting && !err;
    let sentinel: any = null;
    let disposed = false;
    try {
      (window as any).AuraNativeExport?.setKeepScreenOn?.(isPlaying);
      if (isPlaying && "wakeLock" in navigator) {
        (navigator as any).wakeLock.request("screen").then((s: any) => {
          if (disposed) {
            s.release().catch(() => {});
          } else {
            sentinel = s;
          }
        }).catch(() => {});
      }
    } catch { /* ignore */ }
    return () => {
      disposed = true;
      sentinel?.release().catch(() => {});
      try {
        (window as any).AuraNativeExport?.setKeepScreenOn?.(false);
      } catch { /* ignore */ }
    };
  }, [active, paused, waiting, err]);

  const [fullscreen, setFullscreen] = useState(false);
  const [starBurst, setStarBurst] = useState(0);
  /* --- Mobile Gestures --- */
  const [holdSpeed, setHoldSpeed] = useState(false);
  const [speedLock, setSpeedLock] = useState(false);
  const [lockArmed, setLockArmed] = useState(false);
  const holdRef = useRef(false);
  const lockArmedRef = useRef(false);
  const [brightness, setBrightness] = useState<number>(() => {
    try {
      const s = localStorage.getItem("aurastream_brightness");
      return s ? Number(s) : 1.0;
    } catch { return 1.0; }
  });
  const [gestureHud, setGestureHud] = useState<{
    type: "brightness" | "volume";
    val: number;
    visible: boolean;
  }>({ type: "volume", val: 100, visible: false });
  const hudTimerRef = useRef<number | null>(null);
  const [inPip, setInPip] = useState(false);
  const [scrub, setScrub] = useState<{ pct: number; target: number } | null>(null);
  const scrubTarget = useRef<number | null>(null);
  /* Scrub bar drag */
  const barRef = useRef<HTMLDivElement>(null);
  const barScrub = useRef(false);
  const [barPct, setBarPct] = useState<number | null>(null);
  const gesture = useRef<{
    x: number; y: number; left: number; startY: number; t: number; timer: number | null;
    mode: "idle" | "hold" | "scrub" | "pan" | "brightness" | "volume";
    base: number; width: number; playing: boolean; startVal: number;
  } | null>(null);
  /* Single/Double Tap detection: Immediate single-tap, double-tap seeks or toggles play/pause with ripple HUD */
  const lastTapRef = useRef<{ t: number }>({ t: 0 });
  const [seekRipple, setSeekRipple] = useState<{ dir: "left" | "right" | "center"; text: string; id: number } | null>(null);
  const seekRippleTimer = useRef<number | null>(null);
  const wasPlayingBeforeHiddenRef = useRef(false);

  const triggerSeekRipple = (dir: "left" | "right" | "center", text: string) => {
    if (seekRippleTimer.current) window.clearTimeout(seekRippleTimer.current);
    setSeekRipple({ dir, text, id: Date.now() });
    try {
      (window as any).AuraNativeExport?.vibrateHaptic?.("light");
      navigator.vibrate?.(10);
    } catch { /* ignore */ }
    seekRippleTimer.current = window.setTimeout(() => {
      setSeekRipple(null);
      seekRippleTimer.current = null;
    }, 650) as unknown as number;
  };
  /* Native landscape orientation state */
  const [vpLandscape, setVpLandscape] = useState(
    () => typeof window !== "undefined" && window.innerWidth > window.innerHeight,
  );
  /* Fullscreen transition retry playback */
  const keepAliveTimers = useRef<number[]>([]);
  /* Pinch-to-zoom: scale 1-4x with pan */
  const [zoom, setZoom] = useState({ s: 1, x: 0, y: 0, g: false });
  /* Aspect ratio fit modes: contain vs cover */
  const [portraitFit, setPortraitFit] = useState<"contain" | "cover">("contain");
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchRef = useRef<{ d0: number; mx0: number; my0: number; s0: number; x0: number; y0: number } | null>(null);

  const curId = videoIds[index];
  const historyRef = useRef(history);
  historyRef.current = history;
  const historyItem = useMemo(() => history?.find((h) => h.id === curId), [history, curId]);
  const detail = details[curId];
  const curEp = epMap[curId] || 1;
  const playKey = `${curId}:${curEp}`;
  const offlineUrl = offlineUrls[playKey] || "";
  const mainUrl = playUrls[playKey] || "";
  const hevcUrl = hevcUrls[playKey] || "";
  const playUrl = offlineUrl || (preferHevc && hevcUrl ? hevcUrl : mainUrl);
  const isPlayingOffline = Boolean(offlineUrl || playUrl.startsWith("blob:") || playUrl.includes("/offline/"));
  const zeroDataMode = Boolean(
    offlineOnly || isPlayingOffline || (typeof navigator !== "undefined" && navigator.onLine === false)
  );

  useEffect(() => {
    const retry = () => {
      setErr("");
      setWaiting(true);
      // Resolved media is retried in VideoSurface. Only an unresolved API call
      // needs another lookup, so a working stream keeps its episode and position.
      if (!playUrl) setProxyRetry(value => value + 1);
    };
    window.addEventListener("hg:proxy-changed", retry);
    return () => window.removeEventListener("hg:proxy-changed", retry);
  }, [playUrl]);
  useEffect(() => { setZoom({ s: 1, x: 0, y: 0, g: false }); pinchRef.current = null; pointersRef.current.clear(); }, [playUrl]);
  useEffect(() => { videoRef.current?.trace("page.active", { active, view: mode, video_id: curId, episode: curEp }); }, [active, mode, curId, curEp]);
  useEffect(() => {
    if (!active) {
      setPanel(null);
      setDownloadChoiceOpen(false);
      setBatchDownloadOpen(false);
      setExportModalOpen(false);
    }
  }, [active]);

  const [downloadProgressMap, setDownloadProgressMap] = useState<Map<string, ActiveDownloadProgress>>(new Map());
  const [isDownloaded, setIsDownloaded] = useState<boolean>(() => isEpisodeDownloaded(curId, curEp));
  const [offlineRev, setOfflineRev] = useState(0);
  const rawOfflineList = useMemo(() => {
    void offlineRev;
    return getOfflineEpisodes()
      .filter((e) => e.videoId === curId)
      .sort((a, b) => a.episode - b.episode);
  }, [curId, offlineRev]);

  const offlineEps = useMemo(() => {
    return rawOfflineList.map((e) => ({
      ep_num: e.episode,
      title: e.title || `Episode ${e.episode}`,
      duration: e.duration || 0,
      status: 1,
    }));
  }, [rawOfflineList]);

  useEffect(() => {
    if (!offlineOnly || !curId || rawOfflineList.length === 0) return;
    if (!isEpisodeDownloaded(curId, curEp)) {
      setEpMap((m) => ({ ...m, [curId]: rawOfflineList[0].episode }));
    }
  }, [offlineOnly, curId, curEp, rawOfflineList]);

  const episodes = (detail?.episodes && detail.episodes.length > 0) ? detail.episodes : offlineEps;
  const curEpIndex = episodes.findIndex((e) => e.ep_num === curEp);
  const prevEpObj = curEpIndex > 0 ? episodes[curEpIndex - 1] : undefined;
  const nextEpObj =
    curEpIndex >= 0 && curEpIndex < episodes.length - 1
      ? episodes[curEpIndex + 1]
      : episodes.find((e) => e.ep_num === curEp + 1);
  const post = posts[curId];
  const [exportModalOpen, setExportModalOpen] = useState<boolean>(false);
  const [targetExportEpisode, setTargetExportEpisode] = useState<number | null>(null);
  const [batchDownloadOpen, setBatchDownloadOpen] = useState<boolean>(false);
  const [batchPreselectAll, setBatchPreselectAll] = useState<boolean>(false);
  const [downloadChoiceOpen, setDownloadChoiceOpen] = useState<boolean>(false);
  const [sleepTimer, setLocalSleepTimer] = useState<SleepTimerOption>(getSleepTimerOption);
  const [dismissNextEp, setDismissNextEp] = useState<number | null>(null);
  const [subtitleTrackInfo, setSubtitleTrackInfo] = useState<SubtitleTrackStatus>({
    hasTrack: false,
    source: "none",
    cueCount: 0,
  });

  useEffect(() => {
    setSubtitleTrackInfo({ hasTrack: false, source: "none", cueCount: 0 });
  }, [curId, curEp]);

  useEffect(() => {
    setIsDownloaded(isEpisodeDownloaded(curId, curEp));
    const unsub = subscribeDownloadProgress((m) => {
      setDownloadProgressMap(m);
      setIsDownloaded(isEpisodeDownloaded(curId, curEp));
    });
    const onDownloadsChanged = () => {
      setIsDownloaded(isEpisodeDownloaded(curId, curEp));
      setOfflineRev((r) => r + 1);
    };
    window.addEventListener("aurastream:downloads-changed", onDownloadsChanged);

    const unsubSleep = subscribeSleepTimer((rem, opt) => {
      setLocalSleepTimer(opt);
      if (rem === 0) {
        videoRef.current?.pause();
        setPaused(true);
        toast("Sleep timer expired: Playback paused", "info");
      }
    });

    return () => {
      unsub();
      unsubSleep();
      window.removeEventListener("aurastream:downloads-changed", onDownloadsChanged);
    };
  }, [curId, curEp]);

  useEffect(() => {
    if (curId && curEp) {
      markEpisodeActive(curId, curEp);
    }
  }, [curId, curEp]);

  const currentDownload = downloadProgressMap.get(`${curId}_${curEp}`);
  const isDownloadingCurrent = currentDownload && currentDownload.status === "downloading";

  const dramaTitle = detail?.title
    ? formatDramaTitle(detail.title)
    : post?.title
      ? formatDramaTitle(post.title)
      : cards[curId]?.title
        ? formatDramaTitle(cards[curId].title)
        : title
          ? formatDramaTitle(title)
          : historyItem?.title
            ? formatDramaTitle(historyItem.title)
            : rawOfflineList[0]?.title
              ? formatDramaTitle(rawOfflineList[0].title)
              : "AuraStream";
  /** Unified view model: short dramas and posts share playback surface */
  const meta = kind === "post"
    ? {
        title: post?.title || "",
        cover: post?.cover || "",
        desc: post?.content || post?.desc || "",
        author: "Community",
        authorId: -1,
        tags: post?.tags || [],
        score: 0,
        like: 0,
        comment: 0,
        collect: 0,
        episodes: [] as Episode[],
      }
    : {
        title: detail?.title || cards[curId]?.title || title || historyItem?.title || rawOfflineList[0]?.title || "",
        cover: detail?.cover || cards[curId]?.cover || historyItem?.cover || rawOfflineList[0]?.cover || "",
        desc: detail?.description || "",
        author: detail?.author?.name || "AAA",
        authorId: detail?.author?.id || -1,
        authorAvatar: detail?.author?.avatar || "",
        tags: (detail?.tags && detail.tags.length > 0) ? detail.tags : (historyItem?.tags && historyItem.tags.length > 0) ? historyItem.tags : [],
        score: detail?.score || 0,
        like: detail?.counts?.like ?? cards[curId]?.like_count ?? 0,
        comment: detail?.counts?.comment ?? cards[curId]?.comment_count ?? 0,
        collect: detail?.counts?.collect ?? cards[curId]?.collect_count ?? 0,
        episodes: (detail?.episodes && detail.episodes.length > 0) ? detail.episodes : offlineEps,
      };

  const curOfflineEpMeta = rawOfflineList.find((e) => e.episode === curEp) || rawOfflineList[0];
  const hasLocalPoster = Boolean(curOfflineEpMeta?.storage === "native" && curOfflineEpMeta?.hasLocalCover);
  const posterUrl = hasLocalPoster
    ? getOfflineCoverUrl(curOfflineEpMeta, 900)
    : offlineOnly || (typeof navigator !== "undefined" && navigator.onLine === false)
      ? ""
      : meta.cover
        ? cover(meta.cover, 900)
        : "";

  const epTitle = (episodes && episodes.find((e) => e.ep_num === curEp)?.title) || `Episode ${curEp}`;
  const mediaSessionTitle = episodes && episodes.length > 1 ? `${dramaTitle} · ${epTitle}` : dramaTitle;
  const authorName = detail?.author?.name || "AAA";
  const mediaSessionArtist = formatDramaAuthor(authorName);
  const mediaSessionCover = posterUrl;

  useMediaSession({
    title: mediaSessionTitle,
    artist: mediaSessionArtist,
    album: dramaTitle,
    coverUrl: mediaSessionCover,
    duration,
    time,
    playbackRate: rate,
    paused,
    active,
    onPlay: () => videoRef.current?.play(),
    onPause: () => videoRef.current?.pause(),
    onSeek: (target) => videoRef.current?.seek(target, "mediasession"),
    onPreviousTrack: prevEpObj ? () => setEpMap((m) => ({ ...m, [curId]: prevEpObj.ep_num })) : undefined,
    onNextTrack: nextEpObj ? () => setEpMap((m) => ({ ...m, [curId]: nextEpObj.ep_num })) : undefined,
  });

  /* Watch progress periodic sync */
  const onTimeTick = (t: number) => {
    liveRef.current = { id: curId, ep: curEp, dur: duration, t };
    playbackClock.publish(t);
    if (!isDesktop) setTime(t);
    const now = Date.now();
    if (duration > 0 && now - lastSaveRef.current > 5000) {
      lastSaveRef.current = now;
      saveHistory(curEp, t, duration);
    }
    // Never trigger background downloads or network segment preloading during offline/zero-data playback
    if (!zeroDataMode) {
      if (
        duration > 0 &&
        t / duration >= 0.75 &&
        episodes.length > 0 &&
        nextEpObj &&
        !isEpisodeDownloaded(curId, nextEpObj.ep_num)
      ) {
        void checkSmartDownloadNextEpisode(curId, curEp, episodes.length, {
          title: formatDramaTitle(meta?.title) || `Episode ${curEp}`,
          cover: meta?.cover || "",
        });
      }
      if (t > 3 && nextEpObj && !isEpisodeDownloaded(curId, nextEpObj.ep_num)) {
        void preloadEpisode(curId, nextEpObj.ep_num, {
          preferHevc,
          title: formatDramaTitle(meta?.title),
          maxSegments: 5,
        });
      }
      const nextDramaId = videoIds[index + 1];
      if (t > 3 && nextDramaId && kind === "video" && !isEpisodeDownloaded(nextDramaId, 1)) {
        void preloadEpisode(nextDramaId, 1, {
          preferHevc,
          maxSegments: 3,
        });
      }
    }
  };

  /* Safe resume without jumping to end */
  const onDurationTick = (d: number) => {
    setDuration(d);
    liveRef.current = { ...liveRef.current, dur: d };
    const r = resumeRef.current;
    const skipSec = getAutoSkipIntroSec();
    if (r && r.key === playKey && r.t > (skipSec > 0 ? skipSec : 1) && (!d || r.t < d - 3)) {
      resumeRef.current = null;
      videoRef.current?.seek(r.t, "history_resume");
      if (isDesktop) playbackClock.publish(r.t);
      else setTime(r.t);
    } else {
      resumeRef.current = null;
      // Auto-skip intro if starting from the beginning or within intro window
      if (skipSec > 0 && d > skipSec + 5) {
        videoRef.current?.seek(skipSec, "auto_skip_intro");
        if (isDesktop) playbackClock.publish(skipSec);
        else setTime(skipSec);
      }
    }
  };

  const saveHistory = useCallback((ep?: number, currentT?: number, currentDur?: number) => {
    if (!curId) return;
    addHistory(
      curId,
      ep ?? curEp,
      currentT,
      currentDur,
      {
        title: formatDramaTitle(meta?.title),
        cover: meta?.cover,
        tags: meta?.tags,
        episode_count: episodes?.length || meta?.episodes?.length,
        is_finished: detail?.is_finished,
      }
    );
  }, [curId, curEp, meta, episodes, detail, addHistory]);
  const saveHistoryRef = useRef(saveHistory);
  saveHistoryRef.current = saveHistory;
  const hasVideo = kind === "video" || !!post?.video_url;
  const articleHtml = kind === "post" && !hasVideo ? (post?.content || "") : "";

  /* Share: share downloaded MP4 or copy playback link */
  const shareLink = async () => {
    if (isEpisodeDownloaded(curId, curEp)) {
      toast("Preparing episode for share...", "info");
      try {
        await processEpisodeExport(curId, curEp, "share");
        return;
      } catch {
        // fallback to link copy
      }
    }
    const u = kind === "post" ? (posts[curId]?.video_url || meta.title) : `https://aurastream.app/watch/${curId}?ep=${curEp}`;
    copyText(u).then(() => toast(t("player.link_copied") || "Link copied to clipboard", "ok")).catch(() => toast("Failed to copy", "info"));
  };

  /* Playback speed: long press/lock -> 2.0x, else base speed */
  const effRate = holdSpeed || speedLock ? 2 : rate;
  /* Scrub bar progress percentage */
  const barProgress = barPct ?? (duration ? time / duration : 0);
  /* Fullscreen landscape orientation rotation */
  const rotated = !isDesktop && fs && vsize.w > vsize.h && vsize.h > 0 && !vpLandscape;
  const landscapeVideo = vsize.w > 0 && vsize.h > 0 && vsize.w > vsize.h;
  /* Quick control pill transition */
  const capsuleOn = !fs && !clean && !isDesktop && (landscapeVideo || zoom.s > 1.05);
  const isLandscapeCurrent = useCallback(() => {
    if (vsize.w > 0 && vsize.h > 0) return vsize.w > vsize.h;
    const v = videoRef.current?.el();
    if (v && v.videoWidth > 0 && v.videoHeight > 0) {
      return v.videoWidth > v.videoHeight;
    }
    return false;
  }, [vsize.w, vsize.h]);

  /* --- Vertical Swipe Episode Switch ---
   * When swipeEp is active, overlay touch-action is none.
   * Vertical swipe gesture switches episodes or next series.
   * Switches episode if available, otherwise navigates series.
   * When disabled, uses standard vertical scroll.
   */
  const idxRef = useRef(startIndex);
  const swipeTimer = useRef(0);

  const resolveSwipe = useCallback((target: number) => {
    const prev = idxRef.current;
    if (target === prev) return;
    idxRef.current = target;
    setIndex(target);
  }, []);

  /* Scroll positioning */
  const onScroll = useCallback(() => {
    if (fs || pinchRef.current) return;
    const el = boxRef.current;
    if (!el) return;
    const h = el.clientHeight || 1;
    const i = Math.max(0, Math.min(videoIds.length - 1, Math.round(el.scrollTop / h)));
    if (isDesktop) setRenderIndex(i);
    if (onNearEnd && i >= videoIds.length - 3) onNearEnd();
    window.clearTimeout(swipeTimer.current);
    swipeTimer.current = window.setTimeout(() => resolveSwipe(i), 150);
  }, [videoIds.length, onNearEnd, resolveSwipe, fs]);

  const go = useCallback((delta: number) => {
    const el = boxRef.current;
    if (!el) return;
    const next = Math.max(0, Math.min(videoIds.length - 1, index + delta));
    el.scrollTo({ top: next * el.clientHeight, behavior: "smooth" });
  }, [index, videoIds.length]);

  /* Unified episode navigation: switches episodes if multi-episode series.
     Desktop arrow keys and side controls mirror mobile swipe behavior. */
  const stepDir = useCallback((dir: number) => {
    if (swipeEp && kind === "video") {
      const want = dir === 1 ? nextEpObj?.ep_num : prevEpObj?.ep_num;
      if (want) {
        setEpMap((m) => ({ ...m, [curId]: want }));
        setPanel(null);
        return;
      }
    }
    go(dir);
  }, [swipeEp, kind, nextEpObj, prevEpObj, curId, go]);

  const canStep = (dir: number) => {
    if (swipeEp && kind === "video") {
      if (dir === 1 ? Boolean(nextEpObj) : Boolean(prevEpObj)) return true;
    }
    const next = index + dir;
    return next >= 0 && next < videoIds.length;
  };

  /* Initial position */
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const raf = requestAnimationFrame(() => {
      el.scrollTop = startIndex * (el.clientHeight || 1);
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Fetch details (skipped in offlineOnly mode; never prefetches adjacent online items while watching offline) */
  useEffect(() => {
    if (offlineOnly || (typeof navigator !== "undefined" && navigator.onLine === false)) return;
    let alive = true;
    const playingOfflineNow = isPlayingOffline || isEpisodeDownloaded(curId, curEp);
    const need = playingOfflineNow
      ? [videoIds[index]].filter(Boolean)
      : [videoIds[index], videoIds[index + 1], videoIds[index - 1]].filter(Boolean);
    need.forEach((id) => {
      if (details[id]) return;
      api.video(id).then((d) => {
        if (alive) {
          setDetails((m) => ({ ...m, [id]: d }));
          if (id === curId && (d?.cover || d?.title) && historyRef.current.some((h) => h.id === id)) {
            addHistory(id, undefined, undefined, undefined, {
              title: formatDramaTitle(d.title),
              cover: d.cover,
              tags: d.tags,
              episode_count: d.episodes?.length || d.episode_count,
              is_finished: d.is_finished,
            });
          }
        }
      }).catch(() => {});
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, videoIds, proxyRetry, offlineOnly, isPlayingOffline]);

  /* Fetch post details including video URL */
  useEffect(() => {
    if (kind !== "post" || offlineOnly) return;
    let alive = true;
    [videoIds[index], videoIds[index + 1], videoIds[index - 1]].filter(Boolean).forEach((id) => {
      if (posts[id]) return;
      api.post(id).then((p) => { if (alive) setPosts((m) => ({ ...m, [id]: p })); }).catch(() => {});
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, index, videoIds, proxyRetry, offlineOnly]);

  /* Fetch related recommendations (never during offline playback) */
  useEffect(() => {
    if (!curId || kind !== "video" || zeroDataMode || isEpisodeDownloaded(curId, curEp)) return;
    let alive = true;
    setRelated([]);
    api.related(curId).then((r) => { if (alive) setRelated(r?.items || []); }).catch(() => {});
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curId, curEp, kind, zeroDataMode]);

  /* Resolve playback stream URL — strictly prefers local offline downloads with zero internet usage */
  useEffect(() => {
    if (!curId) return;
    let alive = true;

    void (async () => {
      // 1. Fast path: If episode is already known in offline cache, resolve local media instantly
      if (isEpisodeDownloaded(curId, curEp)) {
        if (offlineUrls[playKey]) return;
        try {
          const localUrl = await getOfflinePlaybackUrl(curId, curEp, sessionKeyRef.current);
          if (!alive) return;
          if (localUrl) {
            logLine(`[play] id=${curId} ep=${curEp} playing from local offline cache (instant)`);
            tracePlayback("play.resolve", {
              video_id: curId, episode: curEp, resolved: true, kind: "offline", host: "localhost",
              status: 200, msg: "Offline storage local media",
            });
            setOfflineUrls((m) => ({ ...m, [playKey]: localUrl }));
            setPlayUrls((m) => ({ ...m, [playKey]: localUrl }));
            setHevcUrls((m) => {
              if (!m[playKey]) return m;
              const next = { ...m };
              delete next[playKey];
              return next;
            });
            saveHistory(curEp);
            return;
          }
        } catch {
          // Fall through to resync below
        }
      }

      await ensureOfflineSyncReady().catch(() => {});
      if (!alive) return;

      if (isEpisodeDownloaded(curId, curEp)) {
        if (offlineUrls[playKey]) return;
        try {
          const localUrl = await getOfflinePlaybackUrl(curId, curEp, sessionKeyRef.current);
          if (!alive) return;
          if (localUrl) {
            logLine(`[play] id=${curId} ep=${curEp} playing from local offline cache`);
            tracePlayback("play.resolve", {
              video_id: curId, episode: curEp, resolved: true, kind: "offline", host: "localhost",
              status: 200, msg: "Offline storage local media",
            });
            setOfflineUrls((m) => ({ ...m, [playKey]: localUrl }));
            setPlayUrls((m) => ({ ...m, [playKey]: localUrl }));
            setHevcUrls((m) => {
              if (!m[playKey]) return m;
              const next = { ...m };
              delete next[playKey];
              return next;
            });
            saveHistory(curEp);
            return;
          }
        } catch {
          // fall through to offline error / fallback below
        }
        if (offlineOnly || (typeof navigator !== "undefined" && navigator.onLine === false)) {
          setErr("Offline episode file not found in storage. Please connect to internet to re-download.");
          return;
        }
        fetchOnlineStream(true);
        return;
      }

      if (playUrls[playKey]) return;
      if (offlineOnly) {
        setErr("This episode has not been downloaded for offline playback.");
        return;
      }
      fetchOnlineStream(false);
    })();

    function fetchOnlineStream(fromOfflineFallback = false) {
      api.play(curId, curEp)
        .then((info) => {
          if (!alive) return;
          const streamUrl = info?.streams?.main || info?.video_url;
          const hevcStream = info?.streams?.hevc || info?.video_url_hevc || "";
          const raw = info as unknown as Record<string, unknown>;
          const streams = (raw.streams ?? {}) as Record<string, unknown>;
          const streamKind = streams.main ? "main" : info?.video_url ? "video_url" : streams.hevc ? "hevc" : "-";
          let host = "?";
          try { host = new URL(streamUrl || "").host || "?"; } catch { /* empty or invalid url */ }
          logLine(
            `[play] id=${curId} ep=${curEp} src=${streamUrl ? "y" : "n"} kind=${streamKind} host=${host}` +
            (streamUrl ? "" : ` status=${String(raw.status ?? "?")} msg=${String(raw.msg ?? "")}`),
          );
          tracePlayback("play.resolve", {
            video_id: curId, episode: curEp, resolved: !!streamUrl, kind: streamKind, host,
            status: raw.status ?? null, msg: String(raw.msg ?? "") || null,
          });
          if (!streamUrl) throw new Error("No playback stream available");
          setPlayUrls((m) => ({ ...m, [playKey]: streamUrl }));
          if (hevcStream) setHevcUrls((m) => ({ ...m, [playKey]: hevcStream }));
          saveHistory(curEp);
        })
        .catch((e) => {
          if (!alive) return;
          if (fromOfflineFallback) {
            setErr("Offline episode file not found in storage. Please connect to internet to re-download.");
          } else {
            setErr(localizeError(e, store.language));
          }
        });
    }

    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curId, curEp, proxyRetry, offlineOnly, offlineRev]);

  useEffect(() => {
    const key = playKey;
    return () => {
      setOfflineUrls((m) => {
        if (!m[key]?.startsWith("blob:")) return m;
        const next = { ...m };
        delete next[key];
        return next;
      });
      setPlayUrls((m) => {
        if (!m[key]?.startsWith("blob:")) return m;
        const next = { ...m };
        delete next[key];
        return next;
      });
    };
  }, [playKey]);

  /* Episode warmup: strictly skipped in zeroDataMode or for already-downloaded episodes */
  useEffect(() => {
    if (!curId || kind !== "video" || zeroDataMode || isEpisodeDownloaded(curId, curEp)) return;
    const ep = epMap[curId] || 1;
    const total = episodes.length;
    const want: number[] = [];
    if (ep > 1) want.push(ep - 1);
    if (total === 0 || ep < total) want.push(ep + 1);
    for (const e of want) {
      if (isEpisodeDownloaded(curId, e)) continue;
      const k = `${curId}:${e}`;
      if (playUrls[k]) continue;
      api.play(curId, e)
        .then((info) => {
          const u = info?.streams?.main || info?.video_url;
          const h = info?.streams?.hevc || info?.video_url_hevc || "";
          if (u) setPlayUrls((m) => ({ ...m, [k]: u }));
          if (h) setHevcUrls((m) => ({ ...m, [k]: h }));
          if (e === ep + 1 && !isEpisodeDownloaded(curId, e)) {
            void preloadEpisode(curId, e, {
              preferHevc,
              title: formatDramaTitle(meta?.title),
              maxSegments: 5,
            });
          }
        })
        .catch(() => { /* prefetch error ignored */ });
    }

    // Next drama in feed preheat (only if not downloaded):
    const nextDramaId = videoIds[index + 1];
    if (nextDramaId && kind === "video" && !isEpisodeDownloaded(nextDramaId, 1)) {
      const nextKey = `${nextDramaId}:1`;
      if (!playUrls[nextKey]) {
        api.play(nextDramaId, 1)
          .then((info) => {
            const u = info?.streams?.main || info?.video_url;
            const h = info?.streams?.hevc || info?.video_url_hevc || "";
            if (u) setPlayUrls((m) => ({ ...m, [nextKey]: u }));
            if (h) setHevcUrls((m) => ({ ...m, [nextKey]: h }));
          })
          .catch(() => {});
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curId, curEp, episodes.length, index, videoIds, kind, zeroDataMode]);

  /* Reset playback state and track video element on item/episode change */
  useEffect(() => {
    setTime(0); setDuration(0); bufferedRef.current = 0; setErr(""); setWaiting(true); setVideoStarted(false); setPaused(false); setDescOpen(false);
    setCancelAutoNext(false);
    cancelAutoNextRef.current = false;
    playbackClock.publish(0);
    setVsize({ w: 0, h: 0 });
    setPortraitFit("contain");
  }, [playKey]);

  useEffect(() => {
    setVideoEl(videoRef.current?.el() ?? null);
  }, [playKey, active]);

  /* Volume and mute state synchronization */
  useEffect(() => { videoRef.current?.mute(muted); }, [muted]);
  useEffect(() => { videoRef.current?.volume(volume); }, [volume]);
  /* Playback speed synchronization */
  useEffect(() => { videoRef.current?.rate(effRate); }, [effRate, playKey]);

  /* Persist final progress and cleanup offline blob URLs */
  useEffect(() => () => {
    const s = liveRef.current;
    if (s.id && s.dur) saveHistoryRef.current(s.ep, s.t, s.dur);
    revokeOfflinePlaybackUrls(sessionKeyRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Basic key navigation for accessibility */
  useEffect(() => {
    if (!active || controlsLocked) return;
    const fn = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (panel) { if (e.key === "Escape") setPanel(null); return; }
      switch (e.key) {
        case "ArrowDown": e.preventDefault(); stepDir(1); break;
        case "ArrowUp": e.preventDefault(); stepDir(-1); break;
        case " ": e.preventDefault(); videoRef.current?.toggle(); break;
        default: break;
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, controlsLocked, panel, index, stepDir]);

  /* Android back button handler */
  useEffect(() => {
    if (!panel) { setBackHandler(null); return undefined; }
    setBackHandler(() => { setPanel(null); return true; });
    return () => setBackHandler(null);
  }, [panel]);

  useEffect(() => {
    const onFs = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  const toggleFull = () => {
    const el = boxRef.current?.parentElement;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else el.requestFullscreen().catch(() => {});
  };

  /* --- Long press 2.0x, scrub gesture, and single tap --- */
  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isDesktop || controlsLocked || !active) return;
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointersRef.current.size === 2) {
      const pts = [...pointersRef.current.values()];
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
      pinchRef.current = {
        d0: d,
        mx0: (pts[0].x + pts[1].x) / 2,
        my0: (pts[0].y + pts[1].y) / 2,
        s0: zoom.s,
        x0: zoom.x,
        y0: zoom.y,
      };
      if (gesture.current?.timer) window.clearTimeout(gesture.current.timer);
      gesture.current = null;
      if (holdRef.current) { holdRef.current = false; setHoldSpeed(false); }
      lockArmedRef.current = false;
      setLockArmed(false);
      setZoom((z) => ({ ...z, g: true }));
      return;
    }
    if (gesture.current || e.button !== 0) return;
    const el = e.currentTarget;
    const rect = el.getBoundingClientRect();
    const width = rect.width || el.clientWidth || 1;
    try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const g = {
      x: e.clientX, y: e.clientY, left: rect.left, startY: e.clientY, t: Date.now(), base: time, width,
      mode: "idle" as "idle" | "hold" | "scrub" | "pan" | "brightness" | "volume",
      startVal: 1,
      playing: videoRef.current?.el()?.paused === false,
      timer: window.setTimeout(() => {
        const cur = gesture.current;
        if (!cur || cur.mode !== "idle") return;
        cur.mode = "hold";
        holdRef.current = true;
        setHoldSpeed(true);
        setLockArmed(false);
        lockArmedRef.current = false;
        try { (window as any).AuraNativeExport?.vibrateHaptic?.("medium"); } catch {}
        try { navigator.vibrate?.(25); } catch { /* ignore */ }
      }, 380) as unknown as number,
    };
    gesture.current = g;
  };

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (pointersRef.current.has(e.pointerId)) {
      pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
    const p = pinchRef.current;
    if (p && pointersRef.current.size >= 2) {
      const pts = [...pointersRef.current.values()];
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
      const mx = (pts[0].x + pts[1].x) / 2;
      const my = (pts[0].y + pts[1].y) / 2;
      const s = Math.min(4, Math.max(1, p.s0 * (d / p.d0)));
      setZoom({ s, x: p.x0 + (mx - p.mx0), y: p.y0 + (my - p.my0), g: true });
      return;
    }
    const g = gesture.current;
    if (!g || isDesktop) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;

    /* Long press: slide up 64px to lock 2.0x speed */
    if (g.mode === "hold") {
      const armed = g.startY - e.clientY > 64;
      if (armed !== lockArmedRef.current) {
        lockArmedRef.current = armed;
        setLockArmed(armed);
      }
      return;
    }

    if (g.mode === "idle") {
      if (Math.abs(dx) > 14 && Math.abs(dx) > Math.abs(dy)) {
        if (g.timer) window.clearTimeout(g.timer);
        g.mode = "scrub";
        videoRef.current?.pause();
      } else if (Math.abs(dy) > 14) {
        if (g.timer) window.clearTimeout(g.timer);
        const isLeft = g.x < g.width * 0.5;
        if (fs || !swipeEp) {
          g.mode = isLeft ? "brightness" : "volume";
          g.startVal = isLeft ? brightness : (muted ? 0 : volume);
          try { (window as any).AuraNativeExport?.vibrateHaptic?.("light"); } catch {}
        } else {
          g.mode = "pan";
        }
      }
      return;
    }

    if (g.mode === "brightness") {
      const delta = (g.startY - e.clientY) / (Math.max(window.innerHeight, 400) * 0.45);
      const nextB = Math.max(0.15, Math.min(1.0, g.startVal + delta));
      setBrightness(nextB);
      try { localStorage.setItem("aurastream_brightness", String(nextB)); } catch {}
      if (hudTimerRef.current) window.clearTimeout(hudTimerRef.current);
      setGestureHud({ type: "brightness", val: Math.round(nextB * 100), visible: true });
      return;
    }

    if (g.mode === "volume") {
      const delta = (g.startY - e.clientY) / (Math.max(window.innerHeight, 400) * 0.45);
      const nextV = Math.max(0, Math.min(1.0, g.startVal + delta));
      setVolume(nextV);
      videoRef.current?.volume(nextV);
      if (muted && nextV > 0) setMuted(false);
      if (hudTimerRef.current) window.clearTimeout(hudTimerRef.current);
      setGestureHud({ type: "volume", val: Math.round(nextV * 100), visible: true });
      return;
    }

    if (g.mode === "scrub") {
      const total = duration || 0;
      if (!total) return;
      const target = Math.max(0, Math.min(total, g.base + (dx / g.width) * total));
      scrubTarget.current = target;
      setScrub({ pct: (target / total) * 100, target });
    }
  };

  const onUp = (cancelled = false, e?: React.PointerEvent<HTMLDivElement>) => {
    if (e) pointersRef.current.delete(e.pointerId);
    if (pointersRef.current.size < 2 && pinchRef.current) {
      pinchRef.current = null;
      // Reset zoom if less than 1.05x on release
      setZoom((z) => (z.s < 1.05 ? { s: 1, x: 0, y: 0, g: false } : { s: z.s, x: z.x, y: z.y, g: false }));
    }
    const g = gesture.current;
    gesture.current = null;
    /* Reset long press state on episode change or unmount
       Ensures scroll is not blocked on subsequent interactions
       Restores normal touch scrolling. */
    if (holdRef.current) { holdRef.current = false; setHoldSpeed(false); }
    const wasLockArmed = lockArmedRef.current;
    if (lockArmedRef.current) { lockArmedRef.current = false; setLockArmed(false); }
    if (!g) return;
    if (g.timer) window.clearTimeout(g.timer);

    if (g.mode === "brightness" || g.mode === "volume") {
      if (hudTimerRef.current) window.clearTimeout(hudTimerRef.current);
      hudTimerRef.current = window.setTimeout(() => {
        setGestureHud((h) => ({ ...h, visible: false }));
        hudTimerRef.current = null;
      }, 750) as unknown as number;
      return;
    }

    if (g.mode === "hold") {
      holdRef.current = false;
      setHoldSpeed(false);
      if (!cancelled && wasLockArmed) {
        setSpeedLock(true);
        toast("Locked 2.0x playback speed · Tap top badge to unlock", "info");
      }
      lockArmedRef.current = false;
      setLockArmed(false);
      return;
    }
    if (g.mode === "scrub") {
      const target = scrubTarget.current;
      if (!cancelled && target != null) videoRef.current?.seek(target, "mobile_gesture");
      setScrub(null);
      scrubTarget.current = null;
      if (g.playing && active) videoRef.current?.play();
      return;
    }
    /* Swipe episode gesture handler
       Switches episode or series on swipe release */
    if (!cancelled && e && g.mode === "pan") {
      const dy = e.clientY - g.startY;
      const dx2 = e.clientX - g.x;
      if (Math.abs(dy) > 56 && Math.abs(dy) > Math.abs(dx2)) {
        const dir = dy < 0 ? 1 : -1;
        const want = dir === 1 ? nextEpObj?.ep_num : prevEpObj?.ep_num;
        const total = episodes.length;
        if (swipeEp && kind === "video" && want) {
          setEpMap((m) => ({ ...m, [curId]: want }));
          toast(total ? `Ep. ${want} / ${total}` : `Ep. ${want}`, "info");
          try { navigator.vibrate?.(12); } catch { /* ignore */ }
          return;
        }
        if (swipeEp) { go(dir); return; }
      }
    }
    if (!cancelled && g.mode === "idle" && Date.now() - g.t < 260) {
      const now = Date.now();
      const screenWidth = g.width || (typeof window !== "undefined" ? window.innerWidth : 360);
      const ratio = (g.x - g.left) / screenWidth;

      if (lastTapRef.current.t > 0 && now - lastTapRef.current.t < 230) {
        lastTapRef.current.t = 0;
        flushSync(() => {
          setClean(false);
          if (!isDesktop && fs) setIdle(false);
        });

        const liveVideo = videoRef.current?.el();
        const liveTime = liveVideo && Number.isFinite(liveVideo.currentTime)
          ? liveVideo.currentTime
          : (Number.isFinite(time) ? time : 0);
        const liveDur = liveVideo && Number.isFinite(liveVideo.duration) && liveVideo.duration > 0
          ? liveVideo.duration
          : (typeof duration === "number" && Number.isFinite(duration) && duration > 0 ? duration : Infinity);

        if (ratio < 0.28) {
          // Double tap left: Seek backward 10s (works in both portrait & landscape)
          const target = Math.max(0, liveTime - 10);
          videoRef.current?.seek(target, "double-tap-back");
          setTime(target);
          playbackClock.publish(target);
          triggerSeekRipple("left", "-10s");
        } else if (ratio > 0.72) {
          // Double tap right: Seek forward 10s (works in both portrait & landscape)
          const target = Math.max(0, Math.min(liveDur, liveTime + 10));
          if (Number.isFinite(target)) {
            videoRef.current?.seek(target, "double-tap-forward");
            setTime(target);
            playbackClock.publish(target);
            triggerSeekRipple("right", "+10s");
          }
        } else {
          // Double tap center: Toggle play/pause on mobile
          const wasPaused = videoRef.current?.el()?.paused ?? paused;
          videoRef.current?.toggle();
          triggerSeekRipple("center", wasPaused ? "Play" : "Pause");
        }
      } else {
        // Single tap immediately toggles clean chrome without waiting for double-tap timeout
        lastTapRef.current.t = now;
        flushSync(() => {
          setClean((c) => !c);
          if (!isDesktop && fs) setIdle((i) => !i);
        });
      }
    }
  };

  useEffect(() => {
    if (!active || controlsLocked) {
      onUp(true);
      lastTapRef.current.t = 0;
    }
    // Cancel pending gestures when the page is hidden or controls are locked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, controlsLocked]);

  useEffect(() => () => {
    if (gesture.current?.timer) window.clearTimeout(gesture.current.timer);
    lastTapRef.current.t = 0;
    gesture.current = null;
    holdRef.current = false;
    lockArmedRef.current = false;
  }, [playKey]);

  /* Fullscreen transition playback retry */
  const keepAlive = useCallback(() => {
    for (const t of keepAliveTimers.current) window.clearTimeout(t);
    keepAliveTimers.current = [];
    for (const delay of [50, 150, 300, 500, 800, 1200]) {
      keepAliveTimers.current.push(window.setTimeout(() => {
        const v = videoRef.current?.el();
        if (v && v.paused) videoRef.current?.play();
      }, delay) as unknown as number);
    }
  }, []);

  const enterFs = useCallback((landscape: boolean) => {
    const wasPlaying = videoRef.current?.el()?.paused === false;
    setClean(false);
    setFs(true);
    wake();
    if (wasPlaying) keepAlive();
    if (!isDesktop) {
      setNativeOrientation(landscape);
      if (landscape) {
        try {
          (screen.orientation as unknown as { lock?: (o: string) => Promise<void> })?.lock?.("landscape")?.catch(() => {});
        } catch { /* ignore */ }
      }
    }
  }, [isDesktop, keepAlive, setClean, setFs]);

  const exitFs = useCallback(() => {
    const wasPlaying = videoRef.current?.el()?.paused === false;
    setClean(false);
    setFs(false);
    if (wasPlaying) keepAlive();
    if (!isDesktop) {
      setNativeOrientation(false);
      try { screen.orientation?.unlock?.(); } catch { /* ignore */ }
    }
  }, [isDesktop, keepAlive, setClean, setFs]);

  useEffect(() => {
    if (isDesktop || fs) return;
    setNativeOrientation(false);
    try { screen.orientation?.unlock?.(); } catch { /* ignore */ }
  }, [isDesktop, fs]);

  /* Re-request landscape orientation if video dimensions resolve after fullscreen entry */
  useEffect(() => {
    if (isDesktop || !fs || !landscapeVideo) return;
    setNativeOrientation(true);
    try {
      (screen.orientation as unknown as { lock?: (o: string) => Promise<void> })?.lock?.("landscape")?.catch(() => {});
    } catch { /* ignore */ }
  }, [isDesktop, fs, landscapeVideo]);

  /* When system orientation locks to landscape, CSS transform is bypassed.
     Auto-rotates and toggles fullscreen on device orientation change. */
  useEffect(() => {
    if (isDesktop) return undefined;
    const onViewportChange = () => {
      const ae = document.activeElement?.tagName;
      if (ae === "INPUT" || ae === "TEXTAREA" || panel !== null) return;
      const isLand = window.innerWidth > window.innerHeight;
      setVpLandscape((prev) => {
        if (prev !== isLand && active) {
          const wasPlaying = videoRef.current?.el()?.paused === false;
          setFs(isLand);
          if (wasPlaying) keepAlive();
        }
        return isLand;
      });
    };
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("orientationchange", onViewportChange);
    return () => {
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("orientationchange", onViewportChange);
    };
  }, [isDesktop, active, panel, setFs, keepAlive]);

  /* Calibrates scroll container scrollTop after orientation change
     - Aligns active video item to top of viewport
     - Restores scrollTop to index * clientHeight upon exiting fullscreen
       Prevents viewport misplacement. */
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return undefined;
    if (fs) {
      el.scrollTop = 0;
      return undefined;
    }
    const syncScroll = () => {
      const box = boxRef.current;
      if (!box || fs) return;
      box.scrollTop = index * (box.clientHeight || 1);
    };
    syncScroll();
    const raf = requestAnimationFrame(syncScroll);
    const t1 = window.setTimeout(syncScroll, 120);
    const t2 = window.setTimeout(syncScroll, 350);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [fs, vpLandscape, index]);

  useEffect(() => () => {
    for (const t of keepAliveTimers.current) window.clearTimeout(t);
    keepAliveTimers.current = [];
  }, []);

  const lockControls = () => { setPanel(null); setControlsLocked(true); };

  /* Prevents native scroll during long-press speed boost */
  useEffect(() => {
    if (isDesktop) return undefined;
    const el = boxRef.current;
    if (!el) return undefined;
    const fn = (e: TouchEvent) => { if (holdRef.current && gesture.current?.mode === "hold") e.preventDefault(); };
    el.addEventListener("touchmove", fn, { passive: false });
    return () => el.removeEventListener("touchmove", fn);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDesktop, videoIds.length]);

  /* --- Scrub bar drag calculation --- */
  const barPctAt = (clientX: number, clientY: number) => {
    const r = barRef.current?.getBoundingClientRect();
    if (!r) return null;
    const span = rotated ? r.height : r.width;
    if (!span) return null;
    const raw = rotated ? (clientY - r.top) / span : (clientX - r.left) / span;
    return Math.max(0, Math.min(1, raw));
  };
  const barSeekTo = (clientX: number, clientY: number) => {
    const pct = barPctAt(clientX, clientY);
    if (pct == null) return null;
    setBarPct(pct);
    return pct;
  };
  const onBarDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    videoRef.current?.trace("seek.input.down", { input: "mobile_bar" });
    barScrub.current = true;
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* ignore */ }
    barSeekTo(e.clientX, e.clientY);
  };
  const onBarMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!barScrub.current) return;
    e.stopPropagation();
    videoRef.current?.trace("seek.input.move", { input: "mobile_bar" });
    barSeekTo(e.clientX, e.clientY);
  };
  const onBarUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!barScrub.current) return;
    barScrub.current = false;
    e.stopPropagation();
    const pct = barPctAt(e.clientX, e.clientY);
    if (pct != null && typeof duration === "number" && Number.isFinite(duration) && duration > 0) {
      const target = Math.max(0, Math.min(duration, pct * duration));
      if (Number.isFinite(target)) {
        videoRef.current?.trace("seek.input.up", { input: "mobile_bar", target });
        videoRef.current?.seek(target, "mobile_bar");
        setTime(target);
      }
    }
    setBarPct(null);
  };

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ inPip?: boolean }>).detail;
      setInPip(!!detail?.inPip);
    };
    window.addEventListener("aurastream:pip-changed", handler);
    return () => window.removeEventListener("aurastream:pip-changed", handler);
  }, []);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden" && !inPip) {
        wasPlayingBeforeHiddenRef.current = !paused || waiting;
        if (videoRef.current) {
          videoRef.current.pause();
        }
      } else if (document.visibilityState === "visible") {
        if (videoRef.current) {
          videoRef.current.mute(muted);
        }
        if (active && wasPlayingBeforeHiddenRef.current && videoRef.current) {
          wasPlayingBeforeHiddenRef.current = false;
          setPaused(false);
          setWaiting(false);
          try {
            videoRef.current.play();
          } catch {}
        }
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [active, inPip, waiting, paused, muted]);

  useEffect(() => {
    // Mini PiP popup on app switch / home disabled per user requirement
    try {
      const bridge = (window as any).AuraNativeExport;
      bridge?.setAutoPip?.(false);
    } catch {}
  }, []);

  const togglePip = async () => {
    try {
      const bridge = (window as any).AuraNativeExport;
      if (bridge?.isPictureInPictureSupported?.()) {
        const isLandscape = isLandscapeCurrent();
        const entered = typeof bridge.enterPictureInPictureWithAspect === "function"
          ? bridge.enterPictureInPictureWithAspect(isLandscape ? 16 : 9, isLandscape ? 9 : 16)
          : bridge.enterPictureInPicture?.();
        if (entered) return;
      }
      const v = videoRef.current?.el();
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else if (v && document.pictureInPictureEnabled) await v.requestPictureInPicture();
      else toast("Picture-in-picture is not supported on this device", "info");
    } catch { toast("Failed to enter picture-in-picture", "info"); }
  };

  const requireLogin = () => { if (!user) { setLoginOpen(true); return false; } return true; };

  const onFav = () => {
    if (!curId) return;
    const on = toggleFavLocal(curId);
    setStarBurst((n) => n + 1);
    try {
      (window as any).AuraNativeExport?.vibrateHaptic?.("selection");
      navigator.vibrate?.(18);
    } catch {}
    toast(on ? t("player.favorited") : t("player.unfavorited"), on ? "star" : "info");
    if (user) {
      if (kind === "post") {
        api.postLike(curId, on).catch(() => {});
        api.postCollect(curId, on).catch(() => {});
      } else {
        api.like(curId, curEp, on).catch(() => {});
        api.collect(curId, on).catch(() => {});
      }
    }
  };

  const onLike = onFav;

  const onFollow = () => {
    const uid = meta.authorId > 0 ? meta.authorId : undefined;
    if (!uid) return;
    const on = toggleFollowLocal(uid);
    toast(on ? `Following ${detail?.author?.name || "creator"}` : "Unfollowed", on ? "ok" : "info");
    if (user) api.follow(uid, on).catch(() => {});
  };

  const pickEp = (ep: number) => {
    setEpMap((m) => ({ ...m, [curId]: ep }));
    setPanel(null);
  };

  const likeCount = useMemo(() => {
    const base = meta.like;
    return base + (isLiked(curId) ? 1 : 0);
  }, [meta.like, curId, isLiked]);

  if (!videoIds.length) {
    return <div className="absolute inset-0 bg-black flex items-center justify-center"><Loader className="w-9 h-9 spinner" /></div>;
  }

  return (
    <div
      className={`hg-player-ui ${rotated ? "fs-landscape" : (!isDesktop && fs ? "fs-immersive" : "absolute inset-0")} overflow-hidden bg-black player-root ${controlsLocked ? "is-locked" : ""} ${isDesktop ? "player-surface" : ""} ${theater ? "is-theater" : ""} ${isDesktop && idle ? "is-idle" : ""}`}
      data-clean={clean}
      onPointerMove={() => { if (isDesktop || fs) wake(); }}
      onPointerDown={() => { if (!isDesktop && fs) wake(); }}
      onKeyDownCapture={() => { if (isDesktop || fs) wake(); }}>
      <div className="absolute inset-0" inert={controlsLocked}>
      {/* Ambient glow background */}
      {!isDesktop && posterUrl && (
        <div className="absolute inset-0 scale-110 blur-3xl opacity-25 pointer-events-none">
          <Image src={posterUrl} alt="" className="w-full h-full object-cover" />
        </div>
      )}

      <div ref={boxRef} onScroll={onScroll}
        className={`absolute inset-y-0 left-0 no-bar ${fs ? "overflow-hidden" : "overflow-y-scroll snap-y snap-mandatory overscroll-y-contain"}`}
        style={{ right: isDesktop && panel ? 372 : 0, transition: "right .3s cubic-bezier(.2,0,0,1)" }}>
        {videoIds.map((vid, i) => {
          const isActive = i === index;
          const sectionClass = `${fs && !isActive ? "hidden" : "relative w-full h-full"} snap-start snap-always overflow-hidden`;
          // Preserve scroll/snap geometry without mounting distant posters and controls.
          if (isDesktop && Math.abs(i - index) > 1 && Math.abs(i - renderIndex) > 1) {
            return <section key={vid} className={sectionClass} aria-hidden="true" />;
          }
          return (
            <section key={vid} className={sectionClass}>
              {isActive && playUrl ? (
                <>
                  <div className="absolute inset-0" style={{ touchAction: swipeEp ? "none" : "pan-y" }}
                    onPointerDown={onDown} onPointerMove={onMove} onPointerUp={(e) => onUp(false, e)} onPointerCancel={(e) => onUp(true, e)} onLostPointerCapture={(e) => onUp(true, e)}>
                    <div style={{ position: "absolute", inset: 0, transform: isDesktop ? undefined : `translate3d(${zoom.x}px, ${zoom.y}px, 0) scale(${zoom.s})`, transformOrigin: "center center", transition: isDesktop || zoom.g ? "none" : "transform .18s ease-out" }}>
                      {/* Poster backdrop with smooth crossfade while video stream is connecting / waiting */}
                      <div
                        className="absolute inset-0 z-0 overflow-hidden pointer-events-none transition-opacity duration-500 ease-out flex flex-col items-center justify-center bg-gradient-to-b from-neutral-900 via-neutral-950 to-black select-none"
                        style={{ opacity: !videoStarted || waiting ? 1 : 0 }}
                      >
                        <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,_rgba(255,255,255,0.06)_0%,_transparent_70%)]" />
                        {posterUrl && (
                          <img
                            src={posterUrl}
                            alt=""
                            loading="eager"
                            decoding="async"
                            className={`absolute inset-0 w-full h-full select-none ${
                              isDesktop
                                ? "object-contain"
                                : landscapeVideo
                                ? fs || vpLandscape
                                  ? "object-contain"
                                  : portraitFit === "cover"
                                  ? "object-cover"
                                  : "object-contain"
                                : vpLandscape
                                ? "object-contain"
                                : "object-cover"
                            }`}
                            onError={(e) => {
                              (e.target as HTMLElement).style.display = "none";
                            }}
                          />
                        )}
                        {posterUrl && <div className="absolute inset-0 bg-black/25" />}

                        {/* Title and episode badge fallback backdrop when no poster available */}
                        {!posterUrl && (
                          <div className="relative z-0 flex flex-col items-center justify-center px-6 text-center max-w-md pointer-events-none mb-16">
                            <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-white/10 backdrop-blur-md border border-white/10 text-[12px] font-medium text-white/80 mb-3 tracking-wide">
                              <span>{kind === "post" ? "Post" : (episodes && episodes.length > 0 ? `EP ${curEp} / ${episodes.length}` : `Episode ${curEp}`)}</span>
                            </div>
                            <h2 className="text-lg md:text-xl font-bold text-white/90 line-clamp-2 leading-snug drop-shadow-md">
                              {dramaTitle}
                            </h2>
                            {epTitle && epTitle !== dramaTitle && epTitle !== `Episode ${curEp}` && (
                              <p className="text-xs text-white/60 mt-1 line-clamp-1">
                                {epTitle}
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                      <VideoSurface ref={videoRef} src={playUrl} poster={posterUrl} autoPlay active={active} muted={muted}
                        diagnosticContext={{ active, view: mode, kind, video_id: curId, episode: curEp }}
                        volume={volume} rate={effRate}
                        fit={isDesktop ? "contain" : landscapeVideo ? (fs || vpLandscape ? "contain" : portraitFit) : (vpLandscape ? "contain" : "cover")}
                        onClick={() => { if (isDesktop) videoRef.current?.toggle(); }}
                        onTime={(t) => {
                          if (t > 0.1 && !videoStarted) setVideoStarted(true);
                          const v = videoRef.current?.el();
                          if (v && v !== videoEl) setVideoEl(v);
                          if (v && v.buffered.length > 0) {
                            bufferedRef.current = v.buffered.end(v.buffered.length - 1);
                          }
                          onTimeTick(t);
                        }}
                        onDuration={onDurationTick}
                        onSize={(w, h) => setVsize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }))}
                        onPlaying={() => {
                          const v = videoRef.current?.el();
                          if (v && v !== videoEl) setVideoEl(v);
                          setPaused(false); setWaiting(false); setErr(""); setVideoStarted(true);
                        }}
                        onPause={() => setPaused(true)}
                        onWaiting={() => setWaiting(true)}
                        onEnded={() => {
                          void checkAutoDeleteFinishedEpisode(curId, curEp);
                          let sleepTriggered = false;
                          checkSleepTimerEpisodeEnd(() => {
                            sleepTriggered = true;
                            setPaused(true);
                            toast("Sleep timer: Paused at end of episode", "info");
                          });
                          if (!sleepTriggered) {
                            if (cancelAutoNextRef.current) {
                              setPaused(true);
                              return;
                            }
                            if (nextEpObj) {
                              pickEp(nextEpObj.ep_num);
                            } else if (mode === "home" && index < videoIds.length - 1) {
                              go(1);
                              toast("Series ended, starting next drama", "info");
                            }
                          }
                        }}
                        onError={(m) => {
                          if (preferHevc && hevcUrl) {
                            setErr("");
                            setPreferHevc(false);
                            toast("HD playback unavailable, switched to SD", "info");
                            return;
                          }
                          setErr(localizeError(m, store.language));
                        }} />
                    </div>
                  </div>
                  <SubtitleOverlay
                    videoId={curId}
                    episode={curEp}
                    title={meta.title}
                    streamUrl={playUrl}
                    mode={store.subtitleMode}
                    size={store.subtitleSize}
                    playbackClock={playbackClock}
                    isDesktop={isDesktop}
                    clean={clean}
                    fs={fs}
                    bottomOffset={bottomInset}
                    videoEl={videoEl ?? videoRef.current?.el()}
                    onTrackStatus={setSubtitleTrackInfo}
                  />

                  {/* Double-tap Seek & Tap Play/Pause Ripple HUD */}
                  {seekRipple && (
                    <div className="absolute inset-0 z-30 pointer-events-none flex items-center justify-center">
                      {seekRipple.dir === "left" && (
                        <div className="absolute left-8 flex flex-col items-center justify-center w-20 h-20 rounded-full bg-black/75 backdrop-blur-md border border-white/20 text-white a-rise shadow-2xl">
                          <IRewindF size={24} className="text-primary" />
                          <span className="text-[12px] font-bold text-white/95 mt-1 tracking-tight">10s</span>
                        </div>
                      )}
                      {seekRipple.dir === "right" && (
                        <div className="absolute right-8 flex flex-col items-center justify-center w-20 h-20 rounded-full bg-black/75 backdrop-blur-md border border-white/20 text-white a-rise shadow-2xl">
                          <IFastForwardF size={24} className="text-primary" />
                          <span className="text-[12px] font-bold text-white/95 mt-1 tracking-tight">10s</span>
                        </div>
                      )}
                      {seekRipple.dir === "center" && (
                        <div className="w-20 h-20 rounded-full bg-black/80 backdrop-blur-md border border-white/25 flex flex-col items-center justify-center text-white a-pop shadow-2xl">
                          {seekRipple.text === "Play" ? (
                            <IPlayF size={30} className="text-primary ml-0.5" />
                          ) : (
                            <IPauseF size={30} className="text-primary" />
                          )}
                          <span className="text-[11px] font-bold text-white/95 tracking-tight mt-1">
                            {seekRipple.text}
                          </span>
                        </div>
                      )}
                    </div>
                  )}
                </>
              ) : (
                <div className="absolute inset-0">
                  <Img
                    src={(() => {
                      const localMatch = getOfflineEpisodes().find(
                        (ep) => ep.videoId === vid && ep.storage === "native" && ep.hasLocalCover
                      );
                      if (localMatch) return getOfflineCoverUrl(localMatch, 900);
                      if (offlineOnly || (typeof navigator !== "undefined" && navigator.onLine === false)) {
                        return "";
                      }
                      return detail?.cover || cards[vid]?.cover || posts[vid]?.cover || "";
                    })()}
                    eager={Math.abs(i - index) <= 1}
                  />
                  <div className="absolute inset-0" style={{ background: "rgba(0,0,0,.25)" }} />
                </div>
              )}

              {/* Text post banner */}
              {isActive && kind === "post" && !!post && !post.video_url && (
                <div className="absolute inset-0 z-10 flex items-center justify-center">
                  <Button type="button" onClick={() => setPanel("article")}
                    className="flex items-center gap-2 h-11 px-5 rounded-full text-[14px] font-semibold pressable elev-3"
                    style={{ background: "rgba(255,255,255,.94)", color: "#0b0e15" }}>
                    <IFileText size={17} />View Article Details
                  </Button>
                </div>
              )}

              {/* Top navigation bar */}
              {!inPip && (
              <>
              {!fs && !clean && mode === "context" ? (
                isDesktop ? (
                  <div className="desktop-context-header">
                    <Button onClick={onBack} aria-label={t("common.back")}><IBack size={17} /></Button>
                    <span>{title}</span>
                    <small>{index + 1} / {videoIds.length}</small>
                  </div>
                ) : (
                  <div className="absolute inset-x-0 z-20 flex items-center gap-2 px-2.5" style={{ top: "calc(var(--sat, 0px) + 8px)", paddingRight: mode === "context" ? 170 : 210 }}>
                    <Button onClick={onBack} aria-label={t("common.back")} className="hg-chip w-9 h-9 rounded-full flex items-center justify-center pressable elev-1"><IBack size={20} /></Button>
                    <span className="text-[15px] font-semibold hg-ink hg-ov-shadow truncate max-w-[130px]">{title}</span>
                    {!panel && (
                      <span className="feed-position-pill shrink-0 px-2.5 py-0.5 rounded-full hg-chip text-[11.5px] font-semibold tabular-nums"
                        style={{ color: "rgba(255,255,255,.94)" }}>
                        {index + 1} / {videoIds.length}
                      </span>
                    )}
                  </div>
                )
              ) : null}

              {/* Portrait quick action controls:
                  Reset zoom pill if zoomed in.
                  Clean and unobtrusive, never collides with Skip Intro or Subtitles. */}
              {!isDesktop && zoom.s > 1.05 && (
                <div
                  className="absolute z-20 left-1/2 -translate-x-1/2 whitespace-nowrap"
                  style={{ top: "calc(max(var(--sat, 0px), 28px) + 52px)" }}>
                  <div className="inline-flex items-center gap-0.5 h-8 px-2 rounded-full backdrop-blur-xl elev-2"
                    style={{ background: "rgba(12,15,22,.65)", boxShadow: "inset 0 0 0 1px rgba(255,255,255,.12)" }}>
                    <Button type="button" onClick={() => setZoom({ s: 1, x: 0, y: 0, g: false })}
                      className="whitespace-nowrap flex items-center justify-center gap-1 h-[26px] px-3 rounded-full text-[12px] font-semibold pressable"
                      style={{ color: "rgba(255,255,255,.9)" }}>
                      {t("player.reset_zoom", { zoom: zoom.s.toFixed(1) })}
                    </Button>
                  </div>
                </div>
              )}
              {/* Mobile action rail (Star / Comments / Captions / Download / More) */}
              {!fs && !clean && !isDesktop && !panel && (
                <div className="absolute right-2.5 z-30 flex flex-col items-center gap-[12px] pointer-events-auto"
                  style={{ bottom: `calc(var(--sab, 48px) + ${bottomInset + 18}px)` }}
                  onPointerDown={(e) => e.stopPropagation()}
                  onTouchStart={(e) => e.stopPropagation()}
                  onClick={(e) => e.stopPropagation()}>
                  {/* 1. Star / Favorite */}
                  <Button
                    type="button"
                    onClick={onFav}
                    style={{ touchAction: "manipulation" }}
                    className="flex flex-col items-center justify-center min-w-[50px] min-h-[50px] gap-0.5 pressable cursor-pointer select-none active:scale-95 transition-transform"
                    aria-pressed={isFav(curId)}
                    aria-label={isFav(curId) ? t("player.favorited") : t("player.favorite")}
                  >
                    <span key={starBurst} className={starBurst ? "a-pop" : ""}>
                      {isFav(curId) ? <IStarF size={28} className="text-amber-400 drop-shadow-[0_2px_8px_rgba(251,191,36,0.55)]" /> : <IStar size={28} className="hg-ink hg-ov-shadow" />}
                    </span>
                    <span className="text-[11px] hg-ink-2 hg-ov-shadow font-medium tabular-nums">{fmt(likeCount)}</span>
                  </Button>

                  {/* 2. Comments */}
                  <Button
                    type="button"
                    onClick={() => setPanel("comments")}
                    style={{ touchAction: "manipulation" }}
                    className="flex flex-col items-center justify-center min-w-[50px] min-h-[50px] gap-0.5 pressable cursor-pointer select-none active:scale-95 transition-transform"
                    aria-label={t("player.comments")}
                  >
                    <ICommentF size={25} className="hg-ink hg-ov-shadow" />
                    <span className="text-[11px] hg-ink-2 hg-ov-shadow font-medium tabular-nums">{fmt(meta.comment) || t("player.comments")}</span>
                  </Button>

                  {/* 4. Offline Download */}
                  <Button
                    type="button"
                    onClick={() => setDownloadChoiceOpen(true)}
                    style={{ touchAction: "manipulation" }}
                    className="flex flex-col items-center justify-center min-w-[50px] min-h-[50px] gap-0.5 pressable cursor-pointer select-none active:scale-95 transition-transform"
                    aria-label="Offline Download"
                  >
                    {isDownloaded ? (
                      <div className="w-[27px] h-[27px] rounded-full bg-emerald-500/30 border border-emerald-400/60 flex items-center justify-center">
                        <ICheck size={15} className="text-emerald-400" strokeWidth={2.8} />
                      </div>
                    ) : isDownloadingCurrent ? (
                      <div className="relative w-[28px] h-[28px] flex items-center justify-center">
                        <svg className="w-[28px] h-[28px] -rotate-90" viewBox="0 0 28 28" aria-hidden="true">
                          <circle cx="14" cy="14" r="11" fill="rgba(0,0,0,0.45)" stroke="rgba(255,255,255,0.22)" strokeWidth="2.5" />
                          <circle
                            cx="14"
                            cy="14"
                            r="11"
                            fill="none"
                            stroke="var(--p-primary, #60a5fa)"
                            strokeWidth="2.5"
                            strokeLinecap="round"
                            strokeDasharray={69.115}
                            strokeDashoffset={69.115 * (1 - Math.max(0, Math.min(100, currentDownload?.progress ?? 0)) / 100)}
                          />
                        </svg>
                        <IDownload size={12} className="absolute text-white" />
                      </div>
                    ) : (
                      <IDownload size={25} className="hg-ink hg-ov-shadow" />
                    )}
                    <span className={`text-[11px] font-medium tabular-nums ${isDownloaded ? "text-emerald-400 font-semibold" : "hg-ink-2 hg-ov-shadow"}`}>
                      {isDownloaded ? "Saved" : isDownloadingCurrent ? `${currentDownload?.progress ?? 0}%` : "Download"}
                    </span>
                  </Button>

                  {/* 5. Share */}
                  <Button
                    type="button"
                    onClick={shareLink}
                    style={{ touchAction: "manipulation" }}
                    className="flex flex-col items-center justify-center min-w-[50px] min-h-[50px] gap-0.5 pressable cursor-pointer select-none active:scale-95 transition-transform"
                    aria-label={t("player.share")}
                  >
                    <ILink size={24} className="hg-ink hg-ov-shadow" />
                    <span className="text-[11px] hg-ink-2 hg-ov-shadow font-medium">{t("player.share")}</span>
                  </Button>

                  {/* 6. More Options Sheet */}
                  <Button
                    type="button"
                    onClick={() => setPanel("more")}
                    style={{ touchAction: "manipulation" }}
                    className="flex flex-col items-center justify-center min-w-[50px] min-h-[50px] gap-0.5 pressable cursor-pointer select-none active:scale-95 transition-transform"
                    aria-label="More Options"
                  >
                    <IMore size={26} className="hg-ink hg-ov-shadow" />
                    <span className="text-[11px] hg-ink-2 hg-ov-shadow font-medium">Options</span>
                  </Button>
                </div>
              )}

              {/* Desktop action rail */}
              {!fs && !clean && isDesktop && (
              <div className="absolute z-20 flex flex-col items-center desktop-social">
                <div className="desktop-browse-inline">
                  <Button onClick={() => stepDir(-1)} disabled={!canStep(-1)} aria-label="Previous" title="Previous ↑">
                    <IChevronUp size={19} strokeWidth={1.8} />
                  </Button>
                  <Button onClick={() => stepDir(1)} disabled={!canStep(1)} aria-label="Next" title="Next ↓">
                    <IChevronDown size={19} strokeWidth={1.8} />
                  </Button>
                  <small>{String(index + 1).padStart(2, "0")} / {String(videoIds.length).padStart(2, "0")}</small>
                </div>

                {kind === "video" && (
                  <>
                    <Button onClick={onFav} aria-label={t("player.favorite")} className="flex flex-col items-center gap-1 pressable" aria-pressed={isFav(curId)}>
                      <span key={starBurst} className={starBurst ? "a-pop" : ""}>
                        {isFav(curId) ? <IStarF size={30} className="text-amber-400 drop-shadow-[0_2px_8px_rgba(251,191,36,0.55)]" /> : <IStar size={30} className="text-white tsh" />}
                      </span>
                      <span className="text-[12px] text-white/90 tabular-nums">{fmt(likeCount)}</span>
                    </Button>

                    <Button onClick={() => setPanel("comments")} aria-label="Comments" className="flex flex-col items-center gap-1 pressable">
                      <ICommentF size={27} className="text-white tsh" />
                      <span className="text-[12px] text-white/90 tabular-nums">{fmt(meta.comment)}</span>
                    </Button>

                    <Button onClick={() => setPanel("episodes")} aria-label={t("player.episodes")} className="flex flex-col items-center gap-1 pressable">
                      <IList size={26} className="text-white tsh" />
                      <span className="text-[12px] text-white/90">{t("player.episodes")}</span>
                    </Button>

                    <Button
                      onClick={() => setDownloadChoiceOpen(true)}
                      aria-label="Download Episode"
                      className="flex flex-col items-center gap-1 pressable"
                    >
                      {isDownloaded ? (
                        <div className="w-[26px] h-[26px] rounded-full bg-emerald-500/25 border border-emerald-400/50 flex items-center justify-center">
                          <ICheck size={16} className="text-emerald-400" strokeWidth={2.8} />
                        </div>
                      ) : isDownloadingCurrent ? (
                        <div className="relative w-[26px] h-[26px] flex items-center justify-center">
                          <Loader className="w-6 h-6 spinner text-primary" />
                          <span className="absolute text-[8px] font-bold text-white tabular-nums">
                            {currentDownload?.progress}%
                          </span>
                        </div>
                      ) : (
                        <IDownload size={26} className="text-white tsh" />
                      )}
                      <span className={`text-[12px] ${isDownloaded ? "text-emerald-400 font-semibold" : "text-white/90"}`}>
                        {isDownloaded ? "Saved" : isDownloadingCurrent ? `${currentDownload?.progress}%` : "Download"}
                      </span>
                    </Button>
                  </>
                )}

                <Button onClick={shareLink} aria-label={t("player.share")} className="flex flex-col items-center gap-1 pressable">
                  <ILink size={25} className="text-white tsh" />
                  <span className="text-[12px] text-white/90">{t("player.share")}</span>
                </Button>
              </div>
              )}

              {/* Desktop bottom-left video info */}
              {!fs && !clean && isDesktop && (
              <div className="desktop-video-meta">
                <div className="flex items-center gap-2">
                  <span className="text-[16px] font-bold text-white tsh truncate">@{formatDramaAuthor(meta.author)}</span>
                   {episodes.length > 0 && (
                    <span className="shrink-0 px-1.5 py-px rounded-md text-[12px] font-bold text-white"
                      style={{ background: "rgba(255,255,255,.16)" }}>
                      {t("player.episode_of", { cur: curEp, total: episodes.length })}
                    </span>
                   )}
                   {isPlayingOffline && (
                     <span className="shrink-0 px-1.5 py-px rounded-md text-[11px] font-bold bg-emerald-500/25 border border-emerald-400/40 text-emerald-300">
                       Offline
                     </span>
                   )}
                   {hevcUrl && !isPlayingOffline && (
                     <Button type="button" aria-pressed={preferHevc}
                       onClick={() => { setPreferHevc(!preferHevc); toast(preferHevc ? t("player.sd") : "HD HEVC", "ok"); }}
                       className={`shrink-0 h-[18px] px-1.5 rounded-md text-[12px] font-bold flex items-center pressable transition-colors ${preferHevc ? "bg-primary text-on-primary" : "text-white border border-white/30"}`}>
                       {preferHevc ? "HD" : t("player.sd")}
                     </Button>
                   )}
                   {!!meta.score && (
                    <span className="shrink-0 text-[12px] font-bold hg-gold hg-ov-shadow flex items-center gap-1">
                      <IStarF size={12} className="text-amber-400" />
                      <span>{meta.score.toFixed(1)}</span>
                    </span>
                   )}
                </div>

                <p className="mt-1 text-[14px] leading-snug hg-ink-2 hg-ov-shadow clamp-2">{formatDramaTitle(meta.title)}</p>

                {/* Single-line description (tap to expand) */}
                <Button onClick={() => setDescOpen((v) => !v)} className="mt-1 text-left w-full pressable group">
                  <p className={`text-[12px] leading-relaxed hg-ink-4 ${descOpen ? "" : "clamp-1"}`}>
                    {formatDramaDesc(meta.desc) || t("common.no_desc")}
                  </p>
                  <span className="text-[12px] hg-link font-semibold">{descOpen ? "Hide" : "Show more"}</span>
                </Button>
              </div>
              )}

              {/* Mobile: title, tags, and progress bar
                  Text shadow ensures readability without dimming overlays;
                  Clean minimalistic scrub indicator. */}
              {!fs && !clean && !isDesktop && !panel && (
                <div className="absolute inset-x-0 z-20 pointer-events-none" style={{ bottom: `calc(var(--sab, 48px) + ${bottomInset}px)` }}>
                  {/* Floating Action Pill / Card (Skip Intro or Up Next Countdown) */}
                  {time > 0.8 && time < 14 && duration > 25 && (
                    <div className="px-4 pb-2 flex items-center pointer-events-auto">
                      <Button
                        type="button"
                        onClick={() => {
                          const maxDur = typeof duration === "number" && Number.isFinite(duration) && duration > 0 ? duration : Infinity;
                          const target = Math.min(maxDur, time + 10);
                          videoRef.current?.seek(target, "skip_intro");
                          triggerSeekRipple("right", "+10s");
                          toast("Skipped intro (+10s)", "info");
                        }}
                        className="flex items-center gap-1.5 h-7 px-3 rounded-full bg-black/60 backdrop-blur-md border border-amber-400/40 text-white text-[11.5px] font-semibold shadow-lg pressable a-pop transition-transform hover:scale-105 active:scale-95"
                      >
                        <IFastForwardF size={12} className="text-amber-400" />
                        <span>Skip Intro (+10s)</span>
                      </Button>
                    </div>
                  )}

                  {duration > 20 && duration - time <= 8 && duration - time > 0.4 && !paused && !cancelAutoNext && dismissNextEp !== curEp && Boolean(nextEpObj) && (
                    <div className="px-4 pb-2 pointer-events-auto max-w-[320px]">
                      <div className="flex items-center justify-between gap-3 px-3.5 py-2 rounded-2xl bg-black/85 backdrop-blur-xl border border-amber-400/35 text-white shadow-[0_8px_32px_rgba(0,0,0,0.65)] a-pop">
                        <div className="flex items-center gap-2 min-w-0">
                          <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse shrink-0" />
                          <div className="flex flex-col min-w-0">
                            <span className="text-[10.5px] font-medium text-white/70 leading-tight">Next in {Math.ceil(duration - time)}s</span>
                            <span className="text-[12px] font-bold text-amber-400 truncate leading-tight">Episode {nextEpObj!.ep_num}</span>
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <Button
                            type="button"
                            onClick={() => {
                              setCancelAutoNext(true);
                              cancelAutoNextRef.current = true;
                              setDismissNextEp(curEp);
                              toast("Auto-play next episode cancelled", "info");
                            }}
                            className="h-6 px-2 rounded-lg bg-white/10 hover:bg-white/15 text-white/90 text-[11px] font-medium pressable"
                          >
                            Cancel
                          </Button>
                          <Button
                            type="button"
                            onClick={() => pickEp(nextEpObj!.ep_num)}
                            className="h-6 px-2.5 rounded-lg bg-primary text-on-primary font-bold text-[11px] flex items-center gap-1 shadow-md pressable"
                          >
                            <IPlayF size={9} />
                            <span>Play Now</span>
                          </Button>
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="relative px-4 pb-1.5 pr-20 flex items-center gap-2 pointer-events-none">
                    <p className="flex-1 min-w-0 text-[15px] font-semibold leading-snug hg-ink-2 hg-ov-shadow-strong clamp-2">{formatDramaTitle(meta.title)}</p>
                  </div>
                  <div className="relative pt-1 pb-2 flex items-center gap-2 px-4 pointer-events-none">
                    <Button onClick={() => setPanel("detail")}
                      className="pointer-events-auto flex items-center gap-0.5 text-[12px] font-medium hg-ink-3 hg-ov-shadow-strong pressable px-2.5 py-1 rounded-full bg-black/40 backdrop-blur-md border border-white/10">
                      {t("common.details")} · {t("player.episode_num", { num: curEp })}<IChevR size={11} />
                    </Button>
                    {isPlayingOffline && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-emerald-500/20 border border-emerald-400/35 text-emerald-300 text-[11px] font-bold tracking-tight">
                        Offline
                      </span>
                    )}
                  </div>
                    <div ref={barRef} className="mx-4 mt-1 mb-2 relative pointer-events-auto" style={{ height: 26, touchAction: "none" }}
                      onPointerDown={onBarDown} onPointerMove={onBarMove} onPointerUp={onBarUp} onPointerCancel={onBarUp}>
                      {/* Scrub track */}
                      <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-[2.5px] rounded-full" style={{ background: "rgba(255,255,255,.14)" }}>
                        <div className="h-full rounded-full"
                          style={{ width: `${barProgress * 100}%`, background: "rgba(255,255,255,.38)", transition: barPct !== null ? "none" : "width .25s linear" }} />
                      </div>
                      {/* Scrub thumb */}
                      <span className={`absolute top-1/2 rounded-full bg-white pointer-events-none transition-transform ${barPct !== null ? "w-[11px] h-[11px] scale-110 shadow-lg" : "w-[8px] h-[8px]"}`}
                        style={{
                          left: `${barProgress * 100}%`,
                          transform: "translate(-50%, -50%)",
                          boxShadow: "0 0 10px rgba(0,0,0,.6)",
                          transition: barPct !== null ? "none" : "left .25s linear, transform .15s ease",
                        }} />
                      {barPct !== null && (
                        <div
                          className="absolute -top-9 px-2.5 py-1 rounded-lg bg-black/85 border border-white/20 text-white shadow-xl backdrop-blur-md text-[12px] font-bold tabular-nums whitespace-nowrap pointer-events-none -translate-x-1/2 flex items-center gap-1.5"
                          style={{
                            left: `${Math.max(12, Math.min(88, barProgress * 100))}%`,
                          }}
                        >
                          <span className="text-white">{fmtTime(barPct * (duration || 0))}</span>
                          <span className="text-white/50 text-[10px]">/ {fmtTime(duration)}</span>
                        </div>
                      )}
                    </div>
                </div>
              )}


              {/* Horizontal scrub HUD */}
              {!isDesktop && scrub && (
                <div className="absolute inset-0 z-30 flex flex-col items-center justify-center pointer-events-none" style={{ background: "rgba(0,0,0,.25)" }}>
                  <span className="text-[26px] font-bold hg-ink tabular-nums hg-ov-shadow">{fmtTime(scrub.target)}</span>
                  <span className="text-[12px] hg-ink-4 mt-1 tabular-nums">/ {fmtTime(duration)}</span>
                  <div className="mt-4 w-[62%] h-[3px] rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,.25)" }}>
                    <div className="h-full bg-white" style={{ width: `${scrub.pct}%` }} />
                  </div>
                </div>
              )}

              {/* Play / Pause / Buffering state */}
              {isActive && paused && !err && (
                <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
                  <button
                    type="button"
                    aria-label="Play"
                    onClick={(e) => {
                      e.stopPropagation();
                      videoRef.current?.toggle();
                    }}
                    className="pointer-events-auto w-[66px] h-[66px] rounded-full flex items-center justify-center backdrop-blur-md pressable cursor-pointer"
                    style={{ background: "rgba(0,0,0,.55)", boxShadow: "inset 0 0 0 1px rgba(255,255,255,.12)" }}>
                    <IPlayF size={28} className="hg-ink ml-0.5" />
                  </button>
                </div>
              )}
              {isActive && waiting && !err && !paused && (
                <div className="absolute inset-0 z-20 flex flex-col items-center justify-center pointer-events-none px-4">
                  <div className="w-12 h-12 rounded-full bg-black/60 backdrop-blur-md flex items-center justify-center border border-white/15 shadow-[0_8px_24px_rgba(0,0,0,0.5)]">
                    <Loader className="w-6 h-6 spinner text-primary" />
                  </div>
                </div>
              )}
              {isActive && err && (
                <div className="absolute inset-0 z-20 flex items-center justify-center p-6">
                  <div
                    className="rounded-2xl p-6 flex flex-col items-center gap-3 text-center max-w-sm backdrop-blur-xl border border-white/10 shadow-2xl"
                    style={{ background: "rgba(18, 18, 22, 0.90)" }}
                  >
                    <div className="w-12 h-12 rounded-full bg-red-500/15 flex items-center justify-center text-red-400 mb-1">
                      <IPlayF size={22} className="opacity-80" />
                    </div>
                    <span className="text-[15px] font-bold text-white tracking-tight">{t("player.load_error")}</span>
                    <span className="text-[12.5px] text-zinc-300 leading-relaxed max-w-[260px] break-words">{localizeError(err, store.language)}</span>
                    <div className="flex items-center gap-2 mt-2 w-full">
                      <Button
                        className="flex-1 h-9 rounded-xl bg-white/10 hover:bg-white/15 text-white text-[13px] font-semibold pressable"
                        onClick={() => {
                          setErr("");
                          setWaiting(true);
                          setPlayUrls((m) => {
                            const copy = { ...m };
                            delete copy[playKey];
                            return copy;
                          });
                          setProxyRetry((v) => v + 1);
                          videoRef.current?.play();
                        }}
                      >
                        {t("cat.retry")}
                      </Button>
                    </div>
                  </div>
                </div>
              )}

              {/* Next Episode Outro Floating Countdown Pill (Desktop & Fullscreen) */}
              {isActive && (isDesktop || fs) && !paused && !waiting && !clean && !controlsLocked && !cancelAutoNext && episodes.some((e) => e.ep_num === curEp + 1) && duration > 20 && duration - time <= 15 && duration - time >= 0.6 && dismissNextEp !== curEp && (
                <div
                  className="absolute z-30 pointer-events-auto transition-all duration-300 animate-in fade-in slide-in-from-bottom-2"
                  style={{
                    bottom: isDesktop ? "76px" : fs ? "calc(var(--sab, 48px) + 64px)" : `calc(var(--sab, 48px) + ${bottomInset + 54}px)`,
                    right: isDesktop || fs ? "24px" : "16px",
                  }}
                >
                  <div className="flex items-center gap-1.5 p-1 pl-3.5 pr-1.5 rounded-full bg-black/85 backdrop-blur-xl border border-white/20 text-white shadow-2xl">
                    <Button
                      onClick={() => {
                        const nextEpObj = episodes.find((e) => e.ep_num === curEp + 1);
                        if (nextEpObj) pickEp(nextEpObj.ep_num);
                      }}
                      className="flex items-center gap-2 text-[12px] font-bold tracking-tight text-white hover:text-primary transition-colors pressable"
                    >
                      <span>Next Ep. {curEp + 1}</span>
                      <span className="px-1.5 py-0.5 rounded-full bg-primary/25 text-primary text-[11px] font-mono tabular-nums">
                        {Math.max(1, Math.ceil(duration - time))}s
                      </span>
                      <IPlayF size={11} className="text-primary ml-0.5" />
                    </Button>
                    <Button
                      onClick={() => setDismissNextEp(curEp)}
                      className="w-6 h-6 rounded-full hover:bg-white/10 text-white/60 hover:text-white flex items-center justify-center pressable ml-0.5"
                      aria-label="Dismiss"
                    >
                      <IClose size={11} />
                    </Button>
                  </div>
                </div>
              )}
              </>
              )}
              {isActive && !playUrl && (
                <div className="absolute inset-0 z-0 flex flex-col items-center justify-center bg-gradient-to-b from-neutral-900 via-neutral-950 to-black select-none">
                  <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,_rgba(255,255,255,0.06)_0%,_transparent_70%)]" />
                  {posterUrl && (
                    <img
                      src={posterUrl}
                      alt=""
                      loading="eager"
                      decoding="async"
                      className="absolute inset-0 w-full h-full object-cover select-none"
                      onError={(e) => {
                        (e.target as HTMLElement).style.display = "none";
                      }}
                    />
                  )}
                  {posterUrl && <div className="absolute inset-0 bg-black/40" />}
                  {!posterUrl && (
                    <div className="relative z-10 flex flex-col items-center justify-center px-6 text-center max-w-md pointer-events-none mb-16">
                      <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-white/10 backdrop-blur-md border border-white/10 text-[12px] font-medium text-white/80 mb-3 tracking-wide">
                        <span>{kind === "post" ? "Post" : (episodes && episodes.length > 0 ? `EP ${curEp} / ${episodes.length}` : `Episode ${curEp}`)}</span>
                      </div>
                      <h2 className="text-lg md:text-xl font-bold text-white/90 line-clamp-2 leading-snug drop-shadow-md">
                        {dramaTitle}
                      </h2>
                      {epTitle && epTitle !== dramaTitle && epTitle !== `Episode ${curEp}` && (
                        <p className="text-xs text-white/60 mt-1 line-clamp-1">
                          {epTitle}
                        </p>
                      )}
                    </div>
                  )}
                  {!err && (
                    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center pointer-events-none px-4">
                      <div className="w-12 h-12 rounded-full bg-black/60 backdrop-blur-md flex items-center justify-center border border-white/15 shadow-[0_8px_24px_rgba(0,0,0,0.5)]">
                        <Loader className="w-6 h-6 spinner text-primary" />
                      </div>
                    </div>
                  )}
                </div>
              )}
            </section>
          );
        })}
      </div>

      {/* Vertical Edge Gestures HUD (Brightness on left, Volume on right) */}
      {gestureHud.visible && (
        <div
          className={`absolute top-1/2 -translate-y-1/2 z-40 flex flex-col items-center gap-2.5 p-3 rounded-2xl bg-black/75 backdrop-blur-xl border border-white/20 text-white shadow-2xl pointer-events-none transition-all duration-200 a-rise ${
            gestureHud.type === "brightness" ? "left-6" : "right-6"
          }`}
        >
          <div className="w-8 h-8 rounded-full bg-white/15 flex items-center justify-center">
            {gestureHud.type === "brightness" ? (
              <ISun size={18} className="text-amber-400" />
            ) : gestureHud.val === 0 ? (
              <IVolMute size={18} className="text-zinc-400" />
            ) : (
              <IVol size={18} className="text-white" />
            )}
          </div>
          <div className="w-1.5 h-20 rounded-full bg-white/20 overflow-hidden relative flex flex-col justify-end">
            <div
              className="w-full bg-primary rounded-full transition-all duration-75"
              style={{ height: `${gestureHud.val}%` }}
            />
          </div>
          <span className="text-[11px] font-bold tracking-tight">{gestureHud.val}%</span>
        </div>
      )}

      {/* Screen brightness dimming overlay */}
      {active && brightness < 1 && (
        <div
          className="pointer-events-none fixed inset-0 z-[35] transition-opacity duration-100"
          style={{ backgroundColor: "#000", opacity: (1 - brightness) * 0.85 }}
        />
      )}

      {/* Desktop control bar */}
      {isDesktop && (
        <PlayerControls
          paused={paused} duration={duration} buffered={bufferedRef.current} rate={rate}
          clock={playbackClock}
          muted={muted} volume={volume} theater={theater} fullscreen={fullscreen}
          visible={active && !idle}
          seekEnabled={active && !controlsLocked}
          seekKey={playKey}
          nextDisabled={!nextEpObj && index >= videoIds.length - 1}
          nextTitle={nextEpObj ? `${t("player.next_ep")} ${nextEpObj.ep_num}` : `${t("player.next")} ↓`}
          swipeEp={swipeEp}
          onToggleSwipe={() => { setSwipeEp(!swipeEp); toast(swipeEp ? t("player.swipe_ep_off") : t("player.swipe_ep_on")); }}
          onToggle={() => videoRef.current?.toggle()}
          onSeek={(t, source) => { videoRef.current?.seek(t, source); playbackClock.publish(t); }}
          onSeekInteraction={(phase, input, target, pointerTarget) => videoRef.current?.trace(`seek.input.${phase}`, { input, target, pointer_target: pointerTarget })}
          onRate={(r) => { setRate(r); videoRef.current?.rate(r); }}
          onMute={() => setMuted((m) => !m)}
          onVolume={(v) => setVolume(v)}
          onPip={togglePip}
          onLock={lockControls}
          onTheater={() => setTheater((v) => !v)}
          onFullscreen={toggleFull}
          onOpenCaptions={() => setPanel("captions")}
          onNext={() => {
            if (nextEpObj) pickEp(nextEpObj.ep_num);
            else go(1);
          }}
        />
      )}

      {/* Mobile speed HUD / lock indicator */}
      {!isDesktop && (holdSpeed || speedLock || rate !== 1) && (!fs || !idle) && (
        <Button
          onClick={() => {
            if (speedLock) { setSpeedLock(false); toast("Speed lock released", "info"); }
            else if (rate !== 1 && !holdSpeed) setRate(1);
          }}
          className={`absolute left-1/2 -translate-x-1/2 z-30 flex items-center gap-1.5 px-3.5 h-8 rounded-full backdrop-blur-md whitespace-nowrap max-w-[calc(100vw-32px)] text-[12px] font-bold elev-2 pressable ${speedLock ? "bg-primary text-on-primary" : "hg-chip hg-gold"}`}
          style={{ top: rotated ? 56 : "calc(max(var(--sat, 0px), 36px) + 54px)" }}>
          <IBoltF size={13} />
          {effRate}x {speedLock ? "Locked · Tap to unlock" : holdSpeed ? "2.0x · Release to restore" : "Speed"}
        </Button>
      )}
      {!isDesktop && holdSpeed && (
        <div
          className={`absolute left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 px-4 h-10 rounded-xl backdrop-blur-md elev-2 ${lockArmed ? "bg-primary text-on-primary" : "hg-chip-strong hg-ink-2"}`}
          style={{ top: "38%" }}>
          <ILockF size={16} />
          <span className="text-[14px] font-bold">{lockArmed ? "Release to lock 2.0x" : "Swipe up to lock speed"}</span>
        </div>
      )}

      {/* Mobile fullscreen seekbar */}
      {!isDesktop && fs && !idle && (
        <div
          className="absolute inset-x-0 z-30 px-4"
          style={{
            bottom: rotated ? 52 : "calc(var(--sab, 0px) + 52px)",
            paddingLeft: rotated ? "calc(var(--sat, 0px) + 16px)" : undefined,
            paddingRight: rotated ? "calc(var(--sab, 0px) + 16px)" : undefined,
            height: 22,
          }}>
          <div ref={barRef} className="relative h-full" style={{ touchAction: "none" }}
            onPointerDown={onBarDown} onPointerMove={onBarMove} onPointerUp={onBarUp} onPointerCancel={onBarUp}>
            <div className="absolute inset-x-0 bottom-[8px] h-[2.5px] rounded-full" style={{ background: "rgba(255,255,255,.3)" }}>
              <div className="h-full rounded-full bg-white" style={{ width: `${barProgress * 100}%` }} />
            </div>
          </div>
        </div>
      )}

      {/* Mobile immersive layer */}
      {!isDesktop && fs && !idle && (
        <>
          <Button onClick={exitFs} aria-label="Exit Fullscreen"
            className="hg-chip-strong absolute z-40 w-9 h-9 rounded-full backdrop-blur-md flex items-center justify-center pressable elev-1"
            style={{
              top: rotated ? 12 : "calc(var(--sat, 0px) + 6px)",
              right: rotated ? "calc(var(--sab, 0px) + 12px)" : 12,
            }}>
            <ICompress size={18} />
          </Button>
          <div className="absolute inset-x-0 z-40 flex items-center gap-3 px-4"
            style={{
              bottom: rotated ? 10 : "calc(var(--sab, 0px) + 10px)",
              paddingLeft: rotated ? "calc(var(--sat, 0px) + 16px)" : undefined,
              paddingRight: rotated ? "calc(var(--sab, 0px) + 16px)" : undefined,
            }}>
            <Button onClick={() => videoRef.current?.toggle()}
              className="hg-chip shrink-0 w-9 h-9 rounded-full flex items-center justify-center pressable">
              {paused ? <IPlayF size={18} /> : <IPauseF size={17} />}
            </Button>
            <span className="shrink-0 text-[12px] font-semibold hg-ink-2 tabular-nums">{fmtTime(time)}</span>
            <Button
              onClick={() => {
                if (speedLock) { setSpeedLock(false); return; }
                const seq = [1, 1.25, 1.5, 2];
                const i = seq.indexOf(rate);
                setRate(seq[(i + 1) % seq.length]);
              }}
              className={`ml-auto shrink-0 flex items-center gap-1 px-2.5 h-8 rounded-full text-[13px] font-bold pressable ${effRate !== 1 ? "bg-primary text-on-primary" : "hg-chip hg-ink-2"}`}>
              <IBoltF size={12} />{effRate}x
            </Button>
            {nextEpObj && (
              <Button onClick={() => pickEp(nextEpObj.ep_num)}
                className="shrink-0 flex items-center gap-1 px-2.5 h-8 rounded-full text-[13px] font-semibold hg-chip hg-ink-2 pressable"
                aria-label={`${t("player.next_ep")} ${t("player.episode_num", { num: nextEpObj.ep_num })}`}>
                <IVertSwap size={12} />{t("player.next_ep")}
              </Button>
            )}
            <span className="shrink-0 text-[12px] hg-ink-4 tabular-nums">{fmtTime(duration)}</span>
          </div>
        </>
      )}

      {/* Episodes and Comments panels */}
      {isDesktop ? (
        <div className={`desktop-dock-panel ${panel ? "is-open" : ""}`}>
          <div className="desktop-dock-inner">
            {panel === "episodes" ? (
              <EpisodesPanel videoId={curId} episodes={episodes} current={curEp} onPick={pickEp} onClose={() => setPanel(null)} title={formatDramaTitle(meta.title)} cover={posterUrl} />
            ) : panel === "comments" ? (
              <CommentsPanel videoId={curId} ep={curEp} total={meta.comment} kind={kind} onClose={() => setPanel(null)} />
            ) : null}
          </div>
        </div>
      ) : (
        <>
          {/* Comments sheet */}
          <Sheet open={panel === "comments"} onClose={() => setPanel(null)}>
            <div className="flex flex-col" style={{ height: "72vh" }}>
              <CommentsPanel videoId={curId} ep={curEp} total={meta.comment} kind={kind} onClose={() => setPanel(null)} />
            </div>
          </Sheet>

          {/* Article post content */}
          <Sheet open={panel === "article"} onClose={() => setPanel(null)}>
            <div className="flex flex-col" style={{ height: "78vh" }}>
              <ArticlePanel title={meta.title} html={articleHtml} cover={meta.cover} hot={post?.hot} onClose={() => setPanel(null)} />
            </div>
          </Sheet>

          <Sheet open={panel === "detail" || panel === "episodes"} onClose={() => setPanel(null)}>
            <div className="flex flex-col" style={{ height: "72vh" }}>
              {/* Dual drawer: details and episodes */}
              <div className="shrink-0 flex items-center gap-2 px-4 pb-2">
                <SegmentedControl className="flex-1" aria-label="Episode panel" activeIndex={panel === "detail" ? 0 : 1}>
                  {([["detail", t("common.details")], ["episodes", t("player.episodes")]] as const).map(([k, l]) => (
                    <Button aria-pressed={panel === k} key={k} onClick={() => setPanel(k)}>{l}</Button>
                  ))}
                </SegmentedControl>
                <Button onClick={() => setPanel(null)} aria-label={t("common.close")}
                  className="ios-icon-button">
                  <IClose size={14} />
                </Button>
              </div>

              <div className="flex-1 min-h-0">
                {panel === "episodes" ? (
                  <EpisodesPanel bare videoId={curId} episodes={episodes} current={curEp} onPick={pickEp} onClose={() => setPanel(null)} title={formatDramaTitle(meta.title)} cover={posterUrl} />
                ) : (
                  <div className="h-full scroll-y px-4 pb-[calc(var(--sab,0px)+24px)]">
                    {/* Cover / Title / Score / Metrics */}
                    <div className="flex gap-3">
                      <Surface className="relative w-[84px] shrink-0 rounded-(--r-sm) overflow-hidden bg-s3" style={{ aspectRatio: "3 / 4" }}>
                        <Img src={posterUrl || (offlineOnly || (typeof navigator !== "undefined" && navigator.onLine === false) ? "" : meta.cover)} />
                      </Surface>
                      <div className="flex-1 min-w-0">
                        <div className="text-[14px] font-bold text-on leading-snug clamp-2">{formatDramaTitle(meta.title)}</div>
                        <div className="flex items-center gap-2 mt-1.5">
                          {!!meta.score && (
                            <span className="text-[13px] font-bold text-amber flex items-center gap-1">
                              <IStarF size={13} className="text-amber-400" />
                              <span>{meta.score.toFixed(1)}</span>
                            </span>
                          )}
                          {episodes.length > 0 && <span className="text-[12px] text-mut">{t("player.total_episodes", { count: episodes.length })}</span>}
                        </div>
                        <div className="flex gap-3 mt-2 text-[12px] text-mut">
                          <span>{t("profile.likes")} {fmt(meta.like)}</span>
                          <span>{t("profile.favorites")} {fmt(meta.collect)}</span>
                          <span>{t("player.comments")} {fmt(meta.comment)}</span>
                        </div>
                      </div>
                    </div>

                    {/* Creator info and follow button */}
                    <Surface className="mt-4 flex items-center gap-2.5 rounded-(--r-md) bg-s2 p-2.5">
                      <Button
                        onClick={() => meta.authorId > 0 && store.push({ kind: "user", id: meta.authorId, name: meta.author })}
                        className="flex items-center gap-2.5 flex-1 min-w-0 text-left pressable"
                        disabled={meta.authorId <= 0}>
                        <Avatar size={34} src={meta.authorAvatar} name={formatDramaAuthor(meta.author)} hue={220} />
                        <div className="flex-1 min-w-0">
                          <div className="text-[14px] font-semibold text-on truncate">{formatDramaAuthor(meta.author)}</div>
                          <div className="text-[12px] text-mut">Creator</div>
                        </div>
                      </Button>
                      {meta.authorId > 0 && (
                        <Button onClick={onFollow}
                          className={`h-7 px-3 rounded-full text-[12px] font-semibold pressable shrink-0 ${store.follows.includes(meta.authorId) ? "bg-s3 text-mut" : "bg-primary text-on-primary"}`}>
                          {store.follows.includes(meta.authorId) ? t("common.following") : t("common.follow")}
                        </Button>
                      )}
                    </Surface>

                    {/* Related */}
                    {related.length > 0 && (
                      <div className="mt-4">
                        <div className="text-[12px] font-semibold text-dim mb-2">{t("common.recommended")}</div>
                        <div className="scroll-x flex gap-2.5 snap-x">
                          {related.slice(0, 12).map((v) => (
                            <RowCard key={v.id} v={v} onOpen={() => store.push({ kind: "feed", videoIds: related.map((x) => x.id), index: related.findIndex((x) => x.id === v.id), title: "Recommendations" })} />
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Synopsis */}
                    <div className="mt-4">
                      <div className="text-[12px] font-semibold text-dim mb-1.5">{t("common.synopsis")}</div>
                      <p className="text-[12px] leading-relaxed text-mut whitespace-pre-wrap">{formatDramaDesc(meta.desc) || t("common.no_desc")}</p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </Sheet>

          {/* Subtitle settings sheet */}
          <SubtitleSheet
            open={panel === "captions"}
            onClose={() => setPanel(null)}
            mode={store.subtitleMode}
            onModeChange={(m) => {
              store.setSubtitleMode(m);
              toast(t("captions.mode_changed", {
                mode: m === "off" ? t("captions.off") : t("captions.en")
              }), "ok");
            }}
            size={store.subtitleSize}
            onSizeChange={store.setSubtitleSize}
            videoId={curId}
            episode={curEp}
            title={formatDramaTitle(meta?.title)}
            streamUrl={playUrl}
            trackInfo={subtitleTrackInfo}
          />

          {/* More playback options sheet - Warm Classic Light iOS Theme */}
          <Sheet open={panel === "more"} onClose={() => setPanel(null)} label="Playback Options" className="max-h-[85dvh]">
            <div className="flex flex-col w-full overflow-hidden text-on max-h-[85dvh]">
              {/* Fixed Header */}
              <div className="px-4 pt-1.5 pb-2.5 border-b border-border flex items-center justify-between shrink-0 bg-s1">
                <div className="min-w-0 pr-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[16px] font-bold text-on tracking-tight">Playback Options</span>
                    <span className="px-2 py-0.5 rounded-full text-[10.5px] font-bold bg-s3 text-mut border border-border">
                      Ep. {curEp}
                    </span>
                  </div>
                  <p className="text-[11.5px] text-mut truncate mt-0.5 max-w-[280px]">
                    {(() => {
                      const raw = formatDramaTitle(meta.title) || title || "";
                      const cleaned = raw.replace(/^[:,\s\-#]+|[:,\s\-#]+$/g, "").trim();
                      return cleaned && cleaned.length > 1 ? cleaned : `Episode ${curEp} · Drama Series`;
                    })()}
                  </p>
                </div>
                <Button
                  onClick={() => setPanel(null)}
                  className="w-7 h-7 rounded-full bg-s3 hover:bg-s4/20 flex items-center justify-center text-on/70 hover:text-on pressable shrink-0"
                  aria-label={t("common.close")}
                >
                  <IClose size={14} />
                </Button>
              </div>

              {/* Scrollable Content */}
              <div className="flex flex-col max-h-[calc(85dvh-52px)] scroll-y px-4 pt-2 pb-5 gap-2.5">
                {/* 1. Quick Access Action Grid */}
                <div className="grid grid-cols-4 gap-2">
                  <Button
                    type="button"
                    data-card={true}
                    onClick={() => {
                      setPanel("episodes");
                    }}
                    className="flex flex-col items-center justify-center py-2 px-1 rounded-xl bg-s2 hover:bg-s3 border border-border text-center pressable transition-all"
                  >
                    <div className="w-8 h-8 rounded-lg bg-purple-500/15 text-purple-600 dark:text-purple-400 flex items-center justify-center">
                      <IList size={16} />
                    </div>
                    <span className="text-[11px] font-bold text-on mt-1 leading-tight">Episodes</span>
                    <span className="text-[9.5px] text-mut">{episodes.length || 1} eps</span>
                  </Button>

                  <Button
                    type="button"
                    data-card={true}
                    onClick={() => {
                      setPanel(null);
                      setDownloadChoiceOpen(true);
                    }}
                    className="flex flex-col items-center justify-center py-2 px-1 rounded-xl bg-s2 hover:bg-s3 border border-border text-center pressable transition-all"
                  >
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${
                      isDownloaded ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" : isDownloadingCurrent ? "bg-amber-500/20 text-amber-600 dark:text-amber-400" : "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                    }`}>
                      {isDownloaded ? <ICheck size={16} strokeWidth={2.6} /> : isDownloadingCurrent ? <Loader className="w-3.5 h-3.5 spinner" /> : <IDownload size={16} />}
                    </div>
                    <span className="text-[11px] font-bold text-on mt-1 leading-tight">Download</span>
                    <span className="text-[9.5px] text-mut">{isDownloaded ? "Saved" : "Offline"}</span>
                  </Button>

                  <Button
                    type="button"
                    data-card={true}
                    onClick={() => {
                      const next = store.toggleWatchLaterLocal(curId);
                      toast(next ? "Saved to Watch Later" : "Removed from Watch Later", "ok");
                    }}
                    className="flex flex-col items-center justify-center py-2 px-1 rounded-xl bg-s2 hover:bg-s3 border border-border text-center pressable transition-all"
                  >
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${
                      store.isWatchLater(curId) ? "bg-amber-500/20 text-amber-600 dark:text-amber-400" : "bg-s3 text-mut"
                    }`}>
                      <IClock size={16} />
                    </div>
                    <span className="text-[11px] font-bold text-on mt-1 leading-tight">Watch Later</span>
                    <span className="text-[9.5px] text-mut">{store.isWatchLater(curId) ? "Saved" : "Save"}</span>
                  </Button>

                  <Button
                    type="button"
                    data-card={true}
                    onClick={() => {
                      setPanel(null);
                      setClean(true);
                      toast("Clean Screen active (tap video to restore controls)", "info");
                    }}
                    className="flex flex-col items-center justify-center py-2 px-1 rounded-xl bg-s2 hover:bg-s3 border border-border text-center pressable transition-all"
                  >
                    <div className="w-8 h-8 rounded-lg bg-sky-500/15 text-sky-600 dark:text-sky-400 flex items-center justify-center">
                      <IEye size={16} />
                    </div>
                    <span className="text-[11px] font-bold text-on mt-1 leading-tight">Clean View</span>
                    <span className="text-[9.5px] text-mut">Hide UI</span>
                  </Button>
                </div>

                {/* 2. Stream Quality */}
                <div className="flex flex-col gap-1">
                  <div className="flex items-center justify-between">
                    <span className="text-[10.5px] font-bold uppercase tracking-wider text-mut">Stream Quality</span>
                    <span className="text-[10px] text-dim">Auto-reconnects on switch</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      type="button"
                      data-card={true}
                      style={{ borderRadius: 12 }}
                      aria-pressed={preferHevc}
                      onClick={() => {
                        setPreferHevc(true);
                        toast("HD 1080p HEVC enabled", "ok");
                      }}
                      className={`p-2.5 rounded-xl border flex flex-col text-left transition-all pressable ${
                        preferHevc
                          ? "border-amber-500/50 bg-white dark:bg-neutral-800 text-on shadow-xs ring-1 ring-amber-500/30"
                          : "border-border bg-s2 text-on/80 hover:bg-s3"
                      }`}
                    >
                      <div className="flex items-center justify-between w-full">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[13px] font-bold text-on">HD 1080p</span>
                          <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-s3 text-mut">HEVC</span>
                        </div>
                        {preferHevc && (
                          <div className="w-4 h-4 rounded-full bg-amber-500 flex items-center justify-center text-white">
                            <ICheck size={11} strokeWidth={3} />
                          </div>
                        )}
                      </div>
                      <span className="text-[10.5px] text-mut mt-0.5 leading-snug">Ultra clear high definition</span>
                    </Button>

                    <Button
                      type="button"
                      data-card={true}
                      style={{ borderRadius: 12 }}
                      aria-pressed={!preferHevc}
                      onClick={() => {
                        setPreferHevc(false);
                        toast("Standard SD 720p enabled", "ok");
                      }}
                      className={`p-2.5 rounded-xl border flex flex-col text-left transition-all pressable ${
                        !preferHevc
                          ? "border-amber-500/50 bg-white dark:bg-neutral-800 text-on shadow-xs ring-1 ring-amber-500/30"
                          : "border-border bg-s2 text-on/80 hover:bg-s3"
                      }`}
                    >
                      <div className="flex items-center justify-between w-full">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[13px] font-bold text-on">SD 720p</span>
                          <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-s3 text-mut">Saver</span>
                        </div>
                        {!preferHevc && (
                          <div className="w-4 h-4 rounded-full bg-amber-500 flex items-center justify-center text-white">
                            <ICheck size={11} strokeWidth={3} />
                          </div>
                        )}
                      </div>
                      <span className="text-[10.5px] text-mut mt-0.5 leading-snug">Fast load & data saver</span>
                    </Button>
                  </div>
                </div>

                {/* 2b. Streaming Source & CDN Lines (Feature 3) */}
                <div className="flex flex-col gap-1 p-2.5 rounded-xl bg-s2 border border-border">
                  <div className="flex items-center justify-between">
                    <div className="flex flex-col">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[12.5px] font-bold text-on">Streaming Source</span>
                        <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20">
                          4 Lines Active
                        </span>
                      </div>
                      <span className="text-[10px] text-mut mt-0.5">
                        Primary, Fast CDN & Backup lines with live ping test
                      </span>
                    </div>
                    <Button
                      type="button"
                      data-card={true}
                      onClick={() => {
                        setPanel(null);
                        setLineOpen(true);
                      }}
                      className="px-2.5 py-1.5 rounded-lg bg-white dark:bg-neutral-800 border border-border text-[11.5px] font-bold text-on shadow-xs hover:bg-s3 pressable flex items-center gap-1"
                    >
                      <span>Switch Line</span>
                      <IChevR size={12} className="text-mut" />
                    </Button>
                  </div>
                </div>

                {/* 3. Subtitles & Captions */}
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-bold uppercase tracking-wider text-mut">Subtitles & Captions</span>
                    <Button
                      onClick={() => setPanel("captions")}
                      className="text-[11.5px] text-primary hover:underline font-bold pressable flex items-center gap-0.5"
                    >
                      <span>Customize Styles</span>
                      <IChevR size={12} />
                    </Button>
                  </div>
                  <div className="grid grid-cols-2 gap-1.5 bg-s3 p-1 rounded-xl border border-border">
                    <button
                      type="button"
                      onClick={() => {
                        store.setSubtitleMode("en");
                        toast(subtitleTrackInfo.hasTrack ? "Captions: On" : "Captions enabled (load .SRT/.VTT in Customize)", "ok");
                      }}
                      className={`py-2 rounded-lg text-[13px] font-bold flex items-center justify-center gap-2 transition-all ${
                        store.subtitleMode === "en"
                          ? "bg-white dark:bg-neutral-800 text-on shadow-xs border border-black/5 dark:border-white/15"
                          : "text-mut hover:text-on"
                      }`}
                    >
                      <ICaptions size={15} />
                      <span>Captions On</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        store.setSubtitleMode("off");
                        toast("Subtitles: Off", "ok");
                      }}
                      className={`py-2 rounded-lg text-[13px] font-bold flex items-center justify-center gap-2 transition-all ${
                        store.subtitleMode === "off"
                          ? "bg-white dark:bg-neutral-800 text-on shadow-xs border border-black/5 dark:border-white/15"
                          : "text-mut hover:text-on"
                      }`}
                    >
                      <span>Off</span>
                    </button>
                  </div>
                </div>

                {/* 4. Playback Speed */}
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-bold uppercase tracking-wider text-mut">Playback Speed</span>
                    <span className="text-[12px] font-bold text-primary tabular-nums">{rate}x</span>
                  </div>
                  <div className="grid grid-cols-5 gap-1 bg-s3 p-1 rounded-xl border border-border">
                    {[0.75, 1, 1.25, 1.5, 2].map((r) => (
                      <button
                        key={r}
                        type="button"
                        onClick={() => {
                          setRate(r);
                          videoRef.current?.rate(r);
                          toast(`Playback Speed: ${r}x`, "info");
                        }}
                        className={`py-1.5 rounded-lg text-center text-[12.5px] font-bold transition-all ${
                          rate === r
                            ? "bg-white dark:bg-neutral-800 text-on shadow-xs border border-black/5 dark:border-white/15"
                            : "text-mut hover:text-on hover:bg-s4/10"
                        }`}
                      >
                        {r === 1 ? "1.0x" : `${r}x`}
                      </button>
                    ))}
                  </div>
                </div>

                {/* 5. Sleep Timer */}
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-bold uppercase tracking-wider text-mut">Sleep Timer</span>
                    {sleepTimer !== "off" && (
                      <span className="text-[11px] font-bold text-emerald-600 dark:text-emerald-400">
                        Active ({sleepTimer === "episode_end" ? "End Ep" : `${sleepTimer}m`})
                      </span>
                    )}
                  </div>
                  <div className="grid grid-cols-5 gap-1 bg-s3 p-1 rounded-xl border border-border">
                    {[
                      ["off", "Off"],
                      ["15", "15m"],
                      ["30", "30m"],
                      ["45", "45m"],
                      ["episode_end", "End Ep"],
                    ].map(([val, label]) => (
                      <button
                        key={val}
                        type="button"
                        onClick={() => {
                          setSleepTimer(val as SleepTimerOption, () => {
                            videoRef.current?.pause();
                            setPaused(true);
                          });
                          setLocalSleepTimer(val as SleepTimerOption);
                          toast(val === "off" ? "Sleep timer disabled" : `Sleep timer set to ${label}`, "ok");
                        }}
                        className={`py-1.5 rounded-lg text-center text-[12px] font-bold transition-all ${
                          sleepTimer === val
                            ? "bg-white dark:bg-neutral-800 text-on shadow-xs border border-black/5 dark:border-white/15"
                            : "text-mut hover:text-on hover:bg-s4/10"
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* 6. Auto-Skip Intro */}
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-bold uppercase tracking-wider text-mut">Auto-Skip Intro</span>
                    <span className="text-[10.5px] text-dim">Bypass intro at start</span>
                  </div>
                  <div className="grid grid-cols-3 gap-1.5 bg-s3 p-1 rounded-xl border border-border">
                    {[
                      [0, "Off"],
                      [5, "5s"],
                      [10, "10s"],
                    ].map(([val, label]) => {
                      const sec = Number(val);
                      return (
                        <button
                          key={String(val)}
                          type="button"
                          onClick={() => {
                            setAutoSkipIntroSec(sec);
                            setAutoSkipSecState(sec);
                            toast(sec === 0 ? "Auto-skip intro disabled" : `Auto-skip intro set to ${label}`, "ok");
                          }}
                          className={`py-1.5 rounded-lg text-center text-[12px] font-bold transition-all ${
                            autoSkipSec === sec
                              ? "bg-white dark:bg-neutral-800 text-on shadow-xs border border-black/5 dark:border-white/15"
                              : "text-mut hover:text-on hover:bg-s4/10"
                          }`}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* 7. Vertical Swipe Switch */}
                <div className="flex flex-col gap-1.5">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-mut">Gestures & Navigation</span>
                  <div
                    style={{ borderRadius: 14 }}
                    className="p-3.5 rounded-[14px] border border-border bg-s2 flex items-center justify-between"
                  >
                    <div className="pr-3">
                      <div className="text-[13px] font-bold text-on">Vertical Swipe Switch</div>
                      <div className="text-[11px] text-mut leading-tight mt-0.5">
                        Swipe up / down on video to seamlessly jump episodes
                      </div>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={swipeEp}
                      aria-label="Vertical Swipe Switch"
                      onClick={() => {
                        setSwipeEp(!swipeEp);
                        toast(swipeEp ? t("player.swipe_ep_off") : t("player.swipe_ep_on"));
                      }}
                      className={`relative inline-flex h-7 w-12 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                        swipeEp ? "bg-emerald-500" : "bg-s4"
                      }`}
                    >
                      <span
                        aria-hidden="true"
                        className={`pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow-md ring-0 transition duration-200 ease-in-out ${
                          swipeEp ? "translate-x-5" : "translate-x-0"
                        }`}
                      />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </Sheet>
        </>
      )}
      </div>
      {!isDesktop && !controlsLocked && active && (!fs || !idle) && !clean && !panel && (
        <div className={`absolute z-40 flex items-center gap-1.5 ${fs ? "" : "right-3"}`}
          style={{
            top: rotated ? 12 : "calc(max(var(--sat, 0px), 36px) + 8px)",
            right: fs ? (rotated ? "calc(var(--sab, 0px) + 56px)" : 56) : undefined,
          }}>
          {!fs && !clean && (
            <Button
              onClick={() => {
                if (!subtitleTrackInfo.hasTrack) {
                  setPanel("captions");
                  return;
                }
                if (store.subtitleMode === "off") {
                  store.setSubtitleMode("en");
                  toast("Captions enabled (Tap again to customize)", "info");
                } else {
                  setPanel("captions");
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setPanel("captions");
              }}
              aria-label={t("captions.title")}
              title={subtitleTrackInfo.hasTrack ? "Closed Captions (Tap to customize)" : "Closed Captions (Tap for AI / .SRT / Live Caption)"}
              className={`hg-chip w-9 h-9 rounded-full flex items-center justify-center relative pressable elev-1 ${
                store.subtitleMode === "en" && subtitleTrackInfo.hasTrack
                  ? "text-white bg-black/60 border border-white/20"
                  : "text-white/80"
              }`}
            >
              <ICaptions size={17} />
              {store.subtitleMode === "en" && subtitleTrackInfo.hasTrack && (
                <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-emerald-400 ring-1 ring-black/40" />
              )}
            </Button>
          )}
          {!fs && !clean && <Button onClick={() => setMuted(m => !m)} aria-label={muted ? "Unmute" : "Mute"}
            className="hg-chip w-9 h-9 rounded-full flex items-center justify-center pressable elev-1">
            {muted ? <IVolMute size={17} /> : <IVol size={17} />}
          </Button>}
          <Button onClick={lockControls} aria-label="Lock controls" title="Lock controls" aria-pressed={false}
            className="hg-chip w-9 h-9 rounded-full flex items-center justify-center pressable elev-1"><ILockF size={17} /></Button>
          {!fs && !clean && (
            <Button onClick={() => enterFs(isLandscapeCurrent())} aria-label={t("player.fullscreen")}
              className="hg-chip w-9 h-9 rounded-full flex items-center justify-center pressable elev-1">
              <IExpand size={16} />
            </Button>
          )}
        </div>
      )}
      {(() => {
        const resolvedTotalEpisodes = Math.max(
          episodes.length,
          detail?.episodes?.length || 0,
          detail?.episode_count || 0,
          detail?.total_episodes || 0,
          cards[curId]?.episode_count || 0,
          cards[curId]?.total_episodes || 0,
          historyItem?.episode_count || 0,
          meta.episodes?.length || 0,
          1
        );
        const resolvedEpisodeNumbers = episodes.length >= resolvedTotalEpisodes
          ? episodes.map((e) => e.ep_num)
          : Array.from({ length: resolvedTotalEpisodes }, (_, idx) => idx + 1);
        return (
          <>
      <DownloadChoiceSheet
        isOpen={downloadChoiceOpen}
        onClose={() => setDownloadChoiceOpen(false)}
        videoId={curId}
        currentEpisode={curEp}
        totalEpisodes={resolvedTotalEpisodes}
        title={formatDramaTitle(meta?.title) || formatDramaTitle(detail?.title) || formatDramaTitle(title) || `Series #${curId}`}
        coverUrl={meta.cover || ""}
        isDownloaded={isDownloaded}
        isDownloading={Boolean(isDownloadingCurrent)}
        downloadProgress={currentDownload?.progress || 0}
        onStartSingleDownload={async (targetEp?: number) => {
          const epToDownload = targetEp || curEp;
          let url = epToDownload === curEp ? playUrl : "";
          let prefQuality = getDownloadQualityPreference();
          let isHevc = false;
          try {
            const info = await api.play(curId, epToDownload);
            const resolved = resolveStreamUrlForQuality(info, prefQuality);
            if (resolved?.url) {
              url = resolved.url;
              prefQuality = resolved.quality;
              isHevc = resolved.isHevc;
            } else if (info?.video_url) {
              url = info.video_url;
            }
          } catch {
            // only fall back to playUrl when targeting current episode
          }
          if (!url) {
            toast(epToDownload === curEp ? "Waiting for stream URL..." : "Could not resolve stream URL for selected episode", "info");
            return;
          }
          toast(`Downloading Ep. ${epToDownload} in background...`, "info");
          try {
            await startEpisodeDownload(
              curId,
              epToDownload,
              formatDramaTitle(meta?.title) || formatDramaTitle(detail?.title) || formatDramaTitle(title) || `Drama #${curId}`,
              meta.cover || "",
              url,
              false,
              prefQuality,
              isHevc
            );
          } catch (e) {
            toast((e as Error).message || "Download failed", "info");
          }
        }}
        onOpenBatchDownload={() => {
          setBatchPreselectAll(true);
          setBatchDownloadOpen(true);
        }}
        onOpenExport={(targetEp?: number) => {
          setTargetExportEpisode(targetEp || curEp);
          setExportModalOpen(true);
        }}
      />
      <ExportSheet
        isOpen={exportModalOpen}
        onClose={() => {
          setExportModalOpen(false);
          setTargetExportEpisode(null);
        }}
        videoId={curId}
        episode={targetExportEpisode || curEp}
        title={formatDramaTitle(meta?.title) || formatDramaTitle(detail?.title) || formatDramaTitle(title) || `Series #${curId}`}
      />
      <BatchDownloadSheet
        isOpen={batchDownloadOpen}
        onClose={() => {
          setBatchDownloadOpen(false);
          setBatchPreselectAll(false);
        }}
        videoId={curId}
        title={formatDramaTitle(meta?.title) || formatDramaTitle(detail?.title) || formatDramaTitle(title) || `Series #${curId}`}
        cover={meta.cover || ""}
        totalEpisodes={resolvedTotalEpisodes}
        episodeNumbers={resolvedEpisodeNumbers}
        preselectAll={batchPreselectAll}
      />
          </>
        );
      })()}
      <LinePicker open={lineOpen} onClose={() => setLineOpen(false)} />
      {controlsLocked && <PlaybackLock active={active} onUnlock={() => { setControlsLocked(false); wake(); }} />}
    </div>
  );
}
