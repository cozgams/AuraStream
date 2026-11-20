import { Button, Surface } from "../components/ios/controls";
import { Loader } from "../components/ios/effects";
import { useEffect, useMemo, useState } from "react";
import { api, APP_VERSION, cover as getCoverUrl, fmtTime, isMobile, platform } from "../api";
import type { Detail } from "../types";
import { useStore } from "../store";
import { Avatar, Empty, Modal } from "../components/ui";
import { MediaCard } from "../components/cards";
import ExportSheet from "../components/ExportSheet";
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
  IHist,
  ILogout,
  IPauseF,
  IPlayF,
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
import { runDeepRamPurge } from "../playback/ramBooster";

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
    t,
    toast,
  } = useStore();

  // Navigation view: "overview" (YouTube You tab), or dedicated subviews
  const [view, setView] = useState<"overview" | "history" | "favs" | "watchlater" | "downloads">("overview");

  const [cards, setCards] = useState<Detail[]>([]);
  const [favPreviewCover, setFavPreviewCover] = useState<string>("");
  const [watchLaterPreviewCover, setWatchLaterPreviewCover] = useState<string>("");

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
    if (view !== "downloads") {
      setSelectMode(false);
      setSelectedKeys(new Set());
    }
  }, [view]);

  useEffect(() => {
    if (downloads.length === 0 && selectMode) {
      setSelectMode(false);
      setSelectedKeys(new Set());
    }
  }, [downloads.length, selectMode]);

  const dramaGroups = useMemo(() => {
    const map = new Map<
      number,
      {
        videoId: number;
        title: string;
        cover: string;
        episodes: OfflineEpisode[];
        totalBytes: number;
      }
    >();

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

  const totalDownloadsBytes = useMemo(() => {
    return downloads.reduce((acc, it) => acc + (it.sizeBytes || 0), 0);
  }, [downloads]);

  const openSingleExport = (videoId: number, episode: number, title: string) => {
    setExportSheetState({
      isOpen: true,
      videoId,
      episode,
      title,
    });
  };

  const openBatchDownloadWatchLater = () => {
    const first = cards[0];
    if (first) {
      setBatchSheet({
        isOpen: true,
        videoId: first.id,
        title: first.title,
        cover: first.cover,
        totalEpisodes: first.episode_count || 1,
      });
    }
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

  // Pre-fetch covers for Playlist preview shelf
  useEffect(() => {
    let alive = true;
    if (favs[0]) {
      api.video(favs[0]).then((res) => {
        if (alive && res?.cover) setFavPreviewCover(res.cover);
      }).catch(() => {});
    } else {
      setFavPreviewCover("");
    }

    if (watchLater?.[0]) {
      api.video(watchLater[0]).then((res) => {
        if (alive && res?.cover) setWatchLaterPreviewCover(res.cover);
      }).catch(() => {});
    } else {
      setWatchLaterPreviewCover("");
    }

    return () => {
      alive = false;
    };
  }, [favs[0], watchLater?.[0]]);

  // Subview IDs resolution
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
    if (view === "overview" || view === "downloads" || !subviewIds.length) {
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
    <div className="ios-page absolute inset-0 bg-bg flex flex-col select-none overflow-hidden">
      {/* Top App Bar (Clean YouTube Style - Header + Settings Gear) */}
      <div
        className="shrink-0 px-4 flex items-center justify-between border-b border-edge/30 bg-bg/80 backdrop-blur-md z-10"
        style={{ paddingTop: "calc(var(--sat, 0px) + 10px)", paddingBottom: "10px" }}
      >
        {view === "overview" ? (
          <>
            <h1 className="text-[20px] font-bold tracking-tight text-on">
              {t("profile.title")}
            </h1>
            <div className="flex items-center gap-1.5">
              <Button
                onClick={() => push({ kind: "settings" })}
                aria-label={t("settings.title")}
                className="ios-icon-button"
              >
                <ISettings size={19} strokeWidth={1.8} />
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setView("overview")}
                className="w-8 h-8 rounded-full flex items-center justify-center text-on hover:bg-s3 active:scale-95 transition-all"
                aria-label="Back to Overview"
              >
                <IBack size={18} />
              </button>
              <h1 className="text-[18px] font-bold tracking-tight text-on">
                {view === "history"
                  ? `${t("profile.history")} (${history.length})`
                  : view === "favs"
                  ? `${t("profile.favorites")} (${favs.length})`
                  : view === "watchlater"
                  ? `${t("profile.watch_later")} (${watchLater?.length || 0})`
                  : `${t("profile.downloads")} (${downloads.length})`}
              </h1>
            </div>

            {/* Subview Quick Actions */}
            <div className="flex items-center gap-1.5">
              {view === "history" && history.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    clearHistory();
                    toast("Watch history cleared", "ok");
                  }}
                  className="text-[12px] font-semibold text-mut hover:text-red-400 px-2 py-1 rounded-lg hover:bg-s3 pressable"
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
                  className="text-[12px] font-semibold text-mut hover:text-red-400 px-2 py-1 rounded-lg hover:bg-s3 pressable"
                >
                  {t("search.clear")}
                </button>
              )}
              {view === "watchlater" && (watchLater?.length || 0) > 0 && (
                <div className="flex items-center gap-1.5">
                  <Button
                    onClick={openBatchDownloadWatchLater}
                    className="px-2.5 py-1 rounded-lg bg-primary/20 text-primary text-[11px] font-bold flex items-center gap-1 pressable"
                  >
                    <IDownload size={12} />
                    <span>Download All</span>
                  </Button>
                  <button
                    type="button"
                    onClick={() => {
                      clearWatchLater();
                      toast("Watch later cleared", "ok");
                    }}
                    className="text-[12px] font-semibold text-mut hover:text-red-400 px-2 py-1 rounded-lg hover:bg-s3 pressable"
                  >
                    {t("search.clear")}
                  </button>
                </div>
              )}
              {view === "downloads" && downloads.length > 0 && (
                <div className="flex items-center gap-1.5">
                  {selectMode ? (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          if (selectedKeys.size === downloads.length) {
                            setSelectedKeys(new Set());
                          } else {
                            setSelectedKeys(new Set(downloads.map((d) => `${d.videoId}_${d.episode}`)));
                          }
                        }}
                        className="text-[11.5px] font-semibold text-mut px-2 py-1 rounded-lg hover:bg-s3 pressable"
                      >
                        {selectedKeys.size === downloads.length ? "Deselect" : "Select All"}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectMode(false);
                          setSelectedKeys(new Set());
                        }}
                        className="text-[11.5px] font-bold text-primary px-2.5 py-1 rounded-lg bg-primary/15 pressable"
                      >
                        Done
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => setSelectMode(true)}
                        className="text-[11.5px] font-semibold text-primary px-2 py-1 rounded-lg hover:bg-primary/10 pressable transition-colors"
                      >
                        Select
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmClearAllOpen(true)}
                        className="text-[11.5px] font-semibold text-mut hover:text-red-400 px-2 py-1 rounded-lg hover:bg-s3 pressable transition-colors flex items-center gap-1"
                      >
                        <ITrash size={12} />
                        <span>Clear</span>
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Main Content Area */}
      <div
        className="ios-page-body flex-1 scroll-y px-4 pt-3"
        style={{ paddingBottom: "calc(var(--sab, 48px) + 104px)" }}
      >
        {view === "overview" ? (
          <div className="flex flex-col gap-5 a-rise">
            {/* User Profile Header (YouTube Style - Pure & Minimal with NO Pill Buttons) */}
            <div
              role="button"
              tabIndex={0}
              onClick={() => {
                if (!user) setLoginOpen(true);
                else push({ kind: "user", id: user.id, name: user.nickname });
              }}
              className="flex items-center gap-3.5 pt-1 pb-1 cursor-pointer pressable active:scale-[0.99] transition-transform"
            >
              <div className="relative shrink-0">
                <Avatar
                  size={58}
                  icon={<IUser size={28} />}
                  src={user?.avatar}
                  name={user?.nickname}
                  hue={220}
                  ring
                />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <h2 className="text-[19px] font-bold text-on tracking-tight truncate">
                    {user ? user.nickname : t("profile.my_library")}
                  </h2>
                  <IChevR size={15} className="text-mut/60 shrink-0" />
                </div>
                <div className="text-[12.5px] text-mut truncate mt-0.5">
                  {user ? `@${user.username} · View channel` : "Local Library · Tap to sign in"}
                </div>
              </div>
            </div>

            {/* 1. History Shelf (Modern YouTube Horizontal Carousel with Progress Bars) */}
            <div className="flex flex-col gap-2.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-[17px] font-bold text-on tracking-tight">
                    {t("profile.history")}
                  </span>
                  {history.length > 0 && (
                    <span className="text-[12px] text-mut font-normal tabular-nums">
                      ({history.length})
                    </span>
                  )}
                </div>
                {history.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setView("history")}
                    className="px-2.5 py-1 rounded-full text-[12px] font-semibold text-primary hover:bg-primary/10 pressable transition-colors flex items-center gap-0.5"
                  >
                    <span>View all</span>
                    <IChevR size={13} strokeWidth={2.2} />
                  </button>
                )}
              </div>

              {history.length > 0 ? (
                <div className="flex gap-3 overflow-x-auto scrollbar-none pb-2 -mx-4 px-4">
                  {history.slice(0, 15).map((h, idx) => {
                    const progressPct =
                      h.dur > 0
                        ? Math.min(100, Math.max(5, (h.t / h.dur) * 100))
                        : h.t > 0
                        ? 35
                        : 0;

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
                            title: formatDramaTitle(h.title || "History"),
                            startEp: h.ep,
                            startTime: h.t,
                          })
                        }
                        className="w-38 shrink-0 flex flex-col cursor-pointer pressable active:scale-[0.98] transition-transform"
                      >
                        {/* 16:10 Thumbnail */}
                        <div className="w-full aspect-[16/10] rounded-xl overflow-hidden relative bg-s3 shadow-xs border border-edge/40">
                          {h.cover ? (
                            <img
                              src={getCoverUrl(h.cover, 240)}
                              alt=""
                              className="w-full h-full object-cover"
                              loading="lazy"
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center bg-s3 text-mut">
                              <IHist size={24} />
                            </div>
                          )}

                          {/* YouTube-style Red Progress Bar */}
                          {progressPct > 0 && (
                            <div className="absolute bottom-0 inset-x-0 h-1 bg-black/60 overflow-hidden">
                              <div
                                className="h-full bg-red-600 transition-all duration-300"
                                style={{ width: `${progressPct}%` }}
                              />
                            </div>
                          )}

                          {/* Duration chip / Episode badge */}
                          <div className="absolute bottom-2 right-1.5 px-1.5 py-0.5 rounded bg-black/80 backdrop-blur-xs text-[10px] font-bold text-white tabular-nums shadow-xs">
                            Ep. {h.ep}
                            {h.t > 0 ? ` · ${fmtTime(h.t)}` : ""}
                          </div>
                        </div>

                        {/* Title & Metadata */}
                        <div className="text-[12.5px] font-semibold text-on leading-tight line-clamp-2 mt-1.5">
                          {formatDramaTitle(h.title || `Drama #${h.id}`)}
                        </div>
                        <div className="text-[11px] text-mut truncate mt-0.5">
                          {h.is_finished ? "Ended" : `${h.episode_count || 1} eps`} · Ep. {h.ep}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="p-4 rounded-2xl bg-s2 border border-edge/40 text-center flex flex-col items-center justify-center gap-1.5">
                  <div className="text-[13px] font-semibold text-on">{t("profile.no_hist")}</div>
                  <div className="text-[11.5px] text-mut">{t("profile.no_hist_sub")}</div>
                </div>
              )}
            </div>

            {/* 2. Playlists Shelf (Favorites, Watch Later, Downloads) */}
            <div className="flex flex-col gap-2.5">
              <div className="flex items-center justify-between">
                <span className="text-[17px] font-bold text-on tracking-tight">Playlists</span>
                <button
                  type="button"
                  onClick={() => setView("favs")}
                  className="px-2.5 py-1 rounded-full text-[12px] font-semibold text-primary hover:bg-primary/10 pressable transition-colors flex items-center gap-0.5"
                >
                  <span>View all</span>
                  <IChevR size={13} strokeWidth={2.2} />
                </button>
              </div>

              <div className="flex gap-3 overflow-x-auto scrollbar-none pb-2 -mx-4 px-4">
                {/* Favorites Card */}
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => setView("favs")}
                  className="w-38 shrink-0 flex flex-col cursor-pointer pressable active:scale-[0.98] transition-transform"
                >
                  <div className="w-full aspect-[16/10] rounded-xl overflow-hidden relative bg-s3 shadow-xs border border-edge/40">
                    {favPreviewCover ? (
                      <img
                        src={getCoverUrl(favPreviewCover, 240)}
                        alt=""
                        className="w-full h-full object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <div className="w-full h-full bg-gradient-to-br from-amber-500/20 to-primary/10 flex items-center justify-center text-amber-400">
                        <IStarF size={28} />
                      </div>
                    )}
                    <div className="absolute inset-x-0 bottom-0 p-1.5 bg-gradient-to-t from-black/80 via-black/40 to-transparent flex items-center justify-between">
                      <span className="inline-flex items-center gap-1 text-[10.5px] font-bold text-white px-1.5 py-0.5 rounded bg-black/60">
                        <IStarF size={10} className="text-amber-400" />
                        <span>{favs.length}</span>
                      </span>
                    </div>
                  </div>
                  <div className="text-[12.5px] font-semibold text-on leading-tight truncate mt-1.5">
                    {t("profile.favorites")}
                  </div>
                  <div className="text-[11px] text-mut truncate mt-0.5">
                    {favs.length} {favs.length === 1 ? "drama" : "dramas"}
                  </div>
                </div>

                {/* Watch Later Card */}
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => setView("watchlater")}
                  className="w-38 shrink-0 flex flex-col cursor-pointer pressable active:scale-[0.98] transition-transform"
                >
                  <div className="w-full aspect-[16/10] rounded-xl overflow-hidden relative bg-s3 shadow-xs border border-edge/40">
                    {watchLaterPreviewCover ? (
                      <img
                        src={getCoverUrl(watchLaterPreviewCover, 240)}
                        alt=""
                        className="w-full h-full object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <div className="w-full h-full bg-gradient-to-br from-sky-500/20 to-blue-600/10 flex items-center justify-center text-sky-400">
                        <IClock size={28} />
                      </div>
                    )}
                    <div className="absolute inset-x-0 bottom-0 p-1.5 bg-gradient-to-t from-black/80 via-black/40 to-transparent flex items-center justify-between">
                      <span className="inline-flex items-center gap-1 text-[10.5px] font-bold text-white px-1.5 py-0.5 rounded bg-black/60">
                        <IClock size={10} className="text-sky-400" />
                        <span>{watchLater?.length || 0}</span>
                      </span>
                    </div>
                  </div>
                  <div className="text-[12.5px] font-semibold text-on leading-tight truncate mt-1.5">
                    {t("profile.watch_later")}
                  </div>
                  <div className="text-[11px] text-mut truncate mt-0.5">
                    {watchLater?.length || 0} {watchLater?.length === 1 ? "drama" : "dramas"}
                  </div>
                </div>

                {/* Downloads Playlist Card */}
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => setView("downloads")}
                  className="w-38 shrink-0 flex flex-col cursor-pointer pressable active:scale-[0.98] transition-transform"
                >
                  <div className="w-full aspect-[16/10] rounded-xl overflow-hidden relative bg-s3 shadow-xs border border-edge/40">
                    {dramaGroups[0]?.cover ? (
                      <img
                        src={getCoverUrl(dramaGroups[0].cover, 240)}
                        alt=""
                        className="w-full h-full object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <div className="w-full h-full bg-gradient-to-br from-emerald-500/20 to-teal-600/10 flex items-center justify-center text-emerald-400">
                        <IDownload size={28} />
                      </div>
                    )}
                    <div className="absolute inset-x-0 bottom-0 p-1.5 bg-gradient-to-t from-black/80 via-black/40 to-transparent flex items-center justify-between">
                      <span className="inline-flex items-center gap-1 text-[10.5px] font-bold text-white px-1.5 py-0.5 rounded bg-black/60">
                        <ICheck size={10} className="text-emerald-400" strokeWidth={3} />
                        <span>{downloads.length} eps</span>
                      </span>
                    </div>
                  </div>
                  <div className="text-[12.5px] font-semibold text-on leading-tight truncate mt-1.5">
                    {t("profile.downloads")}
                  </div>
                  <div className="text-[11px] text-mut truncate mt-0.5">
                    {(totalDownloadsBytes / (1024 * 1024)).toFixed(1)} MB · Offline
                  </div>
                </div>
              </div>
            </div>

            {/* 3. Modern YouTube-Style Navigation Rows (Clean & Minimal) */}
            <Surface className="w-full rounded-2xl bg-s2 border border-edge/60 divide-y divide-edge/30 overflow-hidden shadow-xs mt-1">
              <button
                type="button"
                onClick={() => setView("downloads")}
                className="w-full p-3.5 flex items-center justify-between text-left pressable hover:bg-s3/40 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-emerald-500/10 text-emerald-500 flex items-center justify-center shrink-0">
                    <IDownload size={16} />
                  </div>
                  <div>
                    <div className="text-[14px] font-semibold text-on">
                      {t("profile.downloads")}
                    </div>
                    <div className="text-[11.5px] text-mut">
                      {downloads.length} episodes offline · {(totalDownloadsBytes / (1024 * 1024)).toFixed(1)} MB
                    </div>
                  </div>
                </div>
                <IChevR size={15} className="text-mut/60" />
              </button>

              <button
                type="button"
                onClick={() => push({ kind: "settings" })}
                className="w-full p-3.5 flex items-center justify-between text-left pressable hover:bg-s3/40 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-s3 text-on flex items-center justify-center shrink-0">
                    <ISettings size={16} />
                  </div>
                  <div>
                    <div className="text-[14px] font-semibold text-on">{t("settings.title")}</div>
                    <div className="text-[11.5px] text-mut">
                      Playback, quality, subtitles & display
                    </div>
                  </div>
                </div>
                <IChevR size={15} className="text-mut/60" />
              </button>

              {user && (
                <>
                  <button
                    type="button"
                    onClick={() => push({ kind: "following" })}
                    className="w-full p-3.5 flex items-center justify-between text-left pressable hover:bg-s3/40 transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-primary/10 text-primary flex items-center justify-center shrink-0">
                        <IUserF size={16} />
                      </div>
                      <div>
                        <div className="text-[14px] font-semibold text-on">
                          {t("profile.following")}
                        </div>
                        <div className="text-[11.5px] text-mut">{t("profile.following_sub")}</div>
                      </div>
                    </div>
                    <IChevR size={15} className="text-mut/60" />
                  </button>

                  <button
                    type="button"
                    onClick={() => push({ kind: "user", id: user.id, name: user.nickname })}
                    className="w-full p-3.5 flex items-center justify-between text-left pressable hover:bg-s3/40 transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-s3 text-on flex items-center justify-center shrink-0">
                        <IUser size={16} />
                      </div>
                      <div>
                        <div className="text-[14px] font-semibold text-on">
                          {t("profile.my_channel")}
                        </div>
                        <div className="text-[11.5px] text-mut">{t("profile.my_channel_sub")}</div>
                      </div>
                    </div>
                    <IChevR size={15} className="text-mut/60" />
                  </button>
                </>
              )}
            </Surface>
          </div>
        ) : view === "downloads" ? (
          /* Dedicated Full-Screen Downloads Subview */
          <div className="flex flex-col gap-3 a-rise">
            {/* Multi-Select Action Bar */}
            {selectMode && (
              <div className="p-3 rounded-2xl bg-s3 border border-primary/40 flex items-center justify-between gap-2 shadow-md a-rise">
                <div className="text-[12px] font-semibold text-on pl-1">
                  {selectedKeys.size} selected
                </div>
                <div className="flex items-center gap-1.5">
                  <Button
                    onClick={openExportSelected}
                    disabled={selectedKeys.size === 0}
                    className="px-3 py-1.5 rounded-xl bg-primary text-black disabled:opacity-40 text-[11.5px] font-bold flex items-center gap-1 pressable shadow-xs"
                  >
                    <IExport size={13} strokeWidth={2.2} />
                    <span>Export</span>
                  </Button>
                  <Button
                    onClick={deleteSelected}
                    disabled={selectedKeys.size === 0}
                    className="px-3 py-1.5 rounded-xl bg-red-500 text-white disabled:opacity-40 text-[11.5px] font-bold flex items-center gap-1 pressable shadow-xs"
                  >
                    <ITrash size={13} strokeWidth={2.2} />
                    <span>Delete</span>
                  </Button>
                </div>
              </div>
            )}

            {/* Series Batch Downloader Banner */}
            {batchProgress.active && (
              <div className="p-3.5 rounded-2xl bg-primary/10 border border-primary/30 flex flex-col gap-2.5 a-rise">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
                    <span className="text-[13px] font-bold text-on">Series Batch Downloader</span>
                  </div>
                  <Button
                    onClick={() => cancelBatchDownload()}
                    className="text-[11px] font-medium text-mut hover:text-red-400 flex items-center gap-1 pressable"
                  >
                    <IClose size={12} /> Cancel
                  </Button>
                </div>
                <div className="text-[12px] text-on truncate font-medium">
                  {batchProgress.title || "Downloading Series"}
                </div>
                <div className="w-full h-1.5 rounded-full bg-white/10 overflow-hidden">
                  <div
                    className="h-full bg-primary transition-all duration-300"
                    style={{
                      width: `${batchProgress.total > 0 ? (batchProgress.completed / batchProgress.total) * 100 : 0}%`,
                    }}
                  />
                </div>
                <div className="flex items-center justify-between text-[11px] text-mut tabular-nums">
                  <span>
                    Episode {batchProgress.currentEpisode} ({batchProgress.completed} of {batchProgress.total})
                  </span>
                  <span className="text-primary font-bold">
                    {batchProgress.total > 0 ? Math.round((batchProgress.completed / batchProgress.total) * 100) : 0}%
                  </span>
                </div>
              </div>
            )}

            {/* Active Downloads Section (if any downloading) */}
            {activeDownloads.length > 0 && (
              <div className="flex flex-col gap-2.5">
                <div className="flex items-center justify-between px-1">
                  <div className="text-[12px] font-semibold text-mut flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
                    <span>{t("profile.active_downloads", { count: activeDownloads.length })}</span>
                    {activeSummary.aggregateSpeedBytesPerSec > 0 && (
                      <span className="ml-1 px-1.5 py-0.5 rounded-md bg-primary/15 text-primary text-[10px] font-bold inline-flex items-center gap-1 tabular-nums">
                        <IBoltF size={10} className="shrink-0" />
                        <span>{activeSummary.aggregateSpeedFormatted}</span>
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5">
                    {activeDownloads.some((a) => a.status === "downloading") ? (
                      <Button
                        onClick={() => pauseAllDownloads()}
                        className="px-2.5 py-0.5 rounded-lg bg-s3 text-[11px] font-semibold text-mut hover:text-on pressable"
                      >
                        {t("profile.pause_all")}
                      </Button>
                    ) : (
                      <Button
                        onClick={() => void resumeAllDownloads()}
                        className="px-2.5 py-0.5 rounded-lg bg-primary/20 text-[11px] font-semibold text-primary pressable"
                      >
                        {t("profile.resume_all")}
                      </Button>
                    )}
                  </div>
                </div>

                {activeDownloads.map((ad) => (
                  <div key={ad.id} className="p-3 rounded-2xl bg-s2 border border-primary/30 flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                      <div className="flex-1 min-w-0 pr-2">
                        <div className="text-[13px] font-bold text-on truncate">
                          {ad.title || `Episode ${ad.episode}`}
                        </div>
                        <div className="text-[11px] text-mut">Episode {ad.episode}</div>
                      </div>
                      <div className="flex items-center gap-1.5">
                        {ad.status === "downloading" ? (
                          <Button
                            onClick={() => pauseDownload(ad.id)}
                            className="w-7 h-7 rounded-lg bg-s3 text-mut hover:text-on flex items-center justify-center pressable"
                            aria-label="Pause Download"
                          >
                            <IPauseF size={12} />
                          </Button>
                        ) : (
                          <Button
                            onClick={() => void resumeDownload(ad.id)}
                            className="w-7 h-7 rounded-lg bg-primary text-black flex items-center justify-center pressable"
                            aria-label="Resume Download"
                          >
                            <IPlayF size={12} />
                          </Button>
                        )}
                        <Button
                          onClick={() => cancelDownload(ad.id)}
                          className="w-7 h-7 rounded-lg bg-s3 text-mut hover:text-red-400 flex items-center justify-center pressable"
                          aria-label="Cancel Download"
                        >
                          <IClose size={13} />
                        </Button>
                      </div>
                    </div>

                    <div className="w-full h-1.5 rounded-full bg-white/10 overflow-hidden">
                      <div
                        className={`h-full transition-all duration-200 ${
                          ad.status === "paused" ? "bg-amber-400" : "bg-primary"
                        }`}
                        style={{ width: `${ad.progress}%` }}
                      />
                    </div>

                    <div className="flex items-center justify-between text-[11px] tabular-nums">
                      <span className="font-bold text-primary">
                        {ad.progress}% · {formatBytes(ad.downloadedBytes)} /{" "}
                        {ad.totalBytes > 0 ? formatBytes(ad.totalBytes) : "calculating..."}
                      </span>
                      <span className="text-mut font-medium">
                        {ad.status === "paused"
                          ? "Paused"
                          : ad.speedBytesPerSec > 0
                          ? `${ad.speedFormatted} · ${ad.etaFormatted} remaining`
                          : ad.speedFormatted || "Connecting..."}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Grouped Downloaded Shows */}
            {dramaGroups.length > 0 ? (
              <div className="flex flex-col gap-3">
                {dramaGroups.map((group) => {
                  const expanded = !collapsedDramas.has(group.videoId);
                  const totalMB = (group.totalBytes / (1024 * 1024)).toFixed(1);

                  return (
                    <div
                      key={group.videoId}
                      className="rounded-2xl bg-s2 border border-edge/60 overflow-hidden shadow-xs"
                    >
                      {/* Show Header */}
                      <div
                        onClick={() => toggleDramaCollapse(group.videoId)}
                        className="p-3.5 flex items-center gap-3 bg-s3/40 border-b border-edge/40 cursor-pointer pressable hover:bg-s3/70 transition-colors"
                      >
                        <div className="w-13 h-18 rounded-xl overflow-hidden shrink-0 shadow-sm border border-edge/40 bg-s3">
                          <img
                            src={getCoverUrl(group.cover, 160)}
                            alt=""
                            className="w-full h-full object-cover"
                            loading="lazy"
                          />
                        </div>

                        <div className="flex-1 min-w-0">
                          <div className="text-[15px] font-bold text-on truncate">
                            {formatDramaTitle(group.title)}
                          </div>
                          <div className="text-[12px] text-mut mt-0.5 tabular-nums">
                            {group.episodes.length} {group.episodes.length === 1 ? "episode" : "episodes"} · {totalMB} MB
                          </div>
                          <div className="flex items-center gap-2 mt-1.5">
                            <span className="px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 font-bold text-[10.5px]">
                              Offline Ready
                            </span>
                          </div>
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          {/* Play Show Button */}
                          {!selectMode && group.episodes[0] && (
                            <Button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                push({
                                  kind: "feed",
                                  videoIds: [group.videoId],
                                  index: 0,
                                  title: formatDramaTitle(group.title),
                                  startEp: group.episodes[0].episode,
                                });
                              }}
                              className="w-9 h-9 rounded-full bg-emerald-500 hover:bg-emerald-400 text-black flex items-center justify-center pressable shadow-xs active:scale-95 transition-transform"
                              title="Play from Episode 1"
                            >
                              <IPlayF size={12} />
                            </Button>
                          )}

                          {/* Expand / Collapse Chevron */}
                          <div className="w-6 h-6 flex items-center justify-center text-mut">
                            {expanded ? <IChevronUp size={16} /> : <IChevronDown size={16} />}
                          </div>
                        </div>
                      </div>

                      {/* Episodes List (Collapsible) */}
                      {expanded && (
                        <div className="divide-y divide-edge/30 a-rise">
                          {group.episodes.map((item) => {
                            const isChecked = selectedKeys.has(`${item.videoId}_${item.episode}`);
                            const sizeMB = (item.sizeBytes / (1024 * 1024)).toFixed(1);

                            return (
                              <div
                                key={item.id}
                                role="button"
                                tabIndex={0}
                                onClick={() => {
                                  if (selectMode) {
                                    toggleSelect(`${item.videoId}_${item.episode}`);
                                  } else {
                                    push({
                                      kind: "feed",
                                      videoIds: [item.videoId],
                                      index: 0,
                                      title: formatDramaTitle(item.title),
                                      startEp: item.episode,
                                    });
                                  }
                                }}
                                className={`p-3 flex items-center gap-3 transition-colors cursor-pointer pressable ${
                                  isChecked ? "bg-primary/10" : "hover:bg-s3/30 active:bg-s3/50"
                                }`}
                              >
                                {selectMode ? (
                                  <div
                                    className={`w-5 h-5 rounded-md flex items-center justify-center shrink-0 border ${
                                      isChecked ? "bg-primary border-primary" : "border-edge"
                                    }`}
                                  >
                                    {isChecked && <ICheck size={13} className="text-black" strokeWidth={3} />}
                                  </div>
                                ) : (
                                  <div className="w-7 h-7 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 flex items-center justify-center shrink-0">
                                    <IPlayF size={10} />
                                  </div>
                                )}

                                <div className="flex-1 min-w-0 pr-1">
                                  <div className="text-[13.5px] font-bold text-on truncate">
                                    Episode {item.episode}
                                  </div>
                                  <div className="text-[11.5px] text-mut tabular-nums mt-0.5 truncate">
                                    <span className="font-semibold text-emerald-500">{sizeMB} MB</span>
                                    <span className="mx-1.5 opacity-60">·</span>
                                    <span>Offline Ready</span>
                                  </div>
                                </div>

                                <div className="flex items-center gap-1 shrink-0">
                                  <Button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      openSingleExport(item.videoId, item.episode, item.title);
                                    }}
                                    className="ios-icon-button"
                                    title="Export MP4"
                                  >
                                    <IExport size={14} />
                                  </Button>
                                  <Button
                                    onClick={async (e) => {
                                      e.stopPropagation();
                                      await deleteOfflineEpisode(item.videoId, item.episode);
                                      setDownloads(getOfflineEpisodes());
                                      void getDetailedStorageStats().then(setStorageStats);
                                      toast(`Deleted Ep. ${item.episode}`, "ok");
                                    }}
                                    className="ios-icon-button"
                                    title="Delete Download"
                                  >
                                    <ITrash size={14} />
                                  </Button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : activeDownloads.length === 0 ? (
              <Empty
                icon={<IDownload size={26} />}
                title={t("profile.no_downloads")}
                sub={t("profile.no_downloads_sub")}
                action={t("profile.explore")}
                onAction={() => push({ kind: "ranks" })}
              />
            ) : null}
          </div>
        ) : loading ? (
          /* Loading indicator for subviews */
          <div className="flex justify-center py-12">
            <Loader className="w-7 h-7 spinner" />
          </div>
        ) : cards.length ? (
          /* Media Cards Grid for History, Favorites, Watch Later Subviews */
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
          /* Empty State for Subviews */
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

        {/* Handcrafted Quiet Branding Footer */}
        <div className="text-center text-[11.5px] text-mut/60 mt-8 mb-4 tracking-tight">
          AuraStream {APP_VERSION} · This App Created by AAA
        </div>
      </div>

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
          <div className="text-[16px] font-bold text-on">{t("profile.confirm_clear_title")}</div>
          <div className="text-[13px] text-mut leading-relaxed">
            {t("profile.confirm_clear_desc")}
          </div>
          <div className="flex items-center gap-2.5 mt-2">
            <Button
              onClick={() => setConfirmClearAllOpen(false)}
              className="flex-1 h-9 rounded-xl bg-s3 text-on text-[13px] font-medium pressable"
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
