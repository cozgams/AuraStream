import React, { useEffect, useState, useSyncExternalStore } from "react";
import type { SubtitleCue, SubtitleMode, SubtitleSize, SubtitleStyleConfig } from "../subtitles/types";
import { getSubtitlesForEpisode, getSubtitleStyleConfig } from "../subtitles/aiSubtitleService";
import type { PlaybackClock } from "../playbackClock";
import { formatSubtitleText } from "../subtitles/dramaTranslator";
import { speakActiveCue, cancelVoiceDub, isVoiceDubEnabled } from "../subtitles/voiceDubService";

type Props = {
  videoId: number;
  episode: number;
  title?: string;
  mode: SubtitleMode;
  size?: SubtitleSize;
  time?: number;
  playbackClock?: PlaybackClock;
  isDesktop?: boolean;
  clean?: boolean;
  fs?: boolean;
  bottomOffset?: number;
  videoEl?: HTMLVideoElement | null;
};

export default function SubtitleOverlay({
  videoId,
  episode,
  title,
  mode,
  size = "md",
  time: propTime,
  playbackClock,
  isDesktop = false,
  clean = false,
  fs = false,
  bottomOffset,
  videoEl,
}: Props) {
  const [cues, setCues] = useState<SubtitleCue[]>([]);
  const [styleConfig, setStyleConfig] = useState<SubtitleStyleConfig>(() => getSubtitleStyleConfig());
  const [videoFrameBottom, setVideoFrameBottom] = useState<number | null>(null);

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
    if (!videoEl) return;
    const calculateBounds = () => {
      try {
        const rect = videoEl.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && videoEl.videoWidth > 0 && videoEl.videoHeight > 0) {
          const videoRatio = videoEl.videoWidth / videoEl.videoHeight;
          const containerRatio = rect.width / rect.height;
          // Letterboxed video (horizontal video on vertical phone screen)
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
    return () => {
      window.removeEventListener("resize", calculateBounds);
      videoEl?.removeEventListener("loadedmetadata", calculateBounds);
    };
  }, [videoEl, videoEl?.videoWidth, videoEl?.videoHeight]);

  // Subscribe to playbackClock if provided, otherwise fallback to propTime
  const clockTime = useSyncExternalStore(
    playbackClock?.subscribe ?? (() => () => {}),
    playbackClock?.getSnapshot ?? (() => 0),
  );

  // Direct video element time listener for sub-frame subtitle sync
  const [videoTime, setVideoTime] = useState<number>(() => (videoEl ? videoEl.currentTime : 0));
  useEffect(() => {
    if (!videoEl) return;
    const onTime = () => setVideoTime(videoEl.currentTime);
    setVideoTime(videoEl.currentTime);
    videoEl.addEventListener("timeupdate", onTime);
    videoEl.addEventListener("seeking", onTime);
    videoEl.addEventListener("seeked", onTime);
    videoEl.addEventListener("play", onTime);
    videoEl.addEventListener("pause", onTime);
    return () => {
      videoEl.removeEventListener("timeupdate", onTime);
      videoEl.removeEventListener("seeking", onTime);
      videoEl.removeEventListener("seeked", onTime);
      videoEl.removeEventListener("play", onTime);
      videoEl.removeEventListener("pause", onTime);
    };
  }, [videoEl]);

  const currentTime = videoEl ? videoTime : (playbackClock ? clockTime : (propTime ?? 0));

  // Load subtitles when videoId or episode changes
  useEffect(() => {
    let canceled = false;
    getSubtitlesForEpisode(videoId, episode, title).then((track) => {
      if (!canceled) {
        setCues(track.cues);
      }
    });
    return () => {
      canceled = true;
    };
  }, [videoId, episode, title]);

  // Find active cue
  const activeCue = cues.find((c) => currentTime >= c.start && currentTime <= c.end);

  // Synchronized Voice Dubbing Prototype
  useEffect(() => {
    if (activeCue) {
      speakActiveCue(activeCue, videoEl);
    }
  }, [activeCue?.id, videoEl]);

  useEffect(() => {
    return () => {
      cancelVoiceDub(videoEl);
    };
  }, [videoEl]);

  if ((mode === "off" && !isVoiceDubEnabled()) || !cues.length) {
    return null;
  }

  // English-only captions per user requirement
  const englishText = activeCue ? formatSubtitleText(activeCue.en || activeCue.zh) : "";
  const isVisible = Boolean(activeCue && englishText && mode !== "off");

  // Authentic YouTube Caption Typography & Sizing (Small, Clean, Legible)
  const sizeConfig = {
    sm: {
      primary: "text-[10px] sm:text-[10.5px]",
      secondary: "text-[8px] sm:text-[8.5px]",
      padding: "px-1.5 py-[2px]",
    },
    md: {
      primary: "text-[11px] sm:text-[11.5px]",
      secondary: "text-[8.5px] sm:text-[9px]",
      padding: "px-2 py-[2.5px]",
    },
    lg: {
      primary: "text-[12px] sm:text-[12.5px]",
      secondary: "text-[9px] sm:text-[9.5px]",
      padding: "px-2.5 py-[3px]",
    },
    xl: {
      primary: "text-[13px] sm:text-[13.5px]",
      secondary: "text-[10px] sm:text-[10.5px]",
      padding: "px-3 py-1",
    },
  }[size] || {
    primary: "text-[11px] sm:text-[11.5px]",
    secondary: "text-[8.5px] sm:text-[9px]",
    padding: "px-2 py-[2.5px]",
  };

  // Color Mapping - Defaults to YouTube Crisp White
  const colorMap = {
    white: "#FFFFFF", // Clean YouTube White
    yellow: "#FFE600",
    cyan: "#00E5FF",
    green: "#76FF03",
  };
  const primaryTextColor = colorMap[styleConfig.color] || "#FFFFFF";

  // Edge Shadow
  const edgeShadowMap = {
    drop_shadow: "0 1px 2px rgba(0,0,0,0.9), 0 0 1px #000",
    raised: "1px 1px 0px #000",
    depressed: "-1px -1px 0px #000",
    uniform: "-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000",
    none: "none",
  };
  const textShadow = edgeShadowMap[styleConfig.edgeStyle] || edgeShadowMap.drop_shadow;

  // Font Family
  const fontMap = {
    sans: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    rounded: '"SF Pro Rounded", ui-rounded, "Comic Sans MS", cursive, sans-serif',
    serif: 'Georgia, Cambria, "Times New Roman", Times, serif',
    mono: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  };
  const fontFamily = fontMap[styleConfig.font] || fontMap.sans;

  // Background style: Classic YouTube translucent black box
  let backgroundColor = `rgba(0, 0, 0, ${(styleConfig.bgOpacity ?? 80) / 100})`;
  if (styleConfig.bgStyle === "solid") backgroundColor = "#000000";
  if (styleConfig.bgStyle === "none") backgroundColor = "transparent";

  // Position style computation:
  // "custom" -> Fine-tuned percentage height
  // "middle" -> Vertical center of screen
  // "top" -> Upper third
  // "above_title" -> Clear above metadata
  // "bottom" -> Anchored on the downside (bottom of active video frame, never colliding with title)
  const position = styleConfig.position || "bottom";
  let positionStyle: React.CSSProperties = {};

  if (position === "custom" && typeof styleConfig.customOffsetPercent === "number") {
    const pct = Math.max(5, Math.min(92, styleConfig.customOffsetPercent));
    positionStyle = {
      bottom: `calc(var(--sab, 0px) + ${pct}%)`,
    };
  } else if (position === "middle") {
    positionStyle = {
      top: "50%",
      bottom: "auto",
      transform: "translateY(-50%)",
    };
  } else if (position === "top") {
    positionStyle = {
      top: isDesktop ? "64px" : "calc(max(var(--sat, 0px), 28px) + 54px)",
      bottom: "auto",
    };
  } else if (position === "above_title") {
    positionStyle = {
      bottom: isDesktop
        ? "80px"
        : `calc(var(--sab, 0px) + ${(bottomOffset !== undefined ? bottomOffset : 124) + 140}px)`,
    };
  } else {
    // "bottom" -> Anchored on the downside (lower portion of active video frame)
    if (isDesktop) {
      positionStyle = { bottom: "48px" };
    } else if (clean || fs) {
      positionStyle = {
        bottom: videoFrameBottom !== null ? `${videoFrameBottom}px` : "calc(var(--sab, 0px) + 20px)",
      };
    } else {
      positionStyle = {
        bottom: videoFrameBottom !== null ? `${videoFrameBottom}px` : "calc(var(--sab, 0px) + 76px)",
      };
    }
  }

  const commonStyle: React.CSSProperties = {
    backgroundColor,
    textShadow,
    fontFamily,
    boxDecorationBreak: "clone",
    WebkitBoxDecorationBreak: "clone",
    lineHeight: "1.25",
  };

  return (
    <div
      className="absolute left-0 right-0 z-20 pointer-events-none flex flex-col items-center px-3"
      style={positionStyle}
      aria-live="polite"
    >
      <div
        className={`flex flex-col items-center text-center max-w-[85%] sm:max-w-[75%] gap-0.5 select-none transition-all duration-200 ease-out ${
          isVisible ? "opacity-100 scale-100" : "opacity-0 scale-95 pointer-events-none"
        }`}
      >
        <span
          className={`inline-block font-medium tracking-normal rounded-[2px] shadow-[0_1px_3px_rgba(0,0,0,0.85)] transition-all duration-150 ${sizeConfig.primary} ${sizeConfig.padding}`}
          style={{
            ...commonStyle,
            color: primaryTextColor,
          }}
        >
          {englishText}
        </span>
      </div>
    </div>
  );
}
