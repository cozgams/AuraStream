import { LiquidIndicator } from "./components/ios/effects";
import { Button } from "./components/ios/controls";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore, type Page, type Tab } from "./store";
import { api, isMobile, selfTest, type UpdateInfo } from "./api";
import { addPluginListener, invoke } from "@tauri-apps/api/core";
import { runBack } from "./back";
import Home from "./pages/Home";
import Search, { RankPage } from "./pages/Search";
import Category, { ChannelPage } from "./pages/Category";
import Profile from "./pages/Profile";
import SettingsPage from "./pages/Settings";
import Feed from "./components/Feed";
import { PostsPage, PostDetail } from "./pages/Posts";
import { TopicsPage, TopicPage, TagsPage, TagPage } from "./pages/Discover";
import { FollowingPage, UserPage } from "./pages/User";
import LoginModal from "./components/LoginModal";
import UpdateModal from "./components/UpdateModal";
import { getSkippedUpdateVersion, isAndroidNativeOtaSupported, isAutoUpdateCheckEnabled } from "./otaUpdater";
import { ToastHost } from "./components/ui";
import { DesktopRail, DesktopTitleBar } from "./components/DesktopChrome";
import ResizeHandles from "./components/ResizeHandles";
import ContinueWatchingBar from "./components/ContinueWatchingBar";
import { tracePlayback } from "./playbackDiagnostics";
import { IGrid, IGridF, IHome, IHomeF, ISearch, IUser, IUserF, Logo } from "./icons";

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
    style={{ paddingBottom: platform === "android" ? "max(var(--sab, 0px), 48px)" : "calc(var(--sab, 16px) * .55)" }}>
      <div className="hg-glass">
      <div className="hg-drop" aria-hidden="true" style={{ transform: `translateX(${index * 100}%)` }}><LiquidIndicator /></div>
      <div className="ios-mobile-nav-items">
        {items.map(({ key, label, Icon, Active }) => {
          const Glyph = tab === key ? Active : Icon;
          return <Button key={key} className="ios-mobile-nav-item" onClick={() => handleTabClick(key)}
            aria-label={label}
            aria-current={tab === key ? "page" : undefined}>
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
  if (page.kind === "channel") return <ChannelPage cate={page.cate} name={page.name} onBack={onBack} wide={wide} />;
  if (page.kind === "ranks") return <RankPage onBack={onBack} wide={wide} />;
  if (page.kind === "settings") return <SettingsPage onBack={onBack} wide={wide} />;
  if (page.kind === "posts") return <PostsPage onBack={onBack} wide={wide} />;
  if (page.kind === "post") return <PostDetail id={page.id} onBack={onBack} active={top} />;
  if (page.kind === "topics") return <TopicsPage onBack={onBack} wide={wide} />;
  if (page.kind === "topic") return <TopicPage slug={page.slug} name={page.name} onBack={onBack} wide={wide} />;
  if (page.kind === "tags") return <TagsPage onBack={onBack} wide={wide} />;
  if (page.kind === "tag") return <TagPage tag={page.tag} name={page.name} onBack={onBack} wide={wide} />;
  if (page.kind === "following") return <FollowingPage onBack={onBack} wide={wide} />;
  if (page.kind === "user") return <UserPage id={page.id} name={page.name} onBack={onBack} wide={wide} />;
  return null;
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
      inert={inert}
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
  const { platform, tab, setTab, stack, pop, loginOpen, setLoginOpen, fs, clean } = useStore();
  const mainRef = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(!isMobile);
  const [collapsed, setCollapsed] = useState(false);

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
      if (loginOpen) { if (e.key === "Escape") setLoginOpen(false); return; }
      if (e.key === "Escape") { if (stack.length) pop(); return; }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [stack.length, pop, loginOpen, setLoginOpen]);

  const vis = (k: Tab) => (tab === k ? `absolute inset-0 ${k === "home" ? "" : "ios-tab-active"}` : "absolute inset-0 hidden pointer-events-none");
  const pageActive = stack.length === 0 && !loginOpen;
  const bottomInset = isMobile ? (fs || clean ? 0 : (platform === "android" ? 78 : 74)) : 14;
  /* Stack pages (feed from search/category/profile) render without bottom nav */
  const stackInset = isMobile ? 0 : 14;

  return (
    <div className={`absolute inset-0 flex bg-canvas plat-${platform}`}>
      {!isMobile && <DesktopRail collapsed={collapsed} />}
      <div ref={mainRef} className="relative flex-1 min-w-0 overflow-hidden win-main">
        <LayerBox hidden={stack.length > 0} inert={!pageActive} ariaHidden={!pageActive} className="absolute inset-0">
          <div className={vis("home")} inert={!pageActive || tab !== "home"} aria-hidden={!pageActive || tab !== "home"}><Home active={pageActive && tab === "home"} bottomInset={bottomInset} /></div>
          <div className={vis("search")} inert={!pageActive || tab !== "search"} aria-hidden={!pageActive || tab !== "search"}><Search active={pageActive && tab === "search"} wide={wide} /></div>
          <div className={vis("category")} inert={!pageActive || tab !== "category"} aria-hidden={!pageActive || tab !== "category"}><Category wide={wide} active={pageActive && tab === "category"} /></div>
          <div className={vis("profile")} inert={!pageActive || tab !== "profile"} aria-hidden={!pageActive || tab !== "profile"}><Profile wide={wide} active={pageActive && tab === "profile"} /></div>
        </LayerBox>

        {stack.map((p, i) => (
          <LayerBox
            key={p.key}
            hidden={i !== stack.length - 1}
            inert={i !== stack.length - 1 || loginOpen}
            ariaHidden={i !== stack.length - 1 || loginOpen}
            className="absolute inset-0 z-30 bg-bg isolate"
            enterClass={platform === "android" && p.kind === "feed" ? undefined : "a-page-in"}
            style={{ zIndex: 30 + i }}>
            <StackPage page={p} onBack={pop} wide={wide} top={i === stack.length - 1} bottomInset={stackInset} />
          </LayerBox>
        ))}

        {isMobile && !fs && !clean && stack.length === 0 && !loginOpen && tab !== "home" && tab !== "profile" && <ContinueWatchingBar />}
        {isMobile && !fs && !clean && stack.length === 0 && !loginOpen && <TabBar />}
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
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) {
        if (e.key === "Escape") t.blur();
        return;
      }
      if (loginOpen) { if (e.key === "Escape") setLoginOpen(false); return; }
      if (e.key === "Escape") { if (stack.length) pop(); return; }
      if (e.key === "/") { e.preventDefault(); setTab("search"); return; }
      if (tab !== "home" && stack.length === 0 && ["1", "2", "3", "4"].includes(e.key) && !e.repeat) {
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
          <div className={vis("home")} inert={!pageActive || tab !== "home"} aria-hidden={!pageActive || tab !== "home"}><Home active={pageActive && tab === "home"} bottomInset={14} /></div>
          <div className={vis("search")} inert={!pageActive || tab !== "search"} aria-hidden={!pageActive || tab !== "search"}><Search active={pageActive && tab === "search"} wide={wide} /></div>
          <div className={vis("category")} inert={!pageActive || tab !== "category"} aria-hidden={!pageActive || tab !== "category"}><Category wide={wide} active={pageActive && tab === "category"} /></div>
          <div className={vis("profile")} inert={!pageActive || tab !== "profile"} aria-hidden={!pageActive || tab !== "profile"}><Profile wide={wide} active={pageActive && tab === "profile"} /></div>
        </LayerBox>
        {stack.map((p, i) => (
          <LayerBox
            key={p.key}
            hidden={i !== stack.length - 1}
            inert={i !== stack.length - 1 || loginOpen}
            ariaHidden={i !== stack.length - 1 || loginOpen}
            className="absolute inset-0 z-30 bg-bg win-page-in"
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
    <div className={`absolute inset-0 flex flex-col bg-canvas plat-${platform}`}
      style={{ "--sat": "max(env(safe-area-inset-top), 12px)", "--sab": platform === "android" ? "max(env(safe-area-inset-bottom), 48px)" : "max(env(safe-area-inset-bottom), 16px)" } as React.CSSProperties}>
      <div className="relative flex-1 min-h-0">
        <AppBody />
      </div>
    </div>
  );
}

/* ============ Application Entrypoint ============ */
export default function App() {
  const { platform, loginOpen, setLoginOpen, tab, setTab, stack, pop, fs, setFs, toast } = useStore();
  const [startupUpdate, setStartupUpdate] = useState<UpdateInfo | null>(null);
  const lastBackPressRef = useRef<number>(0);
  useEffect(() => {
    tracePlayback("navigation.change", { tab, stack: stack.map(p => ({ page: p.kind, key: p.key })), login_open: loginOpen });
  }, [tab, stack, loginOpen]);

  useEffect(() => {
    const isAndroid = platform === "android";
    const sab = isAndroid ? "max(env(safe-area-inset-bottom, 0px), 48px)" : "max(env(safe-area-inset-bottom, 0px), 16px)";
    const sat = "max(env(safe-area-inset-top, 0px), 12px)";
    document.documentElement.style.setProperty("--sab", sab);
    document.documentElement.style.setProperty("--sat", sat);
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
    if (stack.length) { pop(); return; }
    if (tab !== "home") { setTab("home"); return; }
    
    // Double tap back to exit on Home tab
    const now = Date.now();
    if (now - lastBackPressRef.current < 2000) {
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
    const timer = window.setTimeout(() => {
      if (!alive || (typeof navigator !== "undefined" && navigator.onLine === false)) return;
      api.checkUpdate()
        .then((info) => {
          if (!alive || !info?.has_update || !info.latest) return;
          if (info.latest === getSkippedUpdateVersion()) return;
          setStartupUpdate(info);
        })
        .catch(() => {});
    }, 3500);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, []);

  return (
    <>
      {isMobile ? <MobileShell /> : <DesktopShell />}
      <LoginModal />
      <UpdateModal info={startupUpdate} onClose={() => setStartupUpdate(null)} showSkip />
      <ToastHost />
      {/* Login modal backdrop */}
      {loginOpen && <div className="hidden" onClick={() => setLoginOpen(false)} />}
    </>
  );
}
