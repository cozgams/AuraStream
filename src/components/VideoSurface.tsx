import { useEffect, useImperativeHandle, useRef, forwardRef, useState } from "react";
import Hls from "hls.js";
import { isLocalMedia, isMobile, platform, playlist } from "../api";
import { mediaErrorMessage } from "../mediaErrors";
import { mediaHost, mediaResource, observeHls, usePlayerDiagnostics } from "../playbackDiagnostics";
import { usePlaybackActivity } from "../usePlaybackActivity";
import { useProxyPlaybackRecovery } from "../useProxyPlaybackRecovery";
import { isFullEpisodePreCacheEnabled } from "../playbackFeatures";

export type VideoHandle = {
  el: () => HTMLVideoElement | null;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  seek: (t: number, source?: string) => void;
  trace: (event: string, data?: Record<string, unknown>) => void;
  rate: (r: number) => void;
  mute: (m: boolean) => void;
  volume: (v: number) => void;
  reload?: () => void;
  setAudioOffset?: (offsetMs: number) => void;
};

type Props = {
  src: string;
  poster?: string;
  autoPlay?: boolean;
  active?: boolean;
  diagnosticContext?: Record<string, unknown>;
  muted?: boolean;
  loop?: boolean;
  fit?: "contain" | "cover";
  /** Re-applies volume and playback rate after source change */
  volume?: number;
  rate?: number;
  onTime?: (t: number) => void;
  onDuration?: (d: number) => void;
  onSize?: (w: number, h: number) => void;
  onPlaying?: () => void;
  onPause?: () => void;
  onWaiting?: () => void;
  onEnded?: () => void;
  onError?: (msg: string) => void;
  onClick?: () => void;
  className?: string;
};

const safeVolume = (vol: number) => Math.max(0, Math.min(1, Number.isFinite(vol) ? vol : 1));

/** Core video playback surface (HLS.js + HTMLVideoElement) */
const VideoSurface = forwardRef<VideoHandle, Props>(function VideoSurface(
  { src, poster, autoPlay = true, active = true, diagnosticContext = {}, muted = false, loop = false, fit = "contain", volume = 1, rate = 1,
    onTime, onDuration, onSize, onPlaying, onPause, onWaiting, onEnded, onError, onClick, className = "" },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const recoverCountRef = useRef(0);
  const recoverTimerRef = useRef<number | null>(null);
  const nearEndFiredRef = useRef(false);
  const reportedSizeRef = useRef({ w: 0, h: 0 });
  const [ready, setReady] = useState(false);
  const isBufferingRef = useRef(false);
  const stallStageRef = useRef(0);
  const lastAdvanceTimeRef = useRef(Date.now());
  const lastPosRef = useRef(0);
  const autoPlayRef = useRef(autoPlay);
  autoPlayRef.current = autoPlay;
  const onSizeRef = useRef(onSize);
  onSizeRef.current = onSize;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const audioCtxRef = useRef<AudioContext | null>(null);
  const delayNodeRef = useRef<DelayNode | null>(null);
  const sourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null);
  const { trace, requestSeek } = usePlayerDiagnostics(videoRef, hlsRef, { ...diagnosticContext, active, resource: mediaResource(src) });
  const activity = usePlaybackActivity(videoRef, hlsRef, { active, autoPlay, src, trace });
  const proxyRecovery = useProxyPlaybackRecovery(videoRef, src, activity, trace);

  const reportSize = (v: HTMLVideoElement | null) => {
    if (!v) return;
    const w = v.videoWidth || 0;
    const h = v.videoHeight || 0;
    if (w > 0 && h > 0 && (w !== reportedSizeRef.current.w || h !== reportedSizeRef.current.h)) {
      reportedSizeRef.current = { w, h };
      onSizeRef.current?.(w, h);
    }
  };

  useImperativeHandle(ref, () => ({
    el: () => videoRef.current,
    play: () => activity.play("handle"),
    pause: () => activity.pause(),
    toggle: () => {
      const v = videoRef.current;
      if (!v) return;
      trace("toggle.request");
      if (v.paused) activity.play("toggle"); else activity.pause("toggle");
    },
    seek: (t: number, source = "handle") => {
      const v = videoRef.current;
      if (!v || !Number.isFinite(t)) return;
      // Clamp seek before duration on iOS to avoid stuck ended state
      const dur = v.duration && Number.isFinite(v.duration) ? v.duration : 0;
      const target = dur > 0.5 ? Math.max(0, Math.min(dur - 0.35, t)) : Math.max(0, t);
      requestSeek(target, source);
      if (hlsRef.current) { try { hlsRef.current.startLoad(target); } catch { /* ignore */ } }
      const resume = !v.paused;
      try { v.currentTime = target; trace("seek.assigned", { target, source }); }
      catch (e) { trace("seek.rejected", { error_name: (e as Error).name }); console.warn("Seek suppressed:", e); }
      if (resume) { const p = v.play(); if (p && p.catch) p.catch(() => {}); }
    },
    trace,
    rate: (r: number) => { const v = videoRef.current; if (v) v.playbackRate = r; },
    mute: (m: boolean) => { const v = videoRef.current; if (v) v.muted = m; },
    volume: (vol: number) => { const v = videoRef.current; if (v) v.volume = safeVolume(vol); },
    setAudioOffset: (offsetMs: number) => {
      const v = videoRef.current;
      if (!v) return;
      if (offsetMs === 0) {
        if (delayNodeRef.current && audioCtxRef.current) {
          try {
            delayNodeRef.current.delayTime.setValueAtTime(0, audioCtxRef.current.currentTime);
          } catch { /* ignore */ }
        }
        return;
      }
      try {
        const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (!AudioCtx) return;
        if (!audioCtxRef.current) {
          audioCtxRef.current = new AudioCtx();
        }
        const ctx = audioCtxRef.current;
        if (ctx.state === "suspended") {
          void ctx.resume();
        }
        if (!sourceNodeRef.current) {
          sourceNodeRef.current = ctx.createMediaElementSource(v);
        }
        if (!delayNodeRef.current) {
          delayNodeRef.current = ctx.createDelay(1.0);
          sourceNodeRef.current.connect(delayNodeRef.current);
          delayNodeRef.current.connect(ctx.destination);
        }
        const delaySec = Math.max(0, offsetMs / 1000);
        delayNodeRef.current.delayTime.setValueAtTime(delaySec, ctx.currentTime);
      } catch {
        // Ignored if cross-origin or unsupported
      }
    },
    reload: () => {
      const v = videoRef.current;
      const hls = hlsRef.current;
      if (hls && v) {
        try {
          hls.startLoad(v.currentTime || -1);
          hls.recoverMediaError();
        } catch { /* ignore */ }
      } else if (v) {
        try {
          const cur = v.currentTime;
          const expectedSrc = v.currentSrc;
          if (cur > 0) {
            v.addEventListener("loadedmetadata", () => {
              if (!v.isConnected || v.currentSrc !== expectedSrc) return;
              try { v.currentTime = cur; } catch { /* ignore */ }
            }, { once: true });
          }
          v.load();
          v.play().catch(() => {});
        } catch { /* ignore */ }
      }
    },
  }), [trace]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;
    setReady(false);
    reportedSizeRef.current = { w: 0, h: 0 };
    nearEndFiredRef.current = false;
    recoverCountRef.current = 0;
    isBufferingRef.current = true;
    stallStageRef.current = 0;
    lastAdvanceTimeRef.current = Date.now();
    lastPosRef.current = 0;
    const resume = proxyRecovery.resume();
    const onVideoResize = () => reportSize(video);
    video.addEventListener("resize", onVideoResize);
    if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }

    const isBlob = src.startsWith("blob:");
    const isHlsBlob = isBlob && (src.includes(".m3u8") || src.includes("type=hls") || src.includes("#.m3u8"));
    const isOfflineLocal = isBlob || src.includes("/offline/");
    const isDirectOfflineFile = src.includes("/offline/") && !src.toLowerCase().includes(".m3u8");
    const proxied = isLocalMedia(src) || isBlob;
    const url = isBlob ? src : (proxied ? src : playlist(src));
    const useHls = (isHlsBlob || (!isBlob && !isDirectOfflineFile)) && !url.includes("/seg?u=");
    trace("source.load", { engine: useHls && Hls.isSupported() ? "hls.js" : "native", auto_play: autoPlay, resource: mediaResource(src), host: mediaHost(src) });

    /* Restore volume, playback speed and audio pitch after HLS attach */
    const applySettings = () => {
      const v = videoRef.current;
      if (!v) return;
      v.volume = safeVolume(volume);
      v.muted = muted;
      v.playbackRate = rate;
      (v as HTMLVideoElement).preservesPitch = true;
    };
    applySettings();

    if (useHls && Hls.isSupported()) {
      const fullPreCache = isFullEpisodePreCacheEnabled();
      const isMobileDevice = isMobile || platform === "android" || platform === "ios";
      const hls = new Hls({
        // Disable direct steering URLs
        interstitialsController: undefined,
        contentSteeringController: undefined,
        enableInterstitialPlayback: false,
        enableWebVTT: true,
        enableCEA708Captions: true,
        // Disable worker in WKWebView for stability on iOS
        enableWorker: platform !== "ios",
        // Prefer standard MSE on macOS; hls.js handles MMS-only fallback and seek recovery.
        preferManagedMediaSource: false,
        autoStartLoad: isOfflineLocal || activity.isActive(),
        startFragPrefetch: true,
        progressive: !isOfflineLocal,
        capLevelToPlayerSize: true,
        lowLatencyMode: false,
        maxLoadingDelay: isOfflineLocal ? 0 : 0.5,
        startPosition: resume?.time ?? -1,
        // Calibrated buffer lengths to prevent Android WebView SourceBuffer QuotaExceededError
        maxBufferLength: isOfflineLocal ? 15 : (isMobileDevice ? 20 : (fullPreCache ? 120 : 60)),
        maxMaxBufferLength: isOfflineLocal ? 30 : (isMobileDevice ? 40 : (fullPreCache ? 240 : 120)),
        maxBufferSize: isOfflineLocal ? 15 * 1024 * 1024 : (isMobileDevice ? 15 * 1024 * 1024 : (fullPreCache ? 80 * 1024 * 1024 : 40 * 1024 * 1024)),
        backBufferLength: isMobileDevice ? 10 : (isOfflineLocal ? 20 : 45),
        highBufferWatchdogPeriod: 2,
        // Voice & Audio/Video synchronization hardening:
        stretchShortVideoTrack: true,
        forceKeyFrameOnDiscontinuity: true,
        maxBufferHole: 0.5,
        manifestLoadingTimeOut: isOfflineLocal ? 5000 : 15000,
        manifestLoadingMaxRetry: 4,
        fragLoadingTimeOut: isOfflineLocal ? 5000 : 20000,
        fragLoadingMaxRetry: 6,
        fragLoadingRetryDelay: isOfflineLocal ? 50 : 350,
      });
      hlsRef.current = hls;
      observeHls(hls, trace);
      hls.loadSource(url);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_LOADED, () => {
        if (!activity.isActive()) hls.stopLoad();
      });
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (!activity.isActive()) {
          hls.stopLoad();
          return;
        }
        if (!hls.loadingEnabled) hls.startLoad(resume?.time ?? -1);
        const shouldPlay = autoPlayRef.current && (!resume || resume.playing !== false);
        if (shouldPlay) activity.play("manifest_autoplay", true);
      });
      hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => {
        hls.subtitleDisplay = false;
        if (hls.subtitleTracks?.length && hls.subtitleTrack === -1) {
          const enIdx = hls.subtitleTracks.findIndex((tr) => /^en/i.test(tr.lang || tr.name || ""));
          hls.subtitleTrack = enIdx >= 0 ? enIdx : 0;
        }
      });
      hls.on(Hls.Events.FRAG_BUFFERED, () => {
        recoverCountRef.current = 0;
        if (recoverTimerRef.current) { window.clearTimeout(recoverTimerRef.current); recoverTimerRef.current = null; }
      });
      hls.on(Hls.Events.ERROR, (_e, data) => {
        const isTrackRemoved = String(data.error || "").includes("SourceBuffer, but it does not exist");
        const isBufferAppend = data.details === Hls.ErrorDetails.BUFFER_APPEND_ERROR;

        if (isBufferAppend) {
          try {
            hls.config.maxBufferSize = Math.max(8 * 1024 * 1024, Math.floor((hls.config.maxBufferSize || 15 * 1024 * 1024) * 0.7));
            hls.config.maxBufferLength = Math.max(8, Math.floor((hls.config.maxBufferLength || 20) * 0.7));
            hls.config.backBufferLength = 5;
          } catch { /* ignore */ }
          if (!data.fatal) return;
        }

        if (!data.fatal && !isTrackRemoved) {
          if (data.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR && activity.isActive()) {
            try { hls.startLoad(video.currentTime || -1); } catch { /* ignore */ }
          }
          return;
        }
        if (!activity.isActive()) return;
        const retry = () => {
          recoverCountRef.current += 1;
          const delay = 350 * Math.pow(2, recoverCountRef.current - 1);
          if (recoverTimerRef.current) window.clearTimeout(recoverTimerRef.current);
          recoverTimerRef.current = window.setTimeout(() => {
            recoverTimerRef.current = null;
            if (hlsRef.current !== hls || !activity.isActive()) return;
            try {
              if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
                hls.startLoad(video.currentTime || -1);
              } else if (isTrackRemoved) {
                hls.recoverMediaError();
                hls.startLoad(video.currentTime || -1);
              } else if (isBufferAppend) {
                try { hls.swapAudioCodec(); } catch { /* ignore */ }
                hls.recoverMediaError();
                activity.play("error_recover", true);
              } else {
                hls.recoverMediaError();
                activity.play("error_recover", true);
              }
            } catch { /* ignore */ }
          }, delay);
        };
        if ((data.type === Hls.ErrorTypes.NETWORK_ERROR || isTrackRemoved || data.type === Hls.ErrorTypes.MEDIA_ERROR) && recoverCountRef.current < 4) {
          retry();
          return;
        }
        if (recoverTimerRef.current) { window.clearTimeout(recoverTimerRef.current); recoverTimerRef.current = null; }
        onErrorRef.current?.(`${data.type}/${data.details}`);
        hls.destroy();
        hlsRef.current = null;
      });
    } else {
      video.src = url;
      const shouldPlay = autoPlayRef.current && (!resume || resume.playing !== false);
      if (shouldPlay) activity.play("native_autoplay", true);
    }

    return () => {
      video.removeEventListener("resize", onVideoResize);
      if (recoverTimerRef.current) { window.clearTimeout(recoverTimerRef.current); recoverTimerRef.current = null; }
      trace("source.cleanup");
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      if (video) {
        try {
          video.pause();
          video.removeAttribute("src");
          video.load();
        } catch { /* ignore */ }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, proxyRecovery.revision]);

  // Enable inline playback attributes for Android & mobile WebViews and clean up audio context on unmount
  useEffect(() => {
    const v = videoRef.current;
    if (v) {
      v.setAttribute("playsinline", "true");
      v.setAttribute("webkit-playsinline", "true");
    }
    return () => {
      if (audioCtxRef.current) {
        try {
          void audioCtxRef.current.close();
        } catch { /* ignore */ }
        audioCtxRef.current = null;
        delayNodeRef.current = null;
        sourceNodeRef.current = null;
      }
    };
  }, []);

  useEffect(() => { if (videoRef.current) videoRef.current.muted = muted; }, [muted]);
  useEffect(() => { if (videoRef.current) videoRef.current.volume = safeVolume(volume); }, [volume]);
  useEffect(() => { if (videoRef.current) videoRef.current.playbackRate = rate; }, [rate]);

  /* Playback stall watchdog */
  useEffect(() => {
    if (!active) return;

    const interval = window.setInterval(() => {
      const video = videoRef.current;
      if (!video) return;

      const isPlaybackActive = active && !video.paused && !video.ended;
      if (!isPlaybackActive) {
        lastAdvanceTimeRef.current = Date.now();
        stallStageRef.current = 0;
        return;
      }

      const curTime = video.currentTime;
      const now = Date.now();

      // Reset stall tracker when video time is advancing
      if (Math.abs(curTime - lastPosRef.current) > 0.05) {
        lastPosRef.current = curTime;
        lastAdvanceTimeRef.current = now;
        isBufferingRef.current = false;
        stallStageRef.current = 0;
        return;
      }

      // Check if video is buffering or in readyState < 3
      const isBuffering = isBufferingRef.current || video.readyState < 3;
      if (!isBuffering) return;

      const stalledDuration = now - lastAdvanceTimeRef.current;

      // > 4s stall watchdog: call hls.startLoad(video.currentTime || -1)
      if (stalledDuration >= 4000 && stallStageRef.current < 1) {
        stallStageRef.current = 1;
        trace("playback.stall_watchdog.reload", {
          currentTime: curTime,
          stalledDuration,
          readyState: video.readyState,
        });
        const hls = hlsRef.current;
        if (hls) {
          try {
            hls.startLoad(curTime || -1);
          } catch { /* ignore */ }
        }
      }

      // > 8s stall watchdog: attempt recovery (hls.recoverMediaError() or reload)
      if (stalledDuration >= 8000 && stallStageRef.current < 2) {
        stallStageRef.current = 2;
        trace("playback.stall_watchdog.recover", {
          currentTime: curTime,
          stalledDuration,
          readyState: video.readyState,
        });
        const hls = hlsRef.current;
        if (hls) {
          try {
            hls.recoverMediaError();
            activity.play("error_recover", true);
          } catch {
            try {
              hls.startLoad(curTime || -1);
            } catch { /* ignore */ }
          }
        } else {
          try {
            const expectedSrc = video.currentSrc;
            if (curTime > 0) {
              video.addEventListener("loadedmetadata", () => {
                if (!video.isConnected || video.currentSrc !== expectedSrc) return;
                try { video.currentTime = curTime; } catch { /* ignore */ }
              }, { once: true });
            }
            video.load();
            video.play().catch(() => {});
          } catch { /* ignore */ }
        }
      }

      // > 14s stall watchdog: report error if video remains stuck
      if (stalledDuration >= 14000 && stallStageRef.current < 3) {
        stallStageRef.current = 3;
        trace("playback.stall_watchdog.fatal", {
          currentTime: curTime,
          stalledDuration,
          readyState: video.readyState,
        });
        onErrorRef.current?.("Video playback stalled. Please retry.");
      }
    }, 1000);

    return () => {
      window.clearInterval(interval);
    };
  }, [active, trace]);

  const reapply = (v: HTMLVideoElement) => {
    v.volume = safeVolume(volume);
    v.muted = muted;
    v.playbackRate = rate;
  };

  const handleVideoError = () => {
    const err = videoRef.current?.error ?? null;
    if (!err || err.code === 1) return;
    const hls = hlsRef.current;
    if (hls && err.code === 3 && recoverCountRef.current < 4 && activity.isActive()) {
      recoverCountRef.current += 1;
      try {
        hls.recoverMediaError();
        activity.play("error_recover", true);
        return;
      } catch { /* fall through to fatal */ }
    }
    if (recoverTimerRef.current) { window.clearTimeout(recoverTimerRef.current); recoverTimerRef.current = null; }
    if (hls) {
      hls.destroy();
      hlsRef.current = null;
    }
    const msg = mediaErrorMessage(err);
    if (msg) onErrorRef.current?.(msg);
  };

  return (
    <video
      ref={videoRef}
      poster={poster}
      playsInline
      disablePictureInPicture={platform === "android"}
      controlsList="nodownload noplaybackrate nopictureinpicture"
      preload="auto"
      muted={muted}
      loop={loop}
      onClick={onClick}
      className={`w-full h-full bg-black ${fit === "cover" ? "object-cover" : "object-contain"} ${className}`}
      style={{ opacity: ready ? 1 : 0, transition: "opacity .15s" }}
      onLoadedData={(e) => {
        const v = e.target as HTMLVideoElement;
        setReady(true);
        reapply(v);
        reportSize(v);
      }}
      onTimeUpdate={(e) => {
        const v = e.target as HTMLVideoElement;
        if (Math.abs(v.currentTime - lastPosRef.current) > 0.05) {
          lastPosRef.current = v.currentTime;
          lastAdvanceTimeRef.current = Date.now();
          isBufferingRef.current = false;
          stallStageRef.current = 0;
        }
        reportSize(v);
        onTime?.(v.currentTime);
        const d = v.duration;
        if (d && Number.isFinite(d)) {
          // Reset near-end flag if user sought backwards or rewound
          if (v.currentTime < d - 1.0 && nearEndFiredRef.current) {
            nearEndFiredRef.current = false;
          }
          // Synthetic ended trigger near duration for reliable auto-play (skipped when video is looping)
          if (!loop && activity.isActive() && !v.paused && d > 1 && v.currentTime > d - 0.2 && !nearEndFiredRef.current) {
            nearEndFiredRef.current = true;
            onEnded?.();
          }
        }
      }}
      onLoadedMetadata={(e) => {
        const v = e.target as HTMLVideoElement;
        reapply(v);
        onDuration?.(v.duration || 0);
        reportSize(v);
      }}
      onPlay={() => {
        if (audioCtxRef.current && audioCtxRef.current.state === "suspended") {
          void audioCtxRef.current.resume();
        }
        isBufferingRef.current = true;
        lastAdvanceTimeRef.current = Date.now();
      }}
      onPause={() => {
        isBufferingRef.current = false;
        stallStageRef.current = 0;
        lastAdvanceTimeRef.current = Date.now();
        onPause?.();
      }}
      onWaiting={() => {
        isBufferingRef.current = true;
        onWaiting?.();
      }}
      onStalled={() => {
        isBufferingRef.current = true;
        onWaiting?.();
      }}
      onSeeked={() => {
        lastAdvanceTimeRef.current = Date.now();
        if (videoRef.current) lastPosRef.current = videoRef.current.currentTime;
      }}
      onPlaying={(e) => {
        if (audioCtxRef.current && audioCtxRef.current.state === "suspended") {
          void audioCtxRef.current.resume();
        }
        const v = e.target as HTMLVideoElement;
        isBufferingRef.current = false;
        stallStageRef.current = 0;
        lastAdvanceTimeRef.current = Date.now();
        lastPosRef.current = v.currentTime;
        reportSize(v);
        if (activity.isActive()) onPlaying?.();
      }}
      onEnded={() => {
        // Guard against duplicate synthetic + native ended triggers
        if (!nearEndFiredRef.current && activity.isActive()) {
          nearEndFiredRef.current = true;
          onEnded?.();
        }
      }}
      onError={handleVideoError}
    />
  );
});

export default VideoSurface;
