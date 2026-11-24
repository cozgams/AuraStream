import { invoke } from "@tauri-apps/api/core";
import { tracePlayback } from "./playbackDiagnostics";
import type {
  CommentPage, Detail, HotSearchVideo, Paged, PlayInfo, Post, PostCategory, RankItem, TagGroup, TopicCard, TopicDetail, User, UserProfile, VideoCard,
} from "./types";

/* ── Runtime Environment ─────────────────────────────────── */

/** App version injected at build time */
export const APP_VERSION = __APP_VERSION__;

const ua = navigator.userAgent;
export const isAndroid = /Android/i.test(ua);
/** Platform detection with touch points check for iPadOS */
export const isIos =
  /iPhone|iPad|iPod/i.test(ua) ||
  (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1) ||
  // iPadOS 13+ reports MacIntel, detected via maxTouchPoints
  (typeof navigator.platform === "string" && navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
export const isMacos = !isIos && /Macintosh|Mac OS X/i.test(ua);
/** Linux desktop WebKitGTK user agent check */
export const isLinux = !isAndroid && !isIos && !isMacos && /Linux|X11/i.test(ua);
export const platform: "android" | "ios" | "windows" | "macos" | "linux" =
  isAndroid ? "android" : isIos ? "ios" : isMacos ? "macos" : isLinux ? "linux" : "windows";
/** WebView engine version for codec capability detection */
export const webviewVersion =
  /Chrome\/([\d.]+)/.exec(ua)?.[1] || /Version\/([\d.]+)/.exec(ua)?.[1] || "?";
/** Mobile touchscreen flag (Android & iOS) */
export const isMobile = isAndroid || isIos;

/** Safely extracts human-readable message from Error, Tauri string rejection, or unknown exception */
export function errorMessage(e: unknown, fallback = "An error occurred"): string {
  if (typeof e === "string" && e.trim()) return e;
  if (e instanceof Error && e.message?.trim()) return e.message;
  if (e && typeof e === "object" && "message" in e && typeof (e as any).message === "string") {
    return (e as any).message;
  }
  return fallback;
}

/** Platform-specific local media origin matching media::LOCAL_ORIGIN */
export const LOCAL =
  isMacos || isIos ? "hg://localhost" : isLinux ? "http://127.0.0.1:17650" : "http://hg.localhost";

/** Checks whether URL is already a local media protocol address */
export const isLocalMedia = (src: string) =>
  src.startsWith(`${LOCAL}/`) ||
  src.startsWith("http://127.0.0.1:") ||
  src.startsWith("http://hg.localhost/") ||
  src.startsWith("hg://localhost/");

/** Decrypted cover image URL via local protocol */
export const cover = (url?: string, _w = 480) => {
  if (!url) return "";
  if (url.startsWith("data:") || url.startsWith("blob:") || isLocalMedia(url)) {
    return url;
  }
  return `${LOCAL}/img?u=${encodeURIComponent(url)}`;
};

/** Proxied m3u8 playlist URL via local protocol */
export const playlist = (url: string) => `${LOCAL}/hls?u=${encodeURIComponent(url)}`;

/* ── API Invocation Wrapper ────────────────────────────── */

/** Appends a line to debug.log in app data directory */
export const logLine = (msg: string) => invoke("debug_log", { msg }).catch(() => {});

/** Network link-level failure pattern (DNS, timeout, connection) */
const NET_FAIL = /dns|timed? ?out|timeout|connection|connect|refused|reset|unreachable|broken pipe|tls|ssl|handshake|certificate|network/i;
/** Read-only commands eligible for retry on transient link errors */
const READ_ONLY = new Set([
  "api_me", "api_feed", "api_original_videos", "api_category", "api_rank", "api_search",
  "api_posts", "api_post", "api_post_comments", "api_video", "api_play", "api_comments",
  "api_topics", "api_topic", "api_tags", "api_tag_videos", "api_search_hot",
  "api_post_playback", "api_post_categories", "api_post_category", "api_related", "api_following", "api_user", "api_user_stats", "api_user_videos",
]);
/** Observer hook for auto line selector */
export type NetObserver = (r: { ok: boolean; cmd: string; msg?: string; networkish?: boolean }) => void;
let netObserver: NetObserver | null = null;
export const setNetObserver = (fn: NetObserver | null) => { netObserver = fn; };
const notifyNet = (r: Parameters<NetObserver>[0]) => {
  try { netObserver?.(r); } catch { /* Ignore observer errors */ }
};
const failMessage = (msg: string, status?: string) =>
  status
    ? `Server request failed (HTTP ${status}). Please retry or switch endpoints in Settings.`
    : msg.length > 140 ? `${msg.slice(0, 140)}…` : msg;

/* ── In-Memory Fast Cache & Deduplication ────────────────── */

interface CacheEntry<T> {
  value: T;
  expires: number;
}

const apiMemoryCache = new Map<string, CacheEntry<unknown>>();
const inFlightRequests = new Map<string, Promise<unknown>>();

/** Cache TTL in milliseconds for read-only metadata */
const CACHE_TTL_MAP: Record<string, number> = {
  api_category: 5 * 60 * 1000,
  api_original_videos: 5 * 60 * 1000,
  api_rank: 3 * 60 * 1000,
  api_tags: 10 * 60 * 1000,
  api_topics: 10 * 60 * 1000,
  api_topic: 5 * 60 * 1000,
  api_search_hot: 5 * 60 * 1000,
  api_video: 5 * 60 * 1000,
  api_play: 3 * 60 * 1000,
  api_related: 5 * 60 * 1000,
  api_post_categories: 10 * 60 * 1000,
  api_post_category: 3 * 60 * 1000,
};

export const clearApiMemoryCache = () => {
  apiMemoryCache.clear();
  inFlightRequests.clear();
};

async function callNetwork<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const once = () => invoke(cmd, args) as Promise<T>;
  try {
    const r = await once();
    notifyNet({ ok: true, cmd });
    return r;
  } catch (e) {
    const msg =
      typeof e === "string"
        ? e
        : e instanceof Error
        ? e.message
        : typeof (e as { message?: unknown })?.message === "string"
        ? ((e as { message: string }).message)
        : "Request failed, please check your network connection";
    const status = /^HTTP (\d{3})\b/.exec(msg)?.[1];
    const networkish = !status && NET_FAIL.test(msg);
    const isTransientServer = Boolean(status && ["500", "502", "503", "504", "429"].includes(status));
    const retryable = networkish && READ_ONLY.has(cmd);
    // Log full error details to disk
    logLine(`[api] ${cmd} → ${msg}`);
    tracePlayback("api.fail", { cmd, err: msg, status: status ?? null, networkish, isTransientServer });
    notifyNet({ ok: false, cmd, msg, networkish: networkish || isTransientServer });
    // Retry read-only request once on transient network failure or upstream 50x/429
    if (retryable) {
      logLine(`[api] ${cmd} link unstable (${status ? `HTTP ${status}` : "network"}), retrying in 1.2s`);
      tracePlayback("api.retry", { cmd, err: msg, status: status ?? null });
      await new Promise((r) => setTimeout(r, 1200));
      try {
        const r = await once();
        logLine(`[api] ${cmd} retry succeeded`);
        tracePlayback("api.retry_ok", { cmd });
        notifyNet({ ok: true, cmd });
        return r;
      } catch (e2) {
        const again =
          typeof e2 === "string"
            ? e2
            : e2 instanceof Error
            ? e2.message
            : typeof (e2 as { message?: unknown })?.message === "string"
            ? ((e2 as { message: string }).message)
            : msg;
        const againStatus = /^HTTP (\d{3})\b/.exec(again)?.[1];
        logLine(`[api] ${cmd} retry still failed → ${again}`);
        tracePlayback("api.retry_failed", { cmd, err: again, status: againStatus ?? null });
        throw new Error(failMessage(again, againStatus));
      }
    }
    throw new Error(failMessage(msg, status));
  }
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const isReadOnly = READ_ONLY.has(cmd);
  const cacheTtl = CACHE_TTL_MAP[cmd];
  const cacheKey = isReadOnly ? `${cmd}:${args ? JSON.stringify(args) : ""}` : "";

  // 1. Check in-memory TTL cache (returns immediately in 0ms)
  if (cacheTtl && cacheKey) {
    const cached = apiMemoryCache.get(cacheKey);
    if (cached && cached.expires > Date.now()) {
      return cached.value as T;
    }
  }

  // 2. Check in-flight deduplication (shares promise with concurrent identical calls)
  if (isReadOnly && cacheKey && inFlightRequests.has(cacheKey)) {
    return inFlightRequests.get(cacheKey) as Promise<T>;
  }

  const reqPromise = callNetwork<T>(cmd, args)
    .then((result) => {
      if (cacheTtl && cacheKey) {
        apiMemoryCache.set(cacheKey, {
          value: result,
          expires: Date.now() + cacheTtl,
        });
      }
      if (cacheKey) inFlightRequests.delete(cacheKey);
      return result;
    })
    .catch((err) => {
      if (cacheKey) inFlightRequests.delete(cacheKey);
      throw err;
    });

  if (isReadOnly && cacheKey) {
    inFlightRequests.set(cacheKey, reqPromise);
  }

  return reqPromise;
}

/* ── API Client Endpoints ──────────────────────────────── */

export const api = {
  boot: () =>
    call<{
      user: User | null;
      logged_in: boolean;
      base: string;
      strict_security?: boolean;
      cli_relaxed?: boolean;
    }>("app_boot"),
  securitySet: (strict: boolean) => call<boolean>("security_set", { strict }),
  login: (username: string, password: string) =>
    call<{ user: User }>("api_login", { username, password }),
  register: (username: string, password: string, email = "") =>
    call<{ user: User }>("api_register", { username, password, email }),
  logout: () => call<{ ok: boolean }>("api_logout"),
  me: () => call<User>("api_me"),

  feed: (page = 1, size = 20) => call<Paged<VideoCard>>("api_feed", { page, size }),
  topics: () => call<{ items: TopicCard[] }>("api_topics"),
  topic: (slug: string) => call<TopicDetail>("api_topic", { slug }),
  tags: () => call<{ categories: TagGroup[] }>("api_tags"),
  tagVideos: (tag: string, page = 1, size = 20) =>
    call<Paged<VideoCard>>("api_tag_videos", { tag, page, size }),
  category: (cate: string, page = 1, size = 20, sort?: string) =>
    call<Paged<VideoCard>>("api_category", { cate, page, size, sort: sort ?? null }),
  originalVideos: (cate: string, page = 1, size = 20, sort?: string) =>
    call<Paged<VideoCard>>("api_original_videos", { cate, page, size, sort: sort ?? null }),
  rank: (kind: "hot" | "recommend" | "potential") =>
    call<{ type: string; items: RankItem[] }>("api_rank", { kind }),
  /** Full search across dramas and community posts */
  search: (q: string, page = 1, size = 20, kind?: "video" | "post") =>
    call<{ items: VideoCard[]; pagination: Paged<VideoCard>["pagination"]; keyword: string }>(
      "api_search", { q, page, size, kind: kind ?? null },
    ),
  /** Search community posts */
  searchPosts: (q: string, page = 1, size = 20) =>
    call<{ items: Post[]; pagination: Paged<Post>["pagination"]; keyword: string }>(
      "api_search", { q, page, size, kind: "post" },
    ),
  searchHot: () => call<{ items: HotSearchVideo[] }>("api_search_hot"),
  posts: (page = 1, size = 20, sort?: string) =>
    call<Paged<Post>>("api_posts", { page, size, sort: sort ?? null }),
  post: (id: number) => call<Post & { content?: string; video_url?: string }>("api_post", { id }),
  /** Community post video playback resolver */
  postPlayback: (id: number) => call<{ mode?: number; videos?: { index: number; url: string }[] }>("api_post_playback", { id }),

  video: (id: number) => call<Detail>("api_video", { id }),
  play: (id: number, ep: number) => call<PlayInfo>("api_play", { id, ep }),

  comments: (id: number, ep: number, page = 1, size = 20) =>
    call<CommentPage>("api_comments", { id, ep, page, size }),
  commentSend: (id: number, ep: number, text: string, replyId?: number) =>
    call<unknown>("api_comment_send", { id, ep, text, replyId: replyId ?? null }),

  clearCache: () => {
    clearApiMemoryCache();
    return invoke<void>("cache_clear");
  },
  netDiag: () => invoke<Record<string, unknown>>("net_diag"),
  postLike: (id: number, on: boolean) => invoke<unknown>("api_post_like", { id, on }),
  postCollect: (id: number, on: boolean) => invoke<unknown>("api_post_collect", { id, on }),
  postComments: (id: number, page: number, size: number) => call<CommentPage>("api_post_comments", { id, page, size }),
  postCategories: () => call<{ items: PostCategory[] }>("api_post_categories"),
  postCategory: (route: string, page = 1, size = 20, sort?: string) =>
    call<Paged<Post>>("api_post_category", { route, page, size, sort: sort ?? null }),
  related: (id: number) => call<{ items: VideoCard[] }>("api_related", { id }),
  following: (page = 1, size = 20) => call<Paged<VideoCard>>("api_following", { page, size }),
  user: (id: number) => call<UserProfile>("api_user", { id }),
  userStats: (id: number) => call<{ user_id: number; like_count: number; following: number; followers: number; video_count: number; post_count: number }>("api_user_stats", { id }),
  userVideos: (id: number, page = 1, size = 20) => call<Paged<VideoCard>>("api_user_videos", { id, page, size }),
  like: (id: number, ep: number, on: boolean) => call<unknown>("api_like", { id, ep, on }),
  collect: (id: number, on: boolean) => call<unknown>("api_collect", { id, on }),
  follow: (uid: number, on: boolean) => call<unknown>("api_follow", { uid, on }),

  /* Line sources */
  lineState: () => call<LineState>("line_state"),
  lineSet: (url: string) => {
    clearApiMemoryCache();
    return call<string>("line_set", { url });
  },
  lineCustomSet: (url: string) => {
    clearApiMemoryCache();
    return call<LineApply>("line_custom_set", { url });
  },
  lineReset: () => {
    clearApiMemoryCache();
    return call<LineApply>("line_reset");
  },
  lineCancel: () => call<void>("line_cancel"),
  lineMirrors: () => call<LineMirrors>("line_mirrors"),
  lineProbe: (urls: string[]) => call<LineProbe[]>("line_probe", { urls }),
  lineAuto: () => call<LineAuto>("line_auto"),
  /* Probes main site when on mirror line */
  lineTryMain: () => call<LineTryMain>("line_try_main"),
  /* Line health check */
  lineHealth: () => call<LineHealth>("line_health"),

  /* In-app proxy settings */
  proxyState: () => call<ProxyState>("proxy_state"),
  proxySet: (mode: ProxyMode, url: string) => call<ProxyState>("proxy_set", { mode, url }),
  proxyTest: (mode: ProxyMode, url: string) => call<ProxyProbe>("proxy_test", { mode, url }),

  /* Update checker */
  checkUpdate: () => call<UpdateInfo>("check_update"),
  openUrl: (url: string) => call<void>("open_url", { url }),
};

/* ── Update Checking ───────────────────────────────────── */

export type UpdateInfo = {
  /** Platform-specific update asset */
  asset?: { name: string; url: string; size?: number | null } | null;
  current: string;
  latest: string;
  tag?: string;
  arch?: string;
  has_update: boolean;
  url: string;
  name?: string;
  published_at?: string;
  notes?: string;
};

/* ── Source Lines ──────────────────────────────────────── */

export type LineItem = { name?: string; url: string; host?: string };
export type LineState = { base: string; default: string; fixed: LineItem[]; custom?: boolean };
export type LineApply = { base: string; custom: boolean };
export type LineMirrors = { source: string; script?: string; items: LineItem[]; recommended_source?: string; recommended: LineItem[] };
export type LineProbe = { url: string; ok: boolean; status?: number; ms: number; error?: string };
export type LineHealth = { base: string; ok: boolean; ms: number; status: number | null };

export type ProxyMode = "system" | "custom" | "off";
export type ProxyState = {
  mode: ProxyMode;
  /** Saved custom line URL */
  url: string;
  /** Sanitized outbound origin */
  effective?: string | null;
  system_proxy?: boolean;
  env_proxy?: boolean;
};
export type ProxyProbe = { ok: boolean; status?: number | null; ms: number; error?: string; via?: string };

/** Auto line selection candidate */
export type LineAutoCandidate = {
  tier: "main" | "cn" | "mirror";
  url: string;
  ok: boolean;
  reachable: boolean;
  ms: number;
  status: number | null;
};
export type LineAuto = {
  cancelled?: boolean;
  previous: string;
  base: string;
  switched: boolean;
  pick: {
    base: string;
    tier: "main" | "cn" | "mirror" | "none";
    ms: number;
    reason: string;
    candidates: LineAutoCandidate[];
  };
};

/** Main line probe result */
export type LineTryMain = {
  cancelled?: boolean;
  previous: string;
  base: string;
  switched: boolean;
  probe: { ok: boolean; base: string; tier: string; ms: number; status: number | null };
};

/** Extracts hostname for line display */
export const hostOf = (url: string) => {
  try { return new URL(url).host; } catch { return url.replace(/^https?:\/\//, "").replace(/\/.*$/, ""); }
};

/* ── Streaming Pipeline Verification Diagnostic ────────── */
export async function selfTest(): Promise<string> {
  const steps: string[] = [];
  try {
    const info = await api.play(117, 3);
    steps.push(`play:${info?.video_url ? "ok" : "empty"}`);
    const hlsUrl = `${LOCAL}/hls?u=${encodeURIComponent(info.video_url)}`;
    const r1 = await fetch(hlsUrl);
    const txt = await r1.text();
    steps.push(`hls:${r1.status}/${txt.length}/${txt.startsWith("#EXTM3U") ? "m3u8" : "bad"}`);
    const keyLine = txt.split("\n").find((l) => l.startsWith("#EXT-X-KEY"));
    if (keyLine) {
      const m = keyLine.match(/URI="([^"]+)"/);
      if (m) {
        const rustUrl = m[1];
        steps.push(`rustUrl:${rustUrl.slice(0, 60)}`);
        // Re-encode upstream URL via JS
        const inner = decodeURIComponent(rustUrl.split("?u=")[1] || "");
        steps.push(`inner:${inner.slice(0, 50)}`);
        try {
          const rk = await fetch(rustUrl);
          const bk = await rk.arrayBuffer();
          steps.push(`keyRust:${rk.status}/${bk.byteLength}`);
        } catch (e) { steps.push(`keyRust:throw:${(e as Error).message.slice(0, 30)}`); }
        try {
          const rk2 = await fetch(`${LOCAL}/seg?u=${encodeURIComponent(inner)}`);
          const bk2 = await rk2.arrayBuffer();
          steps.push(`keyJs:${rk2.status}/${bk2.byteLength}`);
        } catch (e) { steps.push(`keyJs:throw:${(e as Error).message.slice(0, 30)}`); }
      }
    }
    const segLine = txt.split("\n").find((l) => l && !l.startsWith("#") && l.includes("/seg?u="));
    if (segLine) {
      try {
        const r2 = await fetch(segLine.trim());
        const buf = await r2.arrayBuffer();
        steps.push(`seg:${r2.status}/${buf.byteLength}`);
      } catch (e) { steps.push(`seg:throw:${(e as Error).message.slice(0, 40)}`); }
    } else steps.push("seg:no-line");
  } catch (e) {
    steps.push(`err:${(e as Error).message.slice(0, 60)}`);
  }
  return steps.join(" | ");
}

/* ── Formatting Utilities ──────────────────────────────── */

export const fmt = (n: number | undefined) => {
  const v = Number(n) || 0;
  if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B`;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(v);
};

export const fmtTime = (s: number) => {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${m}:${ss.toString().padStart(2, "0")}`;
};

export const dur = (s?: number | string) => {
  const n = Number(s) || 0;
  if (n <= 0) return "";
  const m = Math.floor(n / 60);
  const ss = Math.floor(n % 60);
  return `${m}:${String(ss).padStart(2, "0")}`;
};

/** Passthrough URL for non-m3u8 media (mp4, etc.) */
export function directMedia(url: string): string {
  return `${LOCAL}/seg?u=${encodeURIComponent(url)}`;
}

/** Selects proxy handler based on media extension */
export function mediaUrl(url: string): string {
  return /\.m3u8(\?|$)/i.test(url) ? playlist(url) : directMedia(url);
}
