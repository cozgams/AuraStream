import { Button } from "./ios/controls";
import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useStore, type Tab } from "../store";
import { APP_VERSION } from "../api";
import { Avatar } from "./ui";
import {
  IClose, IGrid, IGridF, IHome, IHomeF, IMinus, IMoon, IRestore, ISearch, ISettings, ISidebar,
  ISquare, ISun, ITrophy, IUser, IUserF, Logo,
} from "../icons";

const appWindow = () => {
  if (typeof window === "undefined" || !(window as any).__TAURI_INTERNALS__) {
    return {
      isMaximized: async () => false,
      isFullscreen: async () => false,
      onResized: async () => () => {},
      toggleMaximize: async () => {},
      minimize: async () => {},
      close: async () => {},
    } as unknown as ReturnType<typeof getCurrentWindow>;
  }
  try {
    return getCurrentWindow();
  } catch {
    return {
      isMaximized: async () => false,
      isFullscreen: async () => false,
      onResized: async () => () => {},
      toggleMaximize: async () => {},
      minimize: async () => {},
      close: async () => {},
    } as unknown as ReturnType<typeof getCurrentWindow>;
  }
};

export function DesktopTitleBar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const { theme, setTheme, setTab, platform } = useStore();
  const [maxed, setMaxed] = useState(false);
  const [nativeFs, setNativeFs] = useState(false);

  useEffect(() => {
    let un: (() => void) | undefined;
    const sync = () => {
      appWindow().isMaximized().then(setMaxed).catch(() => {});
      appWindow().isFullscreen().then(setNativeFs).catch(() => {});
    };
    sync();
    appWindow().onResized(sync)
      .then((f: () => void) => { un = f; }).catch(() => {});
    return () => { un?.(); };
  }, []);

  return (
    <header className={`win-titlebar ${nativeFs ? "is-native-fs" : ""}`} data-tauri-drag-region
      onDoubleClick={(e) => { if (!(e.target as HTMLElement).closest("button")) appWindow().toggleMaximize().catch(() => {}); }}>
      <div className="win-wordmark" data-tauri-drag-region>
        <Logo size={24} />
        <span>Aura<span className="win-wordmark-light">Stream</span></span>
      </div>
      <Button className="win-caption-tool" aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} onClick={onToggle}>
        <ISidebar size={17} strokeWidth={1.7} />
      </Button>
      <div className="win-drag-region" data-tauri-drag-region />
      <Button className="win-caption-tool" aria-label="Toggle theme" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
        {theme === "dark" ? <ISun size={17} strokeWidth={1.7} /> : <IMoon size={17} strokeWidth={1.7} />}
      </Button>
      <Button className="win-caption-tool" aria-label="Search" onClick={() => setTab("search")}>
        <ISearch size={17} strokeWidth={1.7} />
      </Button>
      {platform !== "macos" && (
        <div className="win-caption-buttons">
          <Button aria-label="Minimize" onClick={() => appWindow().minimize().catch(() => {})}><IMinus size={15} strokeWidth={1.5} /></Button>
          <Button aria-label={maxed ? "Restore" : "Maximize"} onClick={() => appWindow().toggleMaximize().catch(() => {})}>
            {maxed ? <IRestore size={14} strokeWidth={1.5} /> : <ISquare size={14} strokeWidth={1.5} />}
          </Button>
          <Button className="win-close" aria-label="Close" onClick={() => appWindow().close().catch(() => {})}><IClose size={16} strokeWidth={1.5} /></Button>
        </div>
      )}
    </header>
  );
}

export const DesktopTitlebar = DesktopTitleBar;

export function DesktopRail({ collapsed }: { collapsed: boolean }) {
  const { tab, setTab, user, setLoginOpen, push, platform, stack } = useStore();
  const top = stack[stack.length - 1];
  const railPage: "ranks" | "settings" | null =
    top?.kind === "ranks" ? "ranks" : top?.kind === "settings" ? "settings" : null;
  const onTab = (key: Tab | "search") => !railPage && tab === key;
  const items: { key: Tab; label: string; Icon: typeof IHome; Filled: typeof IHomeF }[] = [
    { key: "home", label: "Home", Icon: IHome, Filled: IHomeF },
    { key: "category", label: "Browse", Icon: IGrid, Filled: IGridF },
    { key: "profile", label: "Profile", Icon: IUser, Filled: IUserF },
  ];
  return (
    <nav className={`win-sidebar ${collapsed ? "is-compact" : ""}`} aria-label="Main navigation">
      <div className="win-sidebar-inner">
        <Button className={`win-search-launch ${onTab("search") ? "is-selected" : ""}`}
          onClick={() => setTab("search")} aria-label="Search">
          <ISearch size={19} strokeWidth={1.7} />
          <span className="win-nav-copy">Search dramas and creators...</span>
          <kbd className="win-nav-key">/</kbd>
        </Button>
        <div className="win-nav-items">
          {items.map((it) => (
            <Button key={it.key} aria-label={it.label}
              className={`win-nav-item ${onTab(it.key) ? "is-selected" : ""}`}
              aria-current={onTab(it.key) ? "page" : undefined}
              onClick={() => setTab(it.key)}>
              <span className="win-nav-symbol">
                {onTab(it.key) ? <it.Filled size={21} /> : <it.Icon size={21} strokeWidth={1.7} />}
              </span>
              <span className="win-nav-copy">{it.label}</span>
            </Button>
          ))}
          <Button aria-label="Rankings" className={`win-nav-item ${railPage === "ranks" ? "is-selected" : ""}`}
            aria-current={railPage === "ranks" ? "page" : undefined}
            onClick={() => { if (railPage !== "ranks") push({ kind: "ranks" }); }}>
            <span className="win-nav-symbol"><ITrophy size={21} strokeWidth={1.7} /></span>
            <span className="win-nav-copy">Rankings</span>
          </Button>
          <Button aria-label="Settings" className={`win-nav-item ${railPage === "settings" ? "is-selected" : ""}`}
            aria-current={railPage === "settings" ? "page" : undefined}
            onClick={() => { if (railPage !== "settings") push({ kind: "settings" }); }}>
            <span className="win-nav-symbol"><ISettings size={21} strokeWidth={1.7} /></span>
            <span className="win-nav-copy">Settings</span>
          </Button>
        </div>
        <div className="win-sidebar-bottom">
          <Button aria-label="Account & Profile" className="win-account" onClick={() => { setTab("profile"); if (!user) setLoginOpen(true); }}>
            <Avatar size={34} src={user?.avatar} hue={220} name={user?.nickname} icon={user ? undefined : <IUser size={17} />} />
            <span className="win-account-copy">
              <strong>{user?.nickname || "Sign In to AuraStream"}</strong>
              <small>{user ? "Welcome back" : "Sync your saved series"}</small>
            </span>
          </Button>
          <span className="win-sidebar-version">AuraStream for {platform === "macos" ? "macOS" : platform === "linux" ? "Linux" : "Windows"} {APP_VERSION}</span>
        </div>
      </div>
    </nav>
  );
}
