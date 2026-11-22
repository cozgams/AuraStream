import type { AICaptionConfig, SubtitleCue, SubtitleTrack, SubtitleStyleConfig } from "./types";
import { normalizeCueText, parseVtt } from "./vttParser";
import { LOCAL, isLocalMedia } from "../api";
import { parseExtXKey, parseHlsIv, sequenceToIv } from "../offline/exportService";
import { decodeAacToWav16k, extractAacFromTs, isMpegTs } from "./tsAudioExtractor";

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
  GROQ_KEY: "aurastream_groq_api_key",
  WHISPER_KEY: "aurastream_whisper_api_key",
  CUSTOM_URL: "aurastream_custom_stt_url",
  CUSTOM_MODEL: "aurastream_custom_stt_model",
  STYLE_CONFIG: "aurastream_subtitle_style_v2",
  PREFIX: "aurastream_sub_",
};

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyleConfig = {
  color: "white",
  edgeStyle: "drop_shadow",
  font: "sans",
  bgStyle: "translucent",
  bgOpacity: 75,
  position: "bottom",
  offsetSec: 0,
};

export function getSubtitleStyleConfig(): SubtitleStyleConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.STYLE_CONFIG);
    if (!raw) {
      return DEFAULT_SUBTITLE_STYLE;
    }
    const parsed = JSON.parse(raw);
    const offsetSec = Number.isFinite(Number(parsed?.offsetSec))
      ? Math.max(-5, Math.min(5, Number(parsed.offsetSec)))
      : 0;
    return { ...DEFAULT_SUBTITLE_STYLE, ...parsed, offsetSec };
  } catch {
    return DEFAULT_SUBTITLE_STYLE;
  }
}

export function setSubtitleStyleConfig(config: Partial<SubtitleStyleConfig>): void {
  try {
    const current = getSubtitleStyleConfig();
    const nextOffset =
      config.offsetSec !== undefined && Number.isFinite(Number(config.offsetSec))
        ? Math.max(-5, Math.min(5, Math.round(Number(config.offsetSec) * 100) / 100))
        : current.offsetSec ?? 0;
    const updated: SubtitleStyleConfig = { ...current, ...config, offsetSec: nextOffset };
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
    const rawProvider = localStorage.getItem(STORAGE_KEYS.PROVIDER);
    const provider: AICaptionConfig["provider"] =
      rawProvider === "gemini" ||
      rawProvider === "groq" ||
      rawProvider === "whisper" ||
      rawProvider === "custom"
        ? rawProvider
        : "none";
    const geminiKey = localStorage.getItem(STORAGE_KEYS.GEMINI_KEY) || "";
    const groqKey = localStorage.getItem(STORAGE_KEYS.GROQ_KEY) || "";
    const whisperKey = localStorage.getItem(STORAGE_KEYS.WHISPER_KEY) || "";
    const customUrl = localStorage.getItem(STORAGE_KEYS.CUSTOM_URL) || "";
    const customModel = localStorage.getItem(STORAGE_KEYS.CUSTOM_MODEL) || "";
    return { provider, geminiKey, groqKey, whisperKey, customUrl, customModel };
  } catch {
    return { provider: "none" };
  }
}

/**
 * Persists AI Caption configuration
 */
export function setAICaptionConfig(config: Partial<AICaptionConfig>): void {
  try {
    if (config.provider !== undefined) localStorage.setItem(STORAGE_KEYS.PROVIDER, config.provider);
    if (config.geminiKey !== undefined) localStorage.setItem(STORAGE_KEYS.GEMINI_KEY, config.geminiKey.trim());
    if (config.groqKey !== undefined) localStorage.setItem(STORAGE_KEYS.GROQ_KEY, config.groqKey.trim());
    if (config.whisperKey !== undefined) localStorage.setItem(STORAGE_KEYS.WHISPER_KEY, config.whisperKey.trim());
    if (config.customUrl !== undefined) localStorage.setItem(STORAGE_KEYS.CUSTOM_URL, config.customUrl.trim());
    if (config.customModel !== undefined) localStorage.setItem(STORAGE_KEYS.CUSTOM_MODEL, config.customModel.trim());
  } catch {
    // ignore
  }
}

function isLegacyFakeTrack(rawOrTrack: unknown): boolean {
  if (typeof rawOrTrack === "string") {
    return rawOrTrack.includes('"procedural"') || rawOrTrack.includes('"mock"');
  }
  if (rawOrTrack && typeof rawOrTrack === "object") {
    const src = String((rawOrTrack as { source?: string }).source || "");
    return src === "procedural" || src === "mock";
  }
  return false;
}

// Purge any previously stored fake procedural subtitles from storage
try {
  if (typeof localStorage !== "undefined") {
    const keys = Object.keys(localStorage);
    for (const key of keys) {
      if (key.startsWith(STORAGE_KEYS.PREFIX)) {
        try {
          const raw = localStorage.getItem(key);
          if (raw && isLegacyFakeTrack(raw)) {
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

function persistTrack(track: SubtitleTrack): void {
  const cacheKey = `${track.videoId}_${track.episode}`;
  setCachedTrack(cacheKey, track);
  try {
    localStorage.setItem(`${STORAGE_KEYS.PREFIX}${cacheKey}`, JSON.stringify(track));
  } catch {
    // ignore quota limits
  }
}

function emitTrackUpdated(track: SubtitleTrack): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent("aurastream:subtitle-track-updated", {
      detail: { videoId: track.videoId, episode: track.episode, track },
    })
  );
}

/**
 * Imports user-provided .SRT or .VTT text for an episode and makes it active immediately.
 */
export function importSubtitleTextForEpisode(
  videoId: number,
  episode: number,
  rawText: string,
  fileName: string = "subtitles.srt"
): SubtitleTrack {
  const cues = parseVtt(rawText);
  if (cues.length === 0) {
    throw new Error("No valid subtitle cues found in file. Please choose a valid .srt or .vtt file.");
  }
  const track: SubtitleTrack = {
    videoId,
    episode,
    cues,
    source: "local_import",
    fileName,
    generatedAt: Date.now(),
  };
  persistTrack(track);
  emitTrackUpdated(track);
  return track;
}

/**
 * Clears an imported or AI-generated subtitle track for an episode.
 */
export function removeSubtitleTrackForEpisode(videoId: number, episode: number): void {
  const cacheKey = `${videoId}_${episode}`;
  MEMORY_CACHE.delete(cacheKey);
  try {
    localStorage.removeItem(`${STORAGE_KEYS.PREFIX}${cacheKey}`);
  } catch {
    // ignore
  }
  emitTrackUpdated({
    videoId,
    episode,
    cues: [],
    source: "none",
  });
}

/**
 * Transcribe and translate audio directly via Google Gemini Audio API (Gemini 2.5 Flash).
 */
export async function transcribeWithGemini(
  audioBase64: string,
  mimeType: string = "audio/aac",
  apiKey?: string,
  signal?: AbortSignal
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
    "zh": "Original spoken transcription",
    "en": "Natural, accurate English translation"
  }
]
Rules:
1. "start" and "end" MUST be floating point seconds matching when dialogue is spoken.
2. Filter out non-speech background music and sound effects.
3. Keep individual cues concise and readable (at most 2 short lines, <= 70 characters).
4. Output valid JSON only, with no markdown wrapping or backticks.`;

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
    signal,
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

  const parsed = rawList.map((cue: any, idx: number) => {
    const s = Number(cue?.start);
    const e = Number(cue?.end);
    const validStart = Number.isFinite(s) ? Math.max(0, s) : 0;
    const validEnd = Number.isFinite(e) && e > validStart ? e : validStart + 1.5;
    const en = normalizeCueText(String(cue?.en || cue?.zh || ""));
    const zh = normalizeCueText(String(cue?.zh || cue?.en || ""));
    return {
      id: Number(cue?.id) || idx + 1,
      start: validStart,
      end: validEnd,
      en,
      zh,
    };
  }).filter((c) => Boolean(c.en));

  parsed.sort((a, b) => a.start - b.start);
  return parsed.map((c, idx) => ({ ...c, id: idx + 1 }));
}

/**
 * Transcribe & translate audio via Groq Whisper, OpenAI Whisper, or OpenAI-compatible custom endpoint.
 */
export async function transcribeWithWhisper(
  audioBlob: Blob,
  apiKey?: string,
  customEndpoint?: string,
  opts?: { model?: string; fileName?: string; signal?: AbortSignal }
): Promise<SubtitleCue[]> {
  const config = getAICaptionConfig();
  const key = apiKey ?? config.whisperKey;
  const endpoint =
    (customEndpoint || config.customUrl || "").trim() ||
    "https://api.openai.com/v1/audio/translations";
  const model = (opts?.model || config.customModel || "whisper-1").trim() || "whisper-1";
  const fileName = opts?.fileName || "audio.wav";

  const formData = new FormData();
  formData.append("file", audioBlob, fileName);
  formData.append("model", model);
  formData.append("response_format", "verbose_json");
  formData.append("temperature", "0");
  if (!endpoint.includes("/translations") && endpoint.includes("/transcriptions")) {
    formData.append("timestamp_granularities[]", "segment");
  }

  const headers: Record<string, string> = {};
  if (key) {
    headers["Authorization"] = `Bearer ${key}`;
  }

  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: formData,
    signal: opts?.signal,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Whisper API error (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const segments = Array.isArray(data?.segments) ? data.segments : [];

  let parsed: SubtitleCue[] = segments
    .map((seg: any, idx: number) => {
      const start = Number.isFinite(Number(seg?.start)) ? Math.max(0, Math.round(Number(seg.start) * 100) / 100) : 0;
      const rawEnd = Number(seg?.end);
      const end = Number.isFinite(rawEnd) && rawEnd > start ? Math.round(rawEnd * 100) / 100 : start + 2.0;
      const text = normalizeCueText(typeof seg?.text === "string" ? seg.text : "");
      return {
        id: idx + 1,
        start,
        end,
        zh: text,
        en: text,
      };
    })
    .filter((c: SubtitleCue) => Boolean(c.en));

  if (parsed.length === 0 && typeof data?.text === "string" && data.text.trim()) {
    const clean = normalizeCueText(data.text);
    if (clean) {
      parsed = [{ id: 1, start: 0, end: 5, zh: clean, en: clean }];
    }
  }

  parsed.sort((a, b) => a.start - b.start);
  return parsed.map((c, idx) => ({ ...c, id: idx + 1 }));
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      if (comma < 0) {
        reject(new Error("Failed to encode audio/video payload"));
        return;
      }
      resolve(result.slice(comma + 1));
    };
    reader.onerror = () => reject(reader.error || new Error("Failed to read media blob"));
    reader.readAsDataURL(blob);
  });
}

function resolveMediaProxyUrl(rawUrl: string): string {
  if (
    rawUrl.startsWith(`${LOCAL}/`) ||
    rawUrl.startsWith("http://127.0.0.1:") ||
    rawUrl.startsWith("http://hg.localhost/") ||
    rawUrl.startsWith("hg://localhost/") ||
    rawUrl.startsWith("blob:")
  ) {
    return rawUrl;
  }
  return `${LOCAL}/seg?u=${encodeURIComponent(rawUrl)}`;
}

function resolveRelativeUrl(baseUrl: string, relOrAbs: string): string {
  if (/^(https?:|blob:|hg:)/i.test(relOrAbs)) return relOrAbs;
  try {
    return new URL(relOrAbs, baseUrl).toString();
  } catch {
    return relOrAbs;
  }
}

function parseExtXMediaSubtitleUri(playlistText: string, playlistBaseUrl: string): string | null {
  const lines = playlistText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (!line.startsWith("#EXT-X-MEDIA:")) continue;
    const typeMatch = line.match(/TYPE=([^,\s]+)/i);
    if (!typeMatch || typeMatch[1].toUpperCase() !== "SUBTITLES") continue;
    const uriMatch = line.match(/URI="([^"]+)"/i);
    if (uriMatch?.[1]) {
      return resolveRelativeUrl(playlistBaseUrl, uriMatch[1]);
    }
  }
  return null;
}

async function fetchHlsSubtitleCues(subtitleUrlOrPlaylistUrl: string): Promise<SubtitleCue[]> {
  const fetchUrl = resolveMediaProxyUrl(subtitleUrlOrPlaylistUrl);
  const res = await fetch(fetchUrl, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return [];
  const text = await res.text();
  if (!text) return [];
  if (!text.trimStart().startsWith("#EXTM3U")) {
    return parseVtt(text);
  }
  // If subtitle URI itself is a sub-playlist of .vtt segments, fetch first up to 12 VTT segments
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const vttSegments = lines.filter((l) => !l.startsWith("#")).slice(0, 12);
  const allCues: SubtitleCue[] = [];
  let seqId = 1;
  for (const seg of vttSegments) {
    try {
      const segUrl = resolveMediaProxyUrl(resolveRelativeUrl(subtitleUrlOrPlaylistUrl, seg));
      const segRes = await fetch(segUrl, { signal: AbortSignal.timeout(6000) });
      if (!segRes.ok) continue;
      const segText = await segRes.text();
      for (const cue of parseVtt(segText)) {
        allCues.push({ ...cue, id: seqId++ });
      }
    } catch {
      // continue remaining segments
    }
  }
  return allCues;
}

function combineAbortSignal(timeoutMs: number, externalSignal?: AbortSignal): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const ctrl = new AbortController();
  const timer = globalThis.setTimeout(() => ctrl.abort(new DOMException("Timed out", "TimeoutError")), timeoutMs);
  const onExternalAbort = () => ctrl.abort(externalSignal?.reason ?? new DOMException("Transcription cancelled", "AbortError"));
  if (externalSignal) {
    if (externalSignal.aborted) {
      onExternalAbort();
    } else {
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }
  }
  return {
    signal: ctrl.signal,
    cleanup: () => {
      globalThis.clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    },
  };
}

async function fetchWithSignal(url: string, timeoutMs: number, externalSignal?: AbortSignal): Promise<Response> {
  if (externalSignal?.aborted) {
    throw new DOMException("Transcription cancelled", "AbortError");
  }
  const { signal, cleanup } = combineAbortSignal(timeoutMs, externalSignal);
  try {
    return await fetch(url, { signal });
  } finally {
    cleanup();
  }
}

async function collectEpisodeMediaForAI(
  streamUrl: string,
  opts?: { preferWav?: boolean; signal?: AbortSignal; onStatus?: (msg: string) => void }
): Promise<{ blob: Blob; mimeType: string; fileName: string }> {
  const MAX_AUDIO_BYTES = 18 * 1024 * 1024;
  const MAX_WAV_UPLOAD_BYTES = 24 * 1024 * 1024;
  const MAX_SEGMENTS = 120;
  const CONCURRENCY = 3;
  const isHls = /\.m3u8(\?|$|#)/i.test(streamUrl) || streamUrl.includes("/hls?u=");

  if (!isHls) {
    const res = await fetchWithSignal(resolveMediaProxyUrl(streamUrl), 30000, opts?.signal);
    if (!res.ok) throw new Error(`Failed to fetch media stream (HTTP ${res.status})`);
    const ab = await res.arrayBuffer();
    const sliced = ab.byteLength > MAX_AUDIO_BYTES ? ab.slice(0, MAX_AUDIO_BYTES) : ab;
    const ctype = res.headers.get("content-type") || "video/mp4";
    const fileName = ctype.includes("webm") ? "audio.webm" : ctype.includes("wav") ? "audio.wav" : "audio.mp4";
    return { blob: new Blob([sliced], { type: ctype }), mimeType: ctype, fileName };
  }

  const plUrl = isLocalMedia(streamUrl) || streamUrl.startsWith("blob:")
    ? streamUrl
    : `${LOCAL}/hls?u=${encodeURIComponent(streamUrl)}`;
  const plRes = await fetchWithSignal(plUrl, 15000, opts?.signal);
  if (!plRes.ok) throw new Error(`Failed to load HLS playlist (HTTP ${plRes.status})`);
  let playlistText = await plRes.text();

  let variantUrl = "";
  if (playlistText.includes("#EXT-X-STREAM-INF")) {
    const lines = playlistText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const variant = lines.find((l) => !l.startsWith("#"));
    if (!variant) throw new Error("Master playlist has no media variants");
    variantUrl = resolveMediaProxyUrl(resolveRelativeUrl(plUrl, variant));
    const vRes = await fetchWithSignal(variantUrl, 15000, opts?.signal);
    if (!vRes.ok) throw new Error(`Failed to load variant playlist (HTTP ${vRes.status})`);
    playlistText = await vRes.text();
  }

  const basePlaylistUrl = variantUrl || plUrl;
  const resolvePlaylistRef = (rawRef: string): string => {
    if (/^(https?:|blob:|hg:)/i.test(rawRef)) return resolveMediaProxyUrl(rawRef);
    if (rawRef.startsWith("/")) return `${LOCAL}${rawRef}`;
    try {
      return resolveMediaProxyUrl(new URL(rawRef, basePlaylistUrl).toString());
    } catch {
      return resolveMediaProxyUrl(rawRef);
    }
  };

  const rawLines = playlistText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let mediaSequence = 0;
  let currentMethod = "";
  let currentIv: string | undefined;
  let currentKeyUri: string | undefined;
  let mapUri: string | undefined;
  const segments: Array<{ url: string; method: string; iv?: string; keyUri?: string }> = [];

  for (const line of rawLines) {
    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      const seq = parseInt(line.slice("#EXT-X-MEDIA-SEQUENCE:".length).trim(), 10);
      if (Number.isFinite(seq) && seq >= 0) mediaSequence = seq;
    } else if (line.startsWith("#EXT-X-MAP:")) {
      const parsedMap = parseExtXKey(line);
      if (parsedMap.uri && !mapUri) mapUri = parsedMap.uri;
    } else if (line.startsWith("#EXT-X-KEY:")) {
      const parsedKey = parseExtXKey(line);
      currentMethod = parsedKey.method || "";
      currentIv = parsedKey.iv;
      currentKeyUri = parsedKey.uri;
    } else if (!line.startsWith("#")) {
      segments.push({
        url: line,
        method: currentMethod,
        iv: currentIv,
        keyUri: currentKeyUri,
      });
    }
  }
  if (segments.length === 0) throw new Error("No downloadable media segments found");

  const cryptoKeyCache = new Map<string, Promise<CryptoKey>>();
  const loadAesKey = (keyUri?: string): Promise<CryptoKey> => {
    if (!keyUri) return Promise.reject(new Error("Missing AES-128 key URI in HLS playlist"));
    const cached = cryptoKeyCache.get(keyUri);
    if (cached) return cached;
    if (typeof crypto === "undefined" || !crypto.subtle) {
      return Promise.reject(new Error("WebCrypto AES-128 decryption is unavailable in this environment"));
    }
    const promise = (async () => {
      const kRes = await fetchWithSignal(resolvePlaylistRef(keyUri), 15000, opts?.signal);
      if (!kRes.ok) throw new Error(`Failed to fetch HLS decryption key (HTTP ${kRes.status})`);
      const rawKey = await kRes.arrayBuffer();
      if (rawKey.byteLength !== 16) {
        throw new Error(`Invalid HLS AES-128 key length (${rawKey.byteLength} bytes)`);
      }
      return crypto.subtle.importKey("raw", rawKey, { name: "AES-CBC" }, false, ["decrypt"]);
    })();
    cryptoKeyCache.set(keyUri, promise);
    return promise;
  };

  const targetCount = Math.min(segments.length, MAX_SEGMENTS);
  const extractedChunks: Uint8Array[] = [];
  let totalBytes = 0;
  let extractedTsAudio = false;
  let initMapBuf: Uint8Array | null = null;
  let completedSegs = 0;

  if (mapUri) {
    try {
      const mRes = await fetchWithSignal(resolvePlaylistRef(mapUri), 15000, opts?.signal);
      if (mRes.ok) {
        const ab = await mRes.arrayBuffer();
        if (ab.byteLength > 0) {
          initMapBuf = new Uint8Array(ab);
        }
      }
    } catch {
      // ignore optional init map failure
    }
  }

  for (let batchStart = 0; batchStart < targetCount; batchStart += CONCURRENCY) {
    if (totalBytes >= MAX_AUDIO_BYTES) break;
    if (opts?.signal?.aborted) throw new DOMException("Transcription cancelled", "AbortError");

    const batchEnd = Math.min(targetCount, batchStart + CONCURRENCY);
    const batchResults = await Promise.all(
      Array.from({ length: batchEnd - batchStart }, async (_, offset) => {
        const idx = batchStart + offset;
        const seg = segments[idx];
        const method = seg.method || "NONE";
        if (method !== "NONE" && method !== "" && method !== "AES-128") {
          throw new Error(`Unsupported HLS encryption method "${method}" for AI transcription`);
        }
        const segRes = await fetchWithSignal(resolvePlaylistRef(seg.url), 20000, opts?.signal);
        if (!segRes.ok) {
          completedSegs++;
          opts?.onStatus?.(`Extracting audio (${completedSegs}/${targetCount} segments)...`);
          return null;
        }
        let ab = await segRes.arrayBuffer();
        if (ab.byteLength === 0) {
          completedSegs++;
          opts?.onStatus?.(`Extracting audio (${completedSegs}/${targetCount} segments)...`);
          return null;
        }
        if (method === "AES-128") {
          const cryptoKey = await loadAesKey(seg.keyUri);
          const iv = seg.iv ? parseHlsIv(seg.iv) : sequenceToIv(mediaSequence + idx);
          ab = await crypto.subtle.decrypt({ name: "AES-CBC", iv: iv as BufferSource }, cryptoKey, ab);
        }
        completedSegs++;
        opts?.onStatus?.(`Extracting audio (${completedSegs}/${targetCount} segments)...`);
        const u8 = new Uint8Array(ab);
        if (isMpegTs(u8)) {
          const aac = extractAacFromTs(u8);
          return { chunk: aac, isTsAudio: aac.length > 0 };
        }
        return { chunk: u8, isTsAudio: false };
      })
    );

    for (const item of batchResults) {
      if (!item || item.chunk.length === 0) continue;
      if (totalBytes >= MAX_AUDIO_BYTES) break;
      if (!item.isTsAudio && extractedChunks.length === 0 && initMapBuf && initMapBuf.length > 0) {
        extractedChunks.push(initMapBuf);
        totalBytes += initMapBuf.length;
      }
      if (item.isTsAudio) extractedTsAudio = true;
      extractedChunks.push(item.chunk);
      totalBytes += item.chunk.length;
    }
  }

  if (totalBytes === 0) throw new Error("Failed to read media segments for transcription");

  const combinedBytes = new Uint8Array(totalBytes);
  let writeOff = 0;
  for (const ch of extractedChunks) {
    combinedBytes.set(ch, writeOff);
    writeOff += ch.length;
  }

  if (extractedTsAudio) {
    if (opts?.preferWav) {
      opts?.onStatus?.("Converting audio to 16 kHz WAV...");
      const wavBlob = await decodeAacToWav16k(combinedBytes);
      if (wavBlob && wavBlob.size > 0 && wavBlob.size <= MAX_WAV_UPLOAD_BYTES) {
        return { blob: wavBlob, mimeType: "audio/wav", fileName: "audio.wav" };
      }
    }
    return {
      blob: new Blob([combinedBytes.slice().buffer], { type: "audio/aac" }),
      mimeType: "audio/aac",
      fileName: "audio.aac",
    };
  }

  return {
    blob: new Blob([combinedBytes.slice().buffer], { type: "video/mp4" }),
    mimeType: "video/mp4",
    fileName: "audio.mp4",
  };
}

/**
 * Generates real subtitles using the user's configured Gemini, Groq Whisper, OpenAI Whisper, or custom STT API.
 */
export async function transcribeEpisodeWithAI(
  videoId: number,
  episode: number,
  streamUrl: string,
  onStatus?: (msg: string) => void,
  signal?: AbortSignal
): Promise<SubtitleTrack> {
  if (!streamUrl) {
    throw new Error("Stream is not ready yet. Wait for video playback to load.");
  }
  const config = getAICaptionConfig();
  const provider: AICaptionConfig["provider"] =
    config.provider !== "none"
      ? config.provider
      : config.groqKey
      ? "groq"
      : config.geminiKey
      ? "gemini"
      : config.whisperKey
      ? "whisper"
      : config.customUrl
      ? "custom"
      : "none";

  if (provider === "none") {
    throw new Error("Configure a Gemini, Groq, OpenAI, or Custom API key/URL first.");
  }

  try {
    onStatus?.("Fetching episode audio stream...");
    const { blob, mimeType, fileName } = await collectEpisodeMediaForAI(streamUrl, {
      preferWav: provider !== "gemini",
      signal,
      onStatus,
    });

    let cues: SubtitleCue[] = [];
    let source: SubtitleTrack["source"] = "ai_gemini";

    if (provider === "gemini") {
      if (!config.geminiKey) throw new Error("Gemini API Key is required.");
      onStatus?.("Transcribing & translating with Gemini...");
      const base64 = await blobToBase64(blob);
      cues = await transcribeWithGemini(base64, mimeType || "audio/aac", config.geminiKey, signal);
      source = "ai_gemini";
    } else if (provider === "groq") {
      if (!config.groqKey) throw new Error("Groq API Key is required (free at console.groq.com).");
      onStatus?.("Translating speech with Groq Whisper...");
      cues = await transcribeWithWhisper(
        blob,
        config.groqKey,
        "https://api.groq.com/openai/v1/audio/translations",
        { model: "whisper-large-v3", fileName, signal }
      );
      source = "ai_groq";
    } else if (provider === "custom") {
      if (!config.customUrl?.trim()) throw new Error("Custom Whisper endpoint URL is required.");
      onStatus?.("Transcribing speech with custom endpoint...");
      cues = await transcribeWithWhisper(blob, config.whisperKey, config.customUrl, {
        model: config.customModel || "whisper-1",
        fileName,
        signal,
      });
      source = "ai_whisper";
    } else {
      if (!config.whisperKey) {
        throw new Error("OpenAI API Key is required.");
      }
      onStatus?.("Translating speech with OpenAI Whisper...");
      cues = await transcribeWithWhisper(
        blob,
        config.whisperKey,
        "https://api.openai.com/v1/audio/translations",
        { model: "whisper-1", fileName, signal }
      );
      source = "ai_whisper";
    }

    if (!cues.length) {
      throw new Error("No spoken dialogue detected in episode audio.");
    }

    const normalizedCues = cues
      .map((c, idx) => {
        const cleanEn = normalizeCueText(c.en || c.zh);
        const cleanZh = normalizeCueText(c.zh || c.en || "");
        return {
          ...c,
          id: idx + 1,
          en: cleanEn,
          zh: cleanZh,
        };
      })
      .filter((c) => Boolean(c.en));

    if (!normalizedCues.length) {
      throw new Error("AI transcription returned empty captions.");
    }

    normalizedCues.sort((a, b) => a.start - b.start);

    const track: SubtitleTrack = {
      videoId,
      episode,
      cues: normalizedCues.map((c, idx) => ({ ...c, id: idx + 1 })),
      source,
      generatedAt: Date.now(),
    };
    persistTrack(track);
    emitTrackUpdated(track);
    return track;
  } catch (err) {
    if ((err as { name?: string })?.name === "AbortError" || signal?.aborted) {
      throw new Error("Transcription cancelled");
    }
    throw err;
  }
}

/**
 * Retrieves real subtitles for a video and episode.
 * Never fabricates fake procedural dialogue; returns source="none" when no real track exists.
 */
export async function getSubtitlesForEpisode(
  videoId: number,
  episode: number,
  _title?: string,
  remoteVttUrl?: string,
  hlsPlaylistUrl?: string
): Promise<SubtitleTrack> {
  const cacheKey = `${videoId}_${episode}`;

  const memHit = MEMORY_CACHE.get(cacheKey);
  if (memHit) {
    if (isLegacyFakeTrack(memHit) || !memHit.cues?.length) {
      MEMORY_CACHE.delete(cacheKey);
    } else {
      return memHit;
    }
  }

  // 1. Check persisted real tracks (user-imported .SRT/.VTT or real AI transcripts)
  try {
    const stored = localStorage.getItem(`${STORAGE_KEYS.PREFIX}${cacheKey}`);
    if (stored) {
      if (isLegacyFakeTrack(stored)) {
        localStorage.removeItem(`${STORAGE_KEYS.PREFIX}${cacheKey}`);
      } else {
        const parsed: SubtitleTrack = JSON.parse(stored);
        if (parsed.cues && Array.isArray(parsed.cues) && parsed.cues.length > 0 && !isLegacyFakeTrack(parsed)) {
          setCachedTrack(cacheKey, parsed);
          return parsed;
        }
      }
    }
  } catch {
    // ignore parse error
  }

  // 2. Check offline downloads metadata (only non-procedural cues)
  try {
    const rawOffline = localStorage.getItem("aurastream_offline_episodes_v1");
    if (rawOffline) {
      const list = JSON.parse(rawOffline);
      const offlineItem = Array.isArray(list)
        ? list.find((it: any) => it.videoId === videoId && it.episode === episode)
        : null;
      if (offlineItem?.cues && Array.isArray(offlineItem.cues) && offlineItem.cues.length > 0 && !isLegacyFakeTrack(offlineItem)) {
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

  // 3. Try explicit upstream WebVTT/SRT URL if provided
  const isLocalRemoteVtt = Boolean(
    remoteVttUrl && (isLocalMedia(remoteVttUrl) || remoteVttUrl.startsWith("blob:"))
  );
  if (remoteVttUrl && (isLocalRemoteVtt || typeof navigator === "undefined" || navigator.onLine !== false)) {
    try {
      const cues = await fetchHlsSubtitleCues(remoteVttUrl);
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
    } catch {
      // continue checking playlist
    }
  }

  // 4. Inspect HLS master manifest for embedded #EXT-X-MEDIA:TYPE=SUBTITLES track
  if (hlsPlaylistUrl && (/\.m3u8(\?|$|#)/i.test(hlsPlaylistUrl) || hlsPlaylistUrl.includes("/hls?u="))) {
    const isOfflinePl = hlsPlaylistUrl.includes("/offline/") || hlsPlaylistUrl.startsWith("blob:");
    const isLocalPl = isLocalMedia(hlsPlaylistUrl) || hlsPlaylistUrl.startsWith("blob:");
    if (!isOfflinePl && typeof navigator !== "undefined" && navigator.onLine === false) {
      // Strict zero-internet offline mode: never inspect remote HLS playlists while offline
    } else {
      try {
        const plUrl = isLocalPl
          ? hlsPlaylistUrl
          : `${LOCAL}/hls?u=${encodeURIComponent(hlsPlaylistUrl)}`;
        const plRes = await fetch(plUrl, { signal: AbortSignal.timeout(5000) });
        if (plRes.ok) {
          const playlistText = await plRes.text();
          if (playlistText.includes("TYPE=SUBTITLES")) {
            const subUri = parseExtXMediaSubtitleUri(playlistText, plUrl);
            if (subUri) {
              const cues = await fetchHlsSubtitleCues(subUri);
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
          }
        }
      } catch {
        // silent non-blocking check
      }
    }
  }

  // No real subtitle track present — return honest empty track (never fabricate fake captions)
  return {
    videoId,
    episode,
    cues: [],
    source: "none",
  };
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
    const text = normalizeCueText(cue.en || cue.zh);
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
    const text = normalizeCueText(cue.en || cue.zh);
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
  try {
    const keys = Object.keys(localStorage);
    for (const key of keys) {
      if (!key.startsWith(STORAGE_KEYS.PREFIX)) continue;
      const suffix = key.slice(STORAGE_KEYS.PREFIX.length);
      const raw = localStorage.getItem(key);
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as Partial<SubtitleTrack>;
          if (parsed?.source === "local_import") {
            continue;
          }
        } catch {
          // remove corrupt entry
        }
      }
      localStorage.removeItem(key);
      MEMORY_CACHE.delete(suffix);
    }
  } catch {
    // ignore
  }
  for (const [k, track] of Array.from(MEMORY_CACHE.entries())) {
    if (track.source !== "local_import") {
      MEMORY_CACHE.delete(k);
    }
  }
  try {
    window.dispatchEvent(new CustomEvent("aurastream:subtitle-cache-cleared"));
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
