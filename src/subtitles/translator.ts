/**
 * AuraStream Real-Time Dialogue & Subtitle Translator
 * Translates Chinese and foreign-language dialogue into fluent, natural English.
 * Supports in-memory caching, offline fallback dictionary, and batch queueing.
 */

import type { SubtitleCue, SubtitleTrack } from "./types";
import { formatDramaDesc, formatDramaTitle } from "./dramaTranslator";

const MEMORY_CACHE = new Map<string, string>();
const STORAGE_KEY = "aurastream_dialogue_tr_v1";

// Seed common drama dialogue patterns for instant, offline English translation
const DIALOGUE_DICTIONARY: Record<string, string> = {
  "你好": "Hello",
  "再见": "Goodbye",
  "谢谢": "Thank you",
  "对不起": "I am sorry",
  "没关系": "It doesn't matter",
  "住手": "Stop right there!",
  "放开她": "Let her go!",
  "放开我": "Let me go!",
  "你以为你是谁": "Who do you think you are?",
  "签字吧": "Sign the papers",
  "离婚": "Divorce",
  "滚出苏家": "Get out of the Su family!",
  "董事长": "Chairman",
  "总裁": "CEO",
  "夫人": "Madam",
  "少爷": "Young Master",
  "战神": "God of War",
  "龙王": "Dragon King",
  "神医": "Divine Doctor",
  "救命": "Help me!",
  "为什么": "Why?",
  "怎么可能": "How is that possible?",
  "三年之期已到": "The three-year term has arrived",
  "恭迎龙王回归": "Welcome the Dragon King back!",
  "我不同意": "I disagree",
  "你敢": "How dare you!",
  "别碰我": "Don't touch me!",
  "这不可能": "This is impossible",
  "你到底是谁": "Who on earth are you?",
  "从今天起": "Starting from today",
  "快走": "Leave quickly!",
  "等一下": "Wait a moment",
  "你疯了吗": "Have you gone mad?",
  "不知死活": "Courting death!",
  "找死": "You seek death!",
  "听到了没有": "Did you hear me?",
};

// Load persisted cache on module initialization
try {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) {
    const obj = JSON.parse(stored);
    if (obj && typeof obj === "object") {
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === "string") MEMORY_CACHE.set(k, v);
      }
    }
  }
} catch {
  // ignore storage errors
}

function persistCache(): void {
  try {
    const obj: Record<string, string> = {};
    let count = 0;
    // Persist up to 200 most recent translations
    for (const [k, v] of MEMORY_CACHE.entries()) {
      obj[k] = v;
      if (++count >= 200) break;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
  } catch {
    // ignore
  }
}

/**
 * Checks whether a text contains foreign characters (such as Chinese ideographs)
 */
export function containsForeignLanguage(text: string): boolean {
  return /[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/.test(text);
}

/**
 * Translates a single line or short paragraph of foreign dialogue to English
 */
export async function translateDialogueToEnglish(text: string): Promise<string> {
  const trimmed = text.trim();
  if (!trimmed || !containsForeignLanguage(trimmed)) {
    return trimmed;
  }

  // 1. Check in-memory / persisted cache
  const cached = MEMORY_CACHE.get(trimmed);
  if (cached) return cached;

  // 2. Check exact dictionary match
  if (DIALOGUE_DICTIONARY[trimmed]) {
    const res = DIALOGUE_DICTIONARY[trimmed];
    MEMORY_CACHE.set(trimmed, res);
    return res;
  }

  // 3. Query fast, free public translation endpoint (MyMemory)
  try {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(trimmed)}&langpair=zh|en`;
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (res.ok) {
      const data = await res.json();
      const trText = data?.responseData?.translatedText;
      if (trText && typeof trText === "string" && trText.trim() && !trText.includes("MYMEMORY WARNING")) {
        const clean = trText.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
        // If the translation actually returned non-Chinese English text
        if (!containsForeignLanguage(clean)) {
          MEMORY_CACHE.set(trimmed, clean);
          persistCache();
          return clean;
        }
      }
    }
  } catch {
    // network timeout or failure, proceed to fallback
  }

  // 4. Offline rule-based transliterator / dictionary fallback
  let fallback = trimmed;
  for (const [zh, en] of Object.entries(DIALOGUE_DICTIONARY)) {
    if (fallback.includes(zh)) {
      fallback = fallback.split(zh).join(` ${en} `);
    }
  }
  fallback = formatDramaDesc(fallback).replace(/\s+/g, " ").trim();
  if (fallback && fallback !== trimmed) {
    MEMORY_CACHE.set(trimmed, fallback);
    return fallback;
  }

  return formatDramaTitle(trimmed);
}

/**
 * Synchronous dictionary / transliterator fallback for immediate parser usage.
 */
export function translateDialogueSync(text: string): string {
  const trimmed = text.trim();
  if (!trimmed || !containsForeignLanguage(trimmed)) {
    return trimmed;
  }
  const cached = MEMORY_CACHE.get(trimmed);
  if (cached) return cached;

  if (DIALOGUE_DICTIONARY[trimmed]) {
    const res = DIALOGUE_DICTIONARY[trimmed];
    MEMORY_CACHE.set(trimmed, res);
    return res;
  }

  let fallback = trimmed;
  for (const [zh, en] of Object.entries(DIALOGUE_DICTIONARY)) {
    if (fallback.includes(zh)) {
      fallback = fallback.split(zh).join(` ${en} `);
    }
  }
  fallback = formatDramaDesc(fallback).replace(/\s+/g, " ").trim();
  if (fallback && fallback !== trimmed) {
    MEMORY_CACHE.set(trimmed, fallback);
    return fallback;
  }

  return formatDramaTitle(trimmed);
}

/**
 * Translates an array of subtitle cues to English in place or cloned.
 * Preserves cue timings while populating cue.en with natural English text.
 */
export async function translateCuesToEnglish(cues: SubtitleCue[]): Promise<SubtitleCue[]> {
  if (!Array.isArray(cues) || cues.length === 0) return [];

  const results: SubtitleCue[] = [];
  const batchSize = 6;

  for (let i = 0; i < cues.length; i += batchSize) {
    const chunk = cues.slice(i, i + batchSize);
    const translatedChunk = await Promise.all(
      chunk.map(async (cue) => {
        // If cue.en is already authentic English (no Chinese characters), keep it
        if (cue.en && !containsForeignLanguage(cue.en)) {
          return cue;
        }

        // Determine source text (original zh or existing text)
        const sourceText = cue.zh || cue.en || "";
        if (!sourceText || !containsForeignLanguage(sourceText)) {
          return { ...cue, en: sourceText };
        }

        const englishText = await translateDialogueToEnglish(sourceText);
        return {
          ...cue,
          en: englishText,
          zh: cue.zh || sourceText,
        };
      })
    );
    results.push(...translatedChunk);
  }

  return results;
}

/**
 * Translates a SubtitleTrack into English, caching and updating both en and zh representations
 */
export async function translateTrackToEnglish(track: SubtitleTrack): Promise<SubtitleTrack> {
  if (!track || !track.cues || track.cues.length === 0) return track;
  const translatedCues = await translateCuesToEnglish(track.cues);
  return {
    ...track,
    cues: translatedCues,
  };
}
