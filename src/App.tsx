import { LiquidIndicator, Loader } from "./components/ios/effects";
import { Button } from "./components/ios/controls";
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore, type Page, type Tab } from "./store";
import { api, isMobile, selfTest, type UpdateInfo } from "./api";
import { addPluginListener, invoke } from "@tauri-apps/api/core";
import { runBack } from "./back";
import Home from "./pages/Home";
import Feed from "./components/Feed";
import { getSkippedUpdateVersion, isAndroidNativeOtaSupported, isAutoUpdateCheckEnabled, setAvailableUpdateInfo } from "./otaUpdater";
import { ToastHost } from "./components/ui";
import { DesktopRail, DesktopTitleBar } from "./components/DesktopChrome";
import ResizeHandles from "./components/ResizeHandles";
import ContinueWatchingBar from "./components/ContinueWatchingBar";
import { tracePlayback } from "./playbackDiagnostics";
import { IGrid, IGridF, IHome, IHomeF, ISearch, IUser, IUserF } from "./icons";

const Search = lazy(() => import("./pages/Search"));
const RankPage = lazy(() => import("./pages/Search").then((m) => ({ default: m.RankPage })));
const Category = lazy(() => import("./pages/Category"));
const ChannelPage = lazy(() => import("./pages/Category").then((m) => ({ default: m.ChannelPage })));
const Profile = lazy(() => import("./pages/Profile"));
const SettingsPage = lazy(() => import("./pages/Settings"));
const PostsPage = lazy(() => import("./pages/Posts").then((m) => ({ default: m.PostsPage })));
const PostDetail = lazy(() => import("./pages/Posts").then((m) => ({ default: m.PostDetail })));
const TopicsPage = lazy(() => import("./pages/Discover").then((m) => ({ default: m.TopicsPage })));
const TopicPage = lazy(() => import("./pages/Discover").then((m) => ({ default: m.TopicPage })));
const TagsPage = lazy(() => import("./pages/Discover").then((m) => ({ default: m.TagsPage })));
const TagPage = lazy(() => import("./pages/Discover").then((m) => ({ default: m.TagPage })));
const FollowingPage = lazy(() => import("./pages/User").then((m) => ({ default: m.FollowingPage })));
const UserPage = lazy(() => import("./pages/User").then((m) => ({ default: m.UserPage })));
const LoginModal = lazy(() => import("./components/LoginModal"));
const UpdateModal = lazy(() => import("./components/UpdateModal"));

function PageFallback() {
  return (
    <div className="ios-page absolute inset-0 bg-bg flex items-center justify-center" aria-busy="true">
      <Loader className="w-7 h-7 spinner" />
    </div>
  );
}

function useNativeBottomInset() {
  const { platform } = useStore();
  const [bottom, setBottom] = useState(() => (platform === "android" ? 24 : 16));
  useEffect(() => {
    if (platform !== "android") {
      setBottom(16);
      return undefined;
    }
    const read = () => {
      try {
        const w = window as unknown as {
          __auraNativeInsets?: { bottom?: number };
          AuraNativeExport?: { getSystemInsets?: () => string };
        };
        if (typeof w.__auraNativeInsets?.bottom === "number") {
          setBottom(Math.max(0, w.__auraNativeInsets.bottom));
          return;
        }
        const raw = w.AuraNativeExport?.getSystemInsets?.();
        if (raw) {
          const parsed = JSON.parse(raw) as { bottom?: number };
          if (typeof parsed.bottom === "number") {
            setBottom(Math.max(0, parsed.bottom));
          }
        }
      } catch { /* ignore */ }
    };
    read();
    window.addEventListener("aurastream:insets-changed", read);
    return () => window.removeEventListener("aurastream:insets-changed", read);
  }, [platform]);
  return bottom;
}

function useSoftKeyboardOpen(enabled: boolean) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!enabled || typeof window === "undefined") {
      setOpen(false);
      document.body.classList.remove("has-keyboard");
      return undefined;
    }
    const baseHeightRef = { current: window.innerHeight };
    const check = () => {
      const vv = window.visualViewport;
      const vh = vv ? vv.height : window.innerHeight;
      if (vh > baseHeightRef.current) baseHeightRef.current = vh;
      const ae = document.activeElement;
      const isTextInput = ae instanceof HTMLInputElement || ae instanceof HTMLTextAreaElement || (ae instanceof HTMLElement && ae.isContentEditable);
      const next = isTextInput && baseHeightRef.current - vh > 120;
      setOpen(next);
      document.body.classList.toggle("has-keyboard", next);
    };
    const onFocusOut = () => window.setTimeout(check, 60);
    const vv = window.visualViewport;
    vv?.addEventListener("resize", check);
    window.addEventListener("resize", check);
    document.addEventListener("focusin", check, true);
    document.addEventListener("focusout", onFocusOut, true);
    return () => {
      document.body.classList.remove("has-keyboard");
      vv?.removeEventListener("resize", check);
      window.removeEventListener("resize", check);
      document.removeEventListener("focusin", check, true);
      document.removeEventListener("focusout", onFocusOut, true);
    };
  }, [enabled]);
  return open;
}

function TabBar() {
  const { tab, setTab, platform, t } = useStore();
  const items = [
    { key: "home", label: t("nav.home"), Icon: IHome, Active: IHomeF },
    { key: "search", label: t("nav.search"), Icon: ISearch, Active: ISearch },
    { key: "category", label: t("nav.category"), Icon: IGrid, Active: IGridF },
    { key: "profile", label: t("nav.profile"), Icon: IUser, Active: IUserF },
  ] as const;
  const index = items.findIndex(item => item.key === tab);
  const handleTabClick = (key: Tab) => {
    if (tab === key) {
      window.dispatchEvent(new CustomEvent("hg:scroll-to-top", { detail: { tab: key } }));
    } else {
      setTab(key);
    }
  };
  return <nav className="hg-tabbar ios-mobile-nav" aria-label="Main Navigation" data-over-video={tab === "home"}
    style={{ paddingBottom: platform === "android" ? "max(var(--sab, 16px), 10px)" : "calc(var(--sab, 16px) * .55)" }}>
      <div className="hg-glass">
      <div className="hg-drop" aria-hidden="true" style={{ transform: `translateX(${index * 100}%)` }}><LiquidIndicator /></div>
      <div className="ios-mobile-nav-items">
        {items.map(({ key, label, Icon, Active }) => {
          const isCurrent = tab === key;
          const Glyph = isCurrent ? Active : Icon;
          return <Button key={key} className={`ios-mobile-nav-item ${isCurrent ? "is-active" : ""}`} onClick={() => handleTabClick(key)}
            aria-label={label}
            aria-current={isCurrent ? "page" : undefined}>
            <Glyph size={22} /><span>{label}</span>
          </Button>;
        })}
      </div>
    </div>
  </nav>;
}

/* ============ Stack Pages ============ */
function StackPage({ page, onBack, wide, top, bottomInset }: {
  page: Page; onBack: () => void; wide: boolean; top: boolean; bottomInset: number;
}) {
  if (page.kind === "feed") {
    return (
      <Feed videoIds={page.videoIds} startIndex={page.index} title={page.title} kind={page.feedKind || "video"}
        startEp={page.startEp} startTime={page.startTime}
        offlineOnly={page.source === "offline"}
        mode="context" active={top} bottomInset={bottomInset} onBack={onBack} />
    );
  }
  return (
    <Suspense fallback={<PageFallback />}>
      {page.kind === "channel" ? <ChannelPage cate={page.cate} name={page.name} onBack={onBack} wide={wide} active={top} />
        : page.kind === "ranks" ? <RankPage onBack={onBack} wide={wide} />
        : page.kind === "settings" ? <SettingsPage onBack={onBack} wide={wide} />
        : page.kind === "posts" ? <PostsPage onBack={onBack} wide={wide} active={top} />
        : page.kind === "post" ? <PostDetail id={page.id} onBack={onBack} active={top} />
        : page.kind === "topics" ? <TopicsPage onBack={onBack} wide={wide} active={top} />
        : page.kind === "topic" ? <TopicPage slug={page.slug} name={page.name} onBack={onBack} wide={wide} active={top} />
        : page.kind === "tags" ? <TagsPage onBack={onBack} wide={wide} active={top} />
        : page.kind === "tag" ? <TagPage tag={page.tag} name={page.name} onBack={onBack} wide={wide} active={top} />
        : page.kind === "following" ? <FollowingPage onBack={onBack} wide={wide} />
        : page.kind === "user" ? <UserPage id={page.id} name={page.name} onBack={onBack} wide={wide} />
        : null}
    </Suspense>
  );
}

/* ============ Main Application ============ */
/** Hide covered pages from the compositor to save GPU/RAM while keeping scroll offsets intact */
function LayerBox({
  hidden,
  inert,
  ariaHidden,
  className,
  enterClass,
  style,
  children,
}: {
  hidden: boolean;
  inert: boolean;
  ariaHidden: boolean;
  className: string;
  enterClass?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const scrollOffsetsRef = useRef<Map<HTMLElement, number>>(new Map());
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;
  const [entered, setEntered] = useState(() => !enterClass || hidden);

  useEffect(() => {
    if (hidden) setEntered(true);
  }, [hidden]);

  useEffect(() => {
    if (hidden || entered || !enterClass) return undefined;
    const timer = window.setTimeout(() => setEntered(true), 480);
    return () => window.clearTimeout(timer);
  }, [hidden, entered, enterClass]);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const onScroll = (e: Event) => {
      if (hiddenRef.current) return;
      const target = e.target;
      if (target instanceof HTMLElement && root.contains(target)) {
        scrollOffsetsRef.current.set(target, target.scrollTop);
      }
    };
    root.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => {
      root.removeEventListener("scroll", onScroll, true);
    };
  }, []);

  useLayoutEffect(() => {
    if (hidden) return;
    const saved = scrollOffsetsRef.current;
    if (!saved.size) return;
    for (const [el, top] of Array.from(saved.entries())) {
      if (!el.isConnected) {
        saved.delete(el);
        continue;
      }
      if (Math.abs(el.scrollTop - top) > 1) el.scrollTop = top;
    }
  }, [hidden]);

  const entering = !hidden && !entered && !!enterClass;
  const boxStyle: React.CSSProperties | undefined = entering
    ? { ...style, boxShadow: "-18px 0 40px rgba(0,0,0,.5)" }
    : style;
  const boxClass = hidden
    ? `${className} hidden pointer-events-none`
    : `${className}${entering ? ` ${enterClass}` : ""}`;

  return (
    <div
      ref={ref}
      inert={inert || undefined}
      aria-hidden={ariaHidden}
      className={boxClass}
      style={boxStyle}
      onAnimationEnd={entering ? (e) => { if (e.target === ref.current) setEntered(true); } : undefined}
    >
      {children}
    </div>
  );
}

function AppBody() {
  const { platform, tab, setTab, stack, pop, loginOpen, setLoginOpen, fs, setFs, clean, setClean } = useStore();
  const mainRef = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(!isMobile);
  const [mountedTabs, setMountedTabs] = useState<Set<Tab>>(() => new Set(["home"]));
  const androidInsetBottom = useNativeBottomInset();
  const keyboardOpen = useSoftKeyboardOpen(isMobile);

  useEffect(() => {
    setMountedTabs((prev) => (prev.has(tab) ? prev : new Set(prev).add(tab)));
  }, [tab]);

  useLayoutEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWide(el.clientWidth > 640));
    ro.observe(el);
    setWide(el.clientWidth > 640);
    return () => ro.disconnect();
  }, []);

  /* Hardware Back Key / Dismissal navigation */
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) {
        if (e.key === "Escape") t.blur();
        return;
      }
      if (e.key === "Escape" && runBack()) return;
      if (e.key === "Escape" && fs) { setFs(false); return; }
      if (loginOpen) { if (e.key === "Escape") setLoginOpen(false); return; }
      if (e.key === "Escape") {
        if (stack.length) {
          if (clean) setClean(false);
          pop();
        } else if (tab !== "home") {
          setTab("home");
        }
        return;
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [stack.length, pop, loginOpen, setLoginOpen, clean, setClean, fs, setFs, tab, setTab]);

  const vis = (k: Tab) => (tab === k ? `absolute inset-0 ${k === "home" ? "" : "ios-tab-active"}` : "absolute inset-0 hidden pointer-events-none");
  const pageActive = stack.length === 0 && !loginOpen;
  const cleanActive = clean && (tab === "home" || stack[stack.length - 1]?.kind === "feed");
  const bottomInset = isMobile ? (fs || cleanActive || keyboardOpen ? 0 : (platform === "android" ? 68 + Math.max(androidInsetBottom, 10) : 74)) : 14;
  /* Stack pages (feed from search/category/profile) render without bottom nav */
  const stackInset = isMobile ? 0 : 14;

  return (
    <div className={`absolute inset-0 flex bg-canvas plat-${platform}`}>
      <div ref={mainRef} className="relative flex-1 min-w-0 overflow-hidden win-main">
        <LayerBox hidden={stack.length > 0} inert={!pageActive} ariaHidden={!pageActive} className="absolute inset-0">
          <div className={vis("home")} inert={(!pageActive || tab !== "home") || undefined} aria-hidden={!pageActive || tab !== "home"}><Home active={pageActive && tab === "home"} bottomInset={bottomInset} /></div>
          {mountedTabs.has("search") && <LayerBox hidden={!pageActive || tab !== "search"} inert={!pageActive || tab !== "search"} ariaHidden={!pageActive || tab !== "search"} className="absolute inset-0 ios-tab-active"><Suspense fallback={<PageFallback />}><Search active={pageActive && tab === "search"} wide={wide} /></Suspense></LayerBox>}
          {mountedTabs.has("category") && <LayerBox hidden={!pageActive || tab !== "category"} inert={!pageActive || tab !== "category"} ariaHidden={!pageActive || tab !== "category"} className="absolute inset-0 ios-tab-active"><Suspense fallback={<PageFallback />}><Category wide={wide} active={pageActive && tab === "category"} /></Suspense></LayerBox>}
          {mountedTabs.has("profile") && <LayerBox hidden={!pageActive || tab !== "profile"} inert={!pageActive || tab !== "profile"} ariaHidden={!pageActive || tab !== "profile"} className="absolute inset-0 ios-tab-active"><Suspense fallback={<PageFallback />}><Profile wide={wide} active={pageActive && tab === "profile"} /></Suspense></LayerBox>}
        </LayerBox>

        {stack.map((p, i) => (
          <LayerBox
            key={p.key}
            hidden={i !== stack.length - 1}
            inert={i !== stack.length - 1 || loginOpen}
            ariaHidden={i !== stack.length - 1 || loginOpen}
            className={`absolute inset-0 z-30 bg-bg ${fs && i === stack.length - 1 ? "" : "isolate"}`}
            enterClass={platform === "android" && p.kind === "feed" ? undefined : "a-page-in"}
            style={{ zIndex: 30 + i }}>
            <StackPage page={p} onBack={pop} wide={wide} top={i === stack.length - 1} bottomInset={stackInset} />
          </LayerBox>
        ))}

        {platform === "android" && !fs && !keyboardOpen && stack.length > 0 && stack[stack.length - 1]?.kind !== "feed" && (
          <div
            aria-hidden="true"
            className="pointer-events-none fixed inset-x-0 bottom-0"
            style={{
              zIndex: Math.min(48, 30 + stack.length),
              height: "calc(max(var(--sab, 0px), 16px) + 18px)",
              background: "linear-gradient(to top, var(--p-bg) 56%, transparent)",
            }}
          />
        )}
        {isMobile && !fs && !cleanActive && !keyboardOpen && stack.length === 0 && !loginOpen && tab !== "home" && tab !== "profile" && <ContinueWatchingBar />}
        {isMobile && !fs && !cleanActive && !keyboardOpen && stack.length === 0 && !loginOpen && <TabBar />}
      </div>
    </div>
  );
}

/* ============ Desktop Window Frame ============ */
function DesktopShell() {
  const [collapsed, setCollapsed] = useState(() => window.innerWidth < 1100);
  useEffect(() => {
    const query = matchMedia("(max-width: 1099px)");
    const update = () => setCollapsed(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const { theater, platform } = useStore();
  return (
    <div className={`absolute inset-0 flex flex-col bg-canvas win-root plat-${platform}`}>
      <DesktopTitleBar collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
      <div className="relative flex-1 min-h-0">
        <ShellInner collapsed={collapsed || theater} theater={theater} />
      </div>
      {/* Resize handles for frameless desktop windows */}
      {(platform === "windows" || platform === "linux") && <ResizeHandles />}
    </div>
  );
}

function ShellInner({ collapsed, theater }: { collapsed: boolean; theater: boolean }) {
  const { stack, pop, loginOpen, setLoginOpen, tab, setTab, platform } = useStore();
  const mainRef = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(true);
  const [mountedTabs, setMountedTabs] = useState<Set<Tab>>(() => new Set(["home"]));

  useEffect(() => {
    setMountedTabs((prev) => (prev.has(tab) ? prev : new Set(prev).add(tab)));
  }, [tab]);

  useLayoutEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWide(el.clientWidth > 640));
    ro.observe(el);
    setWide(el.clientWidth > 640);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) {
        if (e.key === "Escape") t.blur();
        return;
      }
      if (e.key === "Escape" && runBack()) return;
      if (loginOpen) { if (e.key === "Escape") setLoginOpen(false); return; }
      if (e.key === "Escape") { if (stack.length) pop(); return; }
      if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && stack.length === 0 && !loginOpen) {
        e.preventDefault();
        setTab("search");
        return;
      }
      if (tab !== "home" && stack.length === 0 && ["1", "2", "3", "4"].includes(e.key) && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        setTab((["home", "search", "category", "profile"] as Tab[])[Number(e.key) - 1]);
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [stack.length, pop, setTab, loginOpen, setLoginOpen, tab]);

  const vis = (k: Tab) => (tab === k ? `absolute inset-0 ${k === "home" ? "" : "ios-tab-active"}` : "absolute inset-0 hidden pointer-events-none");
  const pageActive = stack.length === 0 && !loginOpen;

  return (
    <div className={`absolute inset-0 flex bg-canvas plat-${platform}`}>
      {!theater && <DesktopRail collapsed={collapsed} />}
      <div ref={mainRef} className={`relative flex-1 min-w-0 overflow-hidden win-main ${theater ? "is-theater-main" : ""}`}>
        <LayerBox hidden={stack.length > 0} inert={!pageActive} ariaHidden={!pageActive} className="absolute inset-0">
          <div className={vis("home")} inert={(!pageActive || tab !== "home") || undefined} aria-hidden={!pageActive || tab !== "home"}><Home active={pageActive && tab === "home"} bottomInset={14} /></div>
          {mountedTabs.has("search") && <div className={vis("search")} inert={(!pageActive || tab !== "search") || undefined} aria-hidden={!pageActive || tab !== "search"}><Suspense fallback={<PageFallback />}><Search active={pageActive && tab === "search"} wide={wide} /></Suspense></div>}
          {mountedTabs.has("category") && <div className={vis("category")} inert={(!pageActive || tab !== "category") || undefined} aria-hidden={!pageActive || tab !== "category"}><Suspense fallback={<PageFallback />}><Category wide={wide} active={pageActive && tab === "category"} /></Suspense></div>}
          {mountedTabs.has("profile") && <div className={vis("profile")} inert={(!pageActive || tab !== "profile") || undefined} aria-hidden={!pageActive || tab !== "profile"}><Suspense fallback={<PageFallback />}><Profile wide={wide} active={pageActive && tab === "profile"} /></Suspense></div>}
        </LayerBox>
        {stack.map((p, i) => (
          <LayerBox
            key={p.key}
            hidden={i !== stack.length - 1}
            inert={i !== stack.length - 1 || loginOpen}
            ariaHidden={i !== stack.length - 1 || loginOpen}
            enterClass="win-page-in"
            className="absolute inset-0 z-30 bg-bg"
            style={{ zIndex: 30 + i, boxShadow: "-18px 0 40px rgba(0,0,0,.5)" }}>
            <StackPage page={p} onBack={pop} wide={wide} top={i === stack.length - 1} bottomInset={14} />
          </LayerBox>
        ))}
        {stack.length === 0 && !loginOpen && tab !== "home" && <ContinueWatchingBar />}
      </div>
    </div>
  );
}

/* ============ Mobile Container ============ */
function MobileShell() {
  const { platform } = useStore();
  return (
    <div className={`absolute inset-0 flex flex-col bg-canvas plat-${platform}`}>
      <div className="relative flex-1 min-h-0">
        <AppBody />
      </div>
    </div>
  );
}

/* ============ Application Entrypoint ============ */
export default function App() {
  const { platform, theme, loginOpen, setLoginOpen, tab, setTab, stack, pop, fs, setFs, clean, setClean, toast } = useStore();
  const [startupUpdate, setStartupUpdate] = useState<UpdateInfo | null>(null);
  const lastBackPressRef = useRef<number>(0);
  useEffect(() => {
    tracePlayback("navigation.change", { tab, stack: stack.map(p => ({ page: p.kind, key: p.key })), login_open: loginOpen });
  }, [tab, stack, loginOpen]);

  useEffect(() => {
    if (platform !== "android") return undefined;
    const isDarkSurface = theme === "dark" || fs || (stack.length > 0 ? stack[stack.length - 1]?.kind === "feed" : tab === "home");
    try {
      (window as unknown as { AuraNativeExport?: { setSystemBarAppearance?: (d: boolean) => void } })
        .AuraNativeExport?.setSystemBarAppearance?.(isDarkSurface);
    } catch { /* ignore */ }
    return undefined;
  }, [platform, theme, fs, tab, stack]);

  useEffect(() => {
    const isAndroid = platform === "android";
    const applyInsets = (detail?: { top?: number; bottom?: number; left?: number; right?: number }) => {
      let info = detail;
      if (!info && isAndroid) {
        try {
          const w = window as unknown as {
            __auraNativeInsets?: { top?: number; bottom?: number; left?: number; right?: number };
            AuraNativeExport?: { getSystemInsets?: () => string };
          };
          if (w.__auraNativeInsets) info = w.__auraNativeInsets;
          else if (typeof w.AuraNativeExport?.getSystemInsets === "function") {
            const raw = w.AuraNativeExport.getSystemInsets();
            if (raw) info = JSON.parse(raw);
          }
        } catch { /* ignore */ }
      }
      if (isAndroid && info && (typeof info.top === "number" || typeof info.bottom === "number")) {
        const t = Math.max(info.top ?? 0, 12);
        const b = Math.max(info.bottom ?? 0, 0);
        const l = Math.max(info.left ?? 0, 0);
        const r = Math.max(info.right ?? 0, 0);
        document.documentElement.style.setProperty("--sat", `${t}px`);
        document.documentElement.style.setProperty("--sab", `${b}px`);
        document.documentElement.style.setProperty("--sal", `${l}px`);
        document.documentElement.style.setProperty("--sar", `${r}px`);
      } else {
        document.documentElement.style.setProperty("--sat", "max(env(safe-area-inset-top, 0px), 12px)");
        document.documentElement.style.setProperty("--sab", isAndroid ? "max(env(safe-area-inset-bottom, 0px), 24px)" : "max(env(safe-area-inset-bottom, 0px), 16px)");
        document.documentElement.style.setProperty("--sal", "env(safe-area-inset-left, 0px)");
        document.documentElement.style.setProperty("--sar", "env(safe-area-inset-right, 0px)");
      }
    };
    applyInsets();
    const onInsets = (e: Event) => applyInsets((e as CustomEvent<{ top?: number; bottom?: number; left?: number; right?: number }>).detail);
    const onTrim = () => {
      if ((window as unknown as { AuraNativeExport?: { isAvailable?: () => boolean } }).AuraNativeExport?.isAvailable?.()) {
        invoke("cache_clear").catch(() => {});
      }
    };
    window.addEventListener("aurastream:insets-changed", onInsets);
    window.addEventListener("aurastream:trim-memory", onTrim);
    return () => {
      window.removeEventListener("aurastream:insets-changed", onInsets);
      window.removeEventListener("aurastream:trim-memory", onTrim);
    };
  }, [platform]);

  /* iOS: Temporarily enables text interaction when focusing input elements */
  useEffect(() => {
    if (platform !== "ios") return;
    const setTI = (enabled: boolean) => invoke("set_text_interaction", { enabled }).catch(() => {});
    const INPUTS = 'input, textarea, [contenteditable="true"]';
    const onDown = (e: Event) => {
      const t = e.target as HTMLElement | null;
      if (t && typeof t.closest === "function" && t.closest(INPUTS)) setTI(true);
    };
    const onFocusOut = (e: FocusEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && typeof t.closest === "function" && t.closest(INPUTS)) setTI(false);
    };
    document.addEventListener("touchstart", onDown, { capture: true, passive: true });
    document.addEventListener("pointerdown", onDown, { capture: true, passive: true });
    document.addEventListener("focusout", onFocusOut, true);
    return () => {
      document.removeEventListener("touchstart", onDown, true);
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("focusout", onFocusOut, true);
    };
  }, [platform]);

  /* Android Hardware Back Button Handler: Sheets -> Fullscreen -> Login -> Stack -> Home -> Double-tap Exit */
  const backRef = useRef<() => void>(() => {});
  backRef.current = () => {
    if (runBack()) return;                                  // Overlays and playback sheets
    if (fs) { setFs(false); return; }                        // Immersive fullscreen
    if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); return; }
    if (loginOpen) { setLoginOpen(false); return; }
    if (stack.length) {
      if (clean) setClean(false);
      pop();
      return;
    }
    if (tab !== "home") { setTab("home"); return; }
    
    // Double tap back to exit on Home tab (minimize to background if native bridge present so downloads survive)
    const now = Date.now();
    if (now - lastBackPressRef.current < 2000) {
      const bridge = (window as unknown as { AuraNativeExport?: { moveAppToBackground?: () => boolean } }).AuraNativeExport;
      if (typeof bridge?.moveAppToBackground === "function" && bridge.moveAppToBackground()) {
        return;
      }
      invoke("app_exit", { code: 0 })
        .catch(() => invoke("plugin:app|exit", { code: 0 }))
        .catch(() => {});
    } else {
      lastBackPressRef.current = now;
      toast("Press back again to exit AuraStream", "info");
      try {
        (window as any).AuraNativeExport?.vibrateHaptic?.("click");
      } catch {}
    }
  };

  useEffect(() => {
    if (platform !== "android") return undefined;
    let disposed = false;
    let handle: { unregister: () => Promise<void> } | null = null;
    addPluginListener("app", "back-button", () => backRef.current())
      .then((l) => { if (disposed) l.unregister().catch(() => {}); else handle = l; })
      .catch(() => { /* Ignore on non-Android hosts */ });
    return () => {
      disposed = true;
      handle?.unregister().catch(() => {});
    };
  }, [platform]);

  useEffect(() => {
    const prevent = (e: Event) => e.preventDefault();
    document.addEventListener("contextmenu", prevent);
    return () => document.removeEventListener("contextmenu", prevent);
  }, []);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const t = window.setTimeout(() => {
      selfTest().then((r) => { invoke("debug_log", { msg: r }).catch(() => {}); }).catch(() => {});
    }, 2500);
    return () => window.clearTimeout(t);
  }, []);

  // Guarded GitHub OTA startup check (never runs in /tests/, fixture mode, or Vite dev without native shell)
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.location?.pathname?.startsWith("/tests/")) return;
    if ((window as unknown as { mobileLayoutFixture?: unknown }).mobileLayoutFixture) return;
    if (!isAutoUpdateCheckEnabled()) return;
    const hasTauri = Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
    if (!isAndroidNativeOtaSupported() && (import.meta.env.DEV || !hasTauri)) return;

    let alive = true;
    let checked = false;
    let lastCheckedAt = 0;
    const CHECK_COOLDOWN_MS = 12 * 60 * 60 * 1000;

    const runCheck = () => {
      if (!alive || !isAutoUpdateCheckEnabled()) return;
      if (typeof navigator !== "undefined" && navigator.onLine === false) return;
      const now = Date.now();
      if (checked && now - lastCheckedAt < CHECK_COOLDOWN_MS) return;

      api.checkUpdate()
        .then((info) => {
          if (!alive) return;
          checked = true;
          lastCheckedAt = Date.now();
          setAvailableUpdateInfo(info?.has_update ? info : null);
          if (!info?.has_update || !info.latest) return;
          if (info.latest === getSkippedUpdateVersion()) return;
          setStartupUpdate(info);
        })
        .catch(() => {});
    };

    const timer = window.setTimeout(runCheck, 3500);
    const onOnline = () => runCheck();
    const onResume = () => runCheck();
    window.addEventListener("online", onOnline);
    window.addEventListener("aurastream:app-resumed", onResume);
    return () => {
      alive = false;
      window.clearTimeout(timer);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("aurastream:app-resumed", onResume);
    };
  }, []);

  return (
    <>
      {isMobile ? <MobileShell /> : <DesktopShell />}
      <Suspense fallback={null}><LoginModal /></Suspense>
      {startupUpdate && (
        <Suspense fallback={null}>
          <UpdateModal info={startupUpdate} onClose={() => setStartupUpdate(null)} showSkip />
        </Suspense>
      )}
      <ToastHost />
    </>
  );
}
