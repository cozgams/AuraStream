/**
 * AuraStream Playback Power Features
 * - Sleep Timer (with gentle audio fade-out and episode end triggers)
 * - Auto-Skip Intro (bypasses repetitive 3-6s intro cards for seamless binge watching)
 * - AMOLED True-Black Theme for OLED phone battery preservation
 */

export type SleepTimerOption = "off" | "15" | "30" | "45" | "60" | "episode_end";

const SKIP_INTRO_KEY = "aurastream_auto_skip_intro_sec_v1";
const AMOLED_KEY = "aurastream_amoled_mode_v1";

let sleepTimerTimeout: ReturnType<typeof setTimeout> | null = null;
let sleepTimerEndTime: number | null = null;
let sleepTimerOption: SleepTimerOption = "off";
let sleepTimerCallback: (() => void) | null = null;
const sleepTimerListeners = new Set<(remainingSec: number | null, option: SleepTimerOption) => void>();

function notifySleepTimer(remainingOverride?: number | null) {
  const remaining =
    remainingOverride !== undefined
      ? remainingOverride
      : sleepTimerEndTime
        ? Math.max(0, Math.round((sleepTimerEndTime - Date.now()) / 1000))
        : null;
  for (const listener of sleepTimerListeners) {
    try {
      listener(remaining, sleepTimerOption);
    } catch {
      // ignore
    }
  }
}

/**
 * Sets or updates the active Sleep Timer
 */
export function setSleepTimer(option: SleepTimerOption, onTrigger?: () => void): void {
  if (sleepTimerTimeout) {
    clearTimeout(sleepTimerTimeout);
    sleepTimerTimeout = null;
  }
  sleepTimerOption = option;
  if (onTrigger) {
    sleepTimerCallback = onTrigger;
  }

  if (option === "off" || option === "episode_end") {
    sleepTimerEndTime = null;
    notifySleepTimer();
    return;
  }

  const minutes = Number(option);
  if (!Number.isFinite(minutes) || minutes <= 0) return;

  const ms = minutes * 60 * 1000;
  sleepTimerEndTime = Date.now() + ms;
  notifySleepTimer();

  sleepTimerTimeout = setTimeout(() => {
    sleepTimerTimeout = null;
    sleepTimerEndTime = null;
    sleepTimerOption = "off";
    notifySleepTimer(0);
    if (sleepTimerCallback) {
      sleepTimerCallback();
    }
  }, ms);
}

/**
 * Checks if Sleep Timer is set to finish at current episode end
 */
export function checkSleepTimerEpisodeEnd(onTrigger: () => void): void {
  if (sleepTimerOption === "episode_end") {
    sleepTimerOption = "off";
    sleepTimerEndTime = null;
    notifySleepTimer();
    onTrigger();
  }
}

export function subscribeSleepTimer(
  listener: (remainingSec: number | null, option: SleepTimerOption) => void
): () => void {
  sleepTimerListeners.add(listener);
  const remaining = sleepTimerEndTime ? Math.max(0, Math.round((sleepTimerEndTime - Date.now()) / 1000)) : null;
  listener(remaining, sleepTimerOption);
  return () => sleepTimerListeners.delete(listener);
}

export function getSleepTimerOption(): SleepTimerOption {
  return sleepTimerOption;
}

/* ── Auto-Skip Intro ────────────────────────────────────────────── */

export function getAutoSkipIntroSec(): number {
  try {
    const val = localStorage.getItem(SKIP_INTRO_KEY);
    return val ? Number(val) || 0 : 0;
  } catch {
    return 0;
  }
}

export function setAutoSkipIntroSec(sec: number): void {
  try {
    localStorage.setItem(SKIP_INTRO_KEY, String(sec));
    window.dispatchEvent(new CustomEvent("aurastream:playback-config-changed"));
  } catch {
    // ignore
  }
}

/* ── AMOLED Mode Cleanup (Disabled: Restore Clean White Theme) ────── */

export function isAmoledModeEnabled(): boolean {
  return false;
}

export function setAmoledModeEnabled(_enabled: boolean): void {
  try {
    localStorage.removeItem(AMOLED_KEY);
    applyAmoledTheme(false);
  } catch {
    // ignore
  }
}

export function applyAmoledTheme(_enabled?: boolean): void {
  if (typeof document === "undefined") return;
  document.documentElement.classList.remove("theme-amoled");
  try { localStorage.removeItem(AMOLED_KEY); } catch { /* ignore */ }
}

/* ── Smart Buffering & Preload Auto-Cleaner ──────────────────────── */
export {
  isFullEpisodePreCacheEnabled,
  setFullEpisodePreCacheEnabled,
  isNextEpisodePreloadEnabled,
  setNextEpisodePreloadEnabled,
  isTempCacheAutoCleanEnabled,
  setTempCacheAutoCleanEnabled,
  getTempCacheStats,
  clearAllTempCache,
  runAutoCleaner,
  preloadEpisode,
  markEpisodeActive,
  subscribeTempCache,
  type TempCacheStats,
  type PreloadedEpisode,
} from "./playback/tempCacheService";

/* ── 1-Tap RAM Booster & Deep Cache Purge ───────────────────────── */
export {
  runDeepRamPurge,
  getRamDiagnostics,
  type RamDiagnostics,
  type RamPurgeResult,
} from "./playback/ramBooster";

