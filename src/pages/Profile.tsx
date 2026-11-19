import { Button, Surface } from "../components/ios/controls";
import { Loader } from "../components/ios/effects";
import { useEffect, useMemo, useState } from "react";
import { api, APP_VERSION, cover as getCoverUrl, fmtTime, isMobile, platform } from "../api";
import type { Detail } from "../types";
import { useStore } from "../store";
import { Avatar, Empty, Modal } from "../components/ui";
import { MediaCard } from "../components/cards";
import { CollectionLink, CollectionLinks } from "../components/CollectionLink";
import ExportSheet from "../components/ExportSheet";
import {
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

  const [tab, setTab] = useState<"fav" | "watchlater" | "history" | "downloads">("fav");
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
  const [ramBoosting, setRamBoosting] = useState(false);
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

  const handleRamBoost = async () => {
    if (ramBoosting) return;
    setRamBoosting(true);
    try {
      const res = await runDeepRamPurge();
      toast(`RAM Boosted · Freed ${res.freedFormatted}`, "ok");
      void getDetailedStorageStats().then(setStorageStats);
    } catch {
      toast("Cache & memory optimized", "ok");
    } finally {
      setRamBoosting(false);
    }
  };

  useEffect(() => {
    if (tab !== "downloads") {
      setSelectMode(false);
      setSelectedKeys(new Set());
    }
  }, [tab]);

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

  const ids =
    tab === "fav"
      ? favs
      : tab === "watchlater"
      ? watchLater
      : tab === "history"
      ? history.map((h) => h.id)
      : [];

  const progressOf = (id: number) => (tab === "history" ? history.find((h) => h.id === id) : undefined);

  useEffect(() => {
    let alive = true;
    if (!ids.length) {
      setCards([]);
      return;
    }
    setLoading(true);
    Promise.allSettled(ids.slice(0, 16).map((id) => api.video(id)))
      .then((rs) => {
        if (!alive) return;
        const fetched = rs
          .filter((r) => r.status === "fulfilled")
          .map((r) => (r as PromiseFulfilledResult<Detail>).value);
        if (tab === "history") {
          const map = new Map(fetched.map((c) => [c.id, c]));
          const combined = ids
            .slice(0, 16)
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
  }, [ids.join(","), tab]);

  return (
    <div className="ios-page absolute inset-0 bg-bg flex flex-col select-none overflow-hidden">
      {/* Top Header */}
      <div
        className="shrink-0 px-4 flex items-center justify-between border-b border-edge/30 bg-bg/80 backdrop-blur-md z-10"
        style={{ paddingTop: "calc(var(--sat, 0px) + 10px)", paddingBottom: "10px" }}
      >
        <h1 className="text-[20px] font-bold tracking-tight text-on">
          {t("profile.title")}
        </h1>
        <div className="flex items-center gap-1.5">
          <Button
            onClick={handleRamBoost}
            className="flex items-center gap-1.5 px-3 h-8 rounded-full bg-primary/15 text-primary text-[12px] font-bold pressable transition-all active:scale-95"
            title="Purge cache and optimize RAM"
          >
            <IBoltF size={12} className={ramBoosting ? "animate-spin" : ""} />
            <span>{ramBoosting ? "Boosting..." : "RAM Boost"}</span>
          </Button>
          <Button
            onClick={() => push({ kind: "settings" })}
            aria-label={t("settings.title")}
            className="ios-icon-button"
          >
            <ISettings size={18} strokeWidth={1.8} />
          </Button>
        </div>
      </div>

      {/* Main Scroll View */}
      <div
        className="ios-page-body flex-1 scroll-y px-4 pt-3"
        style={{ paddingBottom: "calc(var(--sab, 48px) + 104px)" }}
      >
        {/* Unified Hero Library Card */}
        <Surface className="w-full rounded-2xl bg-s2 border border-edge/60 p-4 shadow-xs a-rise flex flex-col gap-3.5">
          {/* Identity & Status */}
          <div className="flex items-center gap-3 w-full">
            <div className="relative shrink-0">
              <Avatar
                size={50}
                icon={<IUser size={24} />}
                src={user?.avatar}
                name={user?.nickname}
                hue={220}
                ring
              />
              <span
                className="absolute bottom-0 right-0 w-3 h-3 rounded-full bg-emerald-500 border-2 border-s2 shadow-xs"
                title={user ? "Cloud Synced" : "Local Device Ready"}
              />
            </div>
            <div className="flex-1 min-w-0">
              <h2 className="text-[17px] font-bold text-on tracking-tight truncate">
                {user ? user.nickname : t("profile.my_library")}
              </h2>
              <div className="flex items-center gap-1.5 mt-1">
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 text-[10.5px] font-bold shrink-0">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                  {user ? "Cloud Synced" : "Offline Ready"}
                </span>
                {user && (
                  <span className="text-[11.5px] text-mut truncate">
                    @{user.username}
                  </span>
                )}
              </div>
            </div>

            {user ? (
              <Button
                onClick={async () => {
                  await logout();
                }}
                className="ios-icon-button shrink-0"
                aria-label={t("profile.logout")}
              >
                <ILogout size={17} />
              </Button>
            ) : (
              <Button
                onClick={() => setLoginOpen(true)}
                className="flex items-center gap-1.5 h-8 px-3 rounded-full bg-primary text-black text-[12px] font-bold shrink-0 pressable shadow-xs active:scale-[0.98] transition-transform"
                title={t("profile.sync_title")}
              >
                <span>{t("profile.sync_btn")}</span>
                <IChevR size={12} strokeWidth={2.4} />
              </Button>
            )}
          </div>

          {/* Interactive 4-Tab Switcher Card (Single Source of Truth) */}
          <div className="grid grid-cols-4 gap-1 p-1 rounded-xl bg-s3/70 border border-edge/40">
            <Button
              type="button"
              onClick={() => setTab("fav")}
              className={`flex flex-col items-center justify-center py-2 px-1 rounded-lg transition-all duration-200 pressable ${
                tab === "fav"
                  ? "bg-primary text-black font-bold shadow-xs scale-[1.02]"
                  : "text-mut hover:text-on hover:bg-s4/40"
              }`}
            >
              <span className={`text-[15px] font-bold tabular-nums leading-none ${tab === "fav" ? "text-black" : "text-on"}`}>
                {favs.length}
              </span>
              <span className={`text-[11px] mt-1 font-semibold leading-tight tracking-tight ${tab === "fav" ? "text-black/90" : "text-mut"}`}>
                {t("profile.favorites")}
              </span>
            </Button>

            <Button
              type="button"
              onClick={() => setTab("watchlater")}
              className={`flex flex-col items-center justify-center py-2 px-1 rounded-lg transition-all duration-200 pressable ${
                tab === "watchlater"
                  ? "bg-primary text-black font-bold shadow-xs scale-[1.02]"
                  : "text-mut hover:text-on hover:bg-s4/40"
              }`}
            >
              <span className={`text-[15px] font-bold tabular-nums leading-none ${tab === "watchlater" ? "text-black" : "text-on"}`}>
                {watchLater?.length || 0}
              </span>
              <span className={`text-[11px] mt-1 font-semibold leading-tight tracking-tight ${tab === "watchlater" ? "text-black/90" : "text-mut"}`}>
                {t("profile.watch_later")}
              </span>
            </Button>

            <Button
              type="button"
              onClick={() => setTab("history")}
              className={`flex flex-col items-center justify-center py-2 px-1 rounded-lg transition-all duration-200 pressable ${
                tab === "history"
                  ? "bg-primary text-black font-bold shadow-xs scale-[1.02]"
                  : "text-mut hover:text-on hover:bg-s4/40"
              }`}
            >
              <span className={`text-[15px] font-bold tabular-nums leading-none ${tab === "history" ? "text-black" : "text-on"}`}>
                {history.length}
              </span>
              <span className={`text-[11px] mt-1 font-semibold leading-tight tracking-tight ${tab === "history" ? "text-black/90" : "text-mut"}`}>
                {t("profile.history")}
              </span>
            </Button>

            <Button
              type="button"
              onClick={() => setTab("downloads")}
              className={`flex flex-col items-center justify-center py-2 px-1 rounded-lg transition-all duration-200 pressable ${
                tab === "downloads"
                  ? "bg-primary text-black font-bold shadow-xs scale-[1.02]"
                  : "text-mut hover:text-on hover:bg-s4/40"
              }`}
            >
              <span className={`text-[15px] font-bold tabular-nums leading-none ${tab === "downloads" ? "text-black" : "text-on"}`}>
                {downloads.length}
              </span>
              <span className={`text-[11px] mt-1 font-semibold leading-tight tracking-tight ${tab === "downloads" ? "text-black/90" : "text-mut"}`}>
                {t("profile.downloads")}
              </span>
            </Button>
          </div>
        </Surface>

        {/* User extra navigation links */}
        {user && (
          <CollectionLinks className="ios-profile-links mt-3">
            <CollectionLink
              icon={<IUserF size={18} className="text-primary" />}
              title={t("profile.following")}
              subtitle={t("profile.following_sub")}
              onClick={() => push({ kind: "following" })}
            />
            <CollectionLink
              icon={<IUserF size={18} />}
              title={t("profile.my_channel")}
              subtitle={t("profile.my_channel_sub")}
              onClick={() => push({ kind: "user", id: user.id, name: user.nickname })}
            />
          </CollectionLinks>
        )}

        {/* Tab Content Area */}
        <div className="mt-3.5">
          {tab === "downloads" ? (
            <div className="flex flex-col gap-3">
              {/* Downloads Subheader */}
              <div className="flex items-center justify-between px-1 mb-1">
                <div className="flex items-center gap-1.5 text-[13px] font-bold text-on">
                  <IDownload size={14} className="text-primary" />
                  <span>{t("profile.downloads")}</span>
                  <span className="text-[11.5px] text-mut font-normal tabular-nums">
                    ({downloads.length} {downloads.length === 1 ? "ep" : "eps"} · {(totalDownloadsBytes / (1024 * 1024)).toFixed(1)} MB)
                  </span>
                </div>

                {downloads.length > 0 && (
                  <div className="flex items-center gap-2">
                    {selectMode ? (
                      <>
                        <button
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
                          onClick={() => setSelectMode(true)}
                          className="text-[11.5px] font-semibold text-primary px-2 py-1 rounded-lg hover:bg-primary/10 pressable transition-colors"
                        >
                          Select
                        </button>
                        <button
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
                                onTouchEnd={(e) => {
                                  e.stopPropagation();
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
            <div className="flex justify-center py-12">
              <Loader className="w-7 h-7 spinner" />
            </div>
          ) : cards.length ? (
            <div className="flex flex-col gap-2.5">
              {/* Sub-header with actions */}
              <div className="flex items-center justify-between px-1 py-1">
                <div className="text-[13px] font-bold text-on flex items-center gap-1.5">
                  {tab === "fav" ? (
                    <>
                      <IStarF size={14} className="text-amber-400" />
                      <span>{t("profile.favorites")}</span>
                    </>
                  ) : tab === "watchlater" ? (
                    <>
                      <IClock size={14} className="text-primary" />
                      <span>{t("profile.watch_later")}</span>
                    </>
                  ) : (
                    <>
                      <IHist size={14} className="text-primary" />
                      <span>{t("profile.history")}</span>
                    </>
                  )}
                  <span className="text-[11.5px] text-mut font-normal tabular-nums">
                    ({cards.length})
                  </span>
                </div>

                <div className="flex items-center gap-1.5">
                  {tab === "watchlater" && cards.length > 0 && (
                    <Button
                      onClick={openBatchDownloadWatchLater}
                      className="px-2.5 py-1 rounded-lg bg-primary/20 text-primary hover:bg-primary/30 text-[11px] font-bold flex items-center gap-1 pressable"
                    >
                      <IDownload size={12} />
                      <span>Download All</span>
                    </Button>
                  )}

                  {tab === "fav" && (
                    <Button
                      onClick={() => {
                        clearFavs();
                        toast(t("player.unfavorited"), "info");
                      }}
                      className="text-[11.5px] font-semibold text-mut hover:text-red-400 px-2 py-1 rounded-lg hover:bg-s3 pressable transition-colors"
                    >
                      {t("search.clear")}
                    </Button>
                  )}

                  {tab === "history" && (
                    <Button
                      onClick={clearHistory}
                      className="text-[11.5px] font-semibold text-mut hover:text-red-400 px-2 py-1 rounded-lg hover:bg-s3 pressable transition-colors"
                    >
                      {t("search.clear")}
                    </Button>
                  )}

                  {tab === "watchlater" && (
                    <Button
                      onClick={clearWatchLater}
                      className="text-[11.5px] font-semibold text-mut hover:text-red-400 px-2 py-1 rounded-lg hover:bg-s3 pressable transition-colors"
                    >
                      {t("search.clear")}
                    </Button>
                  )}
                </div>
              </div>

              {/* Media Card Grid */}
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
                            tab === "fav"
                              ? t("profile.favorites")
                              : tab === "watchlater"
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
              icon={tab === "fav" ? <IStar size={24} /> : <IClock size={24} />}
              title={
                tab === "fav"
                  ? t("profile.no_favs")
                  : tab === "watchlater"
                  ? t("profile.no_watch_later")
                  : t("profile.no_hist")
              }
              sub={
                tab === "fav"
                  ? t("profile.no_favs_sub")
                  : tab === "watchlater"
                  ? t("profile.no_watch_later_sub")
                  : t("profile.no_hist_sub")
              }
              action={t("profile.explore")}
              onAction={() => push({ kind: "ranks" })}
            />
          )}
        </div>

        {/* Quiet Handcrafted Branding Footer */}
        <div className="text-center text-[11.5px] text-mut/60 mt-6 mb-8 tracking-tight">
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
