import { Button } from "../components/ios/controls";
import { Loader } from "../components/ios/effects";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, APP_VERSION, errorMessage, fmtTime, type UpdateInfo } from "../api";
import type { Detail } from "../types";
import { useStore } from "../store";
import { Empty, Modal, Toggle } from "../components/ui";
import { MediaCard } from "../components/cards";
import ExportSheet from "../components/ExportSheet";
import UpdateModal from "../components/UpdateModal";
import { getAvailableUpdateInfo, getOtaRuntimeState, setAvailableUpdateInfo, subscribeAvailableUpdate, subscribeOtaRuntimeState, type OtaRuntimeState } from "../otaUpdater";
import { registerOverlayBack } from "../back";
import {
  IBack,
  ICheck,
  IChevR,
  IChevronDown,
  IChevronUp,
  IClock,
  IClose,
  IDownload,
  IExport,
  IHist,
  ILayers,
  IMore,
  IPauseF,
  IPlayF,
  IRefresh,
  ISearch,
  ISettings,
  IStar,
  IStarF,
  ITrash,
  IUser,
} from "../icons";
import { getCurrentAuthUid, hasActiveFirebaseSession, loadUserDataFromCloud, saveUserDataToCloud, type CloudUserData } from "../firebase";
import { readStorage, writeStorage, STORAGE_KEYS } from "../storage";
import {
  cancelAllDownloads,
  getOfflineCoverUrl,
  getOfflineEpisodes,
  deleteOfflineEpisode,
  deleteOfflineEpisodesBatch,
  clearAllOfflineDownloads,
  getDetailedStorageStats,
  subscribeDownloadProgress,
  cancelDownload,
  pauseDownload,
  resumeDownload,
  pauseAllDownloads,
  resumeAllDownloads,
  getActiveDownloadsSummary,
  formatBytes,
  formatSpeed,
  formatDownloadError,
  syncOfflineEpisodesFromIndexedDB,
  isWifiOnlyDownloadEnabled,
  setWifiOnlyDownloadEnabled,
  isSmartDownloadEnabled,
  setSmartDownloadEnabled,
  type OfflineEpisode,
  type ActiveDownloadProgress,
  type DeviceStorageStats,
} from "../offline/downloadService";
import { getAndroidPermissionsStatus, type AndroidPermissionsStatus } from "../offline/exportService";
import BatchDownloadSheet from "../components/BatchDownloadSheet";
import { formatDramaTag, formatDramaTitle } from "../subtitles/dramaTranslator";

function FolderDownloadIcon({ size = 44, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="fdBack" x1="6" y1="10" x2="42" y2="39" gradientUnits="userSpaceOnUse">
          <stop offset="0%" style={{ stopColor: "var(--p-primary, #1a73e8)" }} />
          <stop offset="100%" stopColor="#3b82f6" />
        </linearGradient>
        <linearGradient id="fdFront" x1="6" y1="15" x2="42" y2="39" gradientUnits="userSpaceOnUse">
          <stop offset="0%" style={{ stopColor: "var(--p-primary, #2563eb)" }} />
          <stop offset="100%" style={{ stopColor: "var(--p-pc, #60a5fa)" }} />
        </linearGradient>
      </defs>
      {/* Back tab */}
      <path
        d="M6 14C6 11.79 7.79 10 10 10H18.5C20.09 10 21.58 10.79 22.47 12.12L23.73 14C24.17 14.67 24.92 15.07 25.71 15.07H38C40.21 15.07 42 16.86 42 19.07V35C42 37.21 40.21 39 38 39H10C7.79 39 6 37.21 6 35V14Z"
        fill="url(#fdBack)"
      />
      {/* Front flap */}
      <path
        d="M6 18.5C6 16.57 7.57 15 9.5 15H38.5C40.43 15 42 16.57 42 18.5V35.5C42 37.43 40.43 39 38.5 39H9.5C7.57 39 6 37.43 6 35.5V18.5Z"
        fill="url(#fdFront)"
      />
      {/* Download Arrow */}
      <path
        d="M24 20V28M24 28L20.5 24.5M24 28L27.5 24.5M19 32H29"
        stroke="white"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SparkleStar({ className = "", size = 16 }: { className?: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M12 0 C12 6.6 6.6 12 0 12 C6.6 12 12 17.4 12 24 C12 17.4 17.4 12 24 12 C17.4 12 12 6.6 12 0 Z" />
    </svg>
  );
}

type DramaGroup = {
  videoId: number;
  title: string;
  cover: string;
  episodes: OfflineEpisode[];
  totalBytes: number;
};

export default function Profile({ wide, active = true }: { wide: boolean; active?: boolean }) {
  const {
    theme,
    user,
    setLoginOpen,
    logout,
    history,
    removeHistory,
    favs,
    toggleFavLocal,
    clearFavs,
    watchLater,
    toggleWatchLaterLocal,
    clearWatchLater,
    clearHistory,
    push,
    setTab,
    t,
    toast,
    mergeCloudUserData,
  } = useStore();

  // Navigation view:
  // "overview" = AuraStream You Tab
  // "downloads" = Dedicated Offline Hub
  // "seriesDetail" = Single downloaded drama episode list
  // "favs" | "watchlater" | "history" = Dedicated subviews
  const [view, setView] = useState<"overview" | "downloads" | "seriesDetail" | "favs" | "watchlater" | "history">("overview");

  const [cards, setCards] = useState<Detail[]>([]);
  const [favSort, setFavSort] = useState<"recent" | "finished" | "episodes">("recent");
  const [favStatusFilter, setFavStatusFilter] = useState<"all" | "ongoing" | "finished">("all");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: Event) => {
      const custom = e as CustomEvent<{ tab: string }>;
      if (custom.detail?.tab === "profile") {
        scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
      }
    };
    window.addEventListener("hg:scroll-to-top", handler);
    return () => window.removeEventListener("hg:scroll-to-top", handler);
  }, []);
  const [downloads, setDownloads] = useState<OfflineEpisode[]>(() => getOfflineEpisodes());
  const [storageStats, setStorageStats] = useState<DeviceStorageStats | null>(null);
  const [activeDownloads, setActiveDownloads] = useState<ActiveDownloadProgress[]>([]);
  const [activeSummary, setActiveSummary] = useState(getActiveDownloadsSummary);
  const [loading, setLoading] = useState(false);
  const [confirmClearAllOpen, setConfirmClearAllOpen] = useState(false);
  const [confirmDeleteSeriesOpen, setConfirmDeleteSeriesOpen] = useState(false);
  const [confirmDeleteEp, setConfirmDeleteEp] = useState<{ videoId: number; episode: number } | null>(null);
  const [subviewLimit, setSubviewLimit] = useState(32);
  const subviewFetchedRef = useRef<Map<number, Detail>>(new Map());
  const [manageStorageOpen, setManageStorageOpen] = useState(false);
  const [seriesMenuOpen, setSeriesMenuOpen] = useState(false);
  const [libraryInfoOpen, setLibraryInfoOpen] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [collapsedDramas, setCollapsedDramas] = useState<Set<number>>(() => new Set());
  const [selectedSeriesGroup, setSelectedSeriesGroup] = useState<DramaGroup | null>(null);
  const [downloadFilter, setDownloadFilter] = useState<"all" | "series">("all");
  const [downloadSort, setDownloadSort] = useState<"recent" | "size" | "title">("recent");
  const [downloadSearchOpen, setDownloadSearchOpen] = useState(false);
  const [downloadSearchQuery, setDownloadSearchQuery] = useState("");
  const [downloadHubTab, setDownloadHubTab] = useState<"downloaded" | "queue">("downloaded");
  const [episodeOrder, setEpisodeOrder] = useState<"asc" | "desc">("asc");
  const [detailCache, setDetailCache] = useState<Record<number, Detail>>({});
  const [wifiOnlyDl, setWifiOnlyDl] = useState<boolean>(() => isWifiOnlyDownloadEnabled());
  const [smartDl, setSmartDl] = useState<boolean>(() => isSmartDownloadEnabled());
  const [androidPerms, setAndroidPerms] = useState<AndroidPermissionsStatus | null>(() => getAndroidPermissionsStatus());
  const [permBannerDismissed, setPermBannerDismissed] = useState(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [availableUpdate, setAvailableUpdate] = useState<UpdateInfo | null>(() => getAvailableUpdateInfo());
  const [otaRuntime, setOtaRuntime] = useState<OtaRuntimeState>(() => getOtaRuntimeState());

  useEffect(() => subscribeAvailableUpdate(setAvailableUpdate), []);
  useEffect(() => subscribeOtaRuntimeState(setOtaRuntime), []);

  const handleCheckUpdate = async () => {
    if (availableUpdate?.has_update && typeof navigator !== "undefined" && navigator.onLine === false) {
      setUpdateInfo(availableUpdate);
      return;
    }
    setCheckingUpdate(true);
    try {
      const res = await api.checkUpdate();
      setAvailableUpdateInfo(res?.has_update ? res : null);
      if (res?.has_update) {
        setUpdateInfo(res);
      } else {
        toast("You are using the latest version of AuraStream", "ok");
      }
    } catch (e) {
      if (availableUpdate?.has_update) {
        setUpdateInfo(availableUpdate);
      } else {
        toast(errorMessage(e, "Unable to check for updates"), "info");
      }
    } finally {
      setCheckingUpdate(false);
    }
  };

  const [syncingCloud, setSyncingCloud] = useState(false);
  const [lastSyncedTime, setLastSyncedTime] = useState<string>(() => {
    try {
      const s = localStorage.getItem("aurastream_last_cloud_sync");
      return s ? new Date(parseInt(s, 10)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
    } catch { return ""; }
  });

  const handleSyncCloud = async () => {
    const uid = getCurrentAuthUid();
    if (!uid || (user?.user_type !== "firebase" && !hasActiveFirebaseSession())) {
      toast("Sign in with a cloud account to sync your library", "info");
      setLoginOpen(true);
      return;
    }
    setSyncingCloud(true);
    try {
      await saveUserDataToCloud(uid, {
        favorites: favs,
        watchLater,
        history: history.map((h) => ({
          id: h.id,
          ep: h.ep,
          t: h.t,
          dur: h.dur,
          updatedAt: h.at,
          title: h.title,
          cover: h.cover,
        })),
      });
      const cloudData = await loadUserDataFromCloud(uid);
      if (cloudData) {
        mergeCloudUserData(cloudData);
      }
      const now = Date.now();
      localStorage.setItem("aurastream_last_cloud_sync", String(now));
      setLastSyncedTime(new Date(now).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
      toast("Cloud library synchronized", "ok");
    } catch {
      toast("Sync failed. Check connection.", "info");
    } finally {
      setSyncingCloud(false);
    }
  };

  const backupInputRef = useRef<HTMLInputElement>(null);

  const handleExportBackup = () => {
    try {
      const backup = {
        app: "AuraStream",
        version: APP_VERSION,
        exportedAt: new Date().toISOString(),
        history,
        favorites: favs,
        watchLater,
        settings: {
          accent: readStorage(STORAGE_KEYS.accent) || "amber",
          language: readStorage(STORAGE_KEYS.lang) || "en",
          subtitleMode: readStorage(STORAGE_KEYS.subtitleMode) || "en",
        },
      };
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `aurastream-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast("Library backup downloaded", "ok");
    } catch {
      toast("Backup export failed", "info");
    }
  };

  const handleImportBackup = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object") throw new Error("Invalid format");
      let count = 0;
      const cloudDataToMerge: CloudUserData = {};
      if (Array.isArray(parsed.history)) {
        cloudDataToMerge.history = parsed.history;
        count += parsed.history.length;
      }
      if (Array.isArray(parsed.favorites)) {
        cloudDataToMerge.favorites = parsed.favorites;
        count += parsed.favorites.length;
      }
      if (Array.isArray(parsed.watchLater)) {
        cloudDataToMerge.watchLater = parsed.watchLater;
        count += parsed.watchLater.length;
      }
      if (Array.isArray(parsed.likes)) {
        cloudDataToMerge.likes = parsed.likes;
        count += parsed.likes.length;
      }
      mergeCloudUserData(cloudDataToMerge);
      if (parsed.settings?.accent) {
        writeStorage(STORAGE_KEYS.accent, parsed.settings.accent);
      }
      if (parsed.settings?.language) {
        writeStorage(STORAGE_KEYS.lang, parsed.settings.language);
      }
      if (parsed.settings?.subtitleMode) {
        writeStorage(STORAGE_KEYS.subtitleMode, parsed.settings.subtitleMode);
      }
      window.dispatchEvent(new CustomEvent("aurastream:storage-migrated"));
      toast(`Restored ${count} library items from backup`, "ok");
    } catch {
      toast("Failed to import backup: invalid JSON", "info");
    } finally {
      if (backupInputRef.current) backupInputRef.current.value = "";
    }
  };

  useEffect(() => {
    const syncConfig = () => {
      setWifiOnlyDl(isWifiOnlyDownloadEnabled());
      setSmartDl(isSmartDownloadEnabled());
    };
    const refreshPerms = () => setAndroidPerms(getAndroidPermissionsStatus());
    const onVis = () => {
      if (document.visibilityState === "visible") refreshPerms();
    };
    window.addEventListener("aurastream:storage-config-changed", syncConfig);
    window.addEventListener("aurastream:app-resumed", refreshPerms);
    window.addEventListener("aurastream:permissions-changed", refreshPerms);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("aurastream:storage-config-changed", syncConfig);
      window.removeEventListener("aurastream:app-resumed", refreshPerms);
      window.removeEventListener("aurastream:permissions-changed", refreshPerms);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  const openSeriesBatchDownloader = async (group: DramaGroup) => {
    const cached = detailCache[group.videoId];
    const maxDownloadedEp = group.episodes.reduce((m, e) => Math.max(m, e.episode), 1);
    const totalEpisodes = cached?.episodes?.length || cached?.episode_count || Math.max(10, maxDownloadedEp + 5);
    setBatchSheet({
      isOpen: true,
      videoId: group.videoId,
      title: formatDramaTitle(group.title),
      cover: group.cover,
      totalEpisodes,
      episodeNumbers: cached?.episodes?.map((e) => e.ep_num),
    });
    if (!cached) {
      try {
        const d = await api.video(group.videoId);
        if (d) {
          setDetailCache((prev) => ({ ...prev, [d.id]: d }));
          const resolvedTotal = d.episodes?.length || d.episode_count || totalEpisodes;
          setBatchSheet((prev) =>
            prev.isOpen && prev.videoId === group.videoId
              ? {
                  ...prev,
                  totalEpisodes: resolvedTotal,
                  episodeNumbers: d.episodes?.map((e) => e.ep_num),
                }
              : prev
          );
        }
      } catch {
        // fallback to existing estimate
      }
    }
  };

  useEffect(() => {
    if (!active || (typeof navigator !== "undefined" && navigator.onLine === false)) return;
    // Only fetch metadata for online history items; keep Downloads Hub 100% zero-internet unless user taps More Eps
    const histNeeded = history
      .slice(0, 15)
      .filter((h) => !h.cover || !h.title || h.title.startsWith("Drama #"))
      .map((h) => h.id);
    const needed = Array.from(new Set(histNeeded)).filter((id) => !detailCache[id]);

    if (!needed.length) return;

    let alive = true;
    Promise.allSettled(needed.slice(0, 12).map((id) => api.video(id)))
      .then((rs) => {
        if (!alive) return;
        const newMap: Record<number, Detail> = {};
        for (const r of rs) {
          if (r.status === "fulfilled" && r.value) {
            newMap[r.value.id] = r.value;
          }
        }
        if (Object.keys(newMap).length) {
          setDetailCache((prev) => ({ ...prev, ...newMap }));
        }
      });

    return () => {
      alive = false;
    };
  }, [history, active]);

  const [batchSheet, setBatchSheet] = useState<{
    isOpen: boolean;
    videoId: number;
    title: string;
    cover: string;
    totalEpisodes: number;
    episodeNumbers?: number[];
  }>({
    isOpen: false,
    videoId: 0,
    title: "",
    cover: "",
    totalEpisodes: 0,
  });

  const [exportSheetState, setExportSheetState] = useState<{
    isOpen: boolean;
    videoId: number;
    episode?: number;
    title: string;
    batchEpisodes?: number[];
    batchItems?: Array<{ videoId: number; episode: number; title: string }>;
  }>({
    isOpen: false,
    videoId: 0,
    title: "",
  });

  const toggleSelect = (key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const deleteSelected = async () => {
    if (selectedKeys.size === 0) return;
    const itemsToDelete = downloads.filter((d) => selectedKeys.has(`${d.videoId}_${d.episode}`));
    await deleteOfflineEpisodesBatch(itemsToDelete);
    setSelectedKeys(new Set());
    setSelectMode(false);
    setDownloads(getOfflineEpisodes());
    void getDetailedStorageStats().then(setStorageStats);
    toast(
      `Deleted ${itemsToDelete.length} offline ${itemsToDelete.length === 1 ? "episode" : "episodes"}`,
      "ok"
    );
  };

  const openExportSelected = () => {
    if (selectedKeys.size === 0) return;
    const selectedDownloads = downloads.filter((d) => selectedKeys.has(`${d.videoId}_${d.episode}`));
    setExportSheetState({
      isOpen: true,
      videoId: 0,
      title: `${selectedDownloads.length} Selected Episodes`,
      batchItems: selectedDownloads.map((d) => ({
        videoId: d.videoId,
        episode: d.episode,
        title: d.title,
      })),
    });
  };

  const toggleDramaCollapse = (videoId: number) => {
    setCollapsedDramas((prev) => {
      const next = new Set(prev);
      if (next.has(videoId)) next.delete(videoId);
      else next.add(videoId);
      return next;
    });
  };

  useEffect(() => {
    if (view !== "downloads" && view !== "seriesDetail") {
      setSelectMode(false);
      setSelectedKeys(new Set());
    }
  }, [view]);

  // Handle hardware back on Android: return to overview seamlessly
  useEffect(() => {
    if (!active || view === "overview") return;
    return registerOverlayBack(() => {
      if (selectMode) {
        setSelectMode(false);
        setSelectedKeys(new Set());
        return true;
      }
      if (view === "seriesDetail") {
        setView("downloads");
        return true;
      }
      setView("overview");
      return true;
    });
  }, [active, view, selectMode]);

  useEffect(() => {
    document.body.classList.toggle("has-selection-mode", active && selectMode);
    return () => {
      document.body.classList.remove("has-selection-mode");
    };
  }, [active, selectMode]);

  useEffect(() => {
    document.body.classList.toggle("has-series-detail", active && view === "seriesDetail");
    return () => {
      document.body.classList.remove("has-series-detail");
    };
  }, [active, view]);

  useEffect(() => {
    if (downloads.length === 0 && selectMode) {
      setSelectMode(false);
      setSelectedKeys(new Set());
    }
  }, [downloads.length, selectMode]);

  const dramaGroups = useMemo(() => {
    const map = new Map<number, DramaGroup>();

    for (const item of downloads) {
      let grp = map.get(item.videoId);
      if (!grp) {
        grp = {
          videoId: item.videoId,
          title: item.title,
          cover: item.cover,
          episodes: [],
          totalBytes: 0,
        };
        map.set(item.videoId, grp);
      }
      grp.episodes.push(item);
      grp.totalBytes += item.sizeBytes || 0;
    }
    for (const grp of map.values()) {
      grp.episodes.sort((a, b) => a.episode - b.episode);
    }
    return Array.from(map.values());
  }, [downloads]);

  // Keep selectedSeriesGroup up-to-date with downloads
  useEffect(() => {
    if (selectedSeriesGroup) {
      const updated = dramaGroups.find((g) => g.videoId === selectedSeriesGroup.videoId);
      if (updated) setSelectedSeriesGroup(updated);
      else if (view === "seriesDetail") setView("downloads");
    }
  }, [dramaGroups, selectedSeriesGroup, view]);

  const totalDownloadsBytes = useMemo(() => {
    return downloads.reduce((acc, it) => acc + (it.sizeBytes || 0), 0);
  }, [downloads]);

  const activeDownloadsProgressPercent = useMemo(() => {
    if (activeSummary.overallProgressPercent > 0) return activeSummary.overallProgressPercent;
    if (activeDownloads.length === 0) return 0;
    const avg = Math.round(
      activeDownloads.reduce((sum, d) => sum + (d.progress || 0), 0) / activeDownloads.length
    );
    return Math.max(0, Math.min(100, avg));
  }, [activeSummary.overallProgressPercent, activeDownloads]);

  const activeDownloadsSpeedFormatted = useMemo(() => {
    if (activeSummary.aggregateSpeedFormatted && activeSummary.aggregateSpeedFormatted !== "-- KB/s") {
      return activeSummary.aggregateSpeedFormatted;
    }
    return activeDownloads.some((d) => d.status === "downloading") ? "Connecting..." : "Paused";
  }, [activeSummary.aggregateSpeedFormatted, activeDownloads]);

  const downloadingItemsCount = useMemo(
    () => activeDownloads.filter((d) => d.status === "downloading").length,
    [activeDownloads]
  );
  const queuedItemsCount = useMemo(
    () => activeDownloads.filter((d) => d.status === "queued").length,
    [activeDownloads]
  );
  const failedItemsCount = useMemo(
    () => activeDownloads.filter((d) => d.status === "error").length,
    [activeDownloads]
  );
  const pausedItemsCount = useMemo(
    () => activeDownloads.filter((d) => d.status === "paused").length,
    [activeDownloads]
  );
  const activeTransferringItem = useMemo(
    () => activeDownloads.find((d) => d.status === "downloading") || activeDownloads[0],
    [activeDownloads]
  );

  const sortedDramaGroups = useMemo(() => {
    let list = [...dramaGroups];
    if (downloadFilter === "series") {
      list = list.filter((g) => g.episodes.length > 1);
    }
    if (downloadSearchQuery.trim()) {
      const q = downloadSearchQuery.trim().toLowerCase();
      list = list.filter(
        (g) =>
          g.title.toLowerCase().includes(q) ||
          g.episodes.some((e) => String(e.episode).includes(q))
      );
    }
    if (downloadSort === "size") {
      list.sort((a, b) => b.totalBytes - a.totalBytes);
    } else if (downloadSort === "title") {
      list.sort((a, b) => a.title.localeCompare(b.title));
    } else {
      list.sort((a, b) => {
        const atA = a.episodes.reduce((max, e) => Math.max(max, e.downloadedAt || 0), 0);
        const atB = b.episodes.reduce((max, e) => Math.max(max, e.downloadedAt || 0), 0);
        return atB - atA;
      });
    }
    return list;
  }, [dramaGroups, downloadFilter, downloadSort, downloadSearchQuery]);

  const displayEpisodes = useMemo(() => {
    if (!selectedSeriesGroup) return [];
    const eps = [...selectedSeriesGroup.episodes];
    return episodeOrder === "desc"
      ? eps.sort((a, b) => b.episode - a.episode)
      : eps.sort((a, b) => a.episode - b.episode);
  }, [selectedSeriesGroup, episodeOrder]);

  const visibleDownloadItems = useMemo(() => {
    if (view === "seriesDetail" && selectedSeriesGroup) {
      return displayEpisodes;
    }
    return sortedDramaGroups.flatMap((g) => g.episodes);
  }, [view, selectedSeriesGroup, displayEpisodes, sortedDramaGroups]);

  useEffect(() => {
    if (view === "seriesDetail" && selectedSeriesGroup) {
      const stillExists = dramaGroups.find((g) => g.videoId === selectedSeriesGroup.videoId);
      if (!stillExists || stillExists.episodes.length === 0) {
        setView("downloads");
      } else if (stillExists !== selectedSeriesGroup) {
        setSelectedSeriesGroup(stillExists);
      }
    }
  }, [view, selectedSeriesGroup, dramaGroups]);

  const playSelected = () => {
    const selectedEpisodes = downloads
      .filter((d) => selectedKeys.has(`${d.videoId}_${d.episode}`))
      .sort((a, b) => (a.videoId === b.videoId ? a.episode - b.episode : a.videoId - b.videoId));
    if (!selectedEpisodes.length) return;
    const first = selectedEpisodes[0];
    push({
      kind: "feed",
      videoIds: Array.from(new Set(selectedEpisodes.map((e) => e.videoId))),
      index: 0,
      title: formatDramaTitle(first.title),
      source: "offline",
      startEp: first.episode,
    });
  };

  const openSingleExport = (videoId: number, episode: number, title: string) => {
    setExportSheetState({
      isOpen: true,
      videoId,
      episode,
      title,
    });
  };

  // Sync and subscription listeners for offline downloads
  useEffect(() => {
    const updateStorage = () => {
      void getDetailedStorageStats().then(setStorageStats);
      setDownloads(getOfflineEpisodes());
    };
    updateStorage();
    void syncOfflineEpisodesFromIndexedDB().then((synced) => {
      if (synced && synced.length > 0) setDownloads(synced);
    });

    const unsubProgress = subscribeDownloadProgress((map) => {
      setActiveDownloads(Array.from(map.values()).filter((p) => p.status !== "completed"));
      setActiveSummary(getActiveDownloadsSummary());
    });

    window.addEventListener("aurastream:downloads-changed", updateStorage);
    return () => {
      unsubProgress();
      window.removeEventListener("aurastream:downloads-changed", updateStorage);
    };
  }, []);

  // Subview IDs resolution for Favorites / Watch Later / History
  const subviewIds = useMemo(() => {
    if (view === "favs") return favs;
    if (view === "watchlater") return watchLater || [];
    if (view === "history") return history.map((h) => h.id);
    return [];
  }, [view, favs, watchLater, history]);

  const progressOf = (id: number) => (view === "history" ? history.find((h) => h.id === id) : undefined);

  const statusCounts = useMemo(() => {
    let ongoing = 0;
    let finished = 0;
    for (const c of cards) {
      if (c.is_finished) finished++;
      else ongoing++;
    }
    return { all: cards.length, ongoing, finished };
  }, [cards]);

  const displayedCards = useMemo(() => {
    let filtered = cards;
    if (view === "favs" || view === "watchlater") {
      if (favStatusFilter === "ongoing") filtered = cards.filter((c) => !c.is_finished);
      else if (favStatusFilter === "finished") filtered = cards.filter((c) => c.is_finished);
    }
    if ((view !== "favs" && view !== "watchlater") || favSort === "recent") return filtered;
    const copy = [...filtered];
    if (favSort === "finished") {
      copy.sort((a, b) => (b.is_finished ? 1 : 0) - (a.is_finished ? 1 : 0));
    } else if (favSort === "episodes") {
      copy.sort((a, b) => (b.episode_count || 0) - (a.episode_count || 0));
    }
    return copy;
  }, [cards, view, favSort, favStatusFilter]);

  useEffect(() => {
    setSubviewLimit(32);
  }, [view]);

  // Fetch full cards when in a dedicated subview (with offline fallback to detailCache / history / downloads)
  useEffect(() => {
    let alive = true;
    if (view === "overview" || view === "downloads" || view === "seriesDetail" || !subviewIds.length) {
      setCards([]);
      return;
    }
    const targetIds = subviewIds.slice(0, subviewLimit);
    const buildCombined = () =>
      targetIds
        .map((id) => {
          const cached = subviewFetchedRef.current.get(id);
          if (cached) return cached;
          if (detailCache[id]) return detailCache[id];
          const h = history.find((x) => x.id === id);
          const dlEps = downloads.filter((x) => x.videoId === id);
          const dlFirst = dlEps[0];
          if (h && (h.title || h.cover)) {
            return {
              id: h.id,
              title: h.title || dlFirst?.title || `Drama #${h.id}`,
              cover: h.cover || dlFirst?.cover || "",
              tags: h.tags || [],
              episode_count: h.episode_count || Math.max(1, dlEps.length),
              is_finished: !!h.is_finished,
            } as unknown as Detail;
          }
          if (dlFirst) {
            return {
              id,
              title: dlFirst.title || `Drama #${id}`,
              cover: dlFirst.cover || "",
              tags: [],
              episode_count: Math.max(1, dlEps.length),
              is_finished: false,
            } as unknown as Detail;
          }
          return null;
        })
        .filter(Boolean) as Detail[];

    if (!active || (typeof navigator !== "undefined" && navigator.onLine === false)) {
      setCards(buildCombined());
      setLoading(false);
      return;
    }

    const missingIds = targetIds.filter((id) => !subviewFetchedRef.current.has(id));
    if (missingIds.length === 0) {
      setCards(buildCombined());
      setLoading(false);
      return;
    }

    const immediate = buildCombined();
    if (immediate.length > 0) setCards(immediate);
    setLoading(immediate.length === 0);
    Promise.allSettled(missingIds.map((id) => api.video(id)))
      .then((rs) => {
        if (!alive) return;
        for (const r of rs) {
          if (r.status === "fulfilled" && r.value?.id) {
            subviewFetchedRef.current.set(r.value.id, r.value);
          }
        }
        setCards(buildCombined());
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [subviewIds, subviewLimit, view, active, detailCache, history, downloads]);

  return (
    <div
      className="ios-page absolute inset-0 flex flex-col select-none overflow-hidden"
      style={{
        background: theme === "dark" ? "#090d16" : "#f0f5fc",
        backgroundImage:
          theme === "dark"
            ? "radial-gradient(ellipse 140% 60% at 85% -10%, rgba(30, 58, 138, 0.35) 0%, rgba(15, 23, 42, 0.5) 45%, transparent 75%), radial-gradient(ellipse 80% 50% at 10% 15%, rgba(15, 23, 42, 0.8) 0%, transparent 60%)"
            : "radial-gradient(ellipse 140% 60% at 85% -10%, rgba(193, 226, 255, 0.75) 0%, rgba(224, 240, 255, 0.35) 45%, transparent 75%), radial-gradient(ellipse 80% 50% at 10% 15%, rgba(210, 235, 255, 0.5) 0%, transparent 60%)",
      }}
    >
      {/* =========================================================================
          Top App Bar
          ========================================================================= */}
      <div
        className="shrink-0 px-4 z-10"
        style={{ paddingTop: "calc(var(--sat, 0px) + 8px)", paddingBottom: "6px" }}
      >
        <div className={`flex items-center justify-between gap-2 ${wide ? "max-w-[960px] mx-auto w-full" : "w-full"}`}>
        {view === "overview" ? (
          <>
            <h1 className="text-[24px] font-black tracking-tight text-[#0f172a] dark:text-neutral-100">
              Profile
            </h1>
            <button
              type="button"
              onClick={() => push({ kind: "settings" })}
              aria-label={t("settings.title")}
              className="w-9 h-9 rounded-full bg-white/85 dark:bg-neutral-900/85 border border-white/70 dark:border-white/10 shadow-xs flex items-center justify-center text-[#1e293b] dark:text-neutral-200 hover:bg-white dark:hover:bg-neutral-800 active:scale-95 transition-all"
            >
              <ISettings size={18} strokeWidth={2} />
            </button>
          </>
        ) : view === "downloads" ? (
          <>
            <div className="flex items-center gap-2">
              {selectMode ? (
                <button
                  type="button"
                  onClick={() => {
                    setSelectMode(false);
                    setSelectedKeys(new Set());
                  }}
                  className="w-8 h-8 rounded-full flex items-center justify-center text-[#0f172a] dark:text-neutral-100 hover:bg-slate-200/60 dark:hover:bg-white/10 active:scale-95 transition-all"
                  aria-label="Exit selection mode"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setView("overview")}
                  className="w-8 h-8 rounded-full flex items-center justify-center text-[#0f172a] dark:text-neutral-100 hover:bg-slate-200/60 dark:hover:bg-white/10 active:scale-95 transition-all"
                  aria-label="Back to overview"
                >
                  <IBack size={20} strokeWidth={2.4} />
                </button>
              )}
              <h1 className="text-[20px] font-black tracking-tight text-[#0f172a] dark:text-neutral-100">
                {selectMode ? `${selectedKeys.size} Selected` : "Downloads"}
              </h1>
            </div>

            <div className="flex items-center gap-1.5">
              {selectMode ? (
                <>
                  <button
                    type="button"
                    onClick={playSelected}
                    disabled={selectedKeys.size === 0}
                    className="w-8 h-8 rounded-full flex items-center justify-center text-[#1a73e8] dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-500/15 disabled:opacity-30 pressable active:scale-95 transition-all"
                    title="Play selected"
                  >
                    <IPlayF size={15} />
                  </button>
                  <button
                    type="button"
                    onClick={deleteSelected}
                    disabled={selectedKeys.size === 0}
                    className="w-8 h-8 rounded-full flex items-center justify-center text-red-500 hover:bg-red-50 dark:hover:bg-red-500/15 disabled:opacity-30 pressable active:scale-95 transition-all"
                    title="Delete selected"
                  >
                    <ITrash size={15} />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const visibleKeys = visibleDownloadItems.map((d) => `${d.videoId}_${d.episode}`);
                      const allVisibleSelected = visibleKeys.length > 0 && visibleKeys.every((k) => selectedKeys.has(k));
                      if (allVisibleSelected) {
                        setSelectedKeys((prev) => {
                          const next = new Set(prev);
                          visibleKeys.forEach((k) => next.delete(k));
                          return next;
                        });
                      } else {
                        setSelectedKeys((prev) => {
                          const next = new Set(prev);
                          visibleKeys.forEach((k) => next.add(k));
                          return next;
                        });
                      }
                    }}
                    className="w-8 h-8 rounded-full flex items-center justify-center text-[#0f172a] dark:text-neutral-100 hover:bg-slate-200/60 dark:hover:bg-white/10 pressable font-bold"
                    title="Toggle Select All"
                    aria-label="Select all toggle"
                  >
                    <ICheck size={16} strokeWidth={2.3} />
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      setDownloadSearchOpen((v) => {
                        if (v) setDownloadSearchQuery("");
                        return !v;
                      });
                    }}
                    className={`w-8 h-8 rounded-full flex items-center justify-center pressable transition-all ${
                      downloadSearchOpen ? "bg-blue-100 dark:bg-blue-500/20 text-[#1a73e8] dark:text-blue-400" : "text-[#0f172a] dark:text-neutral-100 hover:bg-slate-200/60 dark:hover:bg-white/10"
                    }`}
                    aria-label="Search downloads"
                  >
                    <ISearch size={18} />
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectMode(true)}
                    disabled={downloads.length === 0}
                    className="w-8 h-8 rounded-full flex items-center justify-center text-[#0f172a] dark:text-neutral-100 hover:bg-slate-200/60 dark:hover:bg-white/10 pressable font-bold disabled:opacity-40"
                    aria-label="Select mode"
                    title="Select episodes"
                  >
                    <ILayers size={16} />
                  </button>
                </>
              )}
            </div>
          </>
        ) : view === "seriesDetail" && selectedSeriesGroup ? (
          <>
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <button
                type="button"
                onClick={() => setView("downloads")}
                className="w-8 h-8 rounded-full flex items-center justify-center text-[#0f172a] dark:text-neutral-100 hover:bg-slate-200/60 dark:hover:bg-white/10 active:scale-95 transition-all shrink-0"
                aria-label="Back to Downloads"
              >
                <IBack size={20} strokeWidth={2.4} />
              </button>
              <h1 className="text-[17px] font-bold text-[#0f172a] dark:text-neutral-100 truncate">
                {formatDramaTitle(selectedSeriesGroup.title)}
              </h1>
            </div>

            <button
              type="button"
              onClick={() => setSeriesMenuOpen(true)}
              className="w-8 h-8 rounded-full flex items-center justify-center text-[#0f172a] dark:text-neutral-100 hover:bg-slate-200/60 dark:hover:bg-white/10 pressable font-bold shrink-0"
              aria-label="Series options"
            >
              <IMore size={16} className="rotate-90" />
            </button>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setView("overview")}
                className="w-8 h-8 rounded-full flex items-center justify-center text-[#0f172a] dark:text-neutral-100 hover:bg-slate-200/60 dark:hover:bg-white/10 active:scale-95 transition-all"
                aria-label="Back to Overview"
              >
                <IBack size={20} strokeWidth={2.4} />
              </button>
              <h1 className="text-[19px] font-black tracking-tight text-[#0f172a] dark:text-neutral-100">
                {view === "history"
                  ? `${t("profile.history")} (${history.length})`
                  : view === "favs"
                  ? `${t("profile.favorites")} (${favs.length})`
                  : `${t("profile.watch_later")} (${watchLater?.length || 0})`}
              </h1>
            </div>

            <div className="flex items-center gap-1.5">
              {view === "history" && history.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    clearHistory();
                    toast("Watch history cleared", "ok");
                  }}
                  className="text-[12px] font-bold text-[#1a73e8] hover:text-red-500 px-2.5 py-1 rounded-lg hover:bg-slate-200/50 pressable"
                >
                  {t("search.clear")}
                </button>
              )}
              {view === "favs" && favs.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    clearFavs();
                    toast("Favorites cleared", "ok");
                  }}
                  className="text-[12px] font-bold text-[#1a73e8] hover:text-red-500 px-2.5 py-1 rounded-lg hover:bg-slate-200/50 pressable"
                >
                  {t("search.clear")}
                </button>
              )}
              {view === "watchlater" && (watchLater?.length || 0) > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    clearWatchLater();
                    toast("Watch later cleared", "ok");
                  }}
                  className="text-[12px] font-bold text-[#1a73e8] hover:text-red-500 px-2.5 py-1 rounded-lg hover:bg-slate-200/50 pressable"
                >
                  {t("search.clear")}
                </button>
              )}
            </div>
          </>
        )}
        </div>
      </div>

      {/* =========================================================================
          Main Body Content
          ========================================================================= */}
      <div
        ref={scrollRef}
        className="ios-page-body flex-1 scroll-y overflow-x-hidden px-4 pt-0"
        style={{ paddingBottom: view === "seriesDetail" ? "calc(var(--sab, 0px) + 28px)" : "calc(var(--sab, 0px) + 104px)" }}
        onKeyDown={(e) => {
          if (
            (e.key === "Enter" || e.key === " ") &&
            e.target instanceof HTMLElement &&
            e.target.tagName === "DIV" &&
            e.target.getAttribute("role") === "button"
          ) {
            e.preventDefault();
            e.target.click();
          }
        }}
      >
        <div className={wide ? "max-w-[960px] mx-auto w-full" : "w-full"}>
        {/* =====================================================================
            1. Overview Page (AuraStream Profile / You Tab)
            ===================================================================== */}
        {view === "overview" ? (
          <div className="flex flex-col gap-2 a-rise">
            {/* Identity Card */}
            <div
              role="button"
              tabIndex={0}
              onClick={() => {
                if (user) {
                  setLibraryInfoOpen(true);
                } else {
                  setLoginOpen(true);
                }
              }}
              className="bg-white/85 dark:bg-neutral-900/85 backdrop-blur-md rounded-2xl border border-white/70 dark:border-white/10 shadow-[0_4px_20px_-2px_rgba(20,45,85,0.06)] p-2.5 flex items-center gap-3 cursor-pointer pressable active:scale-[0.99] transition-all"
            >
              <div className="relative shrink-0">
                <div className="w-11 h-11 rounded-full bg-gradient-to-tr from-[#1a73e8] to-[#38bdf8] flex items-center justify-center text-white shadow-sm overflow-hidden">
                  {user?.avatar ? (
                    <img src={user.avatar} alt={user.nickname || "User"} className="w-full h-full object-cover" />
                  ) : (
                    <IUser size={22} />
                  )}
                </div>
                <span
                  className={`absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full border-2 border-white dark:border-neutral-900 shadow-xs ${user ? "bg-[#38bdf8]" : "bg-[#22c55e]"}`}
                  title={user ? "Firebase Cloud Sync Active" : "Local Active"}
                />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <h2 className="text-[15.5px] font-bold text-[#0f172a] dark:text-neutral-100 tracking-tight truncate">
                    {user ? (user.nickname || user.username || "Firebase Account") : "My Library"}
                  </h2>
                  <IChevR size={14} className="text-slate-400 shrink-0" strokeWidth={2.5} />
                </div>
                <div className="text-[11px] text-[#64748b] dark:text-neutral-400 truncate mt-0.5">
                  {user ? (user.desc || "Firebase Cloud Sync Active") : "Local Library · Tap to sign in with Email"}
                </div>
              </div>
              {!user && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setLoginOpen(true);
                  }}
                  className="px-3 py-1.5 rounded-full bg-[#1a73e8] text-white text-[11.5px] font-bold pressable active:scale-95 transition-all shrink-0"
                >
                  Sign In
                </button>
              )}
            </div>

            {/* Quick Library Stats Bar */}
            <div className="grid grid-cols-4 gap-2 px-0.5">
              <button
                type="button"
                onClick={() => setView("history")}
                className="p-2 rounded-xl bg-white/70 dark:bg-neutral-900/70 border border-white/60 dark:border-white/10 flex flex-col items-center justify-center text-center shadow-xs pressable active:scale-95 transition-all"
              >
                <span className="text-[14px] font-black text-[#0f172a] dark:text-neutral-100 tabular-nums">
                  {history.length}
                </span>
                <span className="text-[10px] font-medium text-[#64748b] dark:text-neutral-400 mt-0.5">
                  Watched
                </span>
              </button>
              <button
                type="button"
                onClick={() => setView("favs")}
                className="p-2 rounded-xl bg-white/70 dark:bg-neutral-900/70 border border-white/60 dark:border-white/10 flex flex-col items-center justify-center text-center shadow-xs pressable active:scale-95 transition-all"
              >
                <span className="text-[14px] font-black text-amber-500 tabular-nums">
                  {favs.length}
                </span>
                <span className="text-[10px] font-medium text-[#64748b] dark:text-neutral-400 mt-0.5">
                  Favorites
                </span>
              </button>
              <button
                type="button"
                onClick={() => setView("watchlater")}
                className="p-2 rounded-xl bg-white/70 dark:bg-neutral-900/70 border border-white/60 dark:border-white/10 flex flex-col items-center justify-center text-center shadow-xs pressable active:scale-95 transition-all"
              >
                <span className="text-[14px] font-black text-sky-500 tabular-nums">
                  {watchLater?.length || 0}
                </span>
                <span className="text-[10px] font-medium text-[#64748b] dark:text-neutral-400 mt-0.5">
                  Watch Later
                </span>
              </button>
              <button
                type="button"
                onClick={() => setView("downloads")}
                className="p-2 rounded-xl bg-white/70 dark:bg-neutral-900/70 border border-white/60 dark:border-white/10 flex flex-col items-center justify-center text-center shadow-xs pressable active:scale-95 transition-all"
              >
                <span className="text-[14px] font-black text-emerald-600 dark:text-emerald-400 tabular-nums">
                  {downloads.length}
                </span>
                <span className="text-[10px] font-medium text-[#64748b] dark:text-neutral-400 mt-0.5">
                  Downloads
                </span>
              </button>
            </div>

            {/* History Shelf */}
            <div className="flex flex-col gap-1.5 mt-1">
              <div className="flex items-center justify-between px-1">
                <div className="flex items-center gap-2">
                  <div className="w-5 h-5 rounded-full bg-primary/15 text-primary flex items-center justify-center shrink-0">
                    <IHist size={12} strokeWidth={2.4} />
                  </div>
                  <span className="text-[14.5px] font-bold text-[#0f172a] dark:text-neutral-100 tracking-tight">
                    History {history.length > 0 && `(${history.length})`}
                  </span>
                </div>
                {history.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setView("history")}
                    className="text-[11.5px] font-bold text-primary hover:opacity-80 flex items-center gap-0.5 pressable"
                  >
                    <span>View all</span>
                    <IChevR size={12} strokeWidth={2.6} />
                  </button>
                )}
              </div>

              {history.length > 0 ? (
                <div className="flex gap-2 overflow-x-auto scrollbar-none pb-0.5 -mx-4 px-4">
                  {history.slice(0, 15).map((h, idx) => {
                    const progressPct =
                      h.dur > 0
                        ? Math.min(100, Math.max(8, (h.t / h.dur) * 100))
                        : h.t > 0
                        ? 35
                        : 0;

                    const detail = detailCache[h.id];
                    const coverUrl = detail?.cover || h.cover;
                    const offlineMatch = downloads.find((d) => d.videoId === h.id && d.storage === "native" && d.hasLocalCover);
                    const coverSrc = getOfflineCoverUrl(
                      {
                        id: offlineMatch?.id || "",
                        cover: coverUrl || "",
                        storage: offlineMatch?.storage,
                        hasLocalCover: offlineMatch?.hasLocalCover,
                      },
                      240
                    );
                    const dramaTitle = formatDramaTitle(detail?.title || h.title || `Drama #${h.id}`);
                    const epCount = detail?.episode_count || h.episode_count || 1;
                    const isFinished = detail?.is_finished ?? h.is_finished;

                    return (
                      <div
                        key={`${h.id}_${h.ep}_${idx}`}
                        role="button"
                        tabIndex={0}
                        onClick={() =>
                          push({
                            kind: "feed",
                            videoIds: history.map((x) => x.id),
                            index: idx,
                            title: dramaTitle,
                            startEp: h.ep,
                            startTime: h.t,
                          })
                        }
                        className="group w-28 shrink-0 flex flex-col cursor-pointer pressable active:scale-[0.98] transition-transform relative"
                      >
                        <div className="w-full h-[80px] rounded-xl overflow-hidden relative shadow-xs border border-slate-200/60 dark:border-white/10 bg-slate-900">
                          {coverSrc ? (
                            <img
                              src={coverSrc}
                              alt={dramaTitle}
                              className="w-full h-full object-cover"
                              loading="lazy"
                              onError={(e) => {
                                (e.target as HTMLElement).style.display = "none";
                                const fallback = (e.target as HTMLElement).nextElementSibling as HTMLElement;
                                if (fallback) fallback.style.display = "flex";
                              }}
                            />
                          ) : null}
                          <div
                            className={`w-full h-full flex flex-col items-center justify-center bg-gradient-to-br from-slate-800 to-slate-950 text-white/90 p-2 text-center ${
                              coverSrc ? "hidden" : "flex"
                            }`}
                          >
                            <IHist size={16} className="text-white/40 mb-0.5" />
                            <span className="text-[10px] font-bold tracking-tight line-clamp-1 text-white/80">
                              {dramaTitle}
                            </span>
                          </div>

                          {/* Accent Progress Bar along Bottom */}
                          {progressPct > 0 && (
                            <div className="absolute bottom-0 inset-x-0 h-1 bg-black/45 overflow-hidden">
                              <div
                                className="h-full bg-primary rounded-full transition-all duration-300"
                                style={{ width: `${progressPct}%` }}
                              />
                            </div>
                          )}

                          {/* Top-Left Remove History Item Button */}
                          <button
                            type="button"
                            aria-label={`Remove ${dramaTitle} from history`}
                            onClick={(e) => {
                              e.stopPropagation();
                              removeHistory(h.id);
                              toast("Removed from watch history", "info");
                            }}
                            className="absolute top-1 left-1 w-4 h-4 rounded-full bg-black/60 hover:bg-red-500/90 text-white/90 flex items-center justify-center shadow-xs transition-colors"
                          >
                            <IClose size={9} />
                          </button>

                          {/* Top-Right Duration Pill */}
                          <div className="absolute top-1 right-1 px-1.5 py-0.5 rounded-full bg-black/60 backdrop-blur-xs text-[8.5px] font-bold text-white shadow-xs">
                            Ep. {h.ep}{h.t > 0 ? ` · ${fmtTime(h.t)}` : ""}
                          </div>
                        </div>

                        <div className="text-[11.5px] font-bold text-[#0f172a] dark:text-neutral-100 truncate mt-1">
                          {dramaTitle}
                        </div>
                        <div className="text-[10px] text-[#64748b] dark:text-neutral-400 truncate">
                          {isFinished ? "Finished" : `${epCount} ${epCount === 1 ? "ep" : "eps"}`} · Ep. {h.ep}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="p-3 rounded-2xl bg-white/70 dark:bg-neutral-900/70 border border-white/60 dark:border-white/10 text-center flex flex-col items-center justify-center gap-1 shadow-xs">
                  <div className="text-[12px] font-semibold text-[#0f172a] dark:text-neutral-100">{t("profile.no_hist")}</div>
                  <div className="text-[10.5px] text-[#64748b] dark:text-neutral-400">{t("profile.no_hist_sub")}</div>
                </div>
              )}
            </div>

            {/* Playlists Shelf */}
            <div className="flex flex-col gap-1.5 mt-1">
              <div className="flex items-center justify-between px-1">
                <div className="flex items-center gap-2">
                  <div className="w-5 h-5 rounded-full bg-primary/15 text-primary flex items-center justify-center shrink-0">
                    <IStarF size={12} />
                  </div>
                  <span className="text-[14.5px] font-bold text-[#0f172a] dark:text-neutral-100 tracking-tight">Playlists</span>
                </div>
                <button
                  type="button"
                  onClick={() => setView("favs")}
                  className="text-[11.5px] font-bold text-primary hover:opacity-80 flex items-center gap-0.5 pressable"
                >
                  <span>View all</span>
                  <IChevR size={12} strokeWidth={2.6} />
                </button>
              </div>

              <div className="grid grid-cols-2 gap-2">
                {/* Favorites Sunset Sky Card */}
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => setView("favs")}
                  className="min-h-[92px] h-[94px] rounded-2xl overflow-hidden relative shadow-[0_6px_18px_-4px_rgba(121,134,203,0.45),inset_0_1px_0_rgba(255,255,255,0.35)] border border-white/40 dark:border-white/15 p-3 flex flex-col justify-between cursor-pointer pressable active:scale-[0.98] transition-transform"
                  style={{
                    background: "linear-gradient(135deg, #7986cb 0%, #a278b5 35%, #e1819d 70%, #fca380 100%)",
                  }}
                >
                  <div className="absolute inset-0 flex items-center justify-center opacity-30 pointer-events-none">
                    <svg width="40" height="40" viewBox="0 0 24 24" fill="white">
                      <path d="M12 21.1C6.1 17.2 2.5 13.7 2.5 9.8c0-3 2.3-5.3 5.2-5.3 1.7 0 3.3.8 4.3 2.2 1-1.4 2.6-2.2 4.3-2.2 2.9 0 5.2 2.3 5.2 5.3 0 3.9-3.6 7.4-9.5 11.3Z" />
                    </svg>
                  </div>

                  <div className="flex items-center justify-between z-10">
                    <span />
                    <IMore size={13} className="rotate-90 text-white/80" />
                  </div>

                  <div className="flex items-end justify-between z-10">
                    <div>
                      <div className="text-white font-bold text-[12px] leading-tight">Favorites</div>
                      <div className="text-white/80 text-[9.5px] mt-0.5">
                        {favs.length} {favs.length === 1 ? "drama" : "dramas"}
                      </div>
                    </div>
                    <div className="px-1.5 py-0.5 rounded-full bg-black/40 backdrop-blur-xs text-white text-[9px] font-bold flex items-center gap-1 shadow-xs">
                      <IStarF size={9} className="text-white" />
                      <span>{favs.length}</span>
                    </div>
                  </div>
                </div>

                {/* Watch Later Starry Night Sky Card */}
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => setView("watchlater")}
                  className="min-h-[92px] h-[94px] rounded-2xl overflow-hidden relative shadow-[0_6px_18px_-4px_rgba(27,38,59,0.42),inset_0_1px_0_rgba(255,255,255,0.28)] border border-white/40 dark:border-white/15 p-3 flex flex-col justify-between cursor-pointer pressable active:scale-[0.98] transition-transform"
                  style={{
                    background: "linear-gradient(135deg, #0d1b2a 0%, #1b263b 40%, #294362 70%, #466995 100%)",
                  }}
                >
                  <div className="absolute inset-0 flex items-center justify-center opacity-25 pointer-events-none">
                    <svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5">
                      <circle cx="12" cy="12" r="9" />
                      <polyline points="12 7 12 12 15 15" />
                    </svg>
                  </div>

                  <div className="flex items-center justify-between z-10">
                    <span />
                    <IMore size={13} className="rotate-90 text-white/80" />
                  </div>

                  <div className="flex items-end justify-between z-10">
                    <div>
                      <div className="text-white font-bold text-[12px] leading-tight">Watch Later</div>
                      <div className="text-white/80 text-[9.5px] mt-0.5">
                        {watchLater?.length || 0} {(watchLater?.length || 0) === 1 ? "drama" : "dramas"}
                      </div>
                    </div>
                    <div className="px-1.5 py-0.5 rounded-full bg-black/40 backdrop-blur-xs text-white text-[9px] font-bold flex items-center gap-1 shadow-xs">
                      <IClock size={10} className="text-white" strokeWidth={2.5} />
                      <span>{watchLater?.length || 0}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Downloads Card with Storage Bar / Active Download Indicator */}
            <div
              role="button"
              tabIndex={0}
              onClick={() => setView("downloads")}
              className={`bg-white/85 dark:bg-neutral-900/85 backdrop-blur-md rounded-2xl border ${
                activeDownloads.length > 0
                  ? "border-blue-200/80 dark:border-blue-500/30 shadow-[0_4px_20px_-2px_rgba(37,99,235,0.12)]"
                  : "border-white/70 dark:border-white/10 shadow-[0_4px_20px_-2px_rgba(20,45,85,0.06)]"
              } p-3.5 flex flex-col gap-2.5 cursor-pointer pressable hover:bg-white dark:hover:bg-neutral-800/90 active:scale-[0.99] transition-all`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <div
                    className={`w-11 h-11 rounded-2xl ${
                      activeDownloads.length > 0
                        ? "bg-blue-50 dark:bg-blue-500/15 text-[#1a73e8] dark:text-blue-400 border border-blue-200/60 dark:border-blue-500/30"
                        : "bg-[#dcfce7] dark:bg-emerald-500/15 text-[#16a34a] dark:text-emerald-400"
                    } flex items-center justify-center shrink-0 shadow-xs`}
                  >
                    <IDownload size={20} strokeWidth={2.4} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-[14.5px] font-bold text-[#0f172a] dark:text-neutral-100">Downloads</div>
                    {activeDownloads.length > 0 ? (
                      <div className="flex items-center gap-1.5 mt-0.5 min-w-0">
                        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10.5px] font-semibold bg-blue-50 dark:bg-blue-500/15 text-[#1a73e8] dark:text-blue-400 border border-blue-200/80 dark:border-blue-500/30 max-w-full">
                          <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse shrink-0" />
                          <span className="truncate">
                            Downloading ({activeDownloads.length}) · {activeDownloadsSpeedFormatted}
                          </span>
                        </span>
                      </div>
                    ) : (
                      <div className="text-[11px] text-[#64748b] dark:text-neutral-400 truncate">
                        {downloads.length > 0
                          ? `${downloads.length} ${downloads.length === 1 ? "episode" : "episodes"} offline · ${formatBytes(totalDownloadsBytes)}`
                          : "0 episodes offline · Ready for offline download"}
                      </div>
                    )}
                  </div>
                </div>
                <IChevR size={14} className="text-slate-400 shrink-0 ml-2" strokeWidth={2.5} />
              </div>

              {/* Progress / Storage Bar Indicator */}
              {activeDownloads.length > 0 ? (
                <div className="flex items-center gap-2 pt-0.5">
                  <div className="flex-1 h-1.5 rounded-full bg-s3 overflow-hidden">
                    <div
                      className="h-full bg-primary rounded-full transition-all duration-300"
                      style={{
                        width: `${Math.min(100, Math.max(3, activeDownloadsProgressPercent))}%`,
                      }}
                    />
                  </div>
                  <span className="text-[10.5px] font-extrabold text-primary tabular-nums">
                    {activeDownloadsProgressPercent}%
                  </span>
                </div>
              ) : downloads.length > 0 ? (
                <div className="flex flex-col gap-1 pt-0.5">
                  <div className="flex items-center justify-between text-[10.5px] text-[#64748b] dark:text-neutral-400">
                    <span>Phone Storage</span>
                    <span className="font-bold tabular-nums text-[#0f172a] dark:text-neutral-200">
                      {storageStats?.percentUsed != null ? `${Math.round(storageStats.percentUsed)}% used` : ""}
                    </span>
                  </div>
                  <div className="w-full h-1.5 rounded-full bg-[#e2e8f0] dark:bg-neutral-800 overflow-hidden">
                    <div
                      className="h-full bg-slate-400 dark:bg-neutral-600 rounded-full transition-all duration-300"
                      style={{
                        width: `${
                          storageStats?.percentUsed != null
                            ? storageStats.percentUsed > 0
                              ? Math.min(100, Math.max(3, Math.round(storageStats.percentUsed)))
                              : 0
                            : 0
                        }%`,
                      }}
                    />
                  </div>
                </div>
              ) : null}
            </div>

            {/* Settings Card */}
            <div
              role="button"
              tabIndex={0}
              onClick={() => push({ kind: "settings" })}
              className="bg-white/85 dark:bg-neutral-900/85 backdrop-blur-md rounded-2xl border border-white/70 dark:border-white/10 shadow-[0_4px_20px_-2px_rgba(20,45,85,0.06)] p-3.5 flex items-center justify-between cursor-pointer pressable hover:bg-white dark:hover:bg-neutral-800/90 active:scale-[0.99] transition-all"
            >
              <div className="flex items-center gap-3">
                <div className="w-11 h-11 rounded-2xl bg-[#f1f5f9] dark:bg-neutral-800 text-[#475569] dark:text-neutral-300 flex items-center justify-center shrink-0 shadow-xs">
                  <ISettings size={20} strokeWidth={2.2} />
                </div>
                <div>
                  <div className="text-[14.5px] font-bold text-[#0f172a] dark:text-neutral-100">Settings</div>
                  <div className="text-[11px] text-[#64748b] dark:text-neutral-400">Playback, quality, network & display</div>
                </div>
              </div>
              <IChevR size={14} className="text-slate-400" strokeWidth={2.5} />
            </div>

            {/* Footer */}
            <div className="flex flex-col items-center justify-center gap-1.5 pt-1 pb-1">
              <button
                type="button"
                onClick={() => {
                  if (otaRuntime.stage === "downloading" && availableUpdate?.has_update) {
                    setUpdateInfo(availableUpdate);
                    return;
                  }
                  void handleCheckUpdate();
                }}
                disabled={checkingUpdate}
                className={`px-3 py-1 rounded-full text-[10.5px] font-bold pressable disabled:opacity-50 transition-colors ${
                  availableUpdate?.has_update
                    ? "bg-primary/15 text-primary border border-primary/30"
                    : "bg-slate-200/80 dark:bg-neutral-800 text-[#64748b] dark:text-neutral-300 hover:text-primary"
                }`}
              >
                {checkingUpdate
                  ? "Checking for Updates..."
                  : otaRuntime.stage === "downloading" && availableUpdate?.has_update
                  ? `Downloading v${availableUpdate.latest} (${otaRuntime.progress}%)`
                  : availableUpdate?.has_update
                  ? `Update Ready: v${availableUpdate.latest}`
                  : "Check for Updates"}
              </button>
              <div className="text-center text-[10.5px] text-[#94a3b8] font-medium tracking-tight">
                AuraStream v{APP_VERSION} · This App Created by AAA. All rights reserved.
              </div>
            </div>
          </div>
        ) : view === "downloads" ? (
          /* =====================================================================
              2. Downloads Hub View (Image 2 & Image 3 Screen 1)
              ===================================================================== */
          <div className="flex flex-col gap-3.5 a-rise min-w-0 w-full overflow-x-hidden pb-4">
            {/* Search Input Bar (when search is toggled in top bar) */}
            {downloadSearchOpen && (
              <div className="relative flex items-center bg-white/95 dark:bg-neutral-900/95 border border-blue-200/90 dark:border-blue-500/30 rounded-full px-3.5 py-2 shadow-xs a-fade-in">
                <ISearch size={15} className="text-slate-400 shrink-0 mr-2" />
                <input
                  type="text"
                  value={downloadSearchQuery}
                  onChange={(e) => setDownloadSearchQuery(e.target.value)}
                  placeholder="Search downloaded shows & episodes..."
                  className="flex-1 bg-transparent text-[13px] text-[#0f172a] dark:text-neutral-100 placeholder:text-slate-400 outline-none"
                  autoFocus
                />
                {downloadSearchQuery && (
                  <button
                    type="button"
                    onClick={() => setDownloadSearchQuery("")}
                    className="w-5 h-5 rounded-full bg-slate-200 dark:bg-neutral-800 text-slate-500 dark:text-neutral-300 flex items-center justify-center pressable"
                    aria-label="Clear search"
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                )}
              </div>
            )}

            {/* Android Background Permission Banner */}
            {androidPerms &&
              !permBannerDismissed &&
              (!androidPerms.batteryOptimizationIgnored || !androidPerms.notificationsGranted) && (
                <div className="bg-amber-50/95 dark:bg-amber-950/35 border border-amber-200 dark:border-amber-500/30 rounded-2xl p-3 flex items-center justify-between gap-2.5 shadow-xs">
                  <div className="min-w-0 flex-1">
                    <div className="text-[12.5px] font-bold text-[#0f172a] dark:text-neutral-100">
                      Keep Background Downloads Running
                    </div>
                    <div className="text-[11px] text-[#64748b] dark:text-neutral-400 leading-snug mt-0.5">
                      Allow unrestricted battery and notifications so downloads keep running when you leave the app.
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => {
                        const bridge = window.AuraNativeExport;
                        if (!androidPerms.notificationsGranted) {
                          bridge?.requestNotificationPermissionNow?.();
                        } else if (!androidPerms.batteryOptimizationIgnored) {
                          bridge?.requestIgnoreBatteryOptimizations?.();
                        }
                        window.setTimeout(() => setAndroidPerms(getAndroidPermissionsStatus()), 400);
                      }}
                      className="px-3 py-1.5 rounded-xl bg-[#1a73e8] text-white text-[11.5px] font-bold pressable"
                    >
                      Allow Now
                    </button>
                    <button
                      type="button"
                      onClick={() => setPermBannerDismissed(true)}
                      className="w-7 h-7 rounded-full bg-black/5 dark:bg-white/10 text-slate-500 dark:text-neutral-300 flex items-center justify-center pressable"
                      aria-label="Dismiss permission reminder"
                    >
                      <IClose size={11} />
                    </button>
                  </div>
                </div>
              )}

            {/* Downloads Hub Navigation Switcher: Downloaded vs Queue */}
            <div className="flex items-center gap-1.5 p-1 bg-slate-200/70 dark:bg-neutral-800/80 rounded-2xl shrink-0">
              <button
                type="button"
                onClick={() => setDownloadHubTab("downloaded")}
                className={`flex-1 py-1.5 px-3 rounded-xl text-[12.5px] font-bold flex items-center justify-center gap-2 transition-all ${
                  downloadHubTab === "downloaded"
                    ? "bg-white dark:bg-neutral-900 text-[#0f172a] dark:text-neutral-100 shadow-xs"
                    : "text-[#64748b] dark:text-neutral-400 hover:text-[#0f172a] dark:hover:text-neutral-200"
                }`}
              >
                <ICheck size={13} strokeWidth={2.6} />
                <span>Downloaded</span>
                <span
                  className={`text-[11px] px-1.5 py-0.2 rounded-full font-bold ${
                    downloadHubTab === "downloaded"
                      ? "bg-blue-100 dark:bg-blue-500/20 text-[#1a73e8] dark:text-blue-400"
                      : "bg-slate-300/60 dark:bg-neutral-700 text-slate-600 dark:text-neutral-300"
                  }`}
                >
                  {downloads.length}
                </span>
              </button>
              <button
                type="button"
                onClick={() => setDownloadHubTab("queue")}
                className={`flex-1 py-1.5 px-3 rounded-xl text-[12.5px] font-bold flex items-center justify-center gap-2 transition-all ${
                  downloadHubTab === "queue"
                    ? "bg-white dark:bg-neutral-900 text-[#0f172a] dark:text-neutral-100 shadow-xs"
                    : "text-[#64748b] dark:text-neutral-400 hover:text-[#0f172a] dark:hover:text-neutral-200"
                }`}
              >
                <IDownload size={13} strokeWidth={2.4} />
                <span>Queue</span>
                {activeDownloads.length > 0 && (
                  <span
                    className={`text-[11px] px-1.5 py-0.2 rounded-full font-bold flex items-center gap-1 ${
                      downloadHubTab === "queue"
                        ? "bg-blue-500 text-white"
                        : "bg-blue-100 dark:bg-blue-500/20 text-[#1a73e8] dark:text-blue-400"
                    }`}
                  >
                    {downloadingItemsCount > 0 && <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />}
                    <span>{activeDownloads.length}</span>
                  </span>
                )}
              </button>
            </div>

            {/* When on Downloaded Tab: Show Smart Mini-Banner if Downloads are running in background */}
            {downloadHubTab === "downloaded" && activeDownloads.length > 0 && (
              <div
                role="button"
                tabIndex={0}
                onClick={() => setDownloadHubTab("queue")}
                className="p-2.5 px-3 rounded-2xl bg-gradient-to-r from-blue-500/10 via-indigo-500/10 to-blue-500/10 border border-blue-500/25 flex items-center justify-between gap-2.5 cursor-pointer pressable hover:bg-blue-500/15 active:scale-[0.99] transition-all shadow-xs a-fade-in"
              >
                <div className="flex items-center gap-2.5 min-w-0 flex-1">
                  <div className="w-8 h-8 rounded-xl bg-blue-500 text-white flex items-center justify-center shrink-0 shadow-xs">
                    <IDownload size={14} strokeWidth={2.6} className={downloadingItemsCount > 0 ? "animate-bounce" : ""} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 text-[12px] font-bold text-[#0f172a] dark:text-neutral-100 truncate">
                      <span>
                        {downloadingItemsCount > 0
                          ? `Downloading Ep. ${activeTransferringItem?.episode || 1}`
                          : `${activeDownloads.length} ${activeDownloads.length === 1 ? "item" : "items"} in queue`}
                      </span>
                      {activeTransferringItem?.speedFormatted &&
                        !/connecting|--/i.test(activeTransferringItem.speedFormatted) && (
                          <span className="text-blue-600 dark:text-blue-400 font-semibold tabular-nums">
                            · {activeTransferringItem.speedFormatted}
                          </span>
                        )}
                      {activeTransferringItem?.progress != null && activeTransferringItem.progress > 0 && (
                        <span className="text-slate-500 dark:text-neutral-400 tabular-nums">
                          ({activeTransferringItem.progress}%)
                        </span>
                      )}
                    </div>
                    <div className="w-full h-1 rounded-full bg-blue-200 dark:bg-blue-950 overflow-hidden mt-1">
                      <div
                        className="h-full bg-gradient-to-r from-blue-500 to-indigo-500 rounded-full transition-all duration-300"
                        style={{ width: `${Math.max(2, activeTransferringItem?.progress || 0)}%` }}
                      />
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1 text-[11.5px] font-bold text-[#1a73e8] dark:text-blue-400 shrink-0">
                  <span>View Queue ({activeDownloads.length})</span>
                  <IChevR size={12} strokeWidth={2.6} />
                </div>
              </div>
            )}

            {/* Queue Tab Content */}
            {downloadHubTab === "queue" && (
              activeDownloads.length > 0 ? (() => {
                const statusParts: string[] = [];
                if (downloadingItemsCount > 0) statusParts.push(`${downloadingItemsCount} downloading`);
                if (queuedItemsCount > 0) statusParts.push(`${queuedItemsCount} queued`);
                if (failedItemsCount > 0) statusParts.push(`${failedItemsCount} failed`);
                if (pausedItemsCount > 0) statusParts.push(`${pausedItemsCount} paused`);
                if (statusParts.length === 0) statusParts.push(`${activeDownloads.length} active`);
                const hasFailedOnly = failedItemsCount > 0 && pausedItemsCount === 0;
                return (
              <div className="flex flex-col gap-2.5 mb-1 min-w-0 w-full">
                <div className="flex flex-wrap items-center justify-between px-0.5 gap-x-2 gap-y-1.5 min-w-0">
                  <div className="text-[11.5px] font-black text-[#0f172a] dark:text-neutral-100 uppercase tracking-wider flex items-center gap-2 min-w-0">
                    <span className={`w-2 h-2 rounded-full shrink-0 ${downloadingItemsCount > 0 ? "bg-blue-500 animate-pulse" : failedItemsCount > 0 ? "bg-red-500" : "bg-amber-500"}`} />
                    <span className="break-words">{statusParts.join(" · ")}</span>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0 flex-wrap">
                    {(failedItemsCount > 0 || pausedItemsCount > 0) && (
                      <button
                        type="button"
                        onClick={() => void resumeAllDownloads()}
                        className="px-2 py-0.5 rounded-full bg-emerald-500/12 text-[11px] font-bold text-[#16a34a] dark:text-emerald-400 hover:bg-emerald-500/20 pressable whitespace-nowrap"
                      >
                        {hasFailedOnly ? "Retry Failed" : "Resume All"}
                      </button>
                    )}
                    {(downloadingItemsCount > 0 || queuedItemsCount > 0) && (
                      <button
                        type="button"
                        onClick={() => pauseAllDownloads()}
                        className="px-2 py-0.5 rounded-full bg-blue-500/12 text-[11px] font-bold text-[#1a73e8] dark:text-blue-400 hover:bg-blue-500/20 pressable whitespace-nowrap"
                      >
                        Pause All
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => cancelAllDownloads()}
                      className="px-2 py-0.5 rounded-full bg-red-500/12 text-[11px] font-bold text-red-500 hover:bg-red-500/20 pressable whitespace-nowrap"
                    >
                      Cancel All
                    </button>
                  </div>
                </div>

                {activeDownloads.map((item) => (
                  <div
                    key={item.id}
                    className="bg-white/95 dark:bg-neutral-900/95 backdrop-blur-md rounded-2xl border border-blue-100 dark:border-blue-500/25 shadow-[0_4px_20px_-2px_rgba(37,99,235,0.08)] p-3 flex flex-col gap-2.5 overflow-hidden min-w-0"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-12 aspect-[3/4] rounded-xl overflow-hidden shrink-0 shadow-xs border border-black/5 dark:border-white/10 bg-slate-100 dark:bg-neutral-800 relative flex items-center justify-center">
                        {(() => {
                          const coverSrc = getOfflineCoverUrl({ id: item.id, cover: item.cover || "" }, 160);
                          return coverSrc ? (
                            <img
                              src={coverSrc}
                              alt=""
                              className="w-full h-full object-cover"
                              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                            />
                          ) : (
                            <ILayers size={16} className="text-slate-400" />
                          );
                        })()}
                        <div className="absolute bottom-0.5 left-0.5 px-1 py-0.2 rounded bg-black/60 text-[8px] font-bold text-white">
                          Ep. {item.episode}
                        </div>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-[14px] font-bold text-[#0f172a] dark:text-neutral-100 truncate leading-tight">
                          {formatDramaTitle(item.title)}
                        </div>
                        <div className="text-[11px] text-[#64748b] dark:text-neutral-400 mt-0.5 flex items-center gap-1.5 whitespace-nowrap overflow-hidden">
                          <span className="shrink-0">Episode {item.episode}</span>
                          {(item.status === "downloading" || item.status === "paused" || item.status === "error") && item.progress > 0 && (
                            <>
                              <span className="shrink-0">·</span>
                              <span
                                className={`shrink-0 font-semibold tabular-nums ${
                                  item.status === "error"
                                    ? "text-red-500"
                                    : item.status === "paused"
                                    ? "text-slate-500 dark:text-neutral-400"
                                    : "text-blue-600 dark:text-blue-400"
                                }`}
                              >
                                {item.progress}%
                              </span>
                            </>
                          )}
                          <span className="shrink-0">·</span>
                          <span
                            className={`font-semibold truncate ${
                              item.status === "queued"
                                ? "text-amber-600 dark:text-amber-400"
                                : item.status === "paused"
                                ? "text-slate-500 dark:text-neutral-400"
                                : item.status === "error"
                                ? "text-red-500"
                                : "text-blue-600 dark:text-blue-400"
                            }`}
                          >
                            {item.status === "queued"
                              ? "Queued"
                              : item.status === "paused"
                              ? "Paused"
                              : item.status === "error"
                              ? "Failed"
                              : item.speedFormatted && item.speedFormatted !== "-- KB/s" && item.speedFormatted !== "--"
                              ? item.speedFormatted
                              : item.speedBytesPerSec > 0
                              ? formatSpeed(item.speedBytesPerSec)
                              : "Connecting..."}
                          </span>
                        </div>
                        <div className="flex items-center justify-between gap-1.5 text-[10.5px] text-[#94a3b8] mt-0.5 tabular-nums">
                          <span className="truncate min-w-0">
                            {item.status === "queued"
                              ? "Waiting in background queue"
                              : item.totalBytes > 0
                              ? `${formatBytes(item.downloadedBytes)} / ${formatBytes(item.totalBytes)}`
                              : item.downloadedBytes > 0
                              ? `${formatBytes(item.downloadedBytes)}`
                              : "Preparing..."}
                          </span>
                          {item.status === "downloading" && item.etaFormatted && item.etaFormatted !== "--" && (
                            <span className="shrink-0 text-[#64748b] dark:text-neutral-400 font-medium">ETA {item.etaFormatted}</span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {item.status === "downloading" || item.status === "queued" ? (
                          <button
                            type="button"
                            onClick={() => pauseDownload(item.id)}
                            className="w-8 h-8 rounded-full bg-slate-100 dark:bg-neutral-800 hover:bg-slate-200 dark:hover:bg-neutral-700 text-slate-700 dark:text-neutral-200 flex items-center justify-center pressable"
                            title="Pause"
                          >
                            <IPauseF size={12} />
                          </button>
                        ) : item.status === "paused" ? (
                          <button
                            type="button"
                            onClick={() => void resumeDownload(item.id, false)}
                            className="w-8 h-8 rounded-full bg-blue-500 hover:bg-blue-600 text-white flex items-center justify-center pressable shadow-xs"
                            title="Resume"
                          >
                            <IPlayF size={12} className="ml-0.5" />
                          </button>
                        ) : item.status === "error" ? (
                          <button
                            type="button"
                            onClick={() => void resumeDownload(item.id, false)}
                            className="px-2.5 py-1 rounded-full bg-red-50 dark:bg-red-500/15 text-red-600 dark:text-red-400 text-[11px] font-bold hover:bg-red-100 pressable"
                          >
                            Retry
                          </button>
                        ) : null}
                        <button
                          type="button"
                          onClick={() => cancelDownload(item.id)}
                          className="w-8 h-8 rounded-full bg-slate-100 dark:bg-neutral-800 hover:bg-slate-200 dark:hover:bg-neutral-700 text-slate-500 dark:text-neutral-300 flex items-center justify-center pressable"
                          title="Cancel"
                        >
                          <IClose size={13} strokeWidth={2.4} />
                        </button>
                      </div>
                    </div>

                    {/* Live Progress Bar */}
                    <div
                      className={`w-full h-1.5 rounded-full overflow-hidden ${
                        item.status === "error"
                          ? "bg-red-100 dark:bg-red-950/50"
                          : item.status === "paused"
                          ? "bg-slate-200 dark:bg-neutral-800"
                          : "bg-blue-100 dark:bg-blue-950/60"
                      }`}
                    >
                      <div
                        className={`h-full rounded-full transition-all duration-300 ${
                          item.status === "error"
                            ? "bg-red-500"
                            : item.status === "paused"
                            ? "bg-slate-400 dark:bg-neutral-500"
                            : "bg-gradient-to-r from-blue-500 to-indigo-500"
                        }`}
                        style={{ width: `${item.status === "queued" ? 0 : Math.max(2, item.progress)}%` }}
                      />
                    </div>
                    {item.error && (
                      <div className="px-2.5 py-1.5 rounded-xl bg-red-500/8 border border-red-500/15 text-[11px] text-red-600 dark:text-red-400 font-medium leading-snug break-words [overflow-wrap:anywhere]">
                        {formatDownloadError(item.error)}
                      </div>
                    )}
                  </div>
                ))}
              </div>
              );
            })() : (
              <div className="flex flex-col items-center justify-center py-16 px-4 text-center select-none a-fade-in">
                <div className="w-16 h-16 rounded-full bg-blue-100 dark:bg-blue-950/60 text-blue-500 flex items-center justify-center mb-3 shadow-xs">
                  <ICheck size={28} strokeWidth={3} />
                </div>
                <h3 className="text-[17px] font-bold text-[#0f172a] dark:text-neutral-100">Download Queue Is Clear</h3>
                <p className="text-[12.5px] text-[#64748b] dark:text-neutral-400 max-w-xs mt-1">
                  No active or pending downloads in queue.
                </p>
                <button
                  type="button"
                  onClick={() => setDownloadHubTab("downloaded")}
                  className="mt-4 px-5 py-2 rounded-full bg-blue-500 text-white font-bold text-[12.5px] shadow-xs pressable active:scale-95 transition-all"
                >
                  View Downloaded Shows ({downloads.length})
                </button>
              </div>
            ))}

            {/* ======================= DOWNLOADED TAB CONTENT ======================= */}
            {downloadHubTab === "downloaded" && (
              <>
                {/* Device Storage Breakdown Card */}
                <div className="bg-white/85 dark:bg-neutral-900/85 backdrop-blur-md rounded-2xl border border-white/70 dark:border-white/10 shadow-[0_4px_20px_-2px_rgba(20,45,85,0.06)] p-3.5 flex flex-col gap-2.5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2.5">
                      <FolderDownloadIcon size={38} className="shrink-0 drop-shadow-sm" />
                      <div>
                        <div className="text-[11px] font-semibold text-[#64748b] dark:text-neutral-400">Device Storage</div>
                        <div className="text-[15px] font-black text-[#0f172a] dark:text-neutral-100 tracking-tight flex flex-wrap items-baseline gap-x-1.5">
                          <span className="whitespace-nowrap">{formatBytes(totalDownloadsBytes)} AuraStream</span>
                          {storageStats?.freeBytes != null && (
                            <span className="text-[12px] font-medium text-emerald-600 dark:text-emerald-400 whitespace-nowrap">
                              · {formatBytes(storageStats.freeBytes)} Free
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setManageStorageOpen(true)}
                      className="flex items-center gap-1 px-3 py-1.5 rounded-xl bg-white dark:bg-neutral-800 border border-slate-200/80 dark:border-white/10 text-[11.5px] font-bold text-[#334155] dark:text-neutral-200 shadow-xs hover:bg-slate-50 dark:hover:bg-neutral-700 pressable active:scale-95 transition-all"
                    >
                      <ISettings size={12} />
                      <span>Manage</span>
                    </button>
                  </div>

                  {/* Multi-segmented storage bar */}
                  {(() => {
                    const quota = storageStats?.quotaBytes || (storageStats?.freeBytes ? storageStats.freeBytes + totalDownloadsBytes * 2 : 64 * 1024 * 1024 * 1024);
                    const free = storageStats?.freeBytes ?? Math.max(0, quota - totalDownloadsBytes);
                    const auraPct = Math.min(100, Math.max(totalDownloadsBytes > 0 ? 2 : 0, (totalDownloadsBytes / quota) * 100));
                    const rawFreePct = Math.max(5, (free / quota) * 100);
                    const freePct = Math.max(0, Math.min(100 - auraPct, rawFreePct));
                    const otherPct = Math.max(0, 100 - auraPct - freePct);

                    return (
                      <div className="flex flex-col gap-1.5">
                        <div className="w-full h-2 rounded-full bg-slate-200 dark:bg-neutral-800 overflow-hidden flex">
                          {auraPct > 0 && (
                            <div
                              style={{ width: `${auraPct}%` }}
                              className="h-full bg-[#1a73e8] transition-all duration-300"
                              title={`AuraStream: ${formatBytes(totalDownloadsBytes)}`}
                            />
                          )}
                          {otherPct > 0 && (
                            <div
                              style={{ width: `${otherPct}%` }}
                              className="h-full bg-slate-400 dark:bg-neutral-600 transition-all duration-300"
                              title="Other Apps & System"
                            />
                          )}
                          <div
                            style={{ width: `${freePct}%` }}
                            className="h-full bg-emerald-500 transition-all duration-300"
                            title={`Free Space: ${formatBytes(free)}`}
                          />
                        </div>

                        {/* Legend */}
                        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[10.5px] text-[#64748b] dark:text-neutral-400 font-medium px-0.5">
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
                            <span className="flex items-center gap-1">
                              <span className="w-2 h-2 rounded-full bg-[#1a73e8]" />
                              <span>AuraStream ({formatBytes(totalDownloadsBytes)})</span>
                            </span>
                            <span className="flex items-center gap-1">
                              <span className="w-2 h-2 rounded-full bg-emerald-500" />
                              <span>Free ({formatBytes(free)})</span>
                            </span>
                          </div>
                          {storageStats?.quotaBytes && (
                            <span>Total {formatBytes(storageStats.quotaBytes)}</span>
                          )}
                        </div>
                      </div>
                    );
                  })()}
                </div>

                {downloads.length > 0 ? (
                  <>

                {/* Filter Pills */}
                <div className="flex items-center justify-between px-0.5">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setDownloadFilter("all")}
                      className={`px-3.5 py-1.5 rounded-full text-[12px] font-bold flex items-center gap-1.5 pressable transition-all shadow-xs ${
                        downloadFilter === "all"
                          ? "bg-[#1a73e8] text-white"
                          : "bg-white/80 dark:bg-neutral-800/90 border border-slate-200 dark:border-white/10 text-[#64748b] dark:text-neutral-300"
                      }`}
                    >
                      <IPlayF size={10} />
                      <span>All</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setDownloadFilter("series")}
                      className={`px-3.5 py-1.5 rounded-full text-[12px] font-bold flex items-center gap-1.5 pressable transition-all shadow-xs ${
                        downloadFilter === "series"
                          ? "bg-[#1a73e8] text-white"
                          : "bg-white/80 dark:bg-neutral-800/90 border border-slate-200 dark:border-white/10 text-[#64748b] dark:text-neutral-300"
                      }`}
                    >
                      <ILayers size={12} />
                      <span>Series</span>
                    </button>
                  </div>

              <button
                type="button"
                onClick={() => {
                  if (downloadSort === "recent") setDownloadSort("size");
                  else if (downloadSort === "size") setDownloadSort("title");
                  else setDownloadSort("recent");
                }}
                className="flex items-center gap-1 text-[11.5px] font-semibold text-[#475569] dark:text-neutral-300 bg-white/80 dark:bg-neutral-800/90 hover:bg-white dark:hover:bg-neutral-700 border border-slate-200 dark:border-white/10 px-2.5 py-1 rounded-full pressable transition-all shadow-2xs"
              >
                <span>
                  {downloadSort === "recent"
                    ? "Recently Added"
                    : downloadSort === "size"
                    ? "Largest Size"
                    : "Title A-Z"}
                </span>
                <IChevronDown size={12} />
              </button>
            </div>

            {/* Grouped Downloaded Shows */}
            {sortedDramaGroups.length > 0 ? (
              <div className="flex flex-col gap-3 min-w-0">
                {sortedDramaGroups.map((group) => {
                  const isExpanded = !collapsedDramas.has(group.videoId);

                  const allGroupKeys = group.episodes.map((e) => `${e.videoId}_${e.episode}`);
                  const allSelected = allGroupKeys.every((k) => selectedKeys.has(k));
                  const someSelected = allGroupKeys.some((k) => selectedKeys.has(k));

                  const seriesQueue = activeDownloads.filter((d) => d.videoId === group.videoId);
                  const runningCount = seriesQueue.filter((d) => d.status === "downloading" || d.status === "queued").length;
                  const incompleteCount = seriesQueue.filter((d) => d.status === "error" || d.status === "paused").length;
                  const totalKnown = detailCache[group.videoId]?.episodes?.length || detailCache[group.videoId]?.episode_count || 0;
                  const maxSavedEp = group.episodes.reduce((m, e) => Math.max(m, e.episode), 0);

                  return (
                    <div
                      key={group.videoId}
                      className="bg-white/90 dark:bg-neutral-900/90 backdrop-blur-md rounded-2xl border border-white/70 dark:border-white/10 shadow-[0_4px_20px_-2px_rgba(20,45,85,0.06)] p-3 flex flex-col gap-2.5 overflow-hidden min-w-0"
                    >
                      <div className="flex items-center gap-2.5">
                        {selectMode ? (
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedKeys((prev) => {
                                const next = new Set(prev);
                                if (allSelected) {
                                  for (const k of allGroupKeys) next.delete(k);
                                } else {
                                  for (const k of allGroupKeys) next.add(k);
                                }
                                return next;
                              });
                            }}
                            className="w-5 h-5 rounded-full flex items-center justify-center shrink-0 pressable mr-0.5"
                          >
                            {allSelected ? (
                              <div className="w-5 h-5 rounded-full bg-[#1a73e8] text-white flex items-center justify-center shadow-xs">
                                <ICheck size={11} strokeWidth={3.5} />
                              </div>
                            ) : someSelected ? (
                              <div className="w-5 h-5 rounded-full bg-[#1a73e8] text-white flex items-center justify-center shadow-xs">
                                <span className="text-[12px] font-black leading-none">-</span>
                              </div>
                            ) : (
                              <div className="w-5 h-5 rounded-full border-2 border-slate-300 dark:border-neutral-600 bg-white dark:bg-neutral-800" />
                            )}
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => toggleDramaCollapse(group.videoId)}
                            className="w-7 h-7 rounded-full text-slate-400 hover:text-slate-600 dark:hover:text-neutral-200 hover:bg-slate-200/50 dark:hover:bg-white/10 flex items-center justify-center pressable shrink-0"
                            aria-label={isExpanded ? "Collapse episodes" : "Expand episodes"}
                          >
                            {isExpanded ? <IChevronUp size={16} /> : <IChevronDown size={16} />}
                          </button>
                        )}

                        <button
                          type="button"
                          onClick={() => {
                            if (selectMode) {
                              setSelectedKeys((prev) => {
                                const next = new Set(prev);
                                if (allSelected) {
                                  for (const k of allGroupKeys) next.delete(k);
                                } else {
                                  for (const k of allGroupKeys) next.add(k);
                                }
                                return next;
                              });
                            } else {
                              setSelectedSeriesGroup(group);
                              setView("seriesDetail");
                            }
                          }}
                          className="w-14 aspect-[3/4] rounded-xl overflow-hidden shrink-0 shadow-xs border border-black/5 dark:border-white/10 bg-slate-100 dark:bg-neutral-800 cursor-pointer pressable relative p-0 border-0 text-left block"
                        >
                          {(() => {
                            const coverSrc = getOfflineCoverUrl(group.episodes.find((e) => e.hasLocalCover) || group.episodes[0] || { id: "", cover: group.cover }, 200);
                            return coverSrc ? (
                              <img
                                src={coverSrc}
                                alt=""
                                className="w-full h-full object-cover"
                                loading="lazy"
                                onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                              />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center text-slate-400"><ILayers size={18} /></div>
                            );
                          })()}
                          <div className="absolute bottom-1 left-1 px-1.5 py-0.5 rounded-md bg-black/60 backdrop-blur-xs text-[9px] font-bold text-white shadow-xs">
                            {group.episodes.length} {group.episodes.length === 1 ? "ep" : "eps"}
                          </div>
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            if (selectMode) {
                              setSelectedKeys((prev) => {
                                const next = new Set(prev);
                                if (allSelected) {
                                  for (const k of allGroupKeys) next.delete(k);
                                } else {
                                  for (const k of allGroupKeys) next.add(k);
                                }
                                return next;
                              });
                            } else {
                              setSelectedSeriesGroup(group);
                              setView("seriesDetail");
                            }
                          }}
                          className="flex-1 min-w-0 cursor-pointer pr-1 text-left bg-transparent border-0 p-0 block"
                        >
                          <div className="text-[15px] font-bold text-[#0f172a] dark:text-neutral-100 leading-snug line-clamp-2">
                            {formatDramaTitle(group.title)}
                          </div>
                          <div className="text-[11.5px] text-[#64748b] dark:text-neutral-400 mt-0.5 tabular-nums">
                            {group.episodes.length} {group.episodes.length === 1 ? "episode" : "episodes"} · {formatBytes(group.totalBytes)}
                          </div>
                          <div className="flex items-center gap-1.5 mt-1">
                            {runningCount > 0 ? (
                              <span className="inline-flex items-center gap-1 text-[11px] font-bold text-[#1a73e8] dark:text-blue-400">
                                <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
                                <span>Downloading · {group.episodes.length} saved</span>
                              </span>
                            ) : incompleteCount > 0 ? (
                              <span className="inline-flex items-center gap-1 text-[11px] font-bold text-amber-600 dark:text-amber-400">
                                <span>{group.episodes.length} saved · {incompleteCount} incomplete</span>
                              </span>
                            ) : totalKnown > 0 && group.episodes.length < totalKnown ? (
                              <span className="inline-flex items-center gap-1 text-[11px] font-bold text-[#16a34a] dark:text-emerald-400">
                                <ICheck size={11} strokeWidth={3} />
                                <span>{group.episodes.length} of {totalKnown} Saved</span>
                              </span>
                            ) : totalKnown > 0 && group.episodes.length >= totalKnown ? (
                              <span className="inline-flex items-center gap-1 text-[11px] font-bold text-[#16a34a] dark:text-emerald-400">
                                <ICheck size={11} strokeWidth={3} />
                                <span>All Downloaded</span>
                              </span>
                            ) : maxSavedEp > group.episodes.length ? (
                              <span className="inline-flex items-center gap-1 text-[11px] font-bold text-[#16a34a] dark:text-emerald-400">
                                <ICheck size={11} strokeWidth={3} />
                                <span>{group.episodes.length} Episodes Saved</span>
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-[11px] font-bold text-[#16a34a] dark:text-emerald-400">
                                <ICheck size={11} strokeWidth={3} />
                                <span>{group.episodes.length} {group.episodes.length === 1 ? "Episode" : "Episodes"} Saved</span>
                              </span>
                            )}
                          </div>
                        </button>

                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            onClick={() => {
                              if (group.episodes[0]) {
                                push({
                                  kind: "feed",
                                  videoIds: [group.videoId],
                                  index: 0,
                                  title: formatDramaTitle(group.title),
                                  source: "offline",
                                  startEp: group.episodes[0].episode,
                                });
                              }
                            }}
                            className="w-8 h-8 rounded-full bg-[#e0edff] dark:bg-blue-500/20 text-[#1a73e8] dark:text-blue-400 hover:bg-[#d0e4ff] dark:hover:bg-blue-500/30 flex items-center justify-center pressable active:scale-95 shadow-xs transition-all"
                            title="Play Show"
                          >
                            <IPlayF size={11} />
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedSeriesGroup(group);
                              setSeriesMenuOpen(true);
                            }}
                            className="w-8 h-8 rounded-full flex items-center justify-center text-slate-400 hover:text-slate-600 dark:hover:text-neutral-200 hover:bg-slate-200/50 dark:hover:bg-white/10 pressable"
                            aria-label="Series options"
                          >
                            <IMore size={14} className="rotate-90" />
                          </button>
                        </div>
                      </div>

                      {/* Mini Episode Thumbnails Row (Collapsible) */}
                      {isExpanded && (
                        <div className="flex gap-2.5 overflow-x-auto snap-x snap-mandatory pr-1 scrollbar-none pt-1.5 border-t border-slate-100 dark:border-white/10">
                          {group.episodes.map((ep) => {
                            const isChecked = selectedKeys.has(`${ep.videoId}_${ep.episode}`);
                            const epSize = formatBytes(ep.sizeBytes);

                            return (
                              <div
                                key={ep.id}
                                role="button"
                                tabIndex={0}
                                onClick={() => {
                                  if (selectMode) {
                                    toggleSelect(`${ep.videoId}_${ep.episode}`);
                                  } else {
                                    push({
                                      kind: "feed",
                                      videoIds: [ep.videoId],
                                      index: 0,
                                      title: formatDramaTitle(ep.title),
                                      source: "offline",
                                      startEp: ep.episode,
                                    });
                                  }
                                }}
                                className="w-[104px] shrink-0 snap-start flex flex-col gap-1 cursor-pointer pressable active:scale-95 transition-all"
                              >
                                <div className="w-full aspect-[16/10] rounded-lg overflow-hidden relative border border-black/5 bg-slate-200 dark:bg-neutral-800">
                                  {(() => {
                                    const coverSrc = getOfflineCoverUrl(ep, 160);
                                    return coverSrc ? (
                                      <img
                                        src={coverSrc}
                                        alt=""
                                        className="w-full h-full object-cover"
                                        loading="lazy"
                                        onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                                      />
                                    ) : null;
                                  })()}
                                  <div className="absolute bottom-1 right-1 w-4 h-4 rounded-full bg-[#10b981] text-white flex items-center justify-center shadow-xs">
                                    <ICheck size={9} strokeWidth={3.5} />
                                  </div>
                                  {selectMode && (
                                    <div className="absolute top-1 left-1 w-4 h-4 rounded-md border border-white bg-black/40 flex items-center justify-center">
                                      {isChecked && <ICheck size={10} className="text-white" strokeWidth={3} />}
                                    </div>
                                  )}
                                </div>
                                <div className="text-[11.5px] font-bold text-[#0f172a] dark:text-neutral-100 truncate">
                                  Ep. {ep.episode}
                                </div>
                                <div className="text-[10px] text-[#64748b] dark:text-neutral-400 tabular-nums">
                                  {epSize}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}

                {/* All Downloads Up to Date banner (Image 2 & 3) */}
                <div className="p-3.5 rounded-2xl bg-gradient-to-r from-blue-50/90 via-white/95 to-blue-50/90 dark:from-blue-950/40 dark:via-neutral-900/95 dark:to-blue-950/40 border border-blue-100 dark:border-blue-500/20 flex items-center gap-3.5 shadow-xs mt-1">
                  <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-[#1a73e8] to-[#38bdf8] text-white flex items-center justify-center shrink-0 shadow-xs">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                      <rect x="3" y="6" width="18" height="14" rx="3" stroke="currentColor" strokeWidth="2" />
                      <path d="M3 11h18" stroke="currentColor" strokeWidth="1.8" />
                      <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" stroke="currentColor" strokeWidth="1.8" />
                      <path d="M12 13.5 L14.5 16 L12 18.5 L9.5 16 Z" fill="white" />
                    </svg>
                  </div>
                  <div>
                    <div className="text-[13.5px] font-bold text-[#0f172a] dark:text-neutral-100">All Downloads Are Up to Date</div>
                    <div className="text-[11.5px] text-[#64748b] dark:text-neutral-400">Enjoy your offline content!</div>
                  </div>
                </div>

                {/* Bottom spacing handled by scroll container */}
              </div>
            ) : (
              <div className="p-8 text-center flex flex-col items-center justify-center gap-2 bg-white/80 dark:bg-neutral-900/80 rounded-2xl border border-white/60 dark:border-white/10 shadow-xs">
                <div className="text-[14px] font-bold text-[#0f172a] dark:text-neutral-100">
                  {downloadSearchQuery.trim() ? "No matches found" : "No series available"}
                </div>
                <div className="text-[12px] text-[#64748b] dark:text-neutral-400">
                  {downloadSearchQuery.trim()
                    ? `No downloaded shows match "${downloadSearchQuery}"`
                    : "No downloads match the current filter"}
                </div>
                {downloadSearchQuery.trim() && (
                  <button
                    type="button"
                    onClick={() => setDownloadSearchQuery("")}
                    className="mt-2 px-4 py-1.5 rounded-full bg-blue-50 dark:bg-blue-500/20 text-[12px] font-bold text-[#1a73e8] dark:text-blue-400 pressable hover:bg-blue-100"
                  >
                    Clear Search
                  </button>
                )}
              </div>
            )}
              </>
            ) : (
              /* Empty Downloads Screen */
              <div className="flex flex-col items-center justify-center py-8 pb-28 px-4 text-center select-none relative a-fade-in">
                {/* Floating graphic with orbital ring and sparkles */}
                <div className="relative mb-5 flex items-center justify-center">
                  {/* Aura blur behind */}
                  <div className="w-32 h-32 rounded-full bg-blue-300/35 blur-2xl absolute inset-0 m-auto pointer-events-none" />

                  {/* Translucent tilted orbital ring */}
                  <div className="w-48 h-24 rounded-[50%] border-2 border-blue-300/40 -rotate-12 absolute pointer-events-none" />

                  {/* Faint floating play circle (left) */}
                  <div className="absolute -left-12 top-1/2 -translate-y-1/2 w-11 h-11 rounded-full bg-blue-100/50 border border-white/70 dark:border-white/10 shadow-sm flex items-center justify-center text-blue-400/60 pointer-events-none">
                    <IPlayF size={12} className="ml-0.5" />
                  </div>

                  {/* Faint floating play circle (right) */}
                  <div className="absolute -right-12 top-1/3 -translate-y-1/2 w-10 h-10 rounded-full bg-blue-100/50 border border-white/70 dark:border-white/10 shadow-sm flex items-center justify-center text-blue-400/60 pointer-events-none">
                    <IPlayF size={11} className="ml-0.5" />
                  </div>

                  {/* 4-point sparkle star (top-left) */}
                  <SparkleStar size={18} className="absolute -top-3 left-1 text-[#38bdf8] pointer-events-none animate-pulse" />

                  {/* 4-point sparkle star (bottom-right) */}
                  <SparkleStar size={14} className="absolute -bottom-2 right-2 text-[#60a5fa] pointer-events-none animate-pulse" />

                  {/* Glowing Blue Folder in Center */}
                  <div className="relative z-10 drop-shadow-xl">
                    <FolderDownloadIcon size={84} />
                  </div>
                </div>

                <h3 className="text-[20px] font-black text-[#0f172a] dark:text-neutral-100 tracking-tight">No Downloads Yet</h3>
                <p className="text-[13.5px] text-[#64748b] dark:text-neutral-400 max-w-xs mt-1.5 leading-relaxed">
                  Download your favorite series and watch them offline anytime!
                </p>
                <div className="flex items-center gap-2.5 mt-6">
                  <button
                    type="button"
                    onClick={() => {
                      setView("overview");
                      setTab("home");
                    }}
                    className="px-6 py-2.5 rounded-full bg-gradient-to-r from-[#1a73e8] to-[#2563eb] hover:from-[#1557b0] hover:to-[#1d4ed8] text-white font-bold text-[13.5px] shadow-md shadow-blue-500/25 pressable active:scale-95 transition-all flex items-center gap-2"
                  >
                    <IDownload size={15} strokeWidth={2.4} />
                    <span>Browse Content</span>
                  </button>
                  {activeDownloads.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setDownloadHubTab("queue")}
                      className="px-5 py-2.5 rounded-full bg-blue-50 dark:bg-blue-500/20 text-[#1a73e8] dark:text-blue-400 font-bold text-[13.5px] pressable active:scale-95 transition-all"
                    >
                      View Queue ({activeDownloads.length})
                    </button>
                  )}
                </div>
              </div>
            )}
              </>
            )}
            {/* Safe bottom spacer */}
            <div className="h-24 sm:h-8 shrink-0 pointer-events-none" aria-hidden="true" />
          </div>
        ) : view === "seriesDetail" && selectedSeriesGroup ? (
          /* =====================================================================
              3. Series Detail View (Image 3 Screen 2)
              ===================================================================== */
          <div className="flex flex-col gap-4 a-rise">
            {/* Top Showcase Hero */}
            <div className="flex items-center gap-3.5 px-0.5">
              <div className="w-16 h-16 rounded-2xl overflow-hidden shrink-0 shadow-md border border-black/5 dark:border-white/10 bg-slate-100 dark:bg-neutral-800">
                {(() => {
                  const coverSrc = getOfflineCoverUrl(selectedSeriesGroup.episodes.find((e) => e.hasLocalCover) || selectedSeriesGroup.episodes[0] || { id: "", cover: selectedSeriesGroup.cover }, 240);
                  return coverSrc ? (
                    <img
                      src={coverSrc}
                      alt=""
                      className="w-full h-full object-cover"
                      onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-slate-400"><ILayers size={22} /></div>
                  );
                })()}
              </div>
              <div className="flex-1 min-w-0">
                <h2 className="text-[19px] font-black text-[#0f172a] dark:text-neutral-100 tracking-tight leading-tight truncate">
                  {formatDramaTitle(selectedSeriesGroup.title)}
                </h2>
                <div className="text-[12.5px] text-[#64748b] dark:text-neutral-400 mt-0.5 tabular-nums">
                  {selectedSeriesGroup.episodes.length} {selectedSeriesGroup.episodes.length === 1 ? "episode" : "episodes"} · {formatBytes(selectedSeriesGroup.totalBytes)}
                </div>
                <div className="flex items-center gap-1.5 mt-1">
                  {(() => {
                    const seriesQueue = activeDownloads.filter((d) => d.videoId === selectedSeriesGroup.videoId);
                    const runningCount = seriesQueue.filter((d) => d.status === "downloading" || d.status === "queued").length;
                    const incompleteCount = seriesQueue.filter((d) => d.status === "error" || d.status === "paused").length;
                    const totalKnown = detailCache[selectedSeriesGroup.videoId]?.episodes?.length || detailCache[selectedSeriesGroup.videoId]?.episode_count || 0;
                    const maxSavedEp = selectedSeriesGroup.episodes.reduce((m, e) => Math.max(m, e.episode), 0);
                    if (runningCount > 0) {
                      return (
                        <span className="inline-flex items-center gap-1 text-[11px] font-bold text-[#1a73e8] dark:text-blue-400">
                          <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
                          <span>Downloading · {selectedSeriesGroup.episodes.length} saved</span>
                        </span>
                      );
                    }
                    if (incompleteCount > 0) {
                      return (
                        <span className="inline-flex items-center gap-1 text-[11px] font-bold text-amber-600 dark:text-amber-400">
                          <span>{selectedSeriesGroup.episodes.length} saved · {incompleteCount} incomplete</span>
                        </span>
                      );
                    }
                    const label =
                      totalKnown > 0 && selectedSeriesGroup.episodes.length < totalKnown
                        ? `${selectedSeriesGroup.episodes.length} of ${totalKnown} Saved Offline`
                        : totalKnown > 0 && selectedSeriesGroup.episodes.length >= totalKnown
                        ? "All Downloaded"
                        : maxSavedEp > selectedSeriesGroup.episodes.length
                        ? `${selectedSeriesGroup.episodes.length} Episodes Saved Offline`
                        : `${selectedSeriesGroup.episodes.length} ${selectedSeriesGroup.episodes.length === 1 ? "Episode" : "Episodes"} Saved Offline`;
                    return (
                      <span className="inline-flex items-center gap-1 text-[11px] font-bold text-[#16a34a] dark:text-emerald-400">
                        <ICheck size={12} strokeWidth={3} />
                        <span>{label}</span>
                      </span>
                    );
                  })()}
                </div>
              </div>
            </div>

            {/* Action Buttons Row */}
            <div className="flex items-center gap-2.5">
              <button
                type="button"
                onClick={() => {
                  if (displayEpisodes[0]) {
                    push({
                      kind: "feed",
                      videoIds: [selectedSeriesGroup.videoId],
                      index: 0,
                      title: formatDramaTitle(selectedSeriesGroup.title),
                      source: "offline",
                      startEp: displayEpisodes[0].episode,
                    });
                  }
                }}
                className="flex-1 h-11 rounded-full bg-[#1a73e8] hover:bg-[#1557b0] text-white font-bold text-[13px] shadow-md flex items-center justify-center gap-2 pressable active:scale-95 transition-all"
              >
                <IPlayF size={12} />
                <span>Play All</span>
              </button>
              <button
                type="button"
                onClick={() => void openSeriesBatchDownloader(selectedSeriesGroup)}
                className="flex-1 h-11 rounded-full bg-white/90 dark:bg-neutral-900/90 border border-slate-200 dark:border-white/15 text-[#1a73e8] dark:text-blue-400 font-bold text-[13px] shadow-xs flex items-center justify-center gap-1.5 pressable active:scale-95 transition-all"
              >
                <IDownload size={14} />
                <span>More Eps</span>
              </button>
              <button
                type="button"
                onClick={() => setConfirmDeleteSeriesOpen(true)}
                className="h-11 px-4 rounded-full bg-white/90 dark:bg-neutral-900/90 border border-slate-200 dark:border-white/15 text-slate-700 dark:text-neutral-300 hover:text-red-500 font-bold text-[13px] shadow-xs flex items-center justify-center gap-1.5 pressable active:scale-95 transition-all"
                aria-label="Delete All"
              >
                <ITrash size={13} />
                <span>Delete</span>
              </button>
            </div>

            {/* Storage Info Banner */}
            <div
              role="button"
              tabIndex={0}
              onClick={() => {
                if (selectedSeriesGroup.episodes.length > 1) {
                  setExportSheetState({
                    isOpen: true,
                    videoId: selectedSeriesGroup.videoId,
                    title: formatDramaTitle(selectedSeriesGroup.title),
                    batchItems: selectedSeriesGroup.episodes.map((e) => ({
                      videoId: e.videoId,
                      episode: e.episode,
                      title: e.title,
                    })),
                  });
                } else {
                  openSingleExport(
                    selectedSeriesGroup.videoId,
                    selectedSeriesGroup.episodes[0]?.episode || 1,
                    selectedSeriesGroup.title
                  );
                }
              }}
              className="p-3 rounded-2xl bg-white/90 dark:bg-neutral-900/90 border border-slate-200/80 dark:border-white/10 flex items-center justify-between text-[12px] text-[#64748b] dark:text-neutral-400 shadow-xs cursor-pointer pressable hover:bg-white dark:hover:bg-neutral-800 active:scale-[0.99] transition-all"
            >
              <div className="flex items-center gap-2.5 font-medium">
                <div className="w-5 h-5 rounded-md bg-[#1a73e8]/15 text-[#1a73e8] dark:text-blue-400 flex items-center justify-center shrink-0">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" />
                  </svg>
                </div>
                <span className="text-[#334155] dark:text-neutral-200 font-semibold">
                  Downloaded on: {selectedSeriesGroup.episodes[0]?.downloadedAt ? new Date(selectedSeriesGroup.episodes[0].downloadedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "Recently"} · {(selectedSeriesGroup.totalBytes / (1024 * 1024 * 1024) >= 1 ? `${(selectedSeriesGroup.totalBytes / (1024 * 1024 * 1024)).toFixed(1)} GB` : `${(selectedSeriesGroup.totalBytes / (1024 * 1024)).toFixed(0)} MB`)}
                </span>
              </div>
              <IChevR size={13} className="text-slate-400" />
            </div>

            {/* Episodes List Header */}
            <div className="flex items-center justify-between px-1 mt-1">
              <h3 className="text-[15px] font-bold text-[#0f172a] dark:text-neutral-100">
                Episodes ({selectedSeriesGroup.episodes.length})
              </h3>
              <button
                type="button"
                onClick={() => setEpisodeOrder((prev) => (prev === "asc" ? "desc" : "asc"))}
                className="flex items-center gap-1 text-[12px] font-semibold text-[#64748b] dark:text-neutral-400 hover:text-[#1a73e8] pressable active:scale-95 transition-all"
              >
                <span>Sort</span>
                <IChevronDown size={12} className={episodeOrder === "desc" ? "rotate-180 transition-transform" : "transition-transform"} />
              </button>
            </div>

            {/* Episodes Vertical List */}
            <div className="flex flex-col gap-2.5">
              {displayEpisodes.map((item) => {
                const epMB = (item.sizeBytes / (1024 * 1024)).toFixed(1);
                return (
                  <div
                    key={item.id}
                    role="button"
                    tabIndex={0}
                    onClick={() =>
                      push({
                        kind: "feed",
                        videoIds: [item.videoId],
                        index: 0,
                        title: formatDramaTitle(item.title),
                        source: "offline",
                        startEp: item.episode,
                      })
                    }
                    className="p-3 rounded-2xl bg-white/90 dark:bg-neutral-900/90 backdrop-blur-md border border-white/70 dark:border-white/10 shadow-xs flex items-center gap-3 cursor-pointer pressable active:scale-[0.99] transition-all"
                  >
                    <div className="w-20 aspect-[16/10] rounded-xl overflow-hidden relative border border-black/5 bg-slate-200 dark:bg-neutral-800 shrink-0">
                      {(() => {
                        const coverSrc = getOfflineCoverUrl(item, 160);
                        return coverSrc ? (
                          <img
                            src={coverSrc}
                            alt=""
                            className="w-full h-full object-cover"
                            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                          />
                        ) : null;
                      })()}
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="text-[14px] font-bold text-[#0f172a] dark:text-neutral-100 truncate">
                        Episode {item.episode}
                      </div>
                      <div className="text-[11.5px] text-[#64748b] dark:text-neutral-400 mt-0.5 tabular-nums flex items-center gap-1.5 whitespace-nowrap overflow-hidden">
                        <span className="w-3.5 h-3.5 rounded-full bg-[#10b981] text-white flex items-center justify-center shrink-0">
                          <ICheck size={8} strokeWidth={3.5} />
                        </span>
                        <span className="font-semibold text-slate-700 dark:text-neutral-200 shrink-0">{epMB} MB</span>
                        <span className="truncate">· Downloaded</span>
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      <div className="w-8 h-8 rounded-full bg-[#e0edff] dark:bg-blue-500/20 text-[#1a73e8] dark:text-blue-400 flex items-center justify-center">
                        <IPlayF size={10} />
                      </div>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirmDeleteEp({ videoId: item.videoId, episode: item.episode });
                        }}
                        className="w-8 h-8 rounded-full flex items-center justify-center text-slate-400 hover:text-red-500 hover:bg-red-500/10 pressable transition-colors"
                        aria-label="Delete Episode"
                        title="Delete Episode"
                      >
                        <ITrash size={13} />
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          openSingleExport(item.videoId, item.episode, item.title);
                        }}
                        className="w-8 h-8 rounded-full flex items-center justify-center text-slate-400 hover:text-slate-600 dark:hover:text-neutral-200 hover:bg-slate-200/50 dark:hover:bg-white/10 pressable"
                        aria-label="Episode options"
                      >
                        <IMore size={14} className="rotate-90" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : loading ? (
          <div className="flex justify-center py-16">
            <Loader className="w-8 h-8 spinner text-[#1a73e8]" />
          </div>
        ) : cards.length ? (
          /* =====================================================================
              4. Media Grid View (Favorites, Watch Later, History Subviews)
              ===================================================================== */
          <div className="flex flex-col gap-2.5 a-rise">
            {(view === "favs" || view === "watchlater") && cards.length > 1 && (
              <div className="flex flex-wrap items-center justify-between gap-2 px-1 mb-1.5">
                <div className="flex items-center gap-1.5">
                  <span className="text-[12px] font-semibold text-[#64748b] dark:text-neutral-400">Status:</span>
                  <div className="inline-flex rounded-full bg-slate-200/60 dark:bg-white/10 p-0.5 text-[12px]">
                    {([
                      { id: "all", label: `All (${statusCounts.all})` },
                      { id: "ongoing", label: `In-Progress (${statusCounts.ongoing})` },
                      { id: "finished", label: `Finished (${statusCounts.finished})` },
                    ] as const).map((st) => (
                      <button
                        key={st.id}
                        type="button"
                        aria-pressed={favStatusFilter === st.id}
                        onClick={() => setFavStatusFilter(st.id)}
                        className={`px-2.5 py-1 rounded-full text-[11px] font-semibold transition-all pressable ${
                          favStatusFilter === st.id
                            ? "bg-primary text-on-primary shadow-xs"
                            : "text-[#64748b] dark:text-neutral-400 hover:text-[#0f172a] dark:hover:text-white"
                        }`}
                      >
                        {st.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-[12px] font-semibold text-[#64748b] dark:text-neutral-400">Sort:</span>
                  <div className="inline-flex rounded-full bg-slate-200/60 dark:bg-white/10 p-0.5 text-[12px]">
                    {([
                      { id: "recent", label: "Recent" },
                      { id: "finished", label: "Finished First" },
                      { id: "episodes", label: "Episodes" },
                    ] as const).map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        aria-pressed={favSort === s.id}
                        onClick={() => setFavSort(s.id)}
                        className={`px-2.5 py-1 rounded-full text-[11px] font-semibold transition-all pressable ${
                          favSort === s.id
                            ? "bg-primary text-on-primary shadow-xs"
                            : "text-[#64748b] dark:text-neutral-400 hover:text-[#0f172a] dark:hover:text-white"
                        }`}
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
            <div className={`ios-media-grid ${wide ? "is-wide" : ""}`}>
              {displayedCards.map((c) => {
                const progress = progressOf(c.id);
                return (
                  <div key={c.id} className="relative group">
                    <MediaCard
                      title={c.title}
                      cover={c.cover}
                      score={c.score}
                      badge={c.is_finished ? "Finished" : `${c.episode_count} eps`}
                      isFinished={c.is_finished}
                      subtitle={c.tags?.slice(0, 2).map(formatDramaTag).join(" · ")}
                      progress={progress ? `Ep. ${progress.ep} · ${fmtTime(progress.t)}` : undefined}
                      onOpen={() =>
                        push({
                          kind: "feed",
                          videoIds: displayedCards.map((x) => x.id),
                          index: displayedCards.findIndex((x) => x.id === c.id),
                          title:
                            view === "favs"
                              ? t("profile.favorites")
                              : view === "watchlater"
                              ? t("profile.watch_later")
                              : t("profile.history"),
                          startEp: progress?.ep,
                          startTime: progress?.t,
                        })
                      }
                    />
                    <button
                      type="button"
                      aria-label={`Remove ${formatDramaTitle(c.title)}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (view === "favs") {
                          toggleFavLocal(c.id);
                          toast("Removed from favorites", "info");
                        } else if (view === "watchlater") {
                          toggleWatchLaterLocal(c.id);
                          toast("Removed from Watch Later", "info");
                        } else if (view === "history") {
                          removeHistory(c.id);
                          toast("Removed from watch history", "info");
                        }
                      }}
                      className={`absolute ${Number(c.score) > 0 ? "top-11" : "top-2.5"} right-2.5 z-10 w-6 h-6 rounded-full bg-black/65 hover:bg-red-500/90 text-white flex items-center justify-center shadow-sm pressable transition-colors`}
                    >
                      <IClose size={11} />
                    </button>
                  </div>
                );
              })}
            </div>
            {subviewIds.length > subviewLimit && (
              <div className="flex justify-center py-3">
                <Button
                  onClick={() => setSubviewLimit((n) => n + 32)}
                  className="px-5 h-9 rounded-full bg-s2 border border-edge/40 text-[12.5px] font-semibold text-on hover:bg-s3 pressable"
                >
                  Load More ({subviewIds.length - subviewLimit} remaining)
                </Button>
              </div>
            )}
          </div>
        ) : (
          <Empty
            icon={
              view === "favs" ? (
                <IStar size={24} />
              ) : view === "watchlater" ? (
                <IClock size={24} />
              ) : (
                <IHist size={24} />
              )
            }
            title={
              view === "favs"
                ? t("profile.no_favs")
                : view === "watchlater"
                ? t("profile.no_watch_later")
                : t("profile.no_hist")
            }
            sub={
              view === "favs"
                ? t("profile.no_favs_sub")
                : view === "watchlater"
                ? t("profile.no_watch_later_sub")
                : t("profile.no_hist_sub")
            }
            action={t("profile.explore")}
            onAction={() => push({ kind: "ranks" })}
          />
        )}
        </div>
      </div>

      {/* =========================================================================
          Multi-Select Bottom Action Bar (Image 3 Screen 3)
          ========================================================================= */}
      {selectMode && (
        <div
          className="fixed inset-x-5 z-[70] bg-white dark:bg-neutral-900 border border-slate-200/90 dark:border-white/15 rounded-full px-5 py-2.5 flex items-center justify-around shadow-[0_12px_36px_rgba(15,23,42,0.18)] a-rise"
          style={{ bottom: "calc(var(--sab, 0px) + 20px)" }}
        >
          <button
            type="button"
            onClick={playSelected}
            disabled={selectedKeys.size === 0}
            className="flex items-center gap-2 text-[13px] font-bold text-[#0f172a] dark:text-neutral-100 disabled:opacity-40 pressable active:scale-95"
          >
            <IPlayF size={13} className="text-[#1a73e8] dark:text-blue-400" />
            <span>Play</span>
          </button>
          <div className="w-[1px] h-4 bg-slate-200 dark:bg-white/15" />
          <button
            type="button"
            onClick={deleteSelected}
            disabled={selectedKeys.size === 0}
            className="flex items-center gap-2 text-[13px] font-bold text-[#0f172a] dark:text-neutral-100 hover:text-red-600 disabled:opacity-40 pressable active:scale-95"
          >
            <ITrash size={14} className="text-slate-600 dark:text-neutral-300" />
            <span>Delete</span>
          </button>
          <div className="w-[1px] h-4 bg-slate-200 dark:bg-white/15" />
          <button
            type="button"
            onClick={openExportSelected}
            disabled={selectedKeys.size === 0}
            className="flex items-center gap-1.5 text-[13px] font-bold text-[#0f172a] dark:text-neutral-100 disabled:opacity-40 pressable active:scale-95"
          >
            <span>More</span>
            <IChevronDown size={13} className="text-slate-600 dark:text-neutral-300" />
          </button>
        </div>
      )}

      {/* Confirmation Modal: Clear All Downloads */}
      <Modal
        open={confirmClearAllOpen}
        onClose={() => setConfirmClearAllOpen(false)}
        label={t("profile.confirm_clear_title")}
      >
        <div className="p-5 flex flex-col gap-3 text-center">
          <div className="w-12 h-12 rounded-full bg-red-500/15 text-red-500 mx-auto flex items-center justify-center">
            <ITrash size={22} />
          </div>
          <div className="text-[16px] font-bold text-[#0f172a] dark:text-neutral-100">{t("profile.confirm_clear_title")}</div>
          <div className="text-[13px] text-[#64748b] dark:text-neutral-400 leading-relaxed">
            {t("profile.confirm_clear_desc")}
          </div>
          <div className="flex items-center gap-2.5 mt-2">
            <Button
              onClick={() => setConfirmClearAllOpen(false)}
              className="flex-1 h-9 rounded-xl bg-slate-100 dark:bg-neutral-800 hover:bg-slate-200 dark:hover:bg-neutral-700 text-[#0f172a] dark:text-neutral-100 text-[13px] font-medium pressable"
            >
              {t("common.cancel")}
            </Button>
            <Button
              onClick={async () => {
                setConfirmClearAllOpen(false);
                await clearAllOfflineDownloads();
                setDownloads([]);
                void getDetailedStorageStats().then(setStorageStats);
                toast("All offline downloads removed", "ok");
              }}
              className="flex-1 h-9 rounded-xl bg-red-500 text-white text-[13px] font-bold pressable"
            >
              {t("profile.clear_all")}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Confirmation Modal: Delete Series */}
      <Modal
        open={confirmDeleteSeriesOpen}
        onClose={() => setConfirmDeleteSeriesOpen(false)}
        label="Delete Series"
      >
        <div className="p-4 flex flex-col gap-3 text-center">
          <div className="w-12 h-12 rounded-full bg-red-100 dark:bg-red-500/20 text-red-500 mx-auto flex items-center justify-center">
            <ITrash size={22} />
          </div>
          <div>
            <h3 className="text-[16px] font-bold text-[#0f172a] dark:text-neutral-100">
              Delete {selectedSeriesGroup ? formatDramaTitle(selectedSeriesGroup.title) : "Series"}?
            </h3>
            <p className="text-[12.5px] text-[#64748b] dark:text-neutral-400 mt-1 leading-normal">
              This will remove all {selectedSeriesGroup?.episodes.length} downloaded episodes from your device.
            </p>
          </div>
          <div className="flex items-center gap-2.5 mt-2">
            <Button
              onClick={() => setConfirmDeleteSeriesOpen(false)}
              className="flex-1 h-9 rounded-xl bg-slate-100 dark:bg-neutral-800 hover:bg-slate-200 dark:hover:bg-neutral-700 text-[#0f172a] dark:text-neutral-100 text-[13px] font-medium pressable"
            >
              {t("common.cancel")}
            </Button>
            <Button
              onClick={async () => {
                if (selectedSeriesGroup) {
                  setConfirmDeleteSeriesOpen(false);
                  await deleteOfflineEpisodesBatch(selectedSeriesGroup.episodes);
                  setDownloads(getOfflineEpisodes());
                  void getDetailedStorageStats().then(setStorageStats);
                  toast(`Deleted ${selectedSeriesGroup.title}`, "ok");
                  setView("downloads");
                }
              }}
              className="flex-1 h-9 rounded-xl bg-red-500 text-white text-[13px] font-bold pressable"
            >
              Delete
            </Button>
          </div>
        </div>
      </Modal>

      {/* Delete Single Episode Confirmation Modal */}
      <Modal
        open={confirmDeleteEp !== null}
        onClose={() => setConfirmDeleteEp(null)}
        label="Delete Episode"
      >
        <div className="p-4 flex flex-col gap-3 text-center">
          <div className="w-12 h-12 rounded-full bg-red-500/15 text-red-500 mx-auto flex items-center justify-center">
            <ITrash size={22} />
          </div>
          <div>
            <h3 className="text-[16px] font-bold text-[#0f172a] dark:text-neutral-100">
              Delete Episode {confirmDeleteEp?.episode ?? ""}?
            </h3>
            <p className="text-[12.5px] text-[#64748b] dark:text-neutral-400 mt-1">
              This will remove the downloaded episode from offline device storage.
            </p>
          </div>
          <div className="flex gap-2.5 mt-1">
            <Button
              onClick={() => setConfirmDeleteEp(null)}
              className="flex-1 h-9 rounded-xl bg-slate-100 dark:bg-neutral-800 text-[13px] font-semibold text-[#0f172a] dark:text-neutral-100 pressable"
            >
              Cancel
            </Button>
            <Button
              onClick={async () => {
                const target = confirmDeleteEp;
                setConfirmDeleteEp(null);
                if (!target) return;
                await deleteOfflineEpisode(target.videoId, target.episode);
                setDownloads(getOfflineEpisodes());
                void getDetailedStorageStats().then(setStorageStats);
                toast(`Deleted Episode ${target.episode}`, "ok");
              }}
              className="flex-1 h-9 rounded-xl bg-red-500 text-white text-[13px] font-bold pressable"
            >
              Delete
            </Button>
          </div>
        </div>
      </Modal>

      {/* Manage Downloads & Storage Modal */}
      <Modal
        open={manageStorageOpen}
        onClose={() => setManageStorageOpen(false)}
        label="Manage Downloads"
      >
        <div className="p-4 flex flex-col gap-3 text-center">
          <div className="w-12 h-12 rounded-full bg-blue-100 dark:bg-blue-500/20 text-[#1a73e8] dark:text-blue-400 mx-auto flex items-center justify-center">
            <ISettings size={22} />
          </div>
          <div>
            <h3 className="text-[16px] font-bold text-[#0f172a] dark:text-neutral-100">
              Manage Downloads
            </h3>
            <p className="text-[12.5px] text-[#64748b] dark:text-neutral-400 mt-0.5">
              {formatBytes(totalDownloadsBytes)} used ({downloads.length} {downloads.length === 1 ? "episode" : "episodes"})
            </p>
          </div>
          <div className="flex flex-col gap-2 text-left bg-slate-50 dark:bg-neutral-800/70 p-3 rounded-2xl border border-slate-200/70 dark:border-white/10">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-[13px] font-bold text-[#0f172a] dark:text-neutral-100">{t("profile.wifi_only")}</div>
                <div className="text-[11px] text-[#64748b] dark:text-neutral-400 leading-tight">{t("profile.wifi_only_desc")}</div>
              </div>
              <Toggle
                label={t("profile.wifi_only")}
                on={wifiOnlyDl}
                onChange={(on) => {
                  setWifiOnlyDl(on);
                  setWifiOnlyDownloadEnabled(on);
                  toast(on ? "Download on Wi-Fi Only enabled" : "Cellular downloads allowed", "info");
                }}
              />
            </div>
            <div className="h-[1px] bg-slate-200/70 dark:bg-white/10" />
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-[13px] font-bold text-[#0f172a] dark:text-neutral-100">{t("profile.auto_dl_next")}</div>
                <div className="text-[11px] text-[#64748b] dark:text-neutral-400 leading-tight">{t("profile.auto_dl_next_desc")}</div>
              </div>
              <Toggle
                label={t("profile.auto_dl_next")}
                on={smartDl}
                onChange={(on) => {
                  setSmartDl(on);
                  setSmartDownloadEnabled(on);
                  toast(on ? "Smart Auto-Download enabled" : "Smart Auto-Download disabled", "info");
                }}
              />
            </div>
          </div>
          <div className="flex flex-col gap-2 mt-1">
            <button
              type="button"
              disabled={downloads.length === 0}
              onClick={() => {
                setManageStorageOpen(false);
                setSelectMode(true);
              }}
              className="w-full h-10 rounded-xl bg-slate-100 dark:bg-neutral-800 hover:bg-slate-200 dark:hover:bg-neutral-700 text-[#0f172a] dark:text-neutral-100 text-[13px] font-semibold flex items-center justify-center gap-2 pressable disabled:opacity-40"
            >
              <ICheck size={14} />
              <span>Select Episodes to Delete</span>
            </button>
            <button
              type="button"
              disabled={downloads.length === 0}
              onClick={() => {
                setManageStorageOpen(false);
                setConfirmClearAllOpen(true);
              }}
              className="w-full h-10 rounded-xl bg-red-50 dark:bg-red-500/15 hover:bg-red-100 dark:hover:bg-red-500/25 text-red-600 dark:text-red-400 text-[13px] font-semibold flex items-center justify-center gap-2 pressable disabled:opacity-40"
            >
              <ITrash size={14} />
              <span>Clear All Offline Downloads</span>
            </button>
            <button
              type="button"
              onClick={() => setManageStorageOpen(false)}
              className="w-full h-9 rounded-xl border border-slate-200 dark:border-white/15 text-[#64748b] dark:text-neutral-400 text-[12.5px] font-medium pressable"
            >
              Cancel
            </button>
          </div>
        </div>
      </Modal>

      {/* Series Options Menu Modal */}
      <Modal
        open={seriesMenuOpen}
        onClose={() => setSeriesMenuOpen(false)}
        label="Series Options"
      >
        <div className="p-4 flex flex-col gap-3 text-center">
          <div className="w-12 h-12 rounded-full bg-blue-100 dark:bg-blue-500/20 text-[#1a73e8] dark:text-blue-400 mx-auto flex items-center justify-center">
            <ILayers size={22} />
          </div>
          <div>
            <h3 className="text-[16px] font-bold text-[#0f172a] dark:text-neutral-100">
              {selectedSeriesGroup ? formatDramaTitle(selectedSeriesGroup.title) : "Series Options"}
            </h3>
            <p className="text-[12.5px] text-[#64748b] dark:text-neutral-400 mt-0.5">
              {selectedSeriesGroup?.episodes.length} episodes offline
            </p>
          </div>
          <div className="flex flex-col gap-2 mt-1">
            <button
              type="button"
              onClick={() => {
                setSeriesMenuOpen(false);
                if (selectedSeriesGroup && selectedSeriesGroup.episodes[0]) {
                  push({
                    kind: "feed",
                    videoIds: [selectedSeriesGroup.videoId],
                    index: 0,
                    title: formatDramaTitle(selectedSeriesGroup.title),
                    source: "offline",
                    startEp: selectedSeriesGroup.episodes[0].episode,
                  });
                }
              }}
              className="w-full h-10 rounded-xl bg-[#1a73e8] hover:bg-[#1557b0] text-white text-[13px] font-semibold flex items-center justify-center gap-2 pressable"
            >
              <IPlayF size={12} />
              <span>Play All Episodes</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setSeriesMenuOpen(false);
                if (selectedSeriesGroup) {
                  void openSeriesBatchDownloader(selectedSeriesGroup);
                }
              }}
              className="w-full h-10 rounded-xl bg-slate-100 dark:bg-neutral-800 hover:bg-slate-200 dark:hover:bg-neutral-700 text-[#0f172a] dark:text-neutral-100 text-[13px] font-semibold flex items-center justify-center gap-2 pressable"
            >
              <IDownload size={14} />
              <span>Download More Episodes</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setSeriesMenuOpen(false);
                if (selectedSeriesGroup) {
                  setExportSheetState({
                    isOpen: true,
                    videoId: selectedSeriesGroup.videoId,
                    title: formatDramaTitle(selectedSeriesGroup.title),
                    batchItems: selectedSeriesGroup.episodes.map((e) => ({
                      videoId: e.videoId,
                      episode: e.episode,
                      title: e.title,
                    })),
                  });
                }
              }}
              className="w-full h-10 rounded-xl bg-slate-100 dark:bg-neutral-800 hover:bg-slate-200 dark:hover:bg-neutral-700 text-[#0f172a] dark:text-neutral-100 text-[13px] font-semibold flex items-center justify-center gap-2 pressable"
            >
              <IExport size={14} />
              <span>Export All Episodes (MP4)</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setSeriesMenuOpen(false);
                setConfirmDeleteSeriesOpen(true);
              }}
              className="w-full h-10 rounded-xl bg-red-50 dark:bg-red-500/15 hover:bg-red-100 dark:hover:bg-red-500/25 text-red-600 dark:text-red-400 text-[13px] font-semibold flex items-center justify-center gap-2 pressable"
            >
              <ITrash size={14} />
              <span>Delete Entire Series</span>
            </button>
            <button
              type="button"
              onClick={() => setSeriesMenuOpen(false)}
              className="w-full h-9 rounded-xl border border-slate-200 dark:border-white/15 text-[#64748b] dark:text-neutral-400 text-[12.5px] font-medium pressable"
            >
              Cancel
            </button>
          </div>
        </div>
      </Modal>

      {/* My Library Overview Modal */}
      <Modal
        open={libraryInfoOpen}
        onClose={() => setLibraryInfoOpen(false)}
        label="Account & Library"
      >
        <div className="p-4 flex flex-col gap-3.5 text-center">
          {/* Unified Profile Header */}
          <div className="flex items-center gap-3.5 p-3 rounded-2xl bg-s2/90 border border-edge/30 text-left">
            <div className="relative shrink-0">
              <div className="w-12 h-12 rounded-full bg-gradient-to-tr from-[#1a73e8] to-[#38bdf8] flex items-center justify-center text-white font-bold text-lg shadow-sm overflow-hidden">
                {user?.avatar ? (
                  <img src={user.avatar} alt={user.nickname || "User"} className="w-full h-full object-cover" />
                ) : user?.nickname ? (
                  user.nickname.slice(0, 1).toUpperCase()
                ) : user?.username ? (
                  user.username.slice(0, 1).toUpperCase()
                ) : (
                  <IUser size={24} />
                )}
              </div>
              <span
                className={`absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-s2 shadow-xs ${
                  user ? "bg-emerald-500" : "bg-amber-500"
                }`}
                title={user ? "Cloud Synced" : "Local Storage"}
              />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[15.5px] font-bold text-on tracking-tight truncate">
                {user ? (user.nickname || user.username || user.desc || "AuraStream User") : "Local Guest"}
              </div>
              <div className="flex items-center gap-1.5 mt-0.5">
                <span className={`w-1.5 h-1.5 rounded-full ${user ? "bg-emerald-500" : "bg-amber-500"}`} />
                <span className="text-[11.5px] font-medium text-mut truncate">
                  {user?.desc || (user ? "Cloud Synced (Firestore)" : "Local Storage Mode")}
                </span>
              </div>
            </div>
          </div>

          {/* Symmetrical 3-Column Library Overview Card */}
          <div className="flex flex-col rounded-2xl bg-s2/90 border border-edge/30 overflow-hidden shadow-xs">
            <div className="grid grid-cols-3 divide-x divide-edge/20 p-2 text-center">
              <div className="flex flex-col items-center justify-center py-2 px-1">
                <span className="text-[10px] font-bold uppercase tracking-wider text-mut">History</span>
                <span className="text-[16px] font-black text-on mt-0.5 tabular-nums">{history.length}</span>
                <span className="text-[9.5px] text-dim">Items</span>
              </div>
              <div className="flex flex-col items-center justify-center py-2 px-1">
                <span className="text-[10px] font-bold uppercase tracking-wider text-mut">Favorites</span>
                <span className="text-[16px] font-black text-on mt-0.5 tabular-nums">
                  {favs.length + (watchLater?.length || 0)}
                </span>
                <span className="text-[9.5px] text-dim">Dramas</span>
              </div>
              <div className="flex flex-col items-center justify-center py-2 px-1">
                <span className="text-[10px] font-bold uppercase tracking-wider text-mut">Downloads</span>
                <span className="text-[16px] font-black text-on mt-0.5 tabular-nums">{downloads.length}</span>
                <span className="text-[9.5px] text-dim">Episodes</span>
              </div>
            </div>
            <div className="bg-s3/60 px-3 py-1.5 border-t border-edge/20 flex items-center justify-between text-[10.5px] text-mut">
              <span>Local Storage Footprint</span>
              <span className="font-mono font-bold text-on">{formatBytes(totalDownloadsBytes)}</span>
            </div>
          </div>

          {/* Cloud Sync Status & Action */}
          <div className="p-3 rounded-2xl bg-s2/90 border border-edge/30 flex items-center justify-between gap-2 text-left">
            <div className="min-w-0 flex-1">
              <div className="text-[12.5px] font-bold text-on flex items-center gap-1.5">
                <span className={`w-2 h-2 rounded-full ${user ? "bg-emerald-500" : "bg-amber-500"}`} />
                <span>{user ? "Cloud Sync Active" : "Local Storage Mode"}</span>
              </div>
              <div className="text-[10.5px] text-mut mt-0.5 truncate">
                {lastSyncedTime ? `Last synced: ${lastSyncedTime}` : user ? "Connected to Firestore" : "Sign in to sync across devices"}
              </div>
            </div>
            {user ? (
              <button
                type="button"
                onClick={handleSyncCloud}
                disabled={syncingCloud}
                className="px-3 py-1.5 rounded-xl bg-primary text-on-primary text-[11.5px] font-bold flex items-center gap-1.5 pressable disabled:opacity-50 shrink-0 shadow-xs"
              >
                <IRefresh size={12} className={syncingCloud ? "animate-spin" : ""} />
                <span>{syncingCloud ? "Syncing..." : "Sync Now"}</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setLibraryInfoOpen(false);
                  setLoginOpen(true);
                }}
                className="px-3 py-1.5 rounded-xl bg-primary text-on-primary text-[11.5px] font-bold pressable shrink-0 shadow-xs"
              >
                Sign In
              </button>
            )}
          </div>

          {/* Backup & Restore Tools */}
          <div className="p-3 rounded-2xl bg-s2/90 border border-edge/30 flex flex-col gap-2 text-left">
            <div className="text-[11px] font-bold uppercase tracking-wider text-mut">
              Backup & Transfer
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={handleExportBackup}
                className="py-2.5 px-3 rounded-xl bg-s1 border border-edge/30 text-[12px] font-bold text-on flex items-center justify-center gap-1.5 pressable shadow-2xs hover:bg-s3"
              >
                <IExport size={13} className="text-primary" />
                <span>Export Backup</span>
              </button>
              <button
                type="button"
                onClick={() => backupInputRef.current?.click()}
                className="py-2.5 px-3 rounded-xl bg-s1 border border-edge/30 text-[12px] font-bold text-on flex items-center justify-center gap-1.5 pressable shadow-2xs hover:bg-s3"
              >
                <IDownload size={13} className="text-emerald-500" />
                <span>Restore Backup</span>
              </button>
            </div>
            <input
              ref={backupInputRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={handleImportBackup}
            />
          </div>

          {/* Symmetrical Action Buttons */}
          <div className="flex flex-col gap-2 mt-0.5">
            {user && (
              <button
                type="button"
                onClick={() => {
                  logout();
                  setLibraryInfoOpen(false);
                }}
                className="w-full h-10 rounded-xl bg-red-500/10 hover:bg-red-500/15 text-red-600 dark:text-red-400 border border-red-500/20 text-[12.5px] font-bold pressable active:scale-95 transition-all"
              >
                Sign Out
              </button>
            )}

            <button
              type="button"
              onClick={() => setLibraryInfoOpen(false)}
              className="w-full h-11 rounded-xl bg-primary text-on-primary hover:bg-primary/95 text-[13.5px] font-bold pressable active:scale-95 transition-all shadow-xs"
            >
              Done
            </button>
          </div>
        </div>
      </Modal>

      {/* Export Sheet */}
      <ExportSheet
        isOpen={exportSheetState.isOpen}
        onClose={() => setExportSheetState((s) => ({ ...s, isOpen: false }))}
        videoId={exportSheetState.videoId}
        episode={exportSheetState.episode}
        title={exportSheetState.title}
        batchEpisodes={exportSheetState.batchEpisodes}
        batchItems={exportSheetState.batchItems}
      />

      {/* Batch Downloader Sheet */}
      <BatchDownloadSheet
        isOpen={batchSheet.isOpen}
        onClose={() => setBatchSheet((s) => ({ ...s, isOpen: false }))}
        videoId={batchSheet.videoId}
        title={batchSheet.title}
        cover={batchSheet.cover}
        totalEpisodes={batchSheet.totalEpisodes}
        episodeNumbers={batchSheet.episodeNumbers}
      />

      {/* In-App Update Modal */}
      <UpdateModal info={updateInfo} onClose={() => setUpdateInfo(null)} />
    </div>
  );
}
