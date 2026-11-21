import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, platform as envPlatform } from "./api";
import { isStrictSecurity, setStrictSecurity as setHtmlStrictSecurity } from "./html";
import type { User } from "./types";
import { readStorage, removeStorage, writeStorage, STORAGE_KEYS } from "./storage";
import { getTranslation, type Language, type TranslationKey } from "./i18n";
import type { SubtitleMode, SubtitleSize } from "./subtitles/types";
import {
  auth,
  fetchCloudUserData,
  getCurrentAuthUid,
  saveUserDataToCloud,
  subscribeAuthState,
  logOutFirebase,
  hasActiveFirebaseSession,
  type CloudUserData,
} from "./firebase";

export type Platform = "android" | "ios" | "windows" | "macos" | "linux";
export type Theme = "dark" | "light";
export type ThemePreference = Theme | "system";
export type AccentColor = "blue" | "cyan" | "emerald" | "rose" | "amber" | "violet";
export type Tab = "home" | "search" | "category" | "profile";

/** Feed playback context: ids is source list, index is active item */
export type FeedContext = {
  kind: "feed";
  key: string;
  videoIds: number[];
  index: number;
  title: string;
  source: string;
  feedKind?: "video" | "post";
  /** Resume playback from history progress: start episode and time */
  startEp?: number;
  startTime?: number;
};

export type Page =
  | FeedContext
  | { kind: "channel"; key: string; cate: string; name: string }
  | { kind: "ranks"; key: string }
  | { kind: "settings"; key: string }
  | { kind: "posts"; key: string }
  | { kind: "post"; key: string; id: number }
  | { kind: "topics"; key: string }
  | { kind: "topic"; key: string; slug: string; name: string }
  | { kind: "tags"; key: string }
  | { kind: "tag"; key: string; tag: string; name: string }
  | { kind: "following"; key: string }
  | { kind: "user"; key: string; id: number; name?: string };

export type PageInput =
  | { kind: "feed"; videoIds: number[]; index: number; title: string; source?: string; feedKind?: "video" | "post"; startEp?: number; startTime?: number }
  | { kind: "channel"; cate: string; name: string }
  | { kind: "ranks" }
  | { kind: "settings" }
  | { kind: "posts" }
  | { kind: "post"; id: number }
  | { kind: "topics" }
  | { kind: "topic"; slug: string; name: string }
  | { kind: "tags" }
  | { kind: "tag"; tag: string; name: string }
  | { kind: "following" }
  | { kind: "user"; id: number; name?: string };

export type Toast = {
  id: number;
  msg: string;
  icon?: "ok" | "heart" | "star" | "info";
  /** Structured payload for line switch notification */
  line?: { region: "cn" | "intl"; host: string; ms: number };
};

/** Watch history record: episode, progress seconds, duration, title, and cover */
export type WatchProgress = {
  id: number;
  ep: number;
  t: number;
  dur: number;
  at: number;
  title?: string;
  cover?: string;
  tags?: string[];
  episode_count?: number;
  is_finished?: boolean;
};

type Persist = {
  likes: number[];
  favs: number[];
  watchLater?: number[];
  history: WatchProgress[];
  follows: number[];
  muted: boolean;
  muteOnStartup: boolean;
  volume: number;
  searchHist: string[];
  /** Vertical swipe switches episodes instead of next series */
  swipeEp: boolean;
  /** Prefer HEVC high definition stream when available */
  preferHevc: boolean;
};

const LS = STORAGE_KEYS.app;
const DEFAULTS: Persist = {
  likes: [], favs: [], watchLater: [], history: [], follows: [],
  muted: true, muteOnStartup: true, volume: 0.7, searchHist: [], swipeEp: true, preferHevc: false,
};

/** Migrates legacy history number[] to structured progress */
function normalizeHistory(raw: unknown): WatchProgress[] {
  if (!Array.isArray(raw)) return [];
  const out: WatchProgress[] = [];
  raw.forEach((item, i) => {
    if (typeof item === "number") {
      out.push({ id: item, ep: 1, t: 0, dur: 0, at: Date.now() - i });
      return;
    }
    const h = item as Partial<WatchProgress> | null;
    if (h && typeof h.id === "number") {
      out.push({
        id: h.id,
        ep: Number(h.ep) || 1,
        t: Number(h.t) || 0,
        dur: Number(h.dur) || 0,
        at: Number(h.at) || Date.now() - i,
        title: typeof h.title === "string" ? h.title : undefined,
        cover: typeof h.cover === "string" ? h.cover : undefined,
        tags: Array.isArray(h.tags) ? h.tags : undefined,
        episode_count: typeof h.episode_count === "number" ? h.episode_count : undefined,
        is_finished: typeof h.is_finished === "boolean" ? h.is_finished : undefined,
      });
    }
  });
  return out;
}

function loadPersist(): Persist {
  try {
    const raw = readStorage(LS);
    const swipeMigration = readStorage(STORAGE_KEYS.swipeEp);
    if (!raw) return DEFAULTS;
    const p = { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Persist>) };
    // Applied on startup only
    const muteOnStartup = p.muteOnStartup !== false;
    /* Defaults swipeEp to true for smooth episode switching */
    let swipeEp = p.swipeEp !== false;
    try {
      if (swipeMigration !== "1") {
        swipeEp = true;
        localStorage.setItem(STORAGE_KEYS.swipeEp, "1");
      }
    } catch { /* ignore */ }
    return {
      ...p,
      watchLater: Array.isArray(p.watchLater) ? p.watchLater : [],
      swipeEp,
      muteOnStartup,
      muted: muteOnStartup || p.muted === true,
      history: normalizeHistory(p.history),
    };
  } catch {
    return DEFAULTS;
  }
}

function loadLocalUser(): User | null {
  try {
    const raw = readStorage(STORAGE_KEYS.localUser);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<User> | null;
    if (
      parsed &&
      typeof parsed.id === "number" &&
      (parsed.user_type === "offline" || parsed.user_type === "firebase")
    ) {
      return parsed as User;
    }
    return null;
  } catch {
    return null;
  }
}

function readThemePreference(): ThemePreference {
  try {
    const saved = readStorage(STORAGE_KEYS.theme);
    if (saved === "light" || saved === "dark" || saved === "system") return saved;
    return "system";
  } catch {
    return "system";
  }
}

function readLanguagePreference(): Language {
  return "en";
}

function readSubtitleModePreference(): SubtitleMode {
  try {
    const saved = readStorage(STORAGE_KEYS.subtitleMode);
    if (saved === "off") return "off";
    return "en"; // Default to English subtitles only
  } catch {
    return "en";
  }
}

function readSubtitleSizePreference(): SubtitleSize {
  try {
    const saved = readStorage(STORAGE_KEYS.subtitleSize);
    if (saved === "sm" || saved === "md" || saved === "lg" || saved === "xl") return saved;
    return "md";
  } catch {
    return "md";
  }
}

function resolveTheme(preference: ThemePreference): Theme {
  if (preference === "dark") return "dark";
  if (preference === "light") return "light";
  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return "light";
}

function readAccentPreference(): AccentColor {
  try {
    const saved = readStorage(STORAGE_KEYS.accent);
    if (saved === "blue" || saved === "cyan" || saved === "emerald" || saved === "rose" || saved === "amber" || saved === "violet") return saved;
    return "blue";
  } catch {
    return "blue";
  }
}

function applyAccent(accent: AccentColor) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (accent === "blue") {
    root.removeAttribute("data-accent");
  } else {
    root.dataset.accent = accent;
  }
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.remove("theme-amoled");
  root.classList.toggle("theme-light", theme === "light");
  document.documentElement.style.colorScheme = theme;
  root.dataset.theme = theme;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = theme === "light" ? "#eeece7" : "#121212";
}

let themeTransitionTimer = 0;
function beginThemeTransition() {
  const root = document.documentElement;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  root.style.setProperty("--theme-transition-surface", getComputedStyle(root).getPropertyValue("--p-bg").trim());
  root.classList.add("theme-transitioning");
  window.clearTimeout(themeTransitionTimer);
  themeTransitionTimer = window.setTimeout(() => root.classList.remove("theme-transitioning"), 420);
}

type Store = {
  platform: Platform;
  theme: Theme; themePreference: ThemePreference; setTheme: (t: ThemePreference) => void;
  tab: Tab; setTab: (t: Tab) => void;
  stack: Page[]; push: (p: PageInput) => void; pop: () => void;
  user: User | null; setUser: (u: User | null) => void;
  loginOpen: boolean; setLoginOpen: (b: boolean) => void;
  logout: () => Promise<void>;
  likes: number[]; favs: number[]; watchLater: number[]; history: WatchProgress[]; follows: number[];
  isLiked: (id: number) => boolean; isFav: (id: number) => boolean; isWatchLater: (id: number) => boolean;
  toggleLikeLocal: (id: number) => boolean;
  toggleFavLocal: (id: number) => boolean;
  clearFavs: () => void;
  toggleWatchLaterLocal: (id: number) => boolean;
  clearWatchLater: () => void;
  /** Saves or updates watch history progress */
  addHistory: (
    id: number,
    ep?: number,
    t?: number,
    dur?: number,
    meta?: {
      title?: string;
      cover?: string;
      tags?: string[];
      episode_count?: number;
      is_finished?: boolean;
    }
  ) => void;
  removeHistory: (id: number) => void;
  clearHistory: () => void;
  toggleFollowLocal: (uid: number) => boolean;
  mergeCloudUserData: (cloudData: CloudUserData) => void;
  hydrateCloudForUid: (uid: string) => Promise<void>;
  theater: boolean; setTheater: (v: boolean | ((p: boolean) => boolean)) => void;
  fs: boolean; setFs: (v: boolean | ((p: boolean) => boolean)) => void;
  /** Immersive clean screen mode: hides player controls and overlays */
  clean: boolean; setClean: (v: boolean | ((p: boolean) => boolean)) => void;
  muted: boolean; setMuted: (v: boolean | ((p: boolean) => boolean)) => void;
  muteOnStartup: boolean; setMuteOnStartup: (on: boolean) => void;
  swipeEp: boolean; setSwipeEp: (on: boolean) => void;
  preferHevc: boolean; setPreferHevc: (on: boolean) => void;
  volume: number; setVolume: (v: number) => void;
  accent: AccentColor; setAccent: (accent: AccentColor) => void;
  searchHist: string[]; addSearch: (q: string) => void; removeSearch: (q: string) => void; clearSearchHist: () => void;
  strictSecurity: boolean; strictSecurityReady: boolean; securityPending: boolean; cliRelaxed: boolean; setStrictSecurity: (on: boolean) => Promise<void>;
  toasts: Toast[]; toast: (msg: string, icon?: Toast["icon"]) => void;
  /** Line switch counter: triggers view remount to refresh data */
  lineEpoch: number;
  language: Language;
  setLanguage: (lang: Language) => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  subtitleMode: SubtitleMode;
  setSubtitleMode: (m: SubtitleMode) => void;
  subtitleSize: SubtitleSize;
  setSubtitleSize: (s: SubtitleSize) => void;
};

const Ctx = createContext<Store>(null as unknown as Store);
export const useStore = () => useContext(Ctx);
let seq = 0;

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [p, setP] = useState<Persist>(loadPersist);
  const [themePreference, setThemePreferenceState] = useState<ThemePreference>(readThemePreference);
  const [theme, setThemeState] = useState<Theme>(() => resolveTheme(readThemePreference()));
  const themeRef = useRef(theme);
  const [tab, setTabRaw] = useState<Tab>("home");
  const [stack, setStack] = useState<Page[]>([]);
  const [user, setUserState] = useState<User | null>(loadLocalUser);
  const [cloudHydratedUid, setCloudHydratedUid] = useState<string | null>(null);
  const cloudHydratedUidRef = useRef<string | null>(null);
  const hydratingUidRef = useRef<string | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);

  const setUser = useCallback((next: User | null) => {
    setUserState(next);
    if (next?.user_type === "offline" || next?.user_type === "firebase") {
      writeStorage(STORAGE_KEYS.localUser, JSON.stringify(next));
    } else {
      removeStorage(STORAGE_KEYS.localUser);
    }
    if (next?.user_type !== "firebase") {
      cloudHydratedUidRef.current = null;
      hydratingUidRef.current = null;
      setCloudHydratedUid(null);
    }
  }, []);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [lineEpoch, setLineEpoch] = useState(0);
  const [theater, setTheaterState] = useState(false);
  const [fs, setFsState] = useState(false);
  const [clean, setCleanState] = useState(false);
  const [strictSecurity, setStrictSecurityState] = useState<boolean>(isStrictSecurity);
  const [cliRelaxed, setCliRelaxed] = useState(false);
  const [strictSecurityReady, setStrictSecurityReady] = useState(false);
  const [securityPending, setSecurityPending] = useState(false);
  const [language, setLanguageState] = useState<Language>(readLanguagePreference);
  const [accent, setAccentState] = useState<AccentColor>(readAccentPreference);
  const [subtitleMode, setSubtitleModeState] = useState<SubtitleMode>(readSubtitleModePreference);
  const [subtitleSize, setSubtitleSizeState] = useState<SubtitleSize>(readSubtitleSizePreference);
  const toastSeq = useRef(0);

  const setLanguage = useCallback((next: Language) => {
    setLanguageState(next);
    writeStorage(STORAGE_KEYS.lang, next);
  }, []);

  const setSubtitleMode = useCallback((next: SubtitleMode) => {
    const mode = next === "off" ? "off" : "en";
    setSubtitleModeState(mode);
    writeStorage(STORAGE_KEYS.subtitleMode, mode);
  }, []);

  const setSubtitleSize = useCallback((next: SubtitleSize) => {
    setSubtitleSizeState(next);
    writeStorage(STORAGE_KEYS.subtitleSize, next);
  }, []);

  const t = useCallback((key: TranslationKey, params?: Record<string, string | number>) => {
    return getTranslation(language, key, params);
  }, [language]);

  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const sync = () => {
      const next = resolveTheme(themePreference);
      if (themeRef.current !== next) beginThemeTransition();
      themeRef.current = next;
      setThemeState(next);
    };
    sync();
    if (themePreference === "system") {
      if (typeof media.addEventListener === "function") {
        media.addEventListener("change", sync);
        return () => media.removeEventListener("change", sync);
      } else if (typeof (media as any).addListener === "function") {
        (media as any).addListener(sync);
        return () => (media as any).removeListener(sync);
      }
    }
  }, [themePreference]);

  useLayoutEffect(() => {
    applyTheme(theme);
    writeStorage(STORAGE_KEYS.theme, themePreference);
  }, [theme, themePreference]);

  useLayoutEffect(() => {
    applyAccent(accent);
  }, [accent]);

  const setAccent = useCallback((next: AccentColor) => {
    applyAccent(next);
    setAccentState(next);
    writeStorage(STORAGE_KEYS.accent, next);
  }, []);

  const setTheme = useCallback((next: ThemePreference) => {
    const resolved = resolveTheme(next);
    if (resolved !== themeRef.current) beginThemeTransition();
    themeRef.current = resolved;
    setThemePreferenceState(next);
    setThemeState(resolved);
  }, []);

  useEffect(() => {
    writeStorage(LS, JSON.stringify(p));
  }, [p]);

  // Cloud sync to Firestore / Account Vault for authenticated users
  const syncTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current);
    const uid = getCurrentAuthUid();
    if (!uid || user?.user_type !== "firebase" || cloudHydratedUid !== uid) {
      return;
    }
    syncTimeoutRef.current = setTimeout(() => {
      try {
        const activeUid = getCurrentAuthUid();
        if (activeUid && user?.user_type === "firebase" && cloudHydratedUid === activeUid) {
          void saveUserDataToCloud(activeUid, {
            favorites: p.favs,
            likes: p.likes,
            watchLater: p.watchLater,
            history: p.history.map((h) => ({
              id: h.id,
              ep: h.ep,
              t: h.t,
              dur: h.dur,
              updatedAt: h.at,
              title: h.title,
              cover: h.cover,
            })),
          });
        }
      } catch {
        // ignore background sync error
      }
    }, 2000);
    return () => {
      if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current);
    };
  }, [p.favs, p.likes, p.watchLater, p.history, user, cloudHydratedUid]);

  useEffect(() => {
    let request = 0;
    let active = true;
    const readBoot = () => {
      const current = ++request;
      void api.boot().then((r) => {
        if (!active || current !== request) return;
        setUserState((prev) => {
          if (r.user && (r.user as User).id) {
            removeStorage(STORAGE_KEYS.localUser);
            return r.user as User;
          }
          if (prev?.user_type === "firebase" || prev?.user_type === "offline") {
            return prev;
          }
          return null;
        });
        if (typeof r.strict_security === "boolean") {
          setStrictSecurityState(r.strict_security);
          setHtmlStrictSecurity(r.strict_security);
          setStrictSecurityReady(true);
        }
        setCliRelaxed(!!r.cli_relaxed);
      }).catch(() => { /* Offline fallback */ });
    };
    readBoot();
    window.addEventListener("hg:line-changed", readBoot);
    window.addEventListener("hg:proxy-changed", readBoot);
    return () => {
      active = false;
      window.removeEventListener("hg:line-changed", readBoot);
      window.removeEventListener("hg:proxy-changed", readBoot);
    };
  }, []);

  const setStrictSecurity = useCallback(async (on: boolean) => {
    if (!strictSecurityReady) throw new Error("Security configuration not ready. Please restart the app.");
    setSecurityPending(true);
    try {
      const saved = await api.securitySet(on);
      setHtmlStrictSecurity(saved);
      setStrictSecurityState(saved);
    } finally {
      setSecurityPending(false);
    }
  }, [strictSecurityReady]);

  const toast = useCallback((msg: string, icon?: Toast["icon"]) => {
    const id = ++toastSeq.current;
    setToasts((t) => [...t.slice(-2), { id, msg, icon }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2200);
  }, []);
  /** Dispatched on successful automatic line switch */
  useEffect(() => {
    const onLine = (e: Event) => {
      const d = (e as CustomEvent<{ region: "cn" | "intl"; host: string; ms: number }>).detail;
      if (!d) return;
      const id = ++toastSeq.current;
      setToasts((t) => [...t.slice(-2), { id, msg: "", line: d }]);
      window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3200);
    };
    window.addEventListener("hg:line", onLine);
    return () => window.removeEventListener("hg:line", onLine);
  }, []);
  /** Notifies user when all streaming lines are currently unreachable (throttled to 60s) */
  useEffect(() => {
    let last = 0;
    const onDown = () => {
      const now = Date.now();
      if (now - last < 60_000) return;
      last = now;
      const id = ++toastSeq.current;
      setToasts((t) => [...t.slice(-2), { id, msg: "All streaming endpoints unavailable. Please check network or proxy.", icon: "info" }]);
      window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3600);
    };
    window.addEventListener("hg:line-down", onDown);
    return () => window.removeEventListener("hg:line-down", onDown);
  }, []);

  const setTheater = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setTheaterState((prev) => (typeof v === "function" ? (v as (p: boolean) => boolean)(prev) : v));
  }, []);

  const logout = useCallback(async () => {
    cloudHydratedUidRef.current = null;
    hydratingUidRef.current = null;
    setCloudHydratedUid(null);
    setUser(null);
    try { await api.logout(); } catch { /* ignore */ }
    try { await logOutFirebase(); } catch { /* ignore */ }
    toast("Logged out successfully", "info");
  }, [setUser, toast]);

  const mergeCloudUserData = useCallback((cloudData: CloudUserData) => {
    setP((prev) => {
      const mergedFavs = Array.from(new Set([...(cloudData.favorites || []), ...prev.favs]));
      const mergedLikes = Array.from(new Set([...(cloudData.likes || []), ...prev.likes]));
      const mergedWatchLater = Array.from(new Set([...(cloudData.watchLater || []), ...(prev.watchLater || [])]));

      const historyMap = new Map<number, WatchProgress>();
      for (const h of prev.history) {
        historyMap.set(h.id, h);
      }
      if (Array.isArray(cloudData.history)) {
        for (const ch of cloudData.history) {
          if (ch && typeof ch.id === "number") {
            const existing = historyMap.get(ch.id);
            if (!existing || (ch.updatedAt || 0) > existing.at) {
              historyMap.set(ch.id, {
                id: ch.id,
                ep: ch.ep || 1,
                t: ch.t || 0,
                dur: ch.dur || 0,
                at: ch.updatedAt || Date.now(),
                title: ch.title?.trim() ? ch.title : existing?.title,
                cover: ch.cover?.trim() ? ch.cover : existing?.cover,
                tags: existing?.tags,
                episode_count: existing?.episode_count,
                is_finished: existing?.is_finished,
              });
            }
          }
        }
      }
      const mergedHistory = Array.from(historyMap.values()).sort((a, b) => b.at - a.at).slice(0, 80);

      return {
        ...prev,
        favs: mergedFavs,
        likes: mergedLikes,
        watchLater: mergedWatchLater,
        history: mergedHistory,
      };
    });
  }, []);

  const hydrateCloudForUid = useCallback(async (uid: string) => {
    if (!uid || cloudHydratedUidRef.current === uid || hydratingUidRef.current === uid) {
      return;
    }
    hydratingUidRef.current = uid;
    try {
      const res = await fetchCloudUserData(uid);
      if (hydratingUidRef.current !== uid) return;
      if (res.ok) {
        if (res.data) {
          mergeCloudUserData(res.data);
        }
        cloudHydratedUidRef.current = uid;
        setCloudHydratedUid(uid);
      }
    } catch {
      // non-fatal; keep cloudHydratedUid unset so local state never overwrites cloud
    } finally {
      if (hydratingUidRef.current === uid) {
        hydratingUidRef.current = null;
      }
    }
  }, [mergeCloudUserData]);

  // Rehydrate Firebase user session and sync cloud data on launch or sign-in
  const shouldSubscribeFirebase = hasActiveFirebaseSession() || user?.user_type === "firebase";
  useEffect(() => {
    if (!shouldSubscribeFirebase) return;
    if (typeof window !== "undefined" && window.location.pathname.startsWith("/tests/")) {
      return;
    }
    const unsub = subscribeAuthState((fbUser) => {
      if (fbUser && fbUser.email) {
        let hash = 0;
        for (let i = 0; i < fbUser.uid.length; i++) {
          hash = ((hash << 5) - hash) + fbUser.uid.charCodeAt(i);
          hash |= 0;
        }
        setUser({
          id: Math.abs(hash) || 10001,
          username: fbUser.email.split("@")[0] || "User",
          nickname: fbUser.displayName || fbUser.email.split("@")[0] || "User",
          avatar: fbUser.photoURL || "",
          avatar_color: "#1a73e8",
          sign: "Firebase Cloud Sync Active",
          desc: fbUser.email,
          user_type: "firebase",
        });
        void hydrateCloudForUid(fbUser.uid);
      } else {
        cloudHydratedUidRef.current = null;
        hydratingUidRef.current = null;
        setCloudHydratedUid(null);
        setUserState((prev) => (prev?.user_type === "firebase" ? null : prev));
      }
    });
    return () => unsub?.();
  }, [shouldSubscribeFirebase, hydrateCloudForUid, setUser]);
  /** Line switch listener: increments epoch key to refresh content across views */
  useEffect(() => {
    const bump = () => setLineEpoch((n) => n + 1);
    window.addEventListener("hg:line-changed", bump);
    window.addEventListener("hg:proxy-changed", bump);
    return () => {
      window.removeEventListener("hg:line-changed", bump);
      window.removeEventListener("hg:proxy-changed", bump);
    };
  }, []);

  const setTab = useCallback((t: Tab) => { setTabRaw(t); setStack(s => s.length ? [] : s); }, []);
  const push = useCallback((pg: PageInput) => {
    setStack((s) => [...s, { ...pg, key: `p${++seq}` } as Page]);
  }, []);
  const pop = useCallback(() => setStack((s) => s.slice(0, -1)), []);

  const toggleLikeLocal = useCallback((id: number) => {
    let on = false;
    setP((s) => {
      on = !s.likes.includes(id);
      const likes = on ? [id, ...s.likes] : s.likes.filter((x) => x !== id);
      const favs = on ? (s.favs.includes(id) ? s.favs : [id, ...s.favs]) : s.favs.filter((x) => x !== id);
      return { ...s, likes, favs };
    });
    return on;
  }, []);
  const toggleFavLocal = useCallback((id: number) => {
    let on = false;
    setP((s) => {
      on = !s.favs.includes(id);
      const favs = on ? [id, ...s.favs] : s.favs.filter((x) => x !== id);
      const likes = on ? (s.likes.includes(id) ? s.likes : [id, ...s.likes]) : s.likes.filter((x) => x !== id);
      return { ...s, likes, favs };
    });
    return on;
  }, []);
  const clearFavs = useCallback(() => setP((s) => ({ ...s, favs: [], likes: [] })), []);
  const toggleWatchLaterLocal = useCallback((id: number) => {
    let on = false;
    setP((s) => {
      const list = s.watchLater || [];
      on = !list.includes(id);
      return { ...s, watchLater: on ? [id, ...list] : list.filter((x) => x !== id) };
    });
    return on;
  }, []);
  const clearWatchLater = useCallback(() => setP((s) => ({ ...s, watchLater: [] })), []);
  const toggleFollowLocal = useCallback((uid: number) => {
    let on = false;
    setP((s) => {
      on = !s.follows.includes(uid);
      return { ...s, follows: on ? [uid, ...s.follows] : s.follows.filter((x) => x !== uid) };
    });
    return on;
  }, []);
  const addHistory = useCallback(
    (
      id: number,
      ep?: number,
      t?: number,
      dur?: number,
      meta?: {
        title?: string;
        cover?: string;
        tags?: string[];
        episode_count?: number;
        is_finished?: boolean;
      }
    ) => {
      if (!id) return;
      setP((s) => {
        const prev = s.history.find((x) => x.id === id);
        const epChanged = ep !== undefined && prev !== undefined && prev.ep !== ep;
        const entry: WatchProgress = {
          id,
          ep: ep ?? prev?.ep ?? 1,
          t: epChanged ? 0 : (t ?? prev?.t ?? 0),
          dur: dur ?? prev?.dur ?? 0,
          at: Date.now(),
          title: meta?.title?.trim() ? meta.title : prev?.title,
          cover: meta?.cover?.trim() ? meta.cover : prev?.cover,
          tags: meta?.tags && meta.tags.length > 0 ? meta.tags : prev?.tags,
          episode_count: meta?.episode_count ?? prev?.episode_count,
          is_finished: meta?.is_finished ?? prev?.is_finished,
        };
        return { ...s, history: [entry, ...s.history.filter((x) => x.id !== id)].slice(0, 80) };
      });
    },
    []
  );
  const removeHistory = useCallback((id: number) => {
    setP((s) => ({ ...s, history: s.history.filter((x) => x.id !== id) }));
  }, []);
  const clearHistory = useCallback(() => setP((s) => ({ ...s, history: [] })), []);
  const addSearch = useCallback((q: string) => {
    const t = q.trim();
    if (!t) return;
    setP((s) => ({ ...s, searchHist: [t, ...s.searchHist.filter((x) => x !== t)].slice(0, 12) }));
  }, []);
  const removeSearch = useCallback((q: string) => {
    const t = q.trim();
    setP((s) => ({ ...s, searchHist: s.searchHist.filter((x) => x !== t) }));
  }, []);
  const clearSearchHist = useCallback(() => setP((s) => ({ ...s, searchHist: [] })), []);

  const setFs = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setFsState((prev) => (typeof v === "function" ? (v as (p: boolean) => boolean)(prev) : v));
    // Reset clean screen on fullscreen toggle
    setCleanState(false);
  }, []);

  const setClean = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setCleanState((prev) => (typeof v === "function" ? (v as (p: boolean) => boolean)(prev) : v));
  }, []);

  const setMuted = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setP((s) => ({ ...s, muted: typeof v === "function" ? v(s.muted) : v }));
  }, []);
  const setMuteOnStartup = useCallback((on: boolean) => {
    setP((s) => ({ ...s, muteOnStartup: on }));
  }, []);
  const setSwipeEp = useCallback((on: boolean) => {
    setP((s) => ({ ...s, swipeEp: on }));
  }, []);
  const setPreferHevc = useCallback((on: boolean) => {
    setP((s) => ({ ...s, preferHevc: on }));
  }, []);
  const setVolume = useCallback((v: number) => {
    const volume = Math.max(0, Math.min(1, v));
    setP((s) => ({ ...s, volume, muted: volume === 0 }));
  }, []);

  const value = useMemo<Store>(() => ({
    platform: envPlatform,
    theme, themePreference, setTheme,
    tab, setTab, stack, push, pop,
    user, setUser, loginOpen, setLoginOpen, logout,
    likes: p.likes, favs: p.favs, watchLater: p.watchLater || [], history: p.history, follows: p.follows,
    isLiked: (id) => p.likes.includes(id),
    isFav: (id) => p.favs.includes(id),
    isWatchLater: (id) => (p.watchLater || []).includes(id),
    toggleLikeLocal, toggleFavLocal, clearFavs, toggleWatchLaterLocal, clearWatchLater, toggleFollowLocal, addHistory, removeHistory, clearHistory, mergeCloudUserData, hydrateCloudForUid,
    muted: p.muted, setMuted, volume: p.volume, setVolume, theater, setTheater, fs, setFs, clean, setClean,
    muteOnStartup: p.muteOnStartup, setMuteOnStartup,
    swipeEp: p.swipeEp, setSwipeEp,
    preferHevc: p.preferHevc, setPreferHevc,
    accent, setAccent,
    searchHist: p.searchHist, addSearch, removeSearch, clearSearchHist,
    strictSecurity, strictSecurityReady, securityPending, cliRelaxed, setStrictSecurity,
    toasts, toast, lineEpoch,
    language, setLanguage, t,
    subtitleMode, setSubtitleMode, subtitleSize, setSubtitleSize,
  }), [theme, themePreference, setTheme, accent, setAccent, tab, setTab, stack, push, pop, user, setUser, loginOpen, logout,
    p, toggleLikeLocal, toggleFavLocal, clearFavs, toggleWatchLaterLocal, clearWatchLater, toggleFollowLocal, addHistory, removeHistory, clearHistory, mergeCloudUserData, hydrateCloudForUid,
    setMuted, setMuteOnStartup, setSwipeEp, setPreferHevc, setVolume, addSearch, removeSearch, clearSearchHist, strictSecurity, strictSecurityReady, securityPending, cliRelaxed, setStrictSecurity,
    toasts, toast, lineEpoch, theater, setTheater, fs, setFs, clean, setClean,
    language, setLanguage, t, subtitleMode, setSubtitleMode, subtitleSize, setSubtitleSize]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
