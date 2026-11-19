import { Button, Input } from "./ios/controls";
import { Loader } from "./ios/effects";
import React, { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import { fmtTime, platform, playlist } from "../api";
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
  const seek = useSeekInput({ time, duration, enabled: active && !controlsLocked, resetKey: src,
    onInteraction: (phase, input, target, pointerTarget) => trace(`seek.input.${phase}`, { input, target, pointer_target: pointerTarget }),
    onSeek: (target, input) => {
      const video = videoRef.current;
      if (!video || !activity.isActive()) return;
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
    onSeek: (target) => {
      const video = videoRef.current;
      if (!video || !activity.isActive()) return;
      video.currentTime = target;
      setTime(video.currentTime);
    },
  });

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;
    setErrMsg("");
    setWaiting(false);
    recoverCountRef.current = 0;
    const resume = proxyRecovery.resume();
    const url = playlist(src);
    trace("source.load", { engine: Hls.isSupported() ? "hls.js" : "native", auto_play: autoPlay, resource: mediaResource(src), host: mediaHost(src) });

    if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }

    if (Hls.isSupported()) {
      const hls = new Hls({
        // Disable direct steering URLs
        interstitialsController: undefined,
        contentSteeringController: undefined,
        enableInterstitialPlayback: false,
        // Disable worker in WKWebView for stability on iOS
        enableWorker: platform !== "ios",
        // Keep the same macOS seek workaround as the shared player.
        preferManagedMediaSource: false,
        autoStartLoad: false,
        startPosition: resume?.time ?? -1,
        lowLatencyMode: false,
        maxBufferLength: isFullEpisodePreCacheEnabled() ? 600 : 30,
        maxMaxBufferLength: isFullEpisodePreCacheEnabled() ? 1200 : 60,
        maxBufferSize: isFullEpisodePreCacheEnabled() ? 80 * 1024 * 1024 : 30 * 1024 * 1024,
        backBufferLength: isFullEpisodePreCacheEnabled() ? 120 : 30,
        highBufferWatchdogPeriod: isFullEpisodePreCacheEnabled() ? 2 : 4,
        maxBufferHole: 0.5,
        nudgeOffset: 0.25,
        nudgeMaxRetry: 6,
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
        if (autoPlay && !resume) activity.play("manifest_autoplay", true);
      });
      hls.on(Hls.Events.FRAG_BUFFERED, () => {
        recoverCountRef.current = 0;
        setErrMsg("");
      });
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
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && recoverCountRef.current < 4) {
          recoverCountRef.current += 1;
          try { hls.startLoad(video.currentTime || -1); } catch { /* ignore */ }
          return;
        }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && recoverCountRef.current < 4) {
          recoverCountRef.current += 1;
          try { hls.recoverMediaError(); video.play().catch(() => {}); } catch { /* ignore */ }
          return;
        }
        const detail = `${data.type}/${data.details}/${data.response?.code ?? ""}/${String(data.reason ?? "").slice(0, 80)}`;
        (window as unknown as { __hlsErr?: string }).__hlsErr = detail;
        setErrMsg(detail);
        if (!activity.isActive()) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
        else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
        else { hls.destroy(); hlsRef.current = null; }
      });
    } else {
      // Native HLS fallback for Safari and compatible WebViews
      video.src = url;
      if (autoPlay && !resume) activity.play("native_autoplay", true);
    }

    return () => {
      trace("source.cleanup");
      if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
    };
  }, [src, autoPlay, proxyRecovery.revision]);

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

  const pct = duration > 0 ? (seek.time / duration) * 100 : 0;

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
        disablePictureInPicture
        controlsList="nodownload noplaybackrate nopictureinpicture"
        preload="auto"
        muted={muted}
        loop={loop}
        className="relative z-10 w-full h-full object-contain bg-transparent"
        onClick={toggle}
        onPlay={() => { if (activity.isActive()) { setPlaying(true); onTogglePlay?.(true); } }}
        onPause={() => { setPlaying(false); onTogglePlay?.(false); }}
        onWaiting={() => setWaiting(true)}
        onPlaying={() => { if (activity.isActive()) { setWaiting(false); setErrMsg(""); onPlaying?.(); } }}
        onSeeked={() => setWaiting(false)}
        onTimeUpdate={(e) => setTime((e.target as HTMLVideoElement).currentTime)}
        onLoadedMetadata={(e) => setDuration((e.target as HTMLVideoElement).duration || 0)}
        onEnded={() => { if (activity.isActive()) onEnded?.(); }}
        onError={() => {
          if (hlsRef.current) return;
          setWaiting(false);
          setPlaying(false);
          setErrMsg(mediaErrorMessage(videoRef.current?.error ?? null));
        }}
      />

      {errMsg && (
        <div className="absolute left-2 top-2 z-30 max-w-[80%] rounded bg-black/70 px-2 py-1 text-[12px] leading-tight text-red-300 break-all">
          {errMsg}
        </div>
      )}

      {waiting && (
        <div className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none">
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
        <div className="player-inline-controls absolute inset-x-0 bottom-0 z-20 px-3 pb-2 pt-8 opacity-0 group-hover:opacity-100 transition-opacity">
          <Input aria-label="Playback progress" type="range" {...seek.inputProps}
            className="hg-range w-full" style={{ ...seek.inputProps.style, "--fill": `${pct}%` } as React.CSSProperties} />
          <div className="flex items-center gap-3 mt-1 text-white">
            <Button onClick={toggle} aria-label={playing ? "Pause" : "Play"} className="pressable">
              {playing ? <IPauseF size={16} /> : <IPlayF size={16} />}
            </Button>
            <Button onClick={() => onToggleMute?.()} aria-label={muted ? "Unmute" : "Mute"} className="pressable">
              {muted ? <IVolMute size={16} /> : <IVol size={16} />}
            </Button>
            <span className="text-[12px] tabular-nums text-white/85">{fmtTime(seek.time)} / {fmtTime(duration)}</span>
            <div className="flex-1" />
            <Button onClick={() => setControlsLocked(true)} aria-label="Lock controls" title="Lock controls" aria-pressed={false} className="pressable">
              <ILockF size={16} />
            </Button>
            <Button onClick={cycleRate} className="text-[12px] font-bold text-white/85 pressable tabular-nums">{rate}x</Button>
            <Button onClick={toggleFull} aria-label="Fullscreen" className="pressable">
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
