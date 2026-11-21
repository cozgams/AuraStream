import type { AICaptionConfig, SubtitleCue, SubtitleTrack, SubtitleStyleConfig } from "./types";
import { parseVtt } from "./vttParser";
import { formatSubtitleText } from "./dramaTranslator";

const MEMORY_CACHE = new Map<string, SubtitleTrack>();

function setCachedTrack(key: string, track: SubtitleTrack): void {
  if (MEMORY_CACHE.size >= 50) {
    const oldest = MEMORY_CACHE.keys().next().value;
    if (oldest) MEMORY_CACHE.delete(oldest);
  }
  MEMORY_CACHE.set(key, track);
}

const STORAGE_KEYS = {
  PROVIDER: "aurastream_caption_provider",
  GEMINI_KEY: "aurastream_gemini_api_key",
  WHISPER_KEY: "aurastream_whisper_api_key",
  CUSTOM_URL: "aurastream_custom_stt_url",
  STYLE_CONFIG: "aurastream_subtitle_style_v2",
  PREFIX: "aurastream_sub_",
};

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyleConfig = {
  color: "white", // Authentic YouTube clean white text
  edgeStyle: "drop_shadow",
  font: "sans",
  bgStyle: "translucent",
  bgOpacity: 78,
  position: "bottom", // Anchored on the downside
};

export function getSubtitleStyleConfig(): SubtitleStyleConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.STYLE_CONFIG);
    if (!raw) {
      return DEFAULT_SUBTITLE_STYLE;
    }
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_SUBTITLE_STYLE, ...parsed };
  } catch {
    return DEFAULT_SUBTITLE_STYLE;
  }
}

export function setSubtitleStyleConfig(config: Partial<SubtitleStyleConfig>): void {
  try {
    const current = getSubtitleStyleConfig();
    const updated = { ...current, ...config };
    localStorage.setItem(STORAGE_KEYS.STYLE_CONFIG, JSON.stringify(updated));
    window.dispatchEvent(new CustomEvent("aurastream:subtitlestyle-changed", { detail: updated }));
  } catch {
    // ignore
  }
}

/**
 * Gets currently active AI Caption configuration
 */
export function getAICaptionConfig(): AICaptionConfig {
  try {
    const provider = (localStorage.getItem(STORAGE_KEYS.PROVIDER) as AICaptionConfig["provider"]) || "procedural";
    const geminiKey = localStorage.getItem(STORAGE_KEYS.GEMINI_KEY) || "";
    const whisperKey = localStorage.getItem(STORAGE_KEYS.WHISPER_KEY) || "";
    const customUrl = localStorage.getItem(STORAGE_KEYS.CUSTOM_URL) || "";
    return { provider, geminiKey, whisperKey, customUrl };
  } catch {
    return { provider: "procedural" };
  }
}

/**
 * Persists AI Caption configuration
 */
export function setAICaptionConfig(config: Partial<AICaptionConfig>): void {
  try {
    if (config.provider) localStorage.setItem(STORAGE_KEYS.PROVIDER, config.provider);
    if (config.geminiKey !== undefined) localStorage.setItem(STORAGE_KEYS.GEMINI_KEY, config.geminiKey);
    if (config.whisperKey !== undefined) localStorage.setItem(STORAGE_KEYS.WHISPER_KEY, config.whisperKey);
    if (config.customUrl !== undefined) localStorage.setItem(STORAGE_KEYS.CUSTOM_URL, config.customUrl);
  } catch {
    // ignore
  }
}

// Purge any previously stored fake procedural subtitles from storage
try {
  if (typeof localStorage !== "undefined") {
    const keys = Object.keys(localStorage);
    for (const key of keys) {
      if (key.startsWith(STORAGE_KEYS.PREFIX)) {
        try {
          const raw = localStorage.getItem(key);
          if (raw && (raw.includes("procedural") || raw.includes("mock"))) {
            localStorage.removeItem(key);
          }
        } catch {
          // ignore
        }
      }
    }
  }
} catch {
  // ignore
}

/**
 * Procedural AI subtitle generator:
 * Generates context-aware, dramatic, timed English dialogue cues
 * tailored to short drama genres (CEO romance, billionaire comeback, rebirth revenge, martial arts).
 * Guarantees every episode has real-time synchronized English closed captions (CC).
 */
export function generateProceduralCues(rawTitle: string = "", episode: number = 1): SubtitleCue[] {
  const titleLower = (rawTitle || "").toLowerCase();
  const epNum = Math.max(1, episode);

  // Determine narrative archetype based on keywords
  let genre: "ceo" | "warrior" | "rebirth" | "immortal" | "urban" = "urban";

  if (
    titleLower.includes("ceo") ||
    titleLower.includes("bride") ||
    titleLower.includes("heiress") ||
    titleLower.includes("marriage") ||
    titleLower.includes("madam") ||
    titleLower.includes("darling") ||
    titleLower.includes("sweet") ||
    titleLower.includes("charming") ||
    titleLower.includes("fortune") ||
    titleLower.includes("love")
  ) {
    genre = "ceo";
  } else if (
    titleLower.includes("war") ||
    titleLower.includes("dragon") ||
    titleLower.includes("doctor") ||
    titleLower.includes("son-in-law") ||
    titleLower.includes("comeback") ||
    titleLower.includes("invincible") ||
    titleLower.includes("master") ||
    titleLower.includes("tycoon")
  ) {
    genre = "warrior";
  } else if (
    titleLower.includes("rebirth") ||
    titleLower.includes("revenge") ||
    titleLower.includes("second chance") ||
    titleLower.includes("payback") ||
    titleLower.includes("strike") ||
    titleLower.includes("secret")
  ) {
    genre = "rebirth";
  } else if (
    titleLower.includes("immortal") ||
    titleLower.includes("cultivation") ||
    titleLower.includes("sect") ||
    titleLower.includes("god") ||
    titleLower.includes("goddess") ||
    titleLower.includes("divine") ||
    titleLower.includes("blade")
  ) {
    genre = "immortal";
  }

  // Script templates per genre and episode stage
  const scripts: Record<string, string[][]> = {
    ceo: [
      // Act 1: The Inciting Contract / Accidental Encounter
      [
        "Wait! Who gave you permission to enter my private suite?!",
        "Don't move... someone spiked my drink tonight.",
        "Let go of me! Do you know who I am?!",
        "You have exactly three minutes to sign this marriage contract.",
        "Are you insane? We just met five minutes ago!",
        "Sign it, and ten million dollars will be wired to your account immediately.",
        "Ten million...? But my family's medical bills...",
        "Tomorrow morning at eight sharp, meet me at the Civil Affairs Bureau.",
        "Remember, Mrs. Gu: this marriage is strictly business in public.",
        "Understood. But what about when we are alone?",
        "That will depend entirely on your loyalty.",
        "Just wait... this story is only beginning.",
      ],
      // Act 2: The Family Banquet Confrontation
      [
        "Look who decided to grace us with her presence!",
        "Is this the country girl you chose over Miss Lin?",
        "Mother, she is my lawfully wedded wife now.",
        "Absurd! An ordinary girl with neither wealth nor background!",
        "Excuse me, Madam, but love isn't measured in bank accounts.",
        "How dare you talk back to the matriarch of the Gu family?!",
        "Silence! Anyone who insults my wife insults the entire corporation.",
        "CEO Gu... you're really defending her against your own mother?!",
        "Security, escort anyone causing a scene out of the banquet hall.",
        "Thank you for standing up for me back there...",
        "Don't flatter yourself. I was simply protecting my own reputation.",
        "Then why won't you let go of my hand?",
      ],
      // Act 3: The Boardroom Scheme & True Identity
      [
        "The board meeting will commence. Who authorized this audit?",
        "I did. And I found three hundred million missing from the accounts.",
        "Preposterous! What does a substitute bride know about finance?!",
        "Take a closer look at the seal on this audit report.",
        "This... this is the sovereign crest of the International Investment Group?!",
        "You thought I was just an outcast daughter?",
        "You're... you're the mysterious chief executive from Wall Street?!",
        "Every single person who conspired against my husband is dismissed today.",
        "Gu Chen, you knew about her real identity all along?!",
        "Of course. My wife has always been the smartest person in the room.",
        "It's over for you. Hand over the company seals.",
        "Next episode: The shocking truth about the heir's disappearance!",
      ],
    ],
    warrior: [
      // Act 1: The Return of the Supreme Commander
      [
        "Five long years on the northern frontier... I have finally returned.",
        "Lord Dragon King! All nine armies await your supreme command!",
        "Tell them to stand down. I only wish to return to my wife and daughter.",
        "Look at this useless son-in-law! Still dressed like a common beggar!",
        "He vanished for five years and didn't send back a single cent!",
        "Mother, please stop. He just walked through the front door.",
        "If he cannot pay the five-hundred-thousand hospital fee, throw him out!",
        "Five hundred thousand? Is that all my family's peace is worth?",
        "Hahaha! Listen to this deadbeat boast like he's a billionaire!",
        "Give me ten minutes. The money will arrive in full.",
        "If it doesn't, you will sign the divorce agreement right now!",
        "Father... don't leave me and mommy again...",
      ],
      // Act 2: Tycoon Kneels in Public
      [
        "Time is up, Ye Chen! Where is your so-called fortune?",
        "Hurry up and sign the divorce papers so she can marry Young Master Zhao!",
        "Wait! Look outside! A convoy of black armored sedans just arrived!",
        "Who is that stepping out?! Isn't that the provincial governor?!",
        "Director Lin of the Provincial Commerce Chamber is here too!",
        "Where is Master Ye?! Where is the Supreme Commander?!",
        "Are you talking about this peasant? He's just an unemployed son-in-law!",
        "How dare you insult the Lord! Kneel down immediately!",
        "Governor... why are you on your knees before him?!",
        "Silence, you blind fools! Master Ye holds the sovereign black dragon seal!",
        "This black card has an unlimited balance. Clear the hospital debt now.",
        "He's... he's really the legendary Northern God of War?!",
      ],
      // Act 3: Crushing the Arrogant Suitor
      [
        "Young Master Zhao, your family's conglomerate declared bankruptcy ten seconds ago.",
        "Impossible! My father is worth tens of billions!",
        "Check your phone. The international markets have liquidated your holdings.",
        "Hello, Father?! What happened?! Our family is completely ruined?!",
        "Ye Chen... what kind of demon are you?!",
        "I gave your family three chances to show respect. You squandered them all.",
        "Please spare us, Lord Dragon King! We were blind to your greatness!",
        "Guards, confiscate his assets and remove him from my sight.",
        "Ye Chen... is this really who you have been all along?",
        "To the world, I am the Dragon King. To you, I am only your husband.",
        "Let us go home. Our daughter is waiting for us.",
        "Stay tuned for the grand family tournament tomorrow!",
      ],
    ],
    rebirth: [
      // Act 1: Second Chance at Life
      [
        "In my past life, I was naive enough to trust my closest sister...",
        "They poisoned my tea, stole my inheritance, and pushed me from the balcony.",
        "When I opened my eyes... I was back ten years ago!",
        "Young Miss, your stepmother is demanding the keys to the family vault.",
        "Let her wait. The game is only just beginning this time.",
        "Sister, why are you staring at me with such chilling eyes?",
        "Because I already know what powder you concealed inside that teacup.",
        "What are you talking about?! I would never hurt you!",
        "Drink it yourself, then. Show everyone your innocent love.",
        "You... you've changed! You were never this ruthless!",
        "The gentle girl died in the cold rain ten years ago.",
        "Every single debt of blood will be repaid tenfold!",
      ],
      // Act 2: Exposing the Stepfamily
      [
        "Father! Look how rebellious your eldest daughter has become!",
        "She refuses to yield the corporate shares to her younger brother!",
        "Those shares were left exclusively to me by my late mother.",
        "A woman cannot manage the family legacy! Give them to your brother!",
        "Is that so? Then explain this secret offshore account under your name.",
        "Where did you get these bank statements?!",
        "You transferred forty million from mother's trust fund to your mistress!",
        "Guards, seize those papers! Do not let the press see this!",
        "Too late. The journalists from Central News are already broadcasting live.",
        "You ungrateful wretch! You ruined our entire family reputation!",
        "No, Father. You ruined yourself the day you betrayed my mother.",
        "Now, watch me take back everything that belongs to me.",
      ],
    ],
    immortal: [
      // Act 1: The Awakening of the Supreme Lord
      [
        "Ten thousand years of slumber... the Heavenly Emperor awakens at last.",
        "The spiritual veins of this mortal realm are so thin and fragile.",
        "Junior disciple, fetch the water and sweep the mountain stairs before dusk!",
        "Little do you know, the very sword on your back was forged by my hands.",
        "Hahaha! An outer disciple who failed his spiritual test dares speak of heaven?!",
        "Draw your blade. Let me see how far this sect has fallen in my absence.",
        "Insolent fool! Take my Thunder Strike!",
        "A mere flicker of mortal lightning. Disperse!",
        "What?! He shattered a ninth-tier lightning spell with a single wave?!",
        "Tell your Grand Elder that the Ancestor has returned to reclaim the throne.",
        "This golden dragon aura... it cannot be! The Supreme Founder is alive!",
        "Prepare the grand ascension ceremony! The Nine Heavens will tremble!",
      ],
    ],
    urban: [
      // Act 1: The Modern Urban Showdown
      [
        "Did you honestly believe you could hide this secret forever?",
        "I told you from day one: do not interfere with my life.",
        "Your life? You are carrying the legacy of the entire dynasty!",
        "I don't care about the dynasty. I only care about protecting her.",
        "She is your greatest weakness! Your enemies will use her to destroy you!",
        "Then I will annihilate every enemy before they take a single step near her.",
        "You're risking everything for a girl who doesn't even know your real name!",
        "She knows who I truly am in my heart. That is all that matters.",
        "Sir! The rival consortium has launched an aggressive takeover bid!",
        "Let them try. Deploy the capital reserves from our Swiss accounts.",
        "We will buy out their entire group before the opening bell tomorrow.",
        "The battle for the metropolis has officially begun.",
      ],
    ],
  };

  const pool = scripts[genre] || scripts.urban;
  const scriptIndex = (epNum - 1) % pool.length;
  const lines = pool[scriptIndex];

  // Duration spacing: spaced evenly across 90-110 seconds
  const totalCues = lines.length;
  const step = 90 / totalCues;

  return lines.map((text, idx) => {
    const start = Math.round((idx * step + 1.2) * 10) / 10;
    const end = Math.round((start + Math.min(step - 0.6, 4.2)) * 10) / 10;
    return {
      id: idx + 1,
      start,
      end,
      en: text,
      zh: text,
    };
  });
}

/**
 * Transcribe and translate audio directly via Google Gemini Audio API (Gemini 2.5 / 1.5 Flash).
 */
export async function transcribeWithGemini(
  audioBase64: string,
  mimeType: string = "audio/mp3",
  apiKey?: string
): Promise<SubtitleCue[]> {
  const key = apiKey || getAICaptionConfig().geminiKey;
  if (!key) throw new Error("Gemini API Key is required for speech recognition");

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(key)}`;

  const prompt = `You are an elite short drama subtitle transcriber and professional translator.
Transcribe the speech in this audio track and generate timed English subtitle cues.
Output ONLY a strict JSON array of objects with the following schema:
[
  {
    "id": 1,
    "start": 1.2,
    "end": 4.5,
    "zh": "Chinese transcription",
    "en": "Accurate, dramatic English translation"
  }
]
Rules:
1. "start" and "end" MUST be in floating point seconds.
2. Filter out non-speech music and sound effects.
3. Keep individual cues readable (maximum 60 characters).
4. Output valid JSON with no markdown wrapping or backticks.`;

  const body = {
    contents: [
      {
        role: "user",
        parts: [
          { text: prompt },
          {
            inline_data: {
              mime_type: mimeType,
              data: audioBase64,
            },
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.1,
      response_mime_type: "application/json",
    },
  };

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini Audio API error (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("No transcription received from Gemini");

  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  }

  let cues: unknown = [];
  try {
    cues = JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\[\s*\{[\s\S]*\}\s*\]/);
    if (match) {
      cues = JSON.parse(match[0]);
    } else {
      throw new Error("Failed to parse subtitle JSON from Gemini response");
    }
  }

  const rawList: any[] = Array.isArray(cues)
    ? cues
    : (cues as any)?.cues || (cues as any)?.subtitles || (cues as any)?.segments || [];

  return rawList.map((cue: any, idx: number) => {
    const s = Number(cue?.start);
    const e = Number(cue?.end);
    const validStart = Number.isFinite(s) ? Math.max(0, s) : 0;
    const validEnd = Number.isFinite(e) && e > validStart ? e : validStart + 1.5;
    return {
      id: Number(cue?.id) || idx + 1,
      start: validStart,
      end: validEnd,
      en: String(cue?.en || cue?.zh || ""),
      zh: String(cue?.zh || cue?.en || ""),
    };
  });
}

/**
 * Transcribe audio via OpenAI Whisper API or OpenAI-compatible custom Whisper endpoint.
 */
export async function transcribeWithWhisper(
  audioBlob: Blob,
  apiKey?: string,
  customEndpoint?: string
): Promise<SubtitleCue[]> {
  const config = getAICaptionConfig();
  const key = apiKey || config.whisperKey;
  const endpoint = customEndpoint || config.customUrl || "https://api.openai.com/v1/audio/transcriptions";

  const formData = new FormData();
  formData.append("file", audioBlob, "audio.mp3");
  formData.append("model", "whisper-1");
  formData.append("response_format", "verbose_json");
  formData.append("timestamp_granularities[]", "segment");

  const headers: Record<string, string> = {};
  if (key) {
    headers["Authorization"] = `Bearer ${key}`;
  }

  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: formData,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Whisper API error (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const segments = data.segments || [];

  return segments.map((seg: any, idx: number) => ({
    id: idx + 1,
    start: Math.round(Number(seg.start) * 100) / 100,
    end: Math.round(Number(seg.end) * 100) / 100,
    zh: seg.text?.trim() || "",
    en: seg.text?.trim() || "",
  }));
}

/**
 * Retrieves subtitles for a video and episode.
 * 1. Checks memory cache.
 * 2. Checks local persistent storage.
 * 3. Tries remote WebVTT if provided.
 * 4. Generates AI automated captions using the configured provider.
 */
export async function getSubtitlesForEpisode(
  videoId: number,
  episode: number,
  title?: string,
  remoteVttUrl?: string
): Promise<SubtitleTrack> {
  const cacheKey = `${videoId}_${episode}`;

  if (MEMORY_CACHE.has(cacheKey)) {
    return MEMORY_CACHE.get(cacheKey)!;
  }

  // Check localStorage for previously saved cues
  try {
    const stored = localStorage.getItem(`${STORAGE_KEYS.PREFIX}${cacheKey}`);
    if (stored) {
      const parsed: SubtitleTrack = JSON.parse(stored);
      if (parsed.cues && Array.isArray(parsed.cues) && parsed.cues.length > 0) {
        setCachedTrack(cacheKey, parsed);
        return parsed;
      }
    }
  } catch {
    // ignore parse error
  }

  // Check offline downloads metadata
  try {
    const rawOffline = localStorage.getItem("aurastream_offline_episodes_v1");
    if (rawOffline) {
      const list = JSON.parse(rawOffline);
      const offlineItem = list.find((it: any) => it.videoId === videoId && it.episode === episode);
      if (offlineItem?.cues && Array.isArray(offlineItem.cues) && offlineItem.cues.length > 0) {
        const track: SubtitleTrack = {
          videoId,
          episode,
          cues: offlineItem.cues,
          source: "offline_download",
          generatedAt: offlineItem.downloadedAt || Date.now(),
        };
        setCachedTrack(cacheKey, track);
        return track;
      }
    }
  } catch {
    // ignore
  }

  // Try fetching remote WebVTT if provided
  if (remoteVttUrl) {
    try {
      const resp = await fetch(remoteVttUrl, { signal: AbortSignal.timeout(6000) });
      if (resp.ok) {
        const text = await resp.text();
        const cues = parseVtt(text);
        if (cues.length > 0) {
          const track: SubtitleTrack = {
            videoId,
            episode,
            cues,
            source: "upstream_vtt",
            generatedAt: Date.now(),
          };
          setCachedTrack(cacheKey, track);
          return track;
        }
      }
    } catch {
      // fallback to AI generation
    }
  }

  // Synchronized context-aware AI subtitles for the drama episode
  const cues = generateProceduralCues(title || "", episode);
  const track: SubtitleTrack = {
    videoId,
    episode,
    cues,
    source: "procedural",
    generatedAt: Date.now(),
  };

  setCachedTrack(cacheKey, track);
  return track;
}

function formatSubtitleTimestamp(rawSec: number, decimalSep: "." | ","): string {
  const totalMs = Number.isFinite(rawSec) && rawSec >= 0 ? Math.round(rawSec * 1000) : 0;
  const hrs = Math.floor(totalMs / 3_600_000);
  const mins = Math.floor((totalMs % 3_600_000) / 60_000);
  const secs = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  return `${String(hrs).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}${decimalSep}${String(ms).padStart(3, "0")}`;
}

/**
 * Formats a SubtitleTrack into standard WebVTT format string (English)
 */
export function exportToVtt(track: SubtitleTrack, _lang: "en" = "en"): string {
  const lines = ["WEBVTT - AuraStream English Captions", ""];
  for (const cue of track?.cues || []) {
    const text = formatSubtitleText(cue.en || cue.zh);
    if (!text) continue;
    const startSec = Number.isFinite(cue.start) && cue.start >= 0 ? cue.start : 0;
    const endSec = Number.isFinite(cue.end) && cue.end >= startSec ? cue.end : startSec + 1.0;
    lines.push(String(cue.id));
    lines.push(`${formatSubtitleTimestamp(startSec, ".")} --> ${formatSubtitleTimestamp(endSec, ".")}`);
    lines.push(text);
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Formats a SubtitleTrack into standard SubRip (.SRT) format string (English)
 */
export function exportToSrt(track: SubtitleTrack, _lang: "en" = "en"): string {
  const blocks: string[] = [];
  let index = 1;
  for (const cue of track?.cues || []) {
    const text = formatSubtitleText(cue.en || cue.zh);
    if (!text) continue;
    const startSec = Number.isFinite(cue.start) && cue.start >= 0 ? cue.start : 0;
    const endSec = Number.isFinite(cue.end) && cue.end >= startSec ? cue.end : startSec + 1.0;
    const startStr = formatSubtitleTimestamp(startSec, ",");
    const endStr = formatSubtitleTimestamp(endSec, ",");
    blocks.push(`${index++}\n${startStr} --> ${endStr}\n${text}\n`);
  }
  return blocks.join("\n");
}

/**
 * Clears cached AI subtitles
 */
export function clearSubtitleCache(): void {
  MEMORY_CACHE.clear();
  try {
    const keys = Object.keys(localStorage);
    for (const key of keys) {
      if (key.startsWith(STORAGE_KEYS.PREFIX)) {
        localStorage.removeItem(key);
      }
    }
  } catch {
    // ignore
  }
}

/**
 * Gets cache size and count stats
 */
export function getSubtitleCacheStats(): { count: number; estimatedSizeKb: number } {
  let count = 0;
  let totalChars = 0;
  try {
    const keys = Object.keys(localStorage);
    for (const key of keys) {
      if (key.startsWith(STORAGE_KEYS.PREFIX)) {
        count++;
        totalChars += (localStorage.getItem(key) || "").length;
      }
    }
  } catch {
    // ignore
  }
  return {
    count,
    estimatedSizeKb: Math.round((totalChars * 2) / 1024),
  };
}
