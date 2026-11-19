/**
 * AuraStream AI English Voice Dubbing Service (Beta Prototype)
 * Synchronized Text-to-Speech (TTS) engine that speaks English dialogue in real-time.
 * Features dynamic speech rate scaling to avoid timing mismatches, automatic audio ducking,
 * and zero-latency cancellation on seek/pause.
 */

import type { SubtitleCue } from "./types";
import { formatSubtitleText } from "./dramaTranslator";

const STORAGE_KEYS = {
  ENABLED: "aurastream:voice_dub_enabled",
  VOLUME: "aurastream:voice_dub_volume",
  DUCKING: "aurastream:voice_dub_ducking",
};

let cachedVoices: SpeechSynthesisVoice[] = [];
let lastSpokenCueId: string | number | null = null;
let isDucked = false;

function loadVoices(): SpeechSynthesisVoice[] {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return [];
  if (cachedVoices.length) return cachedVoices;
  const voices = window.speechSynthesis.getVoices();
  if (voices.length) {
    cachedVoices = voices;
  }
  return cachedVoices;
}

if (typeof window !== "undefined" && "speechSynthesis" in window) {
  window.speechSynthesis.onvoiceschanged = () => {
    cachedVoices = window.speechSynthesis.getVoices();
  };
}

export function isVoiceDubEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEYS.ENABLED) === "true";
  } catch {
    return false;
  }
}

export function setVoiceDubEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEYS.ENABLED, String(enabled));
    if (!enabled) {
      cancelVoiceDub();
    }
    window.dispatchEvent(new CustomEvent("aurastream:voice-dub-changed", { detail: { enabled } }));
  } catch {
    // ignore
  }
}

export function getVoiceDubVolume(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.VOLUME);
    return raw ? Math.max(0.1, Math.min(1.0, parseFloat(raw))) : 1.0;
  } catch {
    return 1.0;
  }
}

export function setVoiceDubVolume(vol: number): void {
  try {
    const clamped = Math.max(0.1, Math.min(1.0, vol));
    localStorage.setItem(STORAGE_KEYS.VOLUME, String(clamped));
    window.dispatchEvent(new CustomEvent("aurastream:voice-dub-changed", { detail: { volume: clamped } }));
  } catch {
    // ignore
  }
}

export function isAudioDuckingEnabled(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.DUCKING);
    return raw === null ? true : raw === "true";
  } catch {
    return true;
  }
}

export function setAudioDuckingEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEYS.DUCKING, String(enabled));
  } catch {
    // ignore
  }
}

function getBestEnglishVoice(): SpeechSynthesisVoice | null {
  const voices = loadVoices();
  if (!voices.length) return null;

  // 1. Prefer natural Google English voices on Android
  const googleEn = voices.find(
    (v) => v.lang.startsWith("en") && (v.name.includes("Google") || v.name.includes("Natural")),
  );
  if (googleEn) return googleEn;

  // 2. Prefer standard en-US or en-GB
  const enUs = voices.find((v) => v.lang === "en-US");
  if (enUs) return enUs;

  const enAny = voices.find((v) => v.lang.startsWith("en"));
  if (enAny) return enAny;

  return null;
}

/**
 * Speaks an active cue in sync with the scene.
 * Dynamically adjusts speech rate so the voice finishes before the actor stops speaking.
 */
export function speakActiveCue(cue: SubtitleCue, videoEl?: HTMLVideoElement | null): void {
  if (!isVoiceDubEnabled()) return;
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  if (document.visibilityState !== "visible") return;
  if (videoEl && videoEl.paused) return;

  // Avoid repeating the same cue multiple times
  if (lastSpokenCueId === cue.id) return;
  lastSpokenCueId = cue.id;

  const text = formatSubtitleText(cue.en || cue.zh);
  if (!text || text.trim().length === 0) return;

  // Cancel any prior speech to keep tight synchronization with current frame
  window.speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  const voice = getBestEnglishVoice();
  if (voice) {
    utterance.voice = voice;
  }

  // Calculate dynamic speech rate based on cue duration
  // Normal speech is ~2.8 words/second.
  const durationSec = Math.max(0.6, cue.end - cue.start);
  const wordCount = text.trim().split(/\s+/).length;
  const naturalDuration = wordCount / 2.8;

  // If the text is longer than the scene time, speed up proportionally (up to 1.7x)
  let rate = naturalDuration > durationSec ? naturalDuration / durationSec : 1.05;
  rate = Math.min(1.7, Math.max(1.0, rate));

  utterance.rate = rate;
  utterance.pitch = 1.0;
  utterance.volume = getVoiceDubVolume();

  // Audio Ducking: lower original video volume so English speech is clearly intelligible
  if (videoEl && isAudioDuckingEnabled()) {
    try {
      videoEl.volume = 0.22;
      isDucked = true;
    } catch {
      // ignore
    }
  }

  const restoreVolume = () => {
    if (videoEl && isDucked) {
      try {
        videoEl.volume = 1.0;
        isDucked = false;
      } catch {
        // ignore
      }
    }
  };

  utterance.onend = restoreVolume;
  utterance.onerror = restoreVolume;

  try {
    window.speechSynthesis.speak(utterance);
  } catch {
    restoreVolume();
  }
}

/**
 * Cancels any active speech synthesis and restores video volume immediately.
 */
export function cancelVoiceDub(videoEl?: HTMLVideoElement | null): void {
  lastSpokenCueId = null;
  if (typeof window !== "undefined" && "speechSynthesis" in window) {
    try {
      window.speechSynthesis.cancel();
    } catch {
      // ignore
    }
  }
  if (videoEl && isDucked) {
    try {
      videoEl.volume = 1.0;
      isDucked = false;
    } catch {
      // ignore
    }
  }
}
