import { useEffect, useImperativeHandle, useRef, forwardRef, useState } from "react";
import Hls from "hls.js";
import { isLocalMedia, platform, playlist } from "../api";
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
  const { trace, requestSeek } = usePlayerDiagnostics(videoRef, hlsRef, { ...diagnosticContext, active, resource: mediaResource(src) });
  const activity = usePlaybackActivity(videoRef, hlsRef, { active, autoPlay, src, trace });
  const proxyRecovery = useProxyPlaybackRecovery(videoRef, src, activity, trace);

  const reportSize = (v: HTMLVideoElement | null) => {
    if (!v) return;
    const w = v.videoWidth || 0;
    const h = v.videoHeight || 0;
    if (w > 0 && h > 0 && (w !== reportedSizeRef.current.w || h !== reportedSizeRef.current.h)) {
      reportedSizeRef.current = { w, h };
      onSize?.(w, h);
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
      const target = dur > 0 ? Math.max(0, Math.min(dur - 0.15, t)) : Math.max(0, t);
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
  }), []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;
    setReady(false);
    reportedSizeRef.current = { w: 0, h: 0 };
    nearEndFiredRef.current = false;
    recoverCountRef.current = 0;
    const resume = proxyRecovery.resume();
    const onVideoResize = () => reportSize(video);
    video.addEventListener("resize", onVideoResize);
    if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }

    const isBlob = src.startsWith("blob:");
    const isHlsBlob = isBlob && (src.includes(".m3u8") || src.includes("type=hls") || src.includes("#.m3u8"));
    const proxied = isLocalMedia(src) || isBlob;
    const url = isBlob ? src : (proxied ? src : playlist(src));
    const useHls = (isHlsBlob || !isBlob) && !url.includes("/seg?u=");
    trace("source.load", { engine: useHls && Hls.isSupported() ? "hls.js" : "native", auto_play: autoPlay, resource: mediaResource(src), host: mediaHost(src) });

    /* Restore volume and playback speed after HLS attach */
    const applySettings = () => {
      const v = videoRef.current;
      if (!v) return;
      v.volume = safeVolume(volume);
      v.muted = muted;
      v.playbackRate = rate;
    };
    applySettings();

    if (useHls && Hls.isSupported()) {
      const hls = new Hls({
        // Disable direct steering URLs
        interstitialsController: undefined,
        contentSteeringController: undefined,
        enableInterstitialPlayback: false,
        // Disable worker in WKWebView for stability on iOS
        enableWorker: platform !== "ios",
        // Prefer standard MSE on macOS; hls.js handles MMS-only fallback and seek recovery.
        preferManagedMediaSource: false,
        autoStartLoad: activity.isActive(),
        startFragPrefetch: true,
        progressive: true,
        capLevelToPlayerSize: true,
        lowLatencyMode: true,
        maxLoadingDelay: 1,
        startPosition: resume?.time ?? -1,
        // Turbo Wi-Fi Buffer: Eagerly pre-buffers up to 120s (entire short episode)
        maxBufferLength: isFullEpisodePreCacheEnabled() ? 120 : 60,
        maxMaxBufferLength: isFullEpisodePreCacheEnabled() ? 240 : 120,
        maxBufferSize: isFullEpisodePreCacheEnabled() ? 80 * 1024 * 1024 : 40 * 1024 * 1024,
        backBufferLength: 45,
        highBufferWatchdogPeriod: 2,
        maxBufferHole: 0.5,
        nudgeOffset: 0.25,
        nudgeMaxRetry: 6,
        manifestLoadingTimeOut: 15000,
        manifestLoadingMaxRetry: 4,
        fragLoadingTimeOut: 20000,
        fragLoadingMaxRetry: 6,
        fragLoadingRetryDelay: 350,
      });
      hlsRef.current = hls;
      observeHls(hls, trace);
      hls.loadSource(url);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (!hls.loadingEnabled && activity.isActive()) hls.startLoad(resume?.time ?? -1);
        if (autoPlay && !resume) activity.play("manifest_autoplay", true);
      });
      hls.on(Hls.Events.FRAG_BUFFERED, () => { recoverCountRef.current = 0; });
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) {
          if (
            data.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR ||
            data.details === Hls.ErrorDetails.FRAG_LOAD_ERROR
          ) {
            try { hls.startLoad(video.currentTime || -1); } catch { /* ignore */ }
          }
          return;
        }
        if (!activity.isActive()) return;
        const retry = () => {
          recoverCountRef.current += 1;
          const delay = 250 * recoverCountRef.current;
          if (recoverTimerRef.current) window.clearTimeout(recoverTimerRef.current);
          recoverTimerRef.current = window.setTimeout(() => {
            try {
              if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad(video.currentTime || -1);
              else hls.recoverMediaError();
            } catch { /* ignore */ }
          }, delay);
        };
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && recoverCountRef.current < 4) { retry(); return; }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && recoverCountRef.current < 4) { retry(); return; }
        onError?.(`${data.type}/${data.details}`);
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
        else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
        else { hls.destroy(); hlsRef.current = null; }
      });
    } else {
      video.src = url;
      if (autoPlay && !resume) activity.play("native_autoplay", true);
    }

    return () => {
      video.removeEventListener("resize", onVideoResize);
      if (recoverTimerRef.current) { window.clearTimeout(recoverTimerRef.current); recoverTimerRef.current = null; }
      trace("source.cleanup");
      if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, proxyRecovery.revision]);

  // Enable inline playback attribute for iOS WKWebView
  useEffect(() => {
    const v = videoRef.current;
    if (v) v.setAttribute("webkit-playsinline", "true");
  }, []);

  useEffect(() => { if (videoRef.current) videoRef.current.muted = muted; }, [muted]);
  useEffect(() => { if (videoRef.current) videoRef.current.volume = safeVolume(volume); }, [volume]);
  useEffect(() => { if (videoRef.current) videoRef.current.playbackRate = rate; }, [rate]);

  const reapply = (v: HTMLVideoElement) => {
    v.volume = safeVolume(volume);
    v.muted = muted;
    v.playbackRate = rate;
  };

  const handleVideoError = () => {
    if (hlsRef.current) return;
    onError?.(mediaErrorMessage(videoRef.current?.error ?? null));
  };

  return (
    <video
      ref={videoRef}
      poster={poster}
      playsInline
      disablePictureInPicture
      controlsList="nodownload noplaybackrate nopictureinpicture"
      preload="auto"
      muted={muted}
      loop={loop}
      onClick={onClick}
      className={`w-full h-full bg-black ${fit === "cover" ? "object-cover" : "object-contain"} ${className}`}
      style={{ opacity: ready ? 1 : 0, transition: "opacity .35s" }}
      onLoadedData={(e) => {
        const v = e.target as HTMLVideoElement;
        setReady(true);
        reapply(v);
        reportSize(v);
      }}
      onTimeUpdate={(e) => {
        const v = e.target as HTMLVideoElement;
        reportSize(v);
        onTime?.(v.currentTime);
        const d = v.duration;
        if (d && Number.isFinite(d)) {
          // Reset near-end flag if user sought backwards or rewound
          if (v.currentTime < d - 1.0 && nearEndFiredRef.current) {
            nearEndFiredRef.current = false;
          }
          // Synthetic ended trigger near duration for reliable auto-play (skipped when video is looping)
          if (!loop && v.currentTime > d - 0.3 && !nearEndFiredRef.current) {
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
      onPlay={() => { if (activity.isActive()) onPlaying?.(); }}
      onPause={() => onPause?.()}
      onWaiting={() => onWaiting?.()}
      onPlaying={(e) => {
        reportSize(e.target as HTMLVideoElement);
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
