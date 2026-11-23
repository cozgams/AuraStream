import { Button, Input } from "./ios/controls";
import { Loader } from "./ios/effects";
import React, { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import { fmtTime, isLocalMedia, isMobile, platform, playlist } from "../api";
import { mediaErrorMessage } from "../mediaErrors";
import { mediaHost, mediaResource, observeHls, usePlayerDiagnostics } from "../playbackDiagnostics";
import { usePlaybackActivity } from "../usePlaybackActivity";
import { useProxyPlaybackRecovery } from "../useProxyPlaybackRecovery";
import { isFullEpisodePreCacheEnabled } from "../playbackFeatures";
import { useSeekInput } from "../useSeekInput";
import { useMediaSession } from "../useMediaSession";
import PlaybackLock from "./PlaybackLock";
import { ICompress, IExpand, ILockF, IPauseF, IPlayF, IVol, IVolMute } from "../icons";

type Props = {
  src: string;              // Upstream m3u8 playlist URL
  poster?: string;          // Proxied cover image URL
  autoPlay?: boolean;
  active?: boolean;
  muted?: boolean;
  loop?: boolean;
  onEnded?: () => void;
  onPlaying?: () => void;
  onTogglePlay?: (playing: boolean) => void;
  onToggleMute?: () => void;
  controls?: boolean;
  className?: string;
  diagnosticContext?: Record<string, unknown>;
};

export default function Player({
  src, poster, autoPlay, active = true, muted = false, loop = false, onEnded, onPlaying,
  onTogglePlay, onToggleMute, controls = true, className = "", diagnosticContext = {},
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const recoverCountRef = useRef(0);
  const recoverTimerRef = useRef<number | null>(null);
  const { trace, requestSeek } = usePlayerDiagnostics(videoRef, hlsRef, { view: "post_detail", ...diagnosticContext, active, resource: mediaResource(src) });
  const activity = usePlaybackActivity(videoRef, hlsRef, { active, autoPlay: !!autoPlay, src, trace });
  const proxyRecovery = useProxyPlaybackRecovery(videoRef, src, activity, trace);
  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [full, setFull] = useState(false);
  const [rate, setRate] = useState(1);
  const [errMsg, setErrMsg] = useState<string>("");
  const [controlsLocked, setControlsLocked] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(false);
  const controlsTimerRef = useRef<number | null>(null);
  const flashControls = () => {
    setControlsVisible(true);
    if (controlsTimerRef.current) window.clearTimeout(controlsTimerRef.current);
    controlsTimerRef.current = window.setTimeout(() => {
      setControlsVisible(false);
      controlsTimerRef.current = null;
    }, 3200);
  };
  useEffect(() => () => {
    if (controlsTimerRef.current) window.clearTimeout(controlsTimerRef.current);
  }, []);
  const autoPlayRef = useRef(!!autoPlay);
  autoPlayRef.current = !!autoPlay;
  const rateRef = useRef(rate);
  rateRef.current = rate;
  const lastTimeRef = useRef(0);
  const seek = useSeekInput({ time, duration, enabled: active && !controlsLocked, resetKey: src,
    onInteraction: (phase, input, target, pointerTarget) => trace(`seek.input.${phase}`, { input, target, pointer_target: pointerTarget }),
    onSeek: (t, input) => {
      const video = videoRef.current;
      if (!video || !activity.isActive() || !Number.isFinite(t)) return;
      const dur = video.duration && Number.isFinite(video.duration) ? video.duration : 0;
      const target = dur > 0 ? Math.max(0, Math.min(dur - 0.15, t)) : Math.max(0, t);
      requestSeek(target, `legacy_${input}`);
      setWaiting(true);
      if (hlsRef.current) {
        try { hlsRef.current.startLoad(target); } catch { /* ignore */ }
      }
      video.currentTime = target;
      trace("seek.assigned", { target });
      setTime(video.currentTime);
    },
  });

  useMediaSession({
    title: "AuraStream Video",
    artist: "AuraStream",
    coverUrl: poster,
    duration,
    time,
    playbackRate: rate,
    paused: !playing,
    active,
    onPlay: () => activity.play("mediasession"),
    onPause: () => activity.pause("mediasession"),
    onSeek: (t) => {
      const video = videoRef.current;
      if (!video || !activity.isActive() || !Number.isFinite(t)) return;
      const dur = video.duration && Number.isFinite(video.duration) ? video.duration : 0;
      const target = dur > 0 ? Math.max(0, Math.min(dur - 0.15, t)) : Math.max(0, t);
      requestSeek(target, "mediasession");
      if (hlsRef.current) {
        try { hlsRef.current.startLoad(target); } catch { /* ignore */ }
      }
      video.currentTime = target;
      setTime(video.currentTime);
    },
  });

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;
    if (recoverTimerRef.current) { window.clearTimeout(recoverTimerRef.current); recoverTimerRef.current = null; }
    setErrMsg("");
    setWaiting(false);
    recoverCountRef.current = 0;
    lastTimeRef.current = 0;
    const resume = proxyRecovery.resume();
    const isBlob = src.startsWith("blob:");
    const isHlsBlob = isBlob && (src.includes(".m3u8") || src.includes("type=hls") || src.includes("#.m3u8"));
    const isOfflineLocal = isBlob || src.includes("/offline/");
    const isDirectOfflineFile = src.includes("/offline/") && !src.toLowerCase().includes(".m3u8");
    const proxied = isLocalMedia(src) || isBlob;
    const url = isBlob ? src : (proxied ? src : playlist(src));
    const useHls = (isHlsBlob || (!isBlob && !isDirectOfflineFile)) && !url.includes("/seg?u=");
    trace("source.load", { engine: useHls && Hls.isSupported() ? "hls.js" : "native", auto_play: autoPlayRef.current, resource: mediaResource(src), host: mediaHost(src) });

    if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
    video.playbackRate = rateRef.current;

    if (useHls && Hls.isSupported()) {
      const hls = new Hls({
        // Disable direct steering URLs
        interstitialsController: undefined,
        contentSteeringController: undefined,
        enableInterstitialPlayback: false,
        enableWebVTT: true,
        enableCEA708Captions: true,
        // Disable worker in WKWebView for stability on iOS
        enableWorker: platform !== "ios",
        // Keep the same macOS seek workaround as the shared player.
        preferManagedMediaSource: false,
        autoStartLoad: isOfflineLocal || activity.isActive(),
        startFragPrefetch: true,
        progressive: !isOfflineLocal,
        capLevelToPlayerSize: true,
        startPosition: resume?.time ?? -1,
        lowLatencyMode: false,
        maxBufferLength: isFullEpisodePreCacheEnabled() ? 600 : 30,
        maxMaxBufferLength: isFullEpisodePreCacheEnabled() ? 1200 : 60,
        maxBufferSize: isFullEpisodePreCacheEnabled() ? 80 * 1024 * 1024 : 30 * 1024 * 1024,
        backBufferLength: isFullEpisodePreCacheEnabled() ? 120 : 30,
        highBufferWatchdogPeriod: isFullEpisodePreCacheEnabled() ? 2 : 4,
        // Voice & Audio/Video synchronization hardening:
        stretchShortVideoTrack: true,
        forceKeyFrameOnDiscontinuity: true,
        maxBufferHole: 0.5,
        manifestLoadingTimeOut: 20000,
        manifestLoadingMaxRetry: 4,
        fragLoadingTimeOut: 25000,
        fragLoadingMaxRetry: 6,
        fragLoadingRetryDelay: 400,
      });
      hlsRef.current = hls;
      observeHls(hls, trace);
      hls.loadSource(url);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (activity.isActive()) hls.startLoad(resume?.time ?? -1);
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
        setErrMsg("");
        if (recoverTimerRef.current) { window.clearTimeout(recoverTimerRef.current); recoverTimerRef.current = null; }
      });
      hls.on(Hls.Events.ERROR, (_e, data) => {
        const isTrackRemoved = String(data.error || "").includes("SourceBuffer, but it does not exist");

        if (!data.fatal && !isTrackRemoved) {
          if (data.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR && activity.isActive()) {
            try { hls.startLoad(video.currentTime || -1); } catch { /* ignore */ }
          }
          return;
        }
        if (!activity.isActive()) return;
        const retry = () => {
          recoverCountRef.current += 1;
          const delay = 300 * Math.pow(2, recoverCountRef.current - 1);
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
              } else {
                hls.recoverMediaError();
                if (activity.isPlayWanted()) activity.play("error_recover", true);
              }
            } catch { /* ignore */ }
          }, delay);
        };
        if ((data.type === Hls.ErrorTypes.NETWORK_ERROR || isTrackRemoved || data.type === Hls.ErrorTypes.MEDIA_ERROR) && recoverCountRef.current < 4) {
          retry();
          return;
        }
        if (recoverTimerRef.current) { window.clearTimeout(recoverTimerRef.current); recoverTimerRef.current = null; }
        const detail = `${data.type}/${data.details}/${data.response?.code ?? ""}/${String(data.reason ?? "").slice(0, 80)}`;
        (window as unknown as { __hlsErr?: string }).__hlsErr = detail;
        setErrMsg(detail);
        setWaiting(false);
        setPlaying(false);
        hls.destroy();
        hlsRef.current = null;
      });
    } else {
      // Native HLS fallback for Safari and compatible WebViews
      video.src = url;
      const shouldPlay = autoPlayRef.current && (!resume || resume.playing !== false);
      if (shouldPlay) activity.play("native_autoplay", true);
    }

    return () => {
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

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = muted;
  }, [muted]);

  // Enable inline playback attribute for iOS WKWebView
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.setAttribute("webkit-playsinline", "true");
  }, []);

  useEffect(() => {
    const onFs = () => setFull(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  const toggle = () => {
    const video = videoRef.current;
    if (!video) return;
    trace("toggle.request");
    if (video.paused) activity.play("toggle");
    else activity.pause("toggle");
  };

  const cycleRate = () => {
    const video = videoRef.current;
    if (!video) return;
    const next = rate === 1 ? 1.25 : rate === 1.25 ? 1.5 : rate === 1.5 ? 2 : 1;
    video.playbackRate = next;
    setRate(next);
  };

  const toggleFull = () => {
    const el = wrapRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else el.requestFullscreen().catch(() => {});
  };

  const pct = duration > 0 ? Math.max(0, Math.min(100, (seek.time / duration) * 100)) : 0;

  return (
    <div ref={wrapRef} className={`relative bg-black overflow-hidden group ${className}`}>
      <div className="absolute inset-0" inert={controlsLocked}>
      {poster && (
        <div
          className="absolute inset-0 z-0 overflow-hidden pointer-events-none transition-opacity duration-500 ease-out"
          style={{ opacity: !playing || waiting ? 1 : 0 }}
        >
          <img
            src={poster}
            alt=""
            loading="eager"
            decoding="async"
            className="w-full h-full object-contain"
            onError={(e) => {
              (e.target as HTMLElement).style.display = "none";
            }}
          />
          <div className="absolute inset-0 bg-black/25" />
        </div>
      )}
      <video
        ref={videoRef}
        poster={poster}
        playsInline
        disablePictureInPicture={platform === "android"}
        controlsList="nodownload noplaybackrate nopictureinpicture"
        preload="auto"
        muted={muted}
        loop={loop}
        className="relative z-10 w-full h-full object-contain bg-transparent"
        onClick={() => {
          if (isMobile && playing) {
            flashControls();
          }
          toggle();
        }}
        onPlay={() => { if (activity.isActive()) { setPlaying(true); onTogglePlay?.(true); } }}
        onPause={() => { setPlaying(false); onTogglePlay?.(false); }}
        onWaiting={() => setWaiting(true)}
        onStalled={() => setWaiting(true)}
        onPlaying={() => { if (activity.isActive()) { setWaiting(false); setErrMsg(""); onPlaying?.(); } }}
        onSeeked={() => setWaiting(false)}
        onTimeUpdate={(e) => {
          const t = (e.target as HTMLVideoElement).currentTime;
          setTime(t);
          if (Math.abs(t - lastTimeRef.current) > 0.05) {
            lastTimeRef.current = t;
            if (waiting) setWaiting(false);
          }
        }}
        onLoadedMetadata={(e) => {
          const v = e.target as HTMLVideoElement;
          v.playbackRate = rateRef.current;
          setDuration(v.duration || 0);
        }}
        onEnded={() => { if (activity.isActive()) onEnded?.(); }}
        onError={() => {
          const err = videoRef.current?.error ?? null;
          if (!err || err.code === 1) return;
          const hls = hlsRef.current;
          if (hls && err.code === 3 && recoverCountRef.current < 4 && activity.isActive()) {
            recoverCountRef.current += 1;
            try {
              hls.recoverMediaError();
              return;
            } catch { /* fall through to fatal */ }
          }
          if (recoverTimerRef.current) { window.clearTimeout(recoverTimerRef.current); recoverTimerRef.current = null; }
          if (hls) {
            hls.destroy();
            hlsRef.current = null;
          }
          const msg = mediaErrorMessage(err);
          if (!msg) return;
          setWaiting(false);
          setPlaying(false);
          setErrMsg(msg);
        }}
      />

      {errMsg && (
        <div className="absolute left-2 top-2 z-30 max-w-[80%] rounded bg-black/70 px-2 py-1 text-[12px] leading-tight text-red-300 break-all">
          {errMsg}
        </div>
      )}

      {waiting && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center pointer-events-none px-4">
          <div className="w-12 h-12 rounded-full bg-black/60 backdrop-blur-md flex items-center justify-center border border-white/15 shadow-[0_8px_24px_rgba(0,0,0,0.5)]">
            <Loader className="w-6 h-6 spinner text-primary" />
          </div>
        </div>
      )}

      {!playing && !waiting && (
        <Button onClick={toggle} aria-label="Play"
          className="absolute inset-0 z-20 flex items-center justify-center">
          <span className="w-16 h-16 rounded-full bg-black/45 backdrop-blur-sm flex items-center justify-center elev-2 pressable">
            <IPlayF size={26} className="text-white ml-0.5" />
          </span>
        </Button>
      )}

      {controls && (
        <div className={`player-inline-controls absolute inset-x-0 bottom-0 z-20 px-3 pb-2 pt-8 transition-opacity ${!playing || controlsVisible ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}>
          <Input aria-label="Playback progress" type="range" {...seek.inputProps}
            onPointerDown={(e) => { if (isMobile) flashControls(); seek.inputProps.onPointerDown?.(e); }}
            className="hg-range w-full" style={{ ...seek.inputProps.style, "--fill": `${pct}%` } as React.CSSProperties} />
          <div className="flex items-center gap-3 mt-1 text-white">
            <Button onClick={() => { if (isMobile) flashControls(); toggle(); }} aria-label={playing ? "Pause" : "Play"} className="ios-compact pressable">
              {playing ? <IPauseF size={16} /> : <IPlayF size={16} />}
            </Button>
            <Button onClick={() => { if (isMobile) flashControls(); onToggleMute?.(); }} aria-label={muted ? "Unmute" : "Mute"} className="ios-compact pressable">
              {muted ? <IVolMute size={16} /> : <IVol size={16} />}
            </Button>
            <span className="text-[12px] tabular-nums text-white/85">{fmtTime(seek.time)} / {fmtTime(duration)}</span>
            <div className="flex-1" />
            <Button onClick={() => setControlsLocked(true)} aria-label="Lock controls" title="Lock controls" aria-pressed={false} className="ios-compact pressable">
              <ILockF size={16} />
            </Button>
            <Button onClick={() => { if (isMobile) flashControls(); cycleRate(); }} className="ios-compact text-[12px] font-bold text-white/85 pressable tabular-nums">{rate}x</Button>
            <Button onClick={() => { if (isMobile) flashControls(); toggleFull(); }} aria-label="Fullscreen" className="ios-compact pressable">
              {full ? <ICompress size={16} /> : <IExpand size={16} />}
            </Button>
          </div>
        </div>
      )}
      </div>
      {controlsLocked && <PlaybackLock active={active} onUnlock={() => setControlsLocked(false)} />}
    </div>
  );
}
