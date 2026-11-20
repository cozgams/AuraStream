import { Button, Surface } from "../components/ios/controls";
import { Loader } from "../components/ios/effects";
import { useEffect, useMemo, useState } from "react";
import { api, APP_VERSION, cover as getCoverUrl, fmtTime, isMobile, platform } from "../api";
import type { Detail } from "../types";
import { useStore } from "../store";
import { Avatar, Empty, Modal } from "../components/ui";
import { MediaCard } from "../components/cards";
import ExportSheet from "../components/ExportSheet";
import { registerOverlayBack } from "../back";
import {
  IBack,
  IBoltF,
  ICheck,
  IChevR,
  IChevronDown,
  IChevronUp,
  IClock,
  IClose,
  IDownload,
  IExport,
  IGrid,
  IHist,
  ILogout,
  IPauseF,
  IPlayF,
  ISearch,
  ISettings,
  IStar,
  IStarF,
  ITrash,
  IUser,
  IUserF,
} from "../icons";
import {
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
  syncOfflineEpisodesFromIndexedDB,
  subscribeBatchProgress,
  cancelBatchDownload,
  getBatchProgress,
  type OfflineEpisode,
  type ActiveDownloadProgress,
  type DeviceStorageStats,
  type BatchProgressState,
} from "../offline/downloadService";
import BatchDownloadSheet from "../components/BatchDownloadSheet";
import { formatDramaTag, formatDramaTitle } from "../subtitles/dramaTranslator";

type DramaGroup = {
  videoId: number;
  title: string;
  cover: string;
  episodes: OfflineEpisode[];
  totalBytes: number;
};

export default function Profile({ wide }: { wide: boolean }) {
  const {
    user,
    setLoginOpen,
    logout,
    history,
    favs,
    clearFavs,
    watchLater,
    clearWatchLater,
    clearHistory,
    push,
    setTab,
    t,
    toast,
  } = useStore();

  // Navigation view:
  // "overview" = AuraStream You Tab
  // "downloads" = Dedicated Offline Hub
  // "seriesDetail" = Single downloaded drama episode list
  // "favs" | "watchlater" | "history" = Dedicated subviews
  const [view, setView] = useState<"overview" | "downloads" | "seriesDetail" | "favs" | "watchlater" | "history">("overview");

  const [cards, setCards] = useState<Detail[]>([]);
  const [downloads, setDownloads] = useState<OfflineEpisode[]>(() => getOfflineEpisodes());
  const [storageStats, setStorageStats] = useState<DeviceStorageStats | null>(null);
  const [batchProgress, setBatchProgress] = useState<BatchProgressState>(getBatchProgress);
  const [activeDownloads, setActiveDownloads] = useState<ActiveDownloadProgress[]>([]);
  const [activeSummary, setActiveSummary] = useState(getActiveDownloadsSummary);
  const [loading, setLoading] = useState(false);
  const [confirmClearAllOpen, setConfirmClearAllOpen] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [collapsedDramas, setCollapsedDramas] = useState<Set<number>>(() => new Set());
  const [selectedSeriesGroup, setSelectedSeriesGroup] = useState<DramaGroup | null>(null);
  const [downloadFilter, setDownloadFilter] = useState<"all" | "series">("all");
  const [downloadSort, setDownloadSort] = useState<"recent" | "size" | "title">("recent");
  const [downloadSearchOpen, setDownloadSearchOpen] = useState(false);
  const [downloadSearchQuery, setDownloadSearchQuery] = useState("");
  const [episodeOrder, setEpisodeOrder] = useState<"asc" | "desc">("asc");
  const [detailCache, setDetailCache] = useState<Record<number, Detail>>({});

  useEffect(() => {
    const needed = history
      .slice(0, 15)
      .filter((h) => !h.cover || !h.title || h.title.startsWith("Drama #"))
      .map((h) => h.id)
      .filter((id) => !detailCache[id]);

    if (!needed.length) return;

    let alive = true;
    Promise.allSettled(needed.slice(0, 10).map((id) => api.video(id)))
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
  }, [history]);

  const [batchSheet, setBatchSheet] = useState<{
    isOpen: boolean;
    videoId: number;
    title: string;
    cover: string;
    totalEpisodes: number;
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
    if (view === "overview") return;
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
  }, [view, selectMode]);

  useEffect(() => {
    document.body.classList.toggle("has-selection-mode", selectMode);
    return () => {
      document.body.classList.remove("has-selection-mode");
    };
  }, [selectMode]);

  useEffect(() => {
    document.body.classList.toggle("has-series-detail", view === "seriesDetail");
    return () => {
      document.body.classList.remove("has-series-detail");
    };
  }, [view]);

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
        const atA = Math.max(...a.episodes.map((e) => e.downloadedAt || 0));
        const atB = Math.max(...b.episodes.map((e) => e.downloadedAt || 0));
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
    const selectedEpisodes = downloads.filter((d) => selectedKeys.has(`${d.videoId}_${d.episode}`));
    if (!selectedEpisodes.length) return;
    const first = selectedEpisodes[0];
    push({
      kind: "feed",
      videoIds: Array.from(new Set(selectedEpisodes.map((e) => e.videoId))),
      index: 0,
      title: formatDramaTitle(first.title),
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

    const unsubBatch = subscribeBatchProgress((state) => {
      setBatchProgress({ ...state });
    });

    window.addEventListener("aurastream:downloads-changed", updateStorage);
    return () => {
      unsubProgress();
      unsubBatch();
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

  // Fetch full cards when in a dedicated subview
  useEffect(() => {
    let alive = true;
    if (view === "overview" || view === "downloads" || view === "seriesDetail" || !subviewIds.length) {
      setCards([]);
      return;
    }
    setLoading(true);
    Promise.allSettled(subviewIds.slice(0, 32).map((id) => api.video(id)))
      .then((rs) => {
        if (!alive) return;
        const fetched = rs
          .filter((r) => r.status === "fulfilled")
          .map((r) => (r as PromiseFulfilledResult<Detail>).value);
        if (view === "history") {
          const map = new Map(fetched.map((c) => [c.id, c]));
          const combined = subviewIds
            .slice(0, 32)
            .map((id) => {
              if (map.has(id)) return map.get(id)!;
              const h = history.find((x) => x.id === id);
              if (h && (h.title || h.cover)) {
                return {
                  id: h.id,
                  title: h.title || `Drama #${h.id}`,
                  cover: h.cover || "",
                  tags: h.tags || [],
                  episode_count: h.episode_count || 1,
                  is_finished: !!h.is_finished,
                } as unknown as Detail;
              }
              return null;
            })
            .filter(Boolean) as Detail[];
          setCards(combined);
        } else {
          setCards(fetched);
        }
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [subviewIds.join(","), view]);

  return (
    <div
      className="ios-page absolute inset-0 flex flex-col select-none overflow-hidden"
      style={{
        background: "#f0f5fc",
        backgroundImage:
          "radial-gradient(ellipse 140% 60% at 85% -10%, rgba(193, 226, 255, 0.75) 0%, rgba(224, 240, 255, 0.35) 45%, transparent 75%), radial-gradient(ellipse 80% 50% at 10% 15%, rgba(210, 235, 255, 0.5) 0%, transparent 60%)",
      }}
    >
      {/* =========================================================================
          Top App Bar
          ========================================================================= */}
      <div
        className="shrink-0 px-4 flex items-center justify-between z-10"
        style={{ paddingTop: "calc(var(--sat, 0px) + 8px)", paddingBottom: "6px" }}
      >
        {view === "overview" ? (
          <>
            <h1 className="text-[24px] font-black tracking-tight text-[#0f172a]">
              Profile
            </h1>
            <button
              type="button"
              onClick={() => push({ kind: "settings" })}
              aria-label={t("settings.title")}
              className="w-9 h-9 rounded-full bg-white/85 border border-white/70 shadow-xs flex items-center justify-center text-[#1e293b] hover:bg-white active:scale-95 transition-all"
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
                  className="w-8 h-8 rounded-full flex items-center justify-center text-[#0f172a] hover:bg-slate-200/60 active:scale-95 transition-all"
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
                  className="w-8 h-8 rounded-full flex items-center justify-center text-[#0f172a] hover:bg-slate-200/60 active:scale-95 transition-all"
                  aria-label="Back to overview"
                >
                  <IBack size={20} strokeWidth={2.4} />
                </button>
              )}
              <h1 className="text-[20px] font-black tracking-tight text-[#0f172a]">
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
                    className="w-8 h-8 rounded-full flex items-center justify-center text-[#1a73e8] hover:bg-blue-50 disabled:opacity-30 pressable active:scale-95 transition-all"
                    title="Play selected"
                  >
                    <IPlayF size={15} />
                  </button>
                  <button
                    type="button"
                    onClick={deleteSelected}
                    disabled={selectedKeys.size === 0}
                    className="w-8 h-8 rounded-full flex items-center justify-center text-red-500 hover:bg-red-50 disabled:opacity-30 pressable active:scale-95 transition-all"
                    title="Delete selected"
                  >
                    <ITrash size={15} />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (selectedKeys.size === downloads.length) setSelectedKeys(new Set());
                      else setSelectedKeys(new Set(downloads.map((d) => `${d.videoId}_${d.episode}`)));
                    }}
                    className="w-8 h-8 rounded-full flex items-center justify-center text-[#0f172a] hover:bg-slate-200/60 pressable font-bold"
                    title={selectedKeys.size === downloads.length ? "Deselect All" : "Select All"}
                  >
                    ⋮
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
                      downloadSearchOpen ? "bg-blue-100 text-[#1a73e8]" : "text-[#0f172a] hover:bg-slate-200/60"
                    }`}
                    aria-label="Search downloads"
                  >
                    <ISearch size={18} />
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectMode(true)}
                    className="w-8 h-8 rounded-full flex items-center justify-center text-[#0f172a] hover:bg-slate-200/60 pressable font-bold"
                    aria-label="Select mode"
                  >
                    ⋮
                  </button>
                </>
              )}
            </div>
          </>
        ) : view === "seriesDetail" && selectedSeriesGroup ? (
          <>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setView("downloads")}
                className="w-8 h-8 rounded-full flex items-center justify-center text-[#0f172a] hover:bg-slate-200/60 active:scale-95 transition-all"
              >
                <IBack size={20} strokeWidth={2.4} />
              </button>
              <h1 className="text-[18px] font-black tracking-tight text-[#0f172a] truncate max-w-[200px]">
                {formatDramaTitle(selectedSeriesGroup.title)}
              </h1>
            </div>

            <button
              type="button"
              onClick={() => openSingleExport(selectedSeriesGroup.videoId, selectedSeriesGroup.episodes[0]?.episode || 1, selectedSeriesGroup.title)}
              className="w-8 h-8 rounded-full flex items-center justify-center text-[#0f172a] hover:bg-slate-200/60 pressable font-bold"
            >
              ⋮
            </button>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setView("overview")}
                className="w-8 h-8 rounded-full flex items-center justify-center text-[#0f172a] hover:bg-slate-200/60 active:scale-95 transition-all"
                aria-label="Back to Overview"
              >
                <IBack size={20} strokeWidth={2.4} />
              </button>
              <h1 className="text-[19px] font-black tracking-tight text-[#0f172a]">
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

      {/* =========================================================================
          Main Body Content
          ========================================================================= */}
      <div
        className="ios-page-body flex-1 scroll-y px-4 pt-0"
        style={{ paddingBottom: "calc(var(--sab, 48px) + 84px)" }}
      >
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
                if (!user) setLoginOpen(true);
                else push({ kind: "user", id: user.id, name: user.nickname });
              }}
              className="bg-white/85 backdrop-blur-md rounded-2xl border border-white/70 shadow-[0_4px_20px_-2px_rgba(20,45,85,0.06)] p-2 flex items-center gap-3 cursor-pointer pressable active:scale-[0.99] transition-all"
            >
              <div className="relative shrink-0">
                <div className="w-11 h-11 rounded-full bg-gradient-to-tr from-[#1a73e8] to-[#38bdf8] flex items-center justify-center text-white shadow-sm overflow-hidden">
                  {user?.avatar ? (
                    <img src={user.avatar} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <IUser size={22} />
                  )}
                </div>
                <span
                  className="absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full bg-[#22c55e] border-2 border-white shadow-xs"
                  title="Local Active"
                />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <h2 className="text-[15.5px] font-bold text-[#0f172a] tracking-tight truncate">
                    {user ? user.nickname : "My Library"}
                  </h2>
                  <IChevR size={14} className="text-slate-400 shrink-0" strokeWidth={2.5} />
                </div>
                <div className="text-[11px] text-[#64748b] truncate mt-0.5">
                  {user ? `@${user.username}` : "Local Library · Tap to sign in"}
                </div>
              </div>
            </div>

            {/* History Shelf */}
            <div className="flex flex-col gap-1 mt-0.5">
              <div className="flex items-center justify-between px-1">
                <div className="flex items-center gap-2">
                  <div className="w-5 h-5 rounded-full bg-blue-100/70 text-[#1a73e8] flex items-center justify-center shrink-0">
                    <IHist size={12} strokeWidth={2.4} />
                  </div>
                  <span className="text-[14.5px] font-bold text-[#0f172a] tracking-tight">
                    History {history.length > 0 && `(${history.length})`}
                  </span>
                </div>
                {history.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setView("history")}
                    className="text-[11.5px] font-bold text-[#1a73e8] hover:text-[#1557b0] flex items-center gap-0.5 pressable"
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
                        className="w-28 shrink-0 flex flex-col cursor-pointer pressable active:scale-[0.98] transition-transform"
                      >
                        <div className="w-full h-[72px] rounded-xl overflow-hidden relative shadow-xs border border-slate-200/60 bg-slate-100">
                          {coverUrl ? (
                            <img
                              src={getCoverUrl(coverUrl, 240)}
                              alt=""
                              className="w-full h-full object-cover"
                              loading="lazy"
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center bg-slate-100 text-slate-400">
                              <IHist size={18} />
                            </div>
                          )}

                          {/* Blue Progress Bar along Bottom */}
                          {progressPct > 0 && (
                            <div className="absolute bottom-0 inset-x-0 h-1 bg-black/40 overflow-hidden">
                              <div
                                className="h-full bg-[#2563eb] rounded-full transition-all duration-300"
                                style={{ width: `${progressPct}%` }}
                              />
                            </div>
                          )}

                          {/* Top-Right Duration Pill */}
                          <div className="absolute top-1 right-1 px-1.5 py-0.5 rounded-full bg-black/60 backdrop-blur-xs text-[8.5px] font-bold text-white shadow-xs">
                            Ep. {h.ep}{h.t > 0 ? ` · ${fmtTime(h.t)}` : ""}
                          </div>
                        </div>

                        <div className="text-[11.5px] font-bold text-[#0f172a] truncate mt-1">
                          {dramaTitle}
                        </div>
                        <div className="text-[10px] text-[#64748b] truncate">
                          {isFinished ? "Ended" : `${epCount} ${epCount === 1 ? "ep" : "eps"}`} · Ep. {h.ep}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="p-3 rounded-2xl bg-white/70 border border-white/60 text-center flex flex-col items-center justify-center gap-1 shadow-xs">
                  <div className="text-[12px] font-semibold text-[#0f172a]">{t("profile.no_hist")}</div>
                  <div className="text-[10.5px] text-[#64748b]">{t("profile.no_hist_sub")}</div>
                </div>
              )}
            </div>

            {/* Playlists Shelf */}
            <div className="flex flex-col gap-1 mt-0.5">
              <div className="flex items-center justify-between px-1">
                <div className="flex items-center gap-2">
                  <div className="w-5 h-5 rounded-full bg-blue-100/70 text-[#1a73e8] flex items-center justify-center shrink-0">
                    <IStarF size={12} />
                  </div>
                  <span className="text-[14.5px] font-bold text-[#0f172a] tracking-tight">Playlists</span>
                </div>
                <button
                  type="button"
                  onClick={() => setView("favs")}
                  className="text-[11.5px] font-bold text-[#1a73e8] hover:text-[#1557b0] flex items-center gap-0.5 pressable"
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
                  className="h-[70px] rounded-2xl overflow-hidden relative shadow-sm border border-white/60 p-2 flex flex-col justify-between cursor-pointer pressable active:scale-[0.98] transition-transform"
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
                    <span className="text-white/80 font-bold text-[11px] leading-none">⋮</span>
                  </div>

                  <div className="flex items-end justify-between z-10">
                    <div>
                      <div className="text-white font-bold text-[12px] leading-tight">Favorites</div>
                      <div className="text-white/80 text-[9.5px] mt-0.5">
                        {favs.length} {favs.length === 1 ? "drama" : "dramas"}
                      </div>
                    </div>
                    <div className="px-1.5 py-0.5 rounded-full bg-black/40 backdrop-blur-xs text-white text-[9px] font-bold flex items-center gap-1 shadow-xs">
                      <span>★</span>
                      <span>{favs.length}</span>
                    </div>
                  </div>
                </div>

                {/* Watch Later Starry Night Sky Card */}
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => setView("watchlater")}
                  className="h-[70px] rounded-2xl overflow-hidden relative shadow-sm border border-white/60 p-2 flex flex-col justify-between cursor-pointer pressable active:scale-[0.98] transition-transform"
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
                    <span className="text-white/80 font-bold text-[11px] leading-none">⋮</span>
                  </div>

                  <div className="flex items-end justify-between z-10">
                    <div>
                      <div className="text-white font-bold text-[12px] leading-tight">Watch Later</div>
                      <div className="text-white/80 text-[9.5px] mt-0.5">
                        {watchLater?.length || 0} {(watchLater?.length || 0) === 1 ? "drama" : "dramas"}
                      </div>
                    </div>
                    <div className="px-1.5 py-0.5 rounded-full bg-black/40 backdrop-blur-xs text-white text-[9px] font-bold flex items-center gap-1 shadow-xs">
                      <span>🕒</span>
                      <span>{watchLater?.length || 0}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Downloads Card with Storage Bar */}
            <div
              role="button"
              tabIndex={0}
              onClick={() => setView("downloads")}
              className="bg-white/85 backdrop-blur-md rounded-2xl border border-white/70 shadow-[0_4px_20px_-2px_rgba(20,45,85,0.06)] p-2 flex flex-col gap-1 cursor-pointer pressable hover:bg-white active:scale-[0.99] transition-all"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="w-7 h-7 rounded-full bg-[#dcfce7] text-[#16a34a] flex items-center justify-center shrink-0 shadow-xs">
                    <IDownload size={14} strokeWidth={2.4} />
                  </div>
                  <div>
                    <div className="text-[13.5px] font-bold text-[#0f172a]">Downloads</div>
                    <div className="text-[10.5px] text-[#64748b]">
                      {downloads.length} {downloads.length === 1 ? "episode" : "episodes"} offline · {formatBytes(totalDownloadsBytes)}
                    </div>
                  </div>
                </div>
                <IChevR size={14} className="text-slate-400" strokeWidth={2.5} />
              </div>

              {/* Storage Bar Indicator */}
              <div className="flex items-center gap-2 pt-0.5">
                <div className="flex-1 h-1.5 rounded-full bg-[#e2e8f0] overflow-hidden">
                  <div
                    className="h-full bg-[#2563eb] rounded-full transition-all duration-300"
                    style={{
                      width: `${Math.min(100, Math.max(5, storageStats?.percentUsed != null ? Math.round(storageStats.percentUsed) : downloads.length > 0 ? 67 : 0))}%`,
                    }}
                  />
                </div>
                <span className="text-[10.5px] font-extrabold text-[#2563eb] tabular-nums">
                  {storageStats?.percentUsed != null ? `${Math.round(storageStats.percentUsed)}%` : downloads.length > 0 ? "67%" : "0%"}
                </span>
              </div>
            </div>

            {/* Settings Card */}
            <div
              role="button"
              tabIndex={0}
              onClick={() => push({ kind: "settings" })}
              className="bg-white/85 backdrop-blur-md rounded-2xl border border-white/70 shadow-[0_4px_20px_-2px_rgba(20,45,85,0.06)] p-2 flex items-center justify-between cursor-pointer pressable hover:bg-white active:scale-[0.99] transition-all"
            >
              <div className="flex items-center gap-2.5">
                <div className="w-7 h-7 rounded-full bg-[#f1f5f9] text-[#334155] flex items-center justify-center shrink-0 shadow-xs">
                  <ISettings size={14} strokeWidth={2} />
                </div>
                <div>
                  <div className="text-[13.5px] font-bold text-[#0f172a]">Settings</div>
                  <div className="text-[10.5px] text-[#64748b]">Playback, quality, subtitles & display</div>
                </div>
              </div>
              <IChevR size={14} className="text-slate-400" strokeWidth={2.5} />
            </div>

            {/* Footer */}
            <div className="text-center text-[10px] text-[#94a3b8] font-medium pt-0 pb-1 tracking-tight">
              AuraStream v0.1.14
            </div>
          </div>
        ) : view === "downloads" ? (
          /* =====================================================================
              2. Downloads Hub View (Image 2 & Image 3 Screen 1)
              ===================================================================== */
          <div className="flex flex-col gap-3.5 a-rise">
            {/* Search Input Bar (when search is toggled in top bar) */}
            {downloadSearchOpen && (
              <div className="relative flex items-center bg-white/95 border border-blue-200/90 rounded-full px-3.5 py-2 shadow-xs a-fade-in">
                <ISearch size={15} className="text-slate-400 shrink-0 mr-2" />
                <input
                  type="text"
                  value={downloadSearchQuery}
                  onChange={(e) => setDownloadSearchQuery(e.target.value)}
                  placeholder="Search downloaded shows & episodes..."
                  className="flex-1 bg-transparent text-[13px] text-[#0f172a] placeholder:text-slate-400 outline-none"
                  autoFocus
                />
                {downloadSearchQuery && (
                  <button
                    type="button"
                    onClick={() => setDownloadSearchQuery("")}
                    className="w-5 h-5 rounded-full bg-slate-200 text-slate-500 flex items-center justify-center pressable text-[10px]"
                  >
                    ✕
                  </button>
                )}
              </div>
            )}

            {/* Storage Gauge Card */}
            <div className="bg-white/85 backdrop-blur-md rounded-2xl border border-white/70 shadow-[0_4px_20px_-2px_rgba(20,45,85,0.06)] p-3.5 flex items-center justify-between gap-3">
              <div className="w-12 h-12 rounded-2xl bg-gradient-to-tr from-[#1a73e8] to-[#60a5fa] text-white flex items-center justify-center shadow-md shrink-0">
                <IDownload size={22} strokeWidth={2.4} />
              </div>

              <div className="flex-1 min-w-0">
                <div className="text-[11.5px] font-semibold text-[#64748b]">Storage Used</div>
                <div className="text-[16px] font-black text-[#0f172a] tracking-tight">
                  {formatBytes(totalDownloadsBytes)}{" "}
                  <span className="text-[12px] text-[#64748b] font-normal">
                    / {storageStats?.quotaBytes ? (storageStats.quotaBytes / (1024 * 1024 * 1024)).toFixed(0) : "2"} GB
                  </span>
                </div>
                <div className="w-full h-1.5 rounded-full bg-slate-200 overflow-hidden mt-1.5">
                  <div
                    className="h-full bg-[#1a73e8] rounded-full transition-all duration-300"
                    style={{
                      width: `${Math.min(100, Math.max(5, storageStats?.percentUsed != null ? Math.round(storageStats.percentUsed) : 26))}%`,
                    }}
                  />
                </div>
              </div>

              <div className="flex flex-col items-end gap-1 shrink-0">
                <button
                  type="button"
                  onClick={() => setConfirmClearAllOpen(true)}
                  className="flex items-center gap-1 px-3 py-1.5 rounded-xl bg-white border border-slate-200/80 text-[11.5px] font-bold text-[#334155] shadow-xs hover:bg-slate-50 pressable active:scale-95 transition-all"
                >
                  <ISettings size={12} />
                  <span>Manage</span>
                </button>
                <span className="text-[11px] font-bold text-[#1a73e8] tabular-nums">
                  {storageStats?.percentUsed != null ? `${Math.round(storageStats.percentUsed)}%` : "26%"}
                </span>
              </div>
            </div>

            {/* Filter Pills */}
            <div className="flex items-center justify-between px-0.5">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setDownloadFilter("all")}
                  className={`px-3.5 py-1.5 rounded-full text-[12px] font-bold flex items-center gap-1.5 pressable transition-all shadow-xs ${
                    downloadFilter === "all"
                      ? "bg-[#1a73e8] text-white"
                      : "bg-white/80 border border-slate-200 text-[#64748b]"
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
                      : "bg-white/80 border border-slate-200 text-[#64748b]"
                  }`}
                >
                  <IGrid size={11} />
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
                className="flex items-center gap-1 text-[11.5px] font-semibold text-[#475569] bg-white/80 hover:bg-white border border-slate-200 px-2.5 py-1 rounded-full pressable transition-all shadow-2xs"
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
              <div className="flex flex-col gap-3">
                {sortedDramaGroups.map((group) => {
                  const isExpanded = !collapsedDramas.has(group.videoId);
                  const totalMB = (group.totalBytes / (1024 * 1024)).toFixed(0);

                  const allGroupKeys = group.episodes.map((e) => `${e.videoId}_${e.episode}`);
                  const allSelected = allGroupKeys.every((k) => selectedKeys.has(k));
                  const someSelected = allGroupKeys.some((k) => selectedKeys.has(k));

                  return (
                    <div
                      key={group.videoId}
                      className="bg-white/90 backdrop-blur-md rounded-2xl border border-white/70 shadow-[0_4px_20px_-2px_rgba(20,45,85,0.06)] p-3 flex flex-col gap-2.5"
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
                              <div className="w-5 h-5 rounded-full border-2 border-slate-300 bg-white" />
                            )}
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => toggleDramaCollapse(group.videoId)}
                            className="text-slate-400 hover:text-slate-600 pressable p-1 shrink-0"
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
                          className="w-14 aspect-[3/4] rounded-xl overflow-hidden shrink-0 shadow-xs border border-black/5 bg-slate-100 cursor-pointer pressable relative p-0 border-0 text-left block"
                        >
                          <img
                            src={getCoverUrl(group.cover, 200)}
                            alt=""
                            className="w-full h-full object-cover"
                            loading="lazy"
                          />
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
                          <div className="text-[15px] font-bold text-[#0f172a] leading-snug line-clamp-2">
                            {formatDramaTitle(group.title)}
                          </div>
                          <div className="text-[11.5px] text-[#64748b] mt-0.5 tabular-nums">
                            {group.episodes.length} {group.episodes.length === 1 ? "episode" : "episodes"} · {totalMB} MB
                          </div>
                          <div className="flex items-center gap-1.5 mt-1">
                            <span className="inline-flex items-center gap-1 text-[11px] font-bold text-[#16a34a]">
                              <ICheck size={11} strokeWidth={3} />
                              <span>All Downloaded</span>
                            </span>
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
                                  startEp: group.episodes[0].episode,
                                });
                              }
                            }}
                            className="w-8 h-8 rounded-full bg-[#e0edff] text-[#1a73e8] hover:bg-[#d0e4ff] flex items-center justify-center pressable active:scale-95 shadow-xs transition-all"
                            title="Play Show"
                          >
                            <IPlayF size={11} />
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              openSingleExport(group.videoId, group.episodes[0]?.episode || 1, group.title);
                            }}
                            className="w-6 h-6 flex items-center justify-center text-slate-400 hover:text-slate-600 pressable font-bold"
                          >
                            ⋮
                          </button>
                        </div>
                      </div>

                      {/* Mini Episode Thumbnails Row (Collapsible) */}
                      {isExpanded && (
                        <div className="flex gap-2.5 overflow-x-auto scrollbar-none pt-1 border-t border-slate-100">
                          {group.episodes.map((ep) => {
                            const isChecked = selectedKeys.has(`${ep.videoId}_${ep.episode}`);
                            const epMB = (ep.sizeBytes / (1024 * 1024)).toFixed(1);

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
                                      startEp: ep.episode,
                                    });
                                  }
                                }}
                                className="w-28 shrink-0 flex flex-col gap-1 cursor-pointer pressable active:scale-95 transition-all"
                              >
                                <div className="w-full aspect-[16/10] rounded-lg overflow-hidden relative border border-black/5 bg-slate-200">
                                  <img
                                    src={getCoverUrl(group.cover, 160)}
                                    alt=""
                                    className="w-full h-full object-cover"
                                    loading="lazy"
                                  />
                                  <div className="absolute bottom-1 right-1 w-4 h-4 rounded-full bg-[#10b981] text-white flex items-center justify-center shadow-xs">
                                    <ICheck size={9} strokeWidth={3.5} />
                                  </div>
                                  {selectMode && (
                                    <div className="absolute top-1 left-1 w-4 h-4 rounded-md border border-white bg-black/40 flex items-center justify-center">
                                      {isChecked && <ICheck size={10} className="text-white" strokeWidth={3} />}
                                    </div>
                                  )}
                                </div>
                                <div className="text-[11.5px] font-bold text-[#0f172a] truncate">
                                  Ep. {ep.episode}
                                </div>
                                <div className="text-[10px] text-[#64748b] tabular-nums">
                                  {epMB} MB
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
                <div className="p-3.5 rounded-2xl bg-gradient-to-r from-blue-50/90 via-white/95 to-blue-50/90 border border-blue-100 flex items-center gap-3.5 shadow-xs mt-1">
                  <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-[#1a73e8] to-[#38bdf8] text-white flex items-center justify-center shrink-0 shadow-xs">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                      <rect x="2" y="7" width="20" height="14" rx="2" ry="2" />
                      <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
                    </svg>
                  </div>
                  <div>
                    <div className="text-[13.5px] font-bold text-[#0f172a]">All Downloads Are Up to Date</div>
                    <div className="text-[11.5px] text-[#64748b]">Enjoy your offline content!</div>
                  </div>
                </div>
              </div>
            ) : downloadSearchQuery.trim() ? (
              <div className="p-8 text-center flex flex-col items-center justify-center gap-2 bg-white/80 rounded-2xl border border-white/60 shadow-xs">
                <div className="text-[14px] font-bold text-[#0f172a]">No matches found</div>
                <div className="text-[12px] text-[#64748b]">No downloaded shows match &ldquo;{downloadSearchQuery}&rdquo;</div>
                <button
                  type="button"
                  onClick={() => setDownloadSearchQuery("")}
                  className="mt-2 px-4 py-1.5 rounded-full bg-blue-50 text-[12px] font-bold text-[#1a73e8] pressable hover:bg-blue-100"
                >
                  Clear Search
                </button>
              </div>
            ) : (
              /* Empty Downloads Screen (Image 3 Screen 4) */
              <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
                <div className="relative mb-5">
                  <div className="w-24 h-24 rounded-full bg-blue-100/70 blur-xl absolute inset-0" />
                  <div className="w-24 h-24 rounded-3xl bg-gradient-to-tr from-[#1a73e8] to-[#60a5fa] text-white flex items-center justify-center shadow-xl relative z-10">
                    <IDownload size={42} strokeWidth={2.4} />
                  </div>
                </div>
                <h3 className="text-[20px] font-black text-[#0f172a] tracking-tight">No Downloads Yet</h3>
                <p className="text-[13.5px] text-[#64748b] max-w-xs mt-1.5 leading-relaxed">
                  Download your favorite series and watch them offline anytime!
                </p>
                <button
                  type="button"
                  onClick={() => push({ kind: "ranks" })}
                  className="mt-6 px-6 py-2.5 rounded-full bg-[#1a73e8] hover:bg-[#1557b0] text-white font-bold text-[13.5px] shadow-md pressable active:scale-95 transition-all flex items-center gap-2"
                >
                  <IDownload size={15} />
                  <span>Browse Content</span>
                </button>
              </div>
            )}
          </div>
        ) : view === "seriesDetail" && selectedSeriesGroup ? (
          /* =====================================================================
              3. Series Detail View (Image 3 Screen 2)
              ===================================================================== */
          <div className="flex flex-col gap-4 a-rise">
            {/* Top Showcase Card */}
            <div className="bg-white/90 backdrop-blur-md rounded-2xl border border-white/70 shadow-sm p-4 flex gap-4">
              <div className="w-20 aspect-[3/4] rounded-2xl overflow-hidden shrink-0 shadow-sm border border-black/5 bg-slate-100">
                <img
                  src={getCoverUrl(selectedSeriesGroup.cover, 240)}
                  alt=""
                  className="w-full h-full object-cover"
                />
              </div>
              <div className="flex-1 min-w-0 flex flex-col justify-center">
                <h2 className="text-[18px] font-black text-[#0f172a] tracking-tight truncate">
                  {formatDramaTitle(selectedSeriesGroup.title)}
                </h2>
                <div className="text-[12.5px] text-[#64748b] mt-0.5 tabular-nums">
                  {selectedSeriesGroup.episodes.length} {selectedSeriesGroup.episodes.length === 1 ? "episode" : "episodes"} · {(selectedSeriesGroup.totalBytes / (1024 * 1024 * 1024) >= 1 ? `${(selectedSeriesGroup.totalBytes / (1024 * 1024 * 1024)).toFixed(1)} GB` : `${(selectedSeriesGroup.totalBytes / (1024 * 1024)).toFixed(0)} MB`)}
                </div>
                <div className="flex items-center gap-1.5 mt-2">
                  <span className="inline-flex items-center gap-1 text-[11px] font-bold text-[#16a34a]">
                    <ICheck size={12} strokeWidth={3} />
                    <span>All Downloaded</span>
                  </span>
                </div>
              </div>
            </div>

            {/* Action Buttons Row */}
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => {
                  if (selectedSeriesGroup.episodes[0]) {
                    push({
                      kind: "feed",
                      videoIds: [selectedSeriesGroup.videoId],
                      index: 0,
                      title: formatDramaTitle(selectedSeriesGroup.title),
                      startEp: selectedSeriesGroup.episodes[0].episode,
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
                onClick={async () => {
                  await deleteOfflineEpisodesBatch(selectedSeriesGroup.episodes);
                  setDownloads(getOfflineEpisodes());
                  void getDetailedStorageStats().then(setStorageStats);
                  toast(`Deleted ${selectedSeriesGroup.title}`, "ok");
                  setView("downloads");
                }}
                className="flex-1 h-11 rounded-full bg-white/90 border border-slate-200 text-slate-700 hover:text-red-500 font-bold text-[13px] shadow-xs flex items-center justify-center gap-2 pressable active:scale-95 transition-all"
              >
                <ITrash size={13} />
                <span>Delete All</span>
              </button>
            </div>

            {/* Storage Info Banner */}
            <div
              role="button"
              tabIndex={0}
              onClick={() => openSingleExport(selectedSeriesGroup.videoId, selectedSeriesGroup.episodes[0]?.episode || 1, selectedSeriesGroup.title)}
              className="p-3 rounded-2xl bg-white/90 border border-slate-200/80 flex items-center justify-between text-[12px] text-[#64748b] shadow-xs cursor-pointer pressable hover:bg-white active:scale-[0.99] transition-all"
            >
              <div className="flex items-center gap-2.5 font-medium">
                <div className="w-5 h-5 rounded-md bg-[#1a73e8]/15 text-[#1a73e8] flex items-center justify-center shrink-0">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" />
                  </svg>
                </div>
                <span className="text-[#334155] font-semibold">
                  Downloaded on: {selectedSeriesGroup.episodes[0]?.downloadedAt ? new Date(selectedSeriesGroup.episodes[0].downloadedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "Nov 19, 2026"} · {(selectedSeriesGroup.totalBytes / (1024 * 1024 * 1024) >= 1 ? `${(selectedSeriesGroup.totalBytes / (1024 * 1024 * 1024)).toFixed(1)} GB` : `${(selectedSeriesGroup.totalBytes / (1024 * 1024)).toFixed(0)} MB`)}
                </span>
              </div>
              <IChevR size={13} className="text-slate-400" />
            </div>

            {/* Episodes List Header */}
            <div className="flex items-center justify-between px-1 mt-1">
              <h3 className="text-[15px] font-bold text-[#0f172a]">
                Episodes ({selectedSeriesGroup.episodes.length})
              </h3>
              <button
                type="button"
                onClick={() => setEpisodeOrder((prev) => (prev === "asc" ? "desc" : "asc"))}
                className="flex items-center gap-1 text-[11.5px] font-semibold text-[#64748b] hover:text-[#1a73e8] pressable active:scale-95 transition-all"
              >
                <span>{episodeOrder === "asc" ? "Oldest First" : "Newest First"}</span>
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
                        startEp: item.episode,
                      })
                    }
                    className="p-3 rounded-2xl bg-white/90 backdrop-blur-md border border-white/70 shadow-xs flex items-center gap-3 cursor-pointer pressable active:scale-[0.99] transition-all"
                  >
                    <div className="w-20 aspect-[16/10] rounded-xl overflow-hidden relative border border-black/5 bg-slate-200 shrink-0">
                      <img
                        src={getCoverUrl(selectedSeriesGroup.cover, 160)}
                        alt=""
                        className="w-full h-full object-cover"
                      />
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="text-[14px] font-bold text-[#0f172a] truncate">
                        Episode {item.episode}
                      </div>
                      <div className="text-[11.5px] text-[#64748b] mt-0.5 tabular-nums flex items-center gap-1.5 whitespace-nowrap overflow-hidden">
                        <span className="w-3.5 h-3.5 rounded-full bg-[#10b981] text-white flex items-center justify-center shrink-0">
                          <ICheck size={8} strokeWidth={3.5} />
                        </span>
                        <span className="font-semibold text-slate-700 shrink-0">{epMB} MB</span>
                        <span className="truncate">· Downloaded</span>
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      <div className="w-8 h-8 rounded-full bg-[#e0edff] text-[#1a73e8] flex items-center justify-center">
                        <IPlayF size={10} />
                      </div>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          openSingleExport(item.videoId, item.episode, item.title);
                        }}
                        className="w-7 h-7 flex items-center justify-center text-slate-400 hover:text-slate-600 pressable"
                      >
                        ⋮
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
            <div className={`ios-media-grid ${wide ? "is-wide" : ""}`}>
              {cards.map((c) => {
                const progress = progressOf(c.id);
                return (
                  <MediaCard
                    key={c.id}
                    title={c.title}
                    cover={c.cover}
                    score={c.score}
                    badge={c.is_finished ? "Ended" : `${c.episode_count} eps`}
                    subtitle={c.tags?.slice(0, 2).map(formatDramaTag).join(" · ")}
                    progress={progress ? `Ep. ${progress.ep} · ${fmtTime(progress.t)}` : undefined}
                    onOpen={() =>
                      push({
                        kind: "feed",
                        videoIds: cards.map((x) => x.id),
                        index: cards.findIndex((x) => x.id === c.id),
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
                );
              })}
            </div>
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

      {/* =========================================================================
          Multi-Select Bottom Action Bar (Image 3 Screen 3)
          ========================================================================= */}
      {selectMode && (
        <div
          className="fixed inset-x-5 z-[70] bg-white border border-slate-200/90 rounded-full px-5 py-2.5 flex items-center justify-around shadow-[0_12px_36px_rgba(15,23,42,0.18)] a-rise"
          style={{ bottom: "calc(var(--sab, 0px) + 20px)" }}
        >
          <button
            type="button"
            onClick={playSelected}
            disabled={selectedKeys.size === 0}
            className="flex items-center gap-2 text-[13px] font-bold text-[#0f172a] disabled:opacity-40 pressable active:scale-95"
          >
            <IPlayF size={13} className="text-[#1a73e8]" />
            <span>Play</span>
          </button>
          <div className="w-[1px] h-4 bg-slate-200" />
          <button
            type="button"
            onClick={deleteSelected}
            disabled={selectedKeys.size === 0}
            className="flex items-center gap-2 text-[13px] font-bold text-[#0f172a] hover:text-red-600 disabled:opacity-40 pressable active:scale-95"
          >
            <ITrash size={14} className="text-slate-600" />
            <span>Delete</span>
          </button>
          <div className="w-[1px] h-4 bg-slate-200" />
          <button
            type="button"
            onClick={openExportSelected}
            disabled={selectedKeys.size === 0}
            className="flex items-center gap-1.5 text-[13px] font-bold text-[#0f172a] disabled:opacity-40 pressable active:scale-95"
          >
            <span>More</span>
            <IChevronDown size={13} className="text-slate-600" />
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
          <div className="text-[16px] font-bold text-[#0f172a]">{t("profile.confirm_clear_title")}</div>
          <div className="text-[13px] text-[#64748b] leading-relaxed">
            {t("profile.confirm_clear_desc")}
          </div>
          <div className="flex items-center gap-2.5 mt-2">
            <Button
              onClick={() => setConfirmClearAllOpen(false)}
              className="flex-1 h-9 rounded-xl bg-slate-100 text-[#0f172a] text-[13px] font-medium pressable"
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
      />
    </div>
  );
}
