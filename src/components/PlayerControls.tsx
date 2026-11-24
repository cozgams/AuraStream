import { Button, Input } from "./ios/controls";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { fmtTime } from "../api";
import { useSeekInput } from "../useSeekInput";
import { useStore } from "../store";
import { ICaptions, ICaptionsF, ICheck, ICompress, IExpand, ILockF, INext, IPauseF, IPlayF, ITheater, IVertSwap, IVol, IVolMute } from "../icons";
import type { PlaybackClock } from "../playbackClock";

type Props = {
  paused: boolean;
  clock: PlaybackClock;
  duration: number;
  buffered?: number;
  rate: number;
  muted: boolean;
  volume: number;
  theater?: boolean;
  fullscreen?: boolean;
  visible?: boolean;
  seekEnabled?: boolean;
  seekKey?: string;
  episodeHint?: string;
  nextDisabled?: boolean;
  nextTitle?: string;
  swipeEp?: boolean;
  onToggle: () => void;
  onSeek: (t: number, source?: string) => void;
  onSeekInteraction?: (phase: string, input: string, target: number, pointerTarget?: number) => void;
  onRate: (r: number) => void;
  onMute: () => void;
  onVolume: (v: number) => void;
  onLock: () => void;
  onTheater?: () => void;
  onFullscreen: () => void;
  onNext?: () => void;
  onToggleSwipe?: () => void;
  onOpenCaptions?: () => void;
};

const formatClock = (s: number) => fmtTime(Math.max(0, s || 0)).padStart(5, "0");

export default function PlayerControls({
  paused, clock, duration, buffered = 0, rate, muted, volume, theater = false, fullscreen = false,
  visible = true, seekEnabled = true, seekKey, episodeHint, nextDisabled = false, nextTitle = "Next", swipeEp = false, onToggle, onSeek, onSeekInteraction, onRate, onMute, onVolume, onLock, onTheater, onFullscreen, onNext, onToggleSwipe, onOpenCaptions,
}: Props) {
  const store = useStore();
  const { t } = store;
  const [speedOpen, setSpeedOpen] = useState(false);
  const [ccOpen, setCcOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const clockTime = useSyncExternalStore(clock.subscribe, clock.getSnapshot, clock.getSnapshot);
  const seek = useSeekInput({ time: clockTime, duration, enabled: seekEnabled, resetKey: seekKey, onInteraction: onSeekInteraction,
    onSeek: (target, input) => onSeek(target, `desktop_${input}`) });
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const safeBuffered = Number.isFinite(buffered) ? Math.max(0, Math.min(1, buffered)) : 0;
  const pct = safeDuration > 0 ? Math.max(0, Math.min(100, (seek.time / safeDuration) * 100)) : 0;

  useEffect(() => {
    if (!seekEnabled) {
      setSpeedOpen(false);
      setCcOpen(false);
    }
  }, [seekEnabled]);

  useEffect(() => {
    if (!speedOpen && !ccOpen) return;
    const frame = requestAnimationFrame(() => {
      if (speedOpen) {
        boxRef.current?.querySelector<HTMLElement>('.player-rate-menu [role="menuitemradio"][aria-checked="true"]')?.focus();
      } else if (ccOpen) {
        boxRef.current?.querySelector<HTMLElement>('.player-cc-menu [role="menuitemradio"][aria-checked="true"]')?.focus();
      }
    });
    const outside = (e: PointerEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) {
        setSpeedOpen(false);
        setCcOpen(false);
      }
    };
    document.addEventListener("pointerdown", outside);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", outside);
    };
  }, [speedOpen, ccOpen]);

  return (
    <div ref={boxRef} className={`desktop-controls ${fullscreen ? "is-fullscreen" : ""} ${visible ? "" : "is-hidden"}`}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={event => {
        // Native button activation must not also toggle Feed's playback shortcut.
        if ([" ", "Enter"].includes(event.key) && (event.target as HTMLElement).closest("button")) event.stopPropagation();
      }}>
      <div className={`desktop-seek ${seekEnabled ? "is-seekable" : ""}`}>
        <div className="desktop-seek-track">
          <span className="desktop-seek-buffer" style={{ width: `${safeBuffered * 100}%` }} />
          <span className="desktop-seek-played" style={{ width: `${pct}%` }} />
        </div>
        <Input aria-label="Playback progress" type="range" {...seek.inputProps} />
      </div>

      <div className="desktop-control-row">
        <Button className="player-control primary-play" aria-label={paused ? t("player.play") : t("player.pause")} data-tooltip={paused ? t("player.play") : t("player.pause")} onClick={onToggle}>
          {paused ? <IPlayF size={19} /> : <IPauseF size={18} />}
        </Button>
        {onNext && (
          <Button className="player-control" aria-label={nextTitle} data-tooltip={nextTitle} disabled={nextDisabled} onClick={onNext}>
            <INext size={18} strokeWidth={1.7} />
          </Button>
        )}
        {onToggleSwipe && (
          <Button className={`player-control ${swipeEp ? "is-on" : ""}`} aria-label={t("player.swipe_ep")} aria-pressed={swipeEp}
            data-tooltip={swipeEp ? t("player.swipe_ep_on") : t("player.swipe_ep_off")} onClick={onToggleSwipe}>
            <IVertSwap size={19} strokeWidth={1.7} />
          </Button>
        )}
        <span className="player-timecode"><span>{formatClock(seek.time)}</span><span className="player-time-separator">/</span>{formatClock(duration)}</span>
        {fullscreen && paused && episodeHint && (
          <span className="player-control-hint-badge px-2.5 py-0.5 rounded-full bg-white/10 text-white/90 text-[12px] font-semibold tracking-wide">
            {episodeHint}
          </span>
        )}
        <div className="player-control-spacer" />
        <div className="player-speed-slot">
          <Button className={`player-control player-cc ${store.subtitleMode !== "off" ? "is-on" : ""}`} aria-label={t("captions.title")} aria-haspopup="menu" aria-expanded={ccOpen}
            data-tooltip={`${t("captions.title")} (${store.subtitleMode === "en" ? "EN" : "OFF"})`} onClick={() => { setSpeedOpen(false); setCcOpen((v) => !v); }}>
            {store.subtitleMode !== "off" ? <ICaptionsF size={18} /> : <ICaptions size={18} />}
          </Button>
          {ccOpen && (
            <div className="player-speed-menu player-cc-menu" role="menu" aria-label={t("captions.title")} onKeyDownCapture={event => {
              const entries = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"], [role="menuitem"]')];
              const index = entries.indexOf(document.activeElement as HTMLButtonElement);
              if (event.key === "Escape") {
                event.preventDefault(); event.stopPropagation(); setCcOpen(false);
                boxRef.current?.querySelector<HTMLButtonElement>('.player-cc')?.focus();
              } else if (event.key === "Tab") {
                setCcOpen(false);
              } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) && entries.length > 0) {
                event.preventDefault(); event.stopPropagation();
                const next = event.key === "Home" ? 0 : event.key === "End" ? entries.length - 1
                  : (index + (event.key === "ArrowDown" ? 1 : -1) + entries.length) % entries.length;
                entries[next]?.focus();
              }
            }}>
              <span className="player-menu-title">{t("captions.title")}</span>
              {([
                { id: "en", label: "English" },
                { id: "off", label: "Off" },
              ] as const).map((item) => (
                <Button key={item.id} role="menuitemradio" aria-checked={store.subtitleMode === item.id} onClick={() => {
                  store.setSubtitleMode(item.id);
                  setCcOpen(false);
                  boxRef.current?.querySelector<HTMLButtonElement>('.player-cc')?.focus();
                }}>
                  <span>{item.label}</span>{store.subtitleMode === item.id && <ICheck size={14} />}
                </Button>
              ))}
              {onOpenCaptions && (
                <Button role="menuitem" onClick={() => {
                  setCcOpen(false);
                  onOpenCaptions();
                }}>
                  <span>Customize / Import CC...</span>
                </Button>
              )}
            </div>
          )}
        </div>
        <div className="player-speed-slot">
          <Button className={`player-control player-speed ${rate !== 1 ? "is-on" : ""}`} aria-label={t("player.speed")} aria-haspopup="menu" aria-expanded={speedOpen}
            data-tooltip={t("player.speed")} onClick={() => { setCcOpen(false); setSpeedOpen((v) => !v); }}>
            {Number.isInteger(rate) ? rate.toFixed(1) : rate}x
          </Button>
          {speedOpen && (
            <div className="player-speed-menu player-rate-menu" role="menu" aria-label="Speed" onKeyDownCapture={event => {
              const entries = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
              const index = entries.indexOf(document.activeElement as HTMLButtonElement);
              if (event.key === "Escape") {
                event.preventDefault(); event.stopPropagation(); setSpeedOpen(false);
                boxRef.current?.querySelector<HTMLButtonElement>('.player-speed')?.focus();
              } else if (event.key === "Tab") {
                setSpeedOpen(false);
              } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                event.preventDefault(); event.stopPropagation();
                const next = event.key === "Home" ? 0 : event.key === "End" ? entries.length - 1
                  : (index + (event.key === "ArrowDown" ? 1 : -1) + entries.length) % entries.length;
                entries[next]?.focus();
              }
            }}>
              <span className="player-menu-title">Speed</span>
              {[0.5, 0.75, 1, 1.25, 1.5, 2].map((v) => (
                <Button key={v} role="menuitemradio" aria-checked={rate === v} onClick={() => {
                  onRate(v); setSpeedOpen(false);
                  boxRef.current?.querySelector<HTMLButtonElement>('.player-speed')?.focus();
                }}>
                  <span>{v === 1 ? "Normal" : `${v}x`}</span>{rate === v && <ICheck size={14} />}
                </Button>
              ))}
            </div>
          )}
        </div>
        <div className="player-volume">
          <Button className="player-control" aria-label={muted ? "Unmute" : "Mute"} data-tooltip={muted ? "Unmute" : "Mute"} onClick={onMute}>
            {muted || volume === 0 ? <IVolMute size={20} strokeWidth={1.6} /> : <IVol size={20} strokeWidth={1.6} />}
          </Button>
          <div className="player-volume-slider">
            <Input aria-label="Volume" type="range" min={0} max={1} step={0.01} value={muted ? 0 : volume}
              style={{ "--fill": `${(muted ? 0 : volume) * 100}%` } as React.CSSProperties}
              onChange={(e) => onVolume(Number(e.target.value))} />
          </div>
        </div>
        <Button className="player-control" aria-label="Lock controls" aria-pressed={false} data-tooltip="Lock controls" onClick={onLock}><ILockF size={18} /></Button>
        {!fullscreen && onTheater && (
          <Button className={`player-control ${theater ? "is-on" : ""}`} aria-label="Theater mode" aria-pressed={theater}
            data-tooltip="Theater" onClick={onTheater}><ITheater size={20} strokeWidth={1.6} /></Button>
        )}
        <Button className="player-control" aria-label={fullscreen ? "Exit Fullscreen" : "Fullscreen"} data-tooltip={fullscreen ? "Exit Fullscreen" : "Fullscreen"} onClick={onFullscreen}>
          {fullscreen ? <ICompress size={19} strokeWidth={1.6} /> : <IExpand size={19} strokeWidth={1.6} />}
        </Button>
      </div>
    </div>
  );
}
