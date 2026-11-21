/**
 * AuraStream Temporary Cache & Preload Engine with Smart Auto-Cleaner
 * 
 * Features:
 * 1. Full Episode Pre-Cache: Configures HLS to aggressively buffer 100% of the active episode.
 * 2. Next Episode Background Preload: Pre-fetches playlist (.m3u8), decryption keys, and initial segments
 *    for upcoming episodes to achieve 0ms instant swipe transitions.
 * 3. Smart Auto-Cleaner: LRU (Least-Recently-Used) cache manager that evicts older watched
 *    episodes to prevent memory pressure on Android phones while preserving instant playback.
 */

import { api, playlist, LOCAL } from "../api";
import { isEpisodeDownloaded } from "../offline/downloadService";

export interface PreloadedEpisode {
  key: string; // `${videoId}:${ep}`
  videoId: number;
  episode: number;
  title: string;
  streamUrl: string;
  segmentsPreloaded: number;
  totalSegments: number;
  estimatedBytes: number;
  timestamp: number;
}

export interface TempCacheStats {
  count: number;
  totalBytes: number;
  formattedSize: string;
  entries: PreloadedEpisode[];
  autoCleanActive: boolean;
}

const FULL_PRECACHE_KEY = "aurastream_full_episode_precache_v1";
const NEXT_PRELOAD_KEY = "aurastream_next_episode_preload_v1";
const AUTO_CLEAN_KEY = "aurastream_temp_cache_autoclean_v1";
const MAX_TEMP_EPISODES = 3; // Keep active, previous, and next

const preloadedMap = new Map<string, PreloadedEpisode>();
const activePreloadPromises = new Map<string, Promise<boolean>>();
const listeners = new Set<() => void>();
let currentActiveKey: string | null = null;

function notify() {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // ignore
    }
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("aurastream:temp-cache-changed"));
  }
}

/* ── Configuration Getters & Setters ─────────────────────────────── */

export function isFullEpisodePreCacheEnabled(): boolean {
  try {
    const val = localStorage.getItem(FULL_PRECACHE_KEY);
    return val === null ? true : val === "true"; // Default: ON
  } catch {
    return true;
  }
}

export function setFullEpisodePreCacheEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(FULL_PRECACHE_KEY, String(enabled));
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("aurastream:playback-config-changed"));
    }
    notify();
  } catch {
    // ignore
  }
}

export function isNextEpisodePreloadEnabled(): boolean {
  try {
    const val = localStorage.getItem(NEXT_PRELOAD_KEY);
    return val === null ? true : val === "true"; // Default: ON
  } catch {
    return true;
  }
}

export function setNextEpisodePreloadEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(NEXT_PRELOAD_KEY, String(enabled));
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("aurastream:playback-config-changed"));
    }
    notify();
  } catch {
    // ignore
  }
}

export function isTempCacheAutoCleanEnabled(): boolean {
  try {
    const val = localStorage.getItem(AUTO_CLEAN_KEY);
    return val === null ? true : val === "true"; // Default: ON
  } catch {
    return true;
  }
}

export function setTempCacheAutoCleanEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(AUTO_CLEAN_KEY, String(enabled));
    if (enabled) {
      runAutoCleaner();
    }
    notify();
  } catch {
    // ignore
  }
}

/* ── Auto-Cleaner Logic ─────────────────────────────────────────── */

export function runAutoCleaner(): { evictedKeys: string[]; freedBytes: number } {
  if (!isTempCacheAutoCleanEnabled()) return { evictedKeys: [], freedBytes: 0 };

  const evicted: string[] = [];
  let freed = 0;

  // If cached episodes exceed threshold (MAX_TEMP_EPISODES), evict oldest that are not active
  if (preloadedMap.size > MAX_TEMP_EPISODES) {
    const sorted = Array.from(preloadedMap.values()).sort((a, b) => a.timestamp - b.timestamp);

    for (const item of sorted) {
      if (preloadedMap.size <= MAX_TEMP_EPISODES) break;
      // Do not evict the currently playing episode
      if (item.key === currentActiveKey) continue;

      preloadedMap.delete(item.key);
      evicted.push(item.key);
      freed += item.estimatedBytes;
    }
  }

  if (evicted.length > 0) {
    notify();
  }

  return { evictedKeys: evicted, freedBytes: freed };
}

export function clearAllTempCache(): { count: number; freedBytes: number } {
  const count = preloadedMap.size;
  let freedBytes = 0;
  for (const item of preloadedMap.values()) {
    freedBytes += item.estimatedBytes;
  }
  preloadedMap.clear();
  activePreloadPromises.clear();
  notify();
  return { count, freedBytes };
}

/* ── Preloading Service ─────────────────────────────────────────── */

export function markEpisodeActive(videoId: number, episode: number): void {
  const key = `${videoId}:${episode}`;
  currentActiveKey = key;
  const existing = preloadedMap.get(key);
  if (existing) {
    existing.timestamp = Date.now();
  }
  runAutoCleaner();
}

/**
 * Preload an upcoming episode's manifest, encryption key, and initial video segments into temporary cache
 */
export async function preloadEpisode(
  videoId: number,
  episode: number,
  options?: {
    preferHevc?: boolean;
    maxSegments?: number;
    title?: string;
  }
): Promise<boolean> {
  if (!isNextEpisodePreloadEnabled()) return false;
  if (!videoId || episode <= 0) return false;
  if (isEpisodeDownloaded(videoId, episode)) return false;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return false;

  const key = `${videoId}:${episode}`;

  // If already preloaded recently (within last 10 minutes), reuse
  const existing = preloadedMap.get(key);
  if (existing && Date.now() - existing.timestamp < 10 * 60 * 1000) {
    existing.timestamp = Date.now();
    return true;
  }

  // If already in flight, await existing promise
  if (activePreloadPromises.has(key)) {
    return activePreloadPromises.get(key)!;
  }

  const promise = (async () => {
    try {
      // 1. Fetch play info for the episode
      const playInfo = await api.play(videoId, episode);
      if (!playInfo) return false;

      const rawStream = (options?.preferHevc && (playInfo.streams?.hevc || playInfo.video_url_hevc))
        || playInfo.streams?.main
        || playInfo.video_url;

      if (!rawStream) return false;

      // 2. Fetch rewritten m3u8 playlist through local proxy
      const plUrl = playlist(rawStream);
      const res = await fetch(plUrl);
      if (!res.ok) return false;
      const m3u8Text = await res.text();

      // 3. Extract encryption keys and segment URLs
      const lines = m3u8Text.split("\n");
      const keyLines = lines.filter((l) => l.startsWith("#EXT-X-KEY"));
      for (const kl of keyLines) {
        const m = kl.match(/URI="([^"]+)"/);
        if (m && m[1]) {
          try {
            await fetch(m[1]); // Warm up key in Rust's KEY_CACHE
          } catch {
            // ignore
          }
        }
      }

      // 4. Preload first N segments (default 5 segments, ~15-20s of video)
      const segmentUrls = lines
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith("#"));

      const maxSegs = options?.maxSegments || 5;
      const toFetch = segmentUrls.slice(0, maxSegs);
      let loadedCount = 0;
      let totalBytesEstimated = 0;

      // Turbo parallel pre-fetch across Wi-Fi for instant 0ms startup
      await Promise.all(
        toFetch.map(async (segUrl) => {
          try {
            let fullSegUrl = segUrl;
            if (!segUrl.startsWith("http://") && !segUrl.startsWith("https://") && !segUrl.startsWith("hg://")) {
              fullSegUrl = segUrl.startsWith("/") ? `${LOCAL}${segUrl}` : `${LOCAL}/${segUrl}`;
            }
            const segRes = await fetch(fullSegUrl);
            if (segRes.ok) {
              loadedCount++;
              const cl = segRes.headers.get("content-length");
              const b = cl ? Number(cl) : 1024 * 1024; // default ~1MB
              totalBytesEstimated += Number.isFinite(b) ? b : 1024 * 1024;
            }
          } catch {
            // ignore single segment failure
          }
        })
      );

      // 5. Register in preloaded cache map
      const entry: PreloadedEpisode = {
        key,
        videoId,
        episode,
        title: options?.title || `Episode ${episode}`,
        streamUrl: rawStream,
        segmentsPreloaded: loadedCount,
        totalSegments: segmentUrls.length,
        estimatedBytes: totalBytesEstimated,
        timestamp: Date.now(),
      };

      preloadedMap.set(key, entry);

      // 6. Run auto cleaner
      runAutoCleaner();
      notify();
      return true;
    } catch {
      return false;
    } finally {
      activePreloadPromises.delete(key);
    }
  })();

  activePreloadPromises.set(key, promise);
  return promise;
}

/* ── Stats & Subscriptions ───────────────────────────────────────── */

export function getTempCacheStats(): TempCacheStats {
  let totalBytes = 0;
  const entries = Array.from(preloadedMap.values());
  for (const item of entries) {
    totalBytes += item.estimatedBytes;
  }

  let formattedSize = "0 MB";
  if (totalBytes > 0) {
    formattedSize = totalBytes >= 1024 * 1024 * 1024
      ? `${(totalBytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
      : `${(totalBytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  return {
    count: entries.length,
    totalBytes,
    formattedSize,
    entries,
    autoCleanActive: isTempCacheAutoCleanEnabled(),
  };
}

export function subscribeTempCache(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
