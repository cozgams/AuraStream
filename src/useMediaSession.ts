import { useEffect, useRef } from "react";

export type MediaSessionOptions = {
  title?: string;
  artist?: string;
  album?: string;
  coverUrl?: string;
  duration?: number;
  time?: number;
  playbackRate?: number;
  paused?: boolean;
  active?: boolean;
  onPlay?: () => void;
  onPause?: () => void;
  onSeek?: (targetTime: number) => void;
  onPreviousTrack?: () => void;
  onNextTrack?: () => void;
};

/**
 * Syncs playback state with System Media Session (lock screen, notification center, Bluetooth headsets).
 */
export function useMediaSession({
  title,
  artist = "AuraStream",
  album = "AuraStream",
  coverUrl,
  duration = 0,
  time = 0,
  playbackRate = 1,
  paused = false,
  active = true,
  onPlay,
  onPause,
  onSeek,
  onPreviousTrack,
  onNextTrack,
}: MediaSessionOptions): void {
  const handlersRef = useRef({ onPlay, onPause, onSeek, onPreviousTrack, onNextTrack, time });
  handlersRef.current = { onPlay, onPause, onSeek, onPreviousTrack, onNextTrack, time };

  useEffect(() => {
    if (typeof window === "undefined" || !("mediaSession" in navigator)) return;
    if (!active || !title) return;

    try {
      const artwork: MediaImage[] = [];
      if (coverUrl) {
        artwork.push(
          { src: coverUrl, sizes: "96x96", type: "image/jpeg" },
          { src: coverUrl, sizes: "256x256", type: "image/jpeg" },
          { src: coverUrl, sizes: "512x512", type: "image/jpeg" }
        );
      }

      navigator.mediaSession.metadata = new MediaMetadata({
        title,
        artist,
        album,
        artwork,
      });
    } catch {
      // ignore metadata errors
    }
  }, [active, title, artist, album, coverUrl]);

  useEffect(() => {
    if (typeof window === "undefined" || !("mediaSession" in navigator)) return;
    if (!active) return;

    try {
      navigator.mediaSession.playbackState = paused ? "paused" : "playing";
    } catch {
      // ignore
    }
  }, [active, paused]);

  useEffect(() => {
    if (typeof window === "undefined" || !("mediaSession" in navigator)) return;
    if (!active) return;

    const session = navigator.mediaSession;

    try {
      session.setActionHandler("play", () => {
        handlersRef.current.onPlay?.();
      });
      session.setActionHandler("pause", () => {
        handlersRef.current.onPause?.();
      });
      session.setActionHandler("seekto", (details) => {
        if (details.seekTime != null) {
          handlersRef.current.onSeek?.(details.seekTime);
        }
      });
      session.setActionHandler("seekbackward", (details) => {
        const offset = details.seekOffset || 10;
        const cur = handlersRef.current.time || 0;
        handlersRef.current.onSeek?.(Math.max(0, cur - offset));
      });
      session.setActionHandler("seekforward", (details) => {
        const offset = details.seekOffset || 10;
        const cur = handlersRef.current.time || 0;
        handlersRef.current.onSeek?.(cur + offset);
      });
      session.setActionHandler("previoustrack", () => {
        handlersRef.current.onPreviousTrack?.();
      });
      session.setActionHandler("nexttrack", () => {
        handlersRef.current.onNextTrack?.();
      });
    } catch {
      // Ignore unsupported action handler exceptions
    }

    return () => {
      try {
        session.setActionHandler("play", null);
        session.setActionHandler("pause", null);
        session.setActionHandler("seekto", null);
        session.setActionHandler("seekbackward", null);
        session.setActionHandler("seekforward", null);
        session.setActionHandler("previoustrack", null);
        session.setActionHandler("nexttrack", null);
      } catch {
        // ignore
      }
    };
  }, [active]);

  useEffect(() => {
    if (typeof window === "undefined" || !("mediaSession" in navigator)) return;
    if (!active || !navigator.mediaSession.setPositionState) return;

    if (duration > 0 && Number.isFinite(duration) && Number.isFinite(time)) {
      try {
        navigator.mediaSession.setPositionState({
          duration: Math.max(0, duration),
          playbackRate: playbackRate > 0 ? playbackRate : 1,
          position: Math.max(0, Math.min(time, duration)),
        });
      } catch {
        // ignore setPositionState errors
      }
    }
  }, [active, duration, time, playbackRate]);
}
