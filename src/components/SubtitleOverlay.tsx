import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type {
  SubtitleCue,
  SubtitleMode,
  SubtitleSize,
  SubtitleStyleConfig,
  SubtitleTrack,
  SubtitleTrackStatus,
} from "../subtitles/types";
import { getSubtitlesForEpisode, getSubtitleStyleConfig } from "../subtitles/aiSubtitleService";
import type { PlaybackClock } from "../playbackClock";
import { formatBalancedCaptionLines, normalizeCueText } from "../subtitles/vttParser";
import {
  containsForeignLanguage,
  translateCuesToEnglish,
  translateDialogueSync,
  translateDialogueToEnglish,
} from "../subtitles/translator";

type Props = {
  videoId: number;
  episode: number;
  title?: string;
  streamUrl?: string;
  mode: SubtitleMode;
  size?: SubtitleSize;
  time?: number;
  playbackClock?: PlaybackClock;
  isDesktop?: boolean;
  clean?: boolean;
  fs?: boolean;
  bottomOffset?: number;
  videoEl?: HTMLVideoElement | null;
  onTrackStatus?: (info: SubtitleTrackStatus) => void;
};

export default function SubtitleOverlay({
  videoId,
  episode,
  title,
  streamUrl,
  mode,
  size = "md",
  time: propTime,
  playbackClock,
  isDesktop = false,
  clean = false,
  fs = false,
  bottomOffset,
  videoEl,
  onTrackStatus,
}: Props) {
  const [cues, setCues] = useState<SubtitleCue[]>([]);
  const [trackSource, setTrackSource] = useState<SubtitleTrack["source"]>("none");
  const [trackFileName, setTrackFileName] = useState<string | undefined>(undefined);
  const [nativeCues, setNativeCues] = useState<SubtitleCue[]>([]);
  const [liveTranslated, setLiveTranslated] = useState<Record<string, string>>({});
  const [styleConfig, setStyleConfig] = useState<SubtitleStyleConfig>(() => getSubtitleStyleConfig());
  const [videoFrameBottom, setVideoFrameBottom] = useState<number | null>(null);
  const prevEpisodeKeyRef = useRef<string>("");
  const trackSourceRef = useRef<SubtitleTrack["source"]>(trackSource);
  trackSourceRef.current = trackSource;
  const onTrackStatusRef = useRef(onTrackStatus);
  onTrackStatusRef.current = onTrackStatus;

  // Listen to live style updates from Settings & SubtitleSheet
  useEffect(() => {
    const onStyleChange = (e: Event) => {
      const customEvent = e as CustomEvent<SubtitleStyleConfig>;
      if (customEvent.detail) {
        setStyleConfig(customEvent.detail);
      } else {
        setStyleConfig(getSubtitleStyleConfig());
      }
    };
    window.addEventListener("aurastream:subtitlestyle-changed", onStyleChange);
    return () => window.removeEventListener("aurastream:subtitlestyle-changed", onStyleChange);
  }, []);

  // Frame-accurate video rect calculation for letterboxed / aspect-ratio playback
  useEffect(() => {
    if (!videoEl) {
      setVideoFrameBottom(null);
      return;
    }
    const calculateBounds = () => {
      try {
        const rect = videoEl.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && videoEl.videoWidth > 0 && videoEl.videoHeight > 0) {
          const videoRatio = videoEl.videoWidth / videoEl.videoHeight;
          const containerRatio = rect.width / rect.height;
          if (videoRatio > containerRatio) {
            const actualRenderedHeight = rect.width / videoRatio;
            const actualBottom = rect.top + (rect.height + actualRenderedHeight) / 2;
            const offsetFromBottom = window.innerHeight - actualBottom + 16;
            setVideoFrameBottom(Math.max(16, Math.round(offsetFromBottom)));
            return;
          }
        }
      } catch {
        // ignore
      }
      setVideoFrameBottom(null);
    };

    calculateBounds();
    window.addEventListener("resize", calculateBounds);
    videoEl.addEventListener("loadedmetadata", calculateBounds);
    videoEl.addEventListener("resize", calculateBounds);
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(calculateBounds);
      ro.observe(videoEl);
      if (videoEl.parentElement) ro.observe(videoEl.parentElement);
    }
    return () => {
      window.removeEventListener("resize", calculateBounds);
      videoEl.removeEventListener("loadedmetadata", calculateBounds);
      videoEl.removeEventListener("resize", calculateBounds);
      ro?.disconnect();
    };
  }, [videoEl, videoEl?.videoWidth, videoEl?.videoHeight]);

  // Load real subtitles when videoId, episode, or streamUrl changes
  useEffect(() => {
    let canceled = false;
    const episodeKey = `${videoId}:${episode}`;
    if (prevEpisodeKeyRef.current !== episodeKey) {
      prevEpisodeKeyRef.current = episodeKey;
      setCues([]);
      setTrackSource("none");
      setTrackFileName(undefined);
    }

    getSubtitlesForEpisode(videoId, episode, title, undefined, streamUrl)
      .then((track) => {
        if (canceled) return;
        setCues(track?.cues || []);
        setTrackSource(track?.cues?.length ? track.source : "none");
        setTrackFileName(track?.fileName);
      })
      .catch(() => {
        if (canceled) return;
        setCues([]);
        setTrackSource("none");
        setTrackFileName(undefined);
      });

    return () => {
      canceled = true;
    };
  }, [videoId, episode, title, streamUrl]);

  // Listen for immediate imports / AI transcription / removals / cache clears for this episode
  useEffect(() => {
    const onTrackUpdated = (e: Event) => {
      const detail = (e as CustomEvent<{ videoId?: number; episode?: number; track?: SubtitleTrack }>).detail;
      if (!detail || detail.videoId !== videoId || detail.episode !== episode || !detail.track) return;
      const nextTrack = detail.track;
      setCues(nextTrack.cues || []);
      setTrackSource(nextTrack.cues?.length ? nextTrack.source : "none");
      setTrackFileName(nextTrack.fileName);
    };
    const onCacheCleared = () => {
      if (trackSourceRef.current === "local_import" || trackSourceRef.current === "native_track") return;
      setCues([]);
      setTrackSource("none");
      setTrackFileName(undefined);
    };
    window.addEventListener("aurastream:subtitle-track-updated", onTrackUpdated);
    window.addEventListener("aurastream:subtitle-cache-cleared", onCacheCleared);
    return () => {
      window.removeEventListener("aurastream:subtitle-track-updated", onTrackUpdated);
      window.removeEventListener("aurastream:subtitle-cache-cleared", onCacheCleared);
    };
  }, [videoId, episode]);

  // Native HTMLMediaElement TextTracks listener (embedded HLS / WebVTT tracks)
  useEffect(() => {
    if (!videoEl || !videoEl.textTracks) {
      setNativeCues([]);
      return;
    }

    const trackList = videoEl.textTracks;
    let activeTrack: TextTrack | null = null;

    const readNativeCues = () => {
      const tracks = Array.from(trackList);
      const chosen =
        tracks.find((tr) => (tr.kind === "subtitles" || tr.kind === "captions") && /^en/i.test(tr.language || "")) ||
        tracks.find((tr) => tr.kind === "subtitles" || tr.kind === "captions") ||
        null;

      if (!chosen) {
        setNativeCues([]);
        return;
      }

      // Keep mode as "hidden" so cues remain loaded and track availability stays accurate even when CC UI is off
      if (chosen.mode !== "hidden") {
        try {
          chosen.mode = "hidden";
        } catch {
          // ignore read-only textTrack mode
        }
      }

      if (activeTrack !== chosen) {
        if (activeTrack) activeTrack.removeEventListener("cuechange", readNativeCues);
        activeTrack = chosen;
        chosen.addEventListener("cuechange", readNativeCues);
      }

      const cueList = chosen.cues ? Array.from(chosen.cues) : [];
      const extracted: SubtitleCue[] = [];
      let idx = 1;
      for (const c of cueList) {
        const text = normalizeCueText(((c as VTTCue).text || "").replace(/\{[^}]*\}/g, "").replace(/<[^>]+>/g, ""));
        if (!text) continue;
        extracted.push({
          id: idx++,
          start: c.startTime,
          end: c.endTime > c.startTime ? c.endTime : c.startTime + 1.0,
          en: text,
          zh: text,
        });
      }
      setNativeCues(extracted);
      if (extracted.some((c) => containsForeignLanguage(c.en))) {
        translateCuesToEnglish(extracted)
          .then((translated) => setNativeCues(translated))
          .catch(() => {});
      }
    };

    readNativeCues();
    trackList.addEventListener("addtrack", readNativeCues);
    trackList.addEventListener("change", readNativeCues);
    return () => {
      trackList.removeEventListener("addtrack", readNativeCues);
      trackList.removeEventListener("change", readNativeCues);
      if (activeTrack) {
        activeTrack.removeEventListener("cuechange", readNativeCues);
      }
    };
  }, [videoEl]);

  const effectiveCues = cues.length > 0 ? cues : nativeCues;
  const effectiveSource: SubtitleTrack["source"] =
    cues.length > 0 ? trackSource : nativeCues.length > 0 ? "native_track" : "none";
  const shouldTrackTime = mode !== "off" && effectiveCues.length > 0 && effectiveSource !== "none";

  // Subscribe to playbackClock only when captions are active and a track exists
  const clockTime = useSyncExternalStore(
    (shouldTrackTime ? playbackClock?.subscribe : undefined) ?? (() => () => {}),
    playbackClock?.getSnapshot ?? (() => 0),
  );

  // Direct video element time listener for sub-frame subtitle sync (only attached when active)
  const [videoTime, setVideoTime] = useState<number>(() => (videoEl ? videoEl.currentTime : 0));
  useEffect(() => {
    if (!videoEl || !shouldTrackTime) {
      setVideoTime(0);
      return;
    }
    const onTime = () => setVideoTime(videoEl.currentTime);
    setVideoTime(videoEl.currentTime);
    videoEl.addEventListener("timeupdate", onTime);
    videoEl.addEventListener("seeking", onTime);
    videoEl.addEventListener("seeked", onTime);
    videoEl.addEventListener("play", onTime);
    return () => {
      videoEl.removeEventListener("timeupdate", onTime);
      videoEl.removeEventListener("seeking", onTime);
      videoEl.removeEventListener("seeked", onTime);
      videoEl.removeEventListener("play", onTime);
    };
  }, [videoEl, shouldTrackTime]);

  // Inform Feed / SubtitleSheet of genuine track availability
  useEffect(() => {
    onTrackStatusRef.current?.({
      hasTrack: effectiveCues.length > 0 && effectiveSource !== "none",
      source: effectiveSource,
      cueCount: effectiveCues.length,
      fileName: cues.length > 0 ? trackFileName : undefined,
    });
  }, [effectiveCues.length, effectiveSource, trackFileName]);

  const rawTime = videoEl ? videoTime : (playbackClock ? clockTime : (propTime ?? 0));
  const currentTime = Math.max(0, rawTime + (styleConfig.offsetSec || 0));

  // Find active cue
  const activeCue = shouldTrackTime
    ? effectiveCues.find((c) => currentTime >= c.start && currentTime <= c.end)
    : undefined;

  if (!shouldTrackTime) {
    return null;
  }

  let rawEnglish = activeCue ? normalizeCueText(activeCue.en || activeCue.zh) : "";
  if (rawEnglish && containsForeignLanguage(rawEnglish)) {
    if (liveTranslated[rawEnglish]) {
      rawEnglish = liveTranslated[rawEnglish];
    } else {
      const syncTr = translateDialogueSync(rawEnglish);
      if (syncTr && !containsForeignLanguage(syncTr)) {
        rawEnglish = syncTr;
      }
      translateDialogueToEnglish(rawEnglish)
        .then((res) => {
          if (res && res !== rawEnglish && !containsForeignLanguage(res)) {
            setLiveTranslated((prev) => ({ ...prev, [rawEnglish]: res }));
          }
        })
        .catch(() => {});
    }
  }
  const balancedCaption = rawEnglish ? formatBalancedCaptionLines(rawEnglish, 42) : "";
  const isVisible = Boolean(activeCue && balancedCaption);

  // Professional Netflix / YouTube / Viki mobile caption typography
  const sizeConfig = {
    sm: {
      primary: "text-[13px] sm:text-[14px]",
      padding: "px-2.5 py-1",
    },
    md: {
      primary: "text-[15px] sm:text-[16px]",
      padding: "px-3 py-1",
    },
    lg: {
      primary: "text-[17px] sm:text-[18.5px]",
      padding: "px-3.5 py-1.5",
    },
    xl: {
      primary: "text-[20px] sm:text-[22px]",
      padding: "px-4 py-1.5",
    },
  }[size] || {
    primary: "text-[15px] sm:text-[16px]",
    padding: "px-3 py-1",
  };

  const colorMap = {
    white: "#FFFFFF",
    yellow: "#FFE600",
    cyan: "#00E5FF",
    green: "#76FF03",
  };
  const primaryTextColor = colorMap[styleConfig.color] || "#FFFFFF";

  const edgeShadowMap = {
    drop_shadow: "0 1px 3px rgba(0,0,0,0.95), 0 0 2px rgba(0,0,0,0.9)",
    raised: "1px 1px 0px #000, 0 1px 2px rgba(0,0,0,0.85)",
    depressed: "-1px -1px 0px #000, 0 1px 2px rgba(0,0,0,0.85)",
    uniform: "-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, 0 1px 3px rgba(0,0,0,0.8)",
    none: "none",
  };
  const textShadow = edgeShadowMap[styleConfig.edgeStyle] || edgeShadowMap.drop_shadow;

  const fontMap = {
    sans: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    rounded: '"SF Pro Rounded", ui-rounded, sans-serif',
    serif: 'Georgia, Cambria, "Times New Roman", Times, serif',
    mono: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  };
  const fontFamily = fontMap[styleConfig.font] || fontMap.sans;

  let backgroundColor = `rgba(10, 10, 12, ${(styleConfig.bgOpacity ?? 75) / 100})`;
  if (styleConfig.bgStyle === "solid") backgroundColor = "#000000";
  if (styleConfig.bgStyle === "none") backgroundColor = "transparent";

  const position = styleConfig.position || "bottom";
  let positionStyle: React.CSSProperties = {};

  if (position === "custom" && typeof styleConfig.customOffsetPercent === "number") {
    const pct = Math.max(5, Math.min(92, styleConfig.customOffsetPercent));
    positionStyle = {
      bottom: `min(calc(var(--sab, 16px) + ${pct}%), calc(100% - max(var(--sat, 36px), 36px) - 72px))`,
    };
  } else if (position === "middle") {
    positionStyle = {
      top: "50%",
      bottom: "auto",
      transform: "translateY(-50%)",
    };
  } else if (position === "top") {
    positionStyle = {
      top: isDesktop ? "64px" : "calc(max(var(--sat, 12px), 28px) + 56px)",
      bottom: "auto",
    };
  } else if (position === "above_title") {
    positionStyle = {
      bottom: isDesktop
        ? "84px"
        : `calc(var(--sab, 48px) + ${(bottomOffset !== undefined ? bottomOffset : 124) + 148}px)`,
    };
  } else {
    if (isDesktop) {
      positionStyle = { bottom: "56px" };
    } else if (clean || fs) {
      positionStyle = {
        bottom: videoFrameBottom !== null
          ? `calc(max(var(--sab, 24px), ${videoFrameBottom}px) + 18px)`
          : "calc(var(--sab, 24px) + 28px)",
      };
    } else {
      const baseOffset = bottomOffset !== undefined ? bottomOffset : 54;
      const minClearance = `calc(var(--sab, 48px) + ${baseOffset + 148}px)`;
      positionStyle = {
        bottom: videoFrameBottom !== null
          ? `max(${videoFrameBottom}px, ${minClearance})`
          : minClearance,
      };
    }
  }

  const commonStyle: React.CSSProperties = {
    backgroundColor,
    textShadow,
    fontFamily,
    boxDecorationBreak: "clone",
    WebkitBoxDecorationBreak: "clone",
    lineHeight: "1.38",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    textWrap: "balance",
  };

  const isRightRailVisible = !clean && !fs && !isDesktop;

  return (
    <div
      className={`absolute left-0 right-0 z-20 pointer-events-none flex flex-col items-center transition-all duration-150 ${
        isRightRailVisible ? "pr-14 pl-4" : "px-4"
      }`}
      style={positionStyle}
      aria-live="polite"
    >
      <div
        className={`flex flex-col items-center text-center ${
          isRightRailVisible ? "max-w-[80%] sm:max-w-[74%]" : "max-w-[90%] sm:max-w-[76%]"
        } gap-1 select-none transition-opacity duration-150 ease-out ${
          isVisible ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
      >
        <span
          className={`inline-block font-semibold tracking-normal rounded-md shadow-[0_2px_8px_rgba(0,0,0,0.75)] ${sizeConfig.primary} ${sizeConfig.padding}`}
          style={{
            ...commonStyle,
            color: primaryTextColor,
          }}
        >
          {balancedCaption}
        </span>
      </div>
    </div>
  );
}
