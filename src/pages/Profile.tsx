import { Button, SegmentedControl, Surface } from "../components/ios/controls";
import { Loader } from "../components/ios/effects";
import { useEffect, useMemo, useState } from "react";
import { api, APP_VERSION, cover as getCoverUrl, fmt, fmtTime, isLocalMedia, isMobile, platform } from "../api";
import type { Detail } from "../types";
import { useStore } from "../store";
import { Avatar, Empty, Modal, Toggle } from "../components/ui";
import { MediaCard } from "../components/cards";
import { CollectionLink, CollectionLinks } from "../components/CollectionLink";
import ExportSheet from "../components/ExportSheet";
import { IBoltF, ICheck, IChevR, IClock, IClose, IDownload, IExport, ILogout, IPauseF, IPlayF, ISettings, IShare, IStar, ITrash, IUser, IUserF } from "../icons";
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
import { processEpisodeExport, type ExportAction } from "../offline/exportService";
import { formatDramaTag, formatDramaTitle } from "../subtitles/dramaTranslator";

/* Profile: User card + Favorites, Watch Later, History, and Downloads. */
function OfflineDramaCover({ coverUrl, title, epCount }: { coverUrl?: string; title: string; epCount: number }) {
  const [err, setErr] = useState(false);
  const src = useMemo(() => {
    if (!coverUrl) return "";
    return getCoverUrl(coverUrl, 240);
  }, [coverUrl]);

  useEffect(() => {
    setErr(false);
  }, [src]);

  return (
    <div className="relative w-18 h-24 rounded-xl overflow-hidden shrink-0 bg-s3 shadow-sm border border-edge/40 flex items-center justify-center">
      {src && !err ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setErr(true)}
          className="w-full h-full object-cover"
        />
      ) : (
        <div className="w-full h-full flex flex-col items-center justify-center bg-primary/10 text-primary p-1 text-center">
          <span className="text-base font-black">{title.charAt(0) || "A"}</span>
          <span className="text-[10px] font-bold opacity-80">Drama</span>
        </div>
      )}
      <span className="absolute bottom-1 right-1 px-1.5 py-0.5 rounded-md bg-black/80 text-[10px] font-bold text-white tracking-tight">
        {epCount} eps
      </span>
    </div>
  );
}

export default function Profile({ wide }: { wide: boolean }) {
  const { user, setLoginOpen, logout, history, favs, clearFavs, watchLater, clearWatchLater, clearHistory, push, t, toast } = useStore();
  const [tab, setTab] = useState<"fav" | "watchlater" | "history" | "downloads">("fav");
  const [cards, setCards] = useState<Detail[]>([]);
  const [downloads, setDownloads] = useState<OfflineEpisode[]>(() => getOfflineEpisodes());
  const [storageStats, setStorageStats] = useState<DeviceStorageStats | null>(null);
  const [batchProgress, setBatchProgress] = useState<BatchProgressState>(getBatchProgress);
  const [activeDownloads, setActiveDownloads] = useState<ActiveDownloadProgress[]>([]);
  const [activeSummary, setActiveSummary] = useState(getActiveDownloadsSummary);
  const [loading, setLoading] = useState(false);
  const [expandedDramaId, setExpandedDramaId] = useState<number | null>(null);
  const [confirmClearAllOpen, setConfirmClearAllOpen] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());

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
    toast(`Deleted ${itemsToDelete.length} offline ${itemsToDelete.length === 1 ? "episode" : "episodes"}`, "ok");
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

  const dramaGroups = useMemo(() => {
    const map = new Map<number, {
      videoId: number;
      title: string;
      cover: string;
      episodes: OfflineEpisode[];
      totalBytes: number;
    }>();

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
      grp.totalBytes += (item.sizeBytes || 0);
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

  const openDramaBatchExport = (videoId: number, title: string, eps: number[]) => {
    setExportSheetState({
      isOpen: true,
      videoId,
      title,
      batchEpisodes: eps,
    });
  };

  const openExportAllDownloads = () => {
    if (downloads.length === 0) return;
    setExportSheetState({
      isOpen: true,
      videoId: 0,
      title: "All Saved Episodes",
      batchItems: downloads.map((d) => ({
        videoId: d.videoId,
        episode: d.episode,
        title: d.title,
      })),
    });
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

  const ids = tab === "fav" ? favs : tab === "watchlater" ? watchLater : tab === "history" ? history.map((h) => h.id) : [];
  /** Playback progress in watch history */
  const progressOf = (id: number) => (tab === "history" ? history.find((h) => h.id === id) : undefined);

  useEffect(() => {
    let alive = true;
    if (!ids.length) { setCards([]); return; }
    setLoading(true);
    Promise.allSettled(ids.slice(0, 16).map((id) => api.video(id)))
      .then((rs) => {
        if (!alive) return;
        const fetched = rs.filter((r) => r.status === "fulfilled").map((r) => (r as PromiseFulfilledResult<Detail>).value);
        if (tab === "history") {
          const map = new Map(fetched.map((c) => [c.id, c]));
          const combined = ids.slice(0, 16).map((id) => {
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
          }).filter(Boolean) as Detail[];
          setCards(combined);
        } else {
          setCards(fetched);
        }
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [ids.join(","), tab]);

  return (
    <div className="ios-page absolute inset-0 bg-bg flex flex-col">
      <div className="ios-page-heading shrink-0 px-4 flex items-center">
        <div className="ios-page-title text-on">{t("profile.title")}</div>
        {isMobile && (
          <Button onClick={() => push({ kind: "settings" })} aria-label={t("settings.title")}
            className="ios-icon-button ml-auto">
            <ISettings size={17} strokeWidth={1.7} />
          </Button>
        )}
      </div>

      <div className="ios-page-body flex-1 scroll-y px-4 pt-2 pb-52">
        {/* Profile Card: Signed in vs Guest */}
        {user ? (
          <Surface className="ios-account-card w-full flex flex-col p-4 gap-3.5 a-rise">
            <div className="flex items-center gap-3.5 w-full">
              <Avatar size={50} src={user.avatar} name={user.nickname} hue={280} ring />
              <div className="flex-1 min-w-0">
                <div className="text-[16px] font-bold text-on truncate">{user.nickname}</div>
                <div className="text-[12px] text-mut mt-0.5 truncate">@{user.username} · ID {user.id}</div>
                <div className="flex gap-3 mt-1 text-[11px] text-mut">
                  <span>{t("profile.likes")} <b className="text-on">{fmt(user.counts?.like)}</b></span>
                  <span>{t("profile.following")} <b className="text-on">{fmt(user.counts?.following)}</b></span>
                </div>
              </div>
              <Button onClick={async () => { await logout(); }}
                className="ios-icon-button shrink-0" aria-label={t("profile.logout")}>
                <ILogout size={17} />
              </Button>
            </div>
            <div className="grid grid-cols-4 gap-1 pt-3 border-t border-edge/40 w-full text-center">
              <button onClick={() => setTab("fav")} className="flex flex-col items-center py-1 rounded-xl hover:bg-s3/50 transition-colors pressable">
                <span className="text-[15px] font-bold text-on tabular-nums">{favs.length}</span>
                <span className="text-[11px] text-mut font-medium">{t("profile.favorites")}</span>
              </button>
              <button onClick={() => setTab("watchlater")} className="flex flex-col items-center py-1 rounded-xl hover:bg-s3/50 transition-colors pressable">
                <span className="text-[15px] font-bold text-on tabular-nums">{watchLater?.length || 0}</span>
                <span className="text-[11px] text-mut font-medium">{t("profile.watch_later")}</span>
              </button>
              <button onClick={() => setTab("history")} className="flex flex-col items-center py-1 rounded-xl hover:bg-s3/50 transition-colors pressable">
                <span className="text-[15px] font-bold text-on tabular-nums">{history.length}</span>
                <span className="text-[11px] text-mut font-medium">{t("profile.history")}</span>
              </button>
              <button onClick={() => setTab("downloads")} className="flex flex-col items-center py-1 rounded-xl hover:bg-s3/50 transition-colors pressable">
                <span className="text-[15px] font-bold text-on tabular-nums">{downloads.length}</span>
                <span className="text-[11px] text-mut font-medium">{t("profile.downloads")}</span>
              </button>
            </div>
          </Surface>
        ) : (
          <Surface className="ios-account-card w-full flex flex-col p-4 gap-3.5 a-rise">
            <div className="flex items-center gap-3.5 w-full">
              <div className="relative shrink-0">
                <Avatar size={50} icon={<IUser size={24} />} hue={220} ring />
                <span className="absolute bottom-0 right-0 w-3 h-3 rounded-full bg-emerald-500 border-2 border-canvas shadow-sm" title={t("profile.local_active")} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[16px] font-bold text-on tracking-tight leading-tight truncate">
                  {t("profile.my_library")}
                </div>
                <div className="flex items-center gap-1.5 text-[11.5px] text-mut mt-1">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />
                  <span className="truncate">{t("profile.private_device")}</span>
                </div>
              </div>
              <Button
                onClick={() => setLoginOpen(true)}
                className="flex items-center gap-1 h-8 px-3 rounded-full bg-s3 hover:bg-s4 text-mut hover:text-on text-[11.5px] font-semibold shrink-0 pressable border border-edge/40 transition-colors"
                title={t("profile.sync_title")}
              >
                <span>{t("profile.sync_btn")}</span>
                <IChevR size={12} />
              </Button>
            </div>
            <div className="grid grid-cols-4 gap-1 pt-3 border-t border-edge/40 w-full text-center">
              <button onClick={() => setTab("fav")} className="flex flex-col items-center py-1 rounded-xl hover:bg-s3/50 transition-colors pressable">
                <span className="text-[15px] font-bold text-on tabular-nums">{favs.length}</span>
                <span className="text-[11px] text-mut font-medium">{t("profile.favorites")}</span>
              </button>
              <button onClick={() => setTab("watchlater")} className="flex flex-col items-center py-1 rounded-xl hover:bg-s3/50 transition-colors pressable">
                <span className="text-[15px] font-bold text-on tabular-nums">{watchLater?.length || 0}</span>
                <span className="text-[11px] text-mut font-medium">{t("profile.watch_later")}</span>
              </button>
              <button onClick={() => setTab("history")} className="flex flex-col items-center py-1 rounded-xl hover:bg-s3/50 transition-colors pressable">
                <span className="text-[15px] font-bold text-on tabular-nums">{history.length}</span>
                <span className="text-[11px] text-mut font-medium">{t("profile.history")}</span>
              </button>
              <button onClick={() => setTab("downloads")} className="flex flex-col items-center py-1 rounded-xl hover:bg-s3/50 transition-colors pressable">
                <span className="text-[15px] font-bold text-on tabular-nums">{downloads.length}</span>
                <span className="text-[11px] text-mut font-medium">{t("profile.downloads")}</span>
              </button>
            </div>
          </Surface>
        )}

        {/* User extra navigation links */}
        {user && (
          <CollectionLinks className="ios-profile-links mt-4">
            <CollectionLink icon={<IUserF size={18} className="text-primary" />} title={t("profile.following")} subtitle={t("profile.following_sub")}
              onClick={() => push({ kind: "following" })} />
            <CollectionLink icon={<IUserF size={18} />} title={t("profile.my_channel")} subtitle={t("profile.my_channel_sub")}
              onClick={() => push({ kind: "user", id: user.id, name: user.nickname })} />
          </CollectionLinks>
        )}

        {/* Favorites, Watch Later, History & Downloads tabs */}
        <SegmentedControl
          className="mt-4"
          aria-label="Collections"
          activeIndex={tab === "fav" ? 0 : tab === "watchlater" ? 1 : tab === "history" ? 2 : 3}
        >
          {([
            ["fav", t("profile.favorites")],
            ["watchlater", t("profile.watch_later")],
            ["history", t("profile.history")],
            ["downloads", t("profile.downloads")],
          ] as const).map(([k, l]) => (
            <Button aria-pressed={tab === k} key={k} onClick={() => setTab(k)} className="whitespace-nowrap px-1 text-[12px] sm:text-[13px] font-semibold">{l}</Button>
          ))}
        </SegmentedControl>

        <div className="mt-3">
          {tab === "downloads" ? (
            <div className="flex flex-col gap-3">
              {/* Clean, Consumer-Grade Downloads Header */}
              <div className="p-3.5 rounded-2xl bg-s2 border border-edge/60 shadow-xs flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5 min-w-0 flex-1">
                  <div className="w-9 h-9 rounded-xl bg-primary/15 text-primary flex items-center justify-center shrink-0">
                    <IDownload size={18} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-[14px] font-bold text-on leading-tight truncate">
                      {t("profile.downloads")}
                    </div>
                    <div className="text-[11.5px] text-mut mt-0.5 flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-on">
                        {downloads.length} {downloads.length === 1 ? "episode" : "episodes"}
                      </span>
                      <span>·</span>
                      <span className="px-1.5 py-0.5 rounded-md bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 font-bold text-[11px]">
                        {(totalDownloadsBytes / (1024 * 1024)).toFixed(1)} MB total
                      </span>
                    </div>
                  </div>
                </div>

                {downloads.length > 0 && (
                  <div className="flex items-center gap-1.5 shrink-0">
                    {selectMode ? (
                      <>
                        <Button
                          onClick={() => {
                            if (selectedKeys.size === downloads.length) {
                              setSelectedKeys(new Set());
                            } else {
                              setSelectedKeys(new Set(downloads.map((d) => `${d.videoId}_${d.episode}`)));
                            }
                          }}
                          className="px-2.5 py-1 rounded-lg bg-s3 text-[11px] font-semibold text-on pressable"
                        >
                          {selectedKeys.size === downloads.length ? "Deselect" : "Select All"}
                        </Button>
                        <Button
                          onClick={openExportSelected}
                          disabled={selectedKeys.size === 0}
                          className="px-2.5 py-1 rounded-lg bg-primary/15 text-primary disabled:opacity-40 text-[11px] font-bold flex items-center gap-1 pressable"
                        >
                          <IExport size={12} /> Export ({selectedKeys.size})
                        </Button>
                        <Button
                          onClick={deleteSelected}
                          disabled={selectedKeys.size === 0}
                          className="px-2.5 py-1 rounded-lg bg-red-500 text-white disabled:opacity-40 text-[11px] font-bold flex items-center gap-1 pressable"
                        >
                          <ITrash size={12} /> Delete ({selectedKeys.size})
                        </Button>
                        <Button
                          onClick={() => {
                            setSelectMode(false);
                            setSelectedKeys(new Set());
                          }}
                          className="px-2.5 py-1 rounded-lg bg-primary/20 text-primary text-[11px] font-bold pressable"
                        >
                          Done
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button
                          onClick={() => setSelectMode(true)}
                          className="px-2.5 py-1 rounded-lg bg-s3 hover:bg-s4 text-[11px] font-semibold text-on flex items-center gap-1 pressable"
                        >
                          Select
                        </Button>
                        <Button
                          onClick={() => setConfirmClearAllOpen(true)}
                          className="px-2 py-1 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-[11px] font-semibold text-red-500 flex items-center gap-1 pressable"
                          title="Delete all downloads"
                        >
                          <ITrash size={12} /> Clear
                        </Button>
                      </>
                    )}
                  </div>
                )}
              </div>

              {/* Batch Downloader Active Banner */}
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
                      <IClose size={12} /> Cancel Batch
                    </Button>
                  </div>
                  <div className="text-[12px] text-on truncate font-medium">
                    {batchProgress.title || "Downloading Series"}
                  </div>
                  <div className="w-full h-2 rounded-full bg-white/10 overflow-hidden">
                    <div
                      className="h-full bg-primary transition-all duration-300"
                      style={{
                        width: `${batchProgress.total > 0 ? (batchProgress.completed / batchProgress.total) * 100 : 0}%`
                      }}
                    />
                  </div>
                  <div className="flex items-center justify-between text-[11px] text-mut">
                    <span>
                      Episode {batchProgress.currentEpisode} ({batchProgress.completed} of {batchProgress.total})
                    </span>
                    <span className="text-primary font-semibold">
                      {batchProgress.total > 0 ? Math.round((batchProgress.completed / batchProgress.total) * 100) : 0}%
                    </span>
                  </div>
                </div>
              )}

              {/* Active Downloads Section (if any in progress) */}
              {activeDownloads.length > 0 && (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between px-1">
                    <div className="text-[12px] font-semibold text-mut flex items-center gap-1.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
                      {t("profile.active_downloads", { count: activeDownloads.length })}
                      {activeSummary.aggregateSpeedBytesPerSec > 0 && (
                        <span className="ml-1 px-1.5 py-0.5 rounded-md bg-primary/15 text-primary text-[10px] font-bold inline-flex items-center gap-1">
                          <IBoltF size={10} className="shrink-0" />
                          <span>{activeSummary.aggregateSpeedFormatted}</span>
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5">
                      {activeDownloads.some((a) => a.status === "downloading") ? (
                        <Button
                          onClick={() => pauseAllDownloads()}
                          className="px-2 py-0.5 rounded-lg bg-s3 text-[11px] font-semibold text-mut hover:text-on pressable"
                        >
                          {t("profile.pause_all")}
                        </Button>
                      ) : (
                        <Button
                          onClick={() => void resumeAllDownloads()}
                          className="px-2 py-0.5 rounded-lg bg-primary/20 text-[11px] font-semibold text-primary pressable"
                        >
                          {t("profile.resume_all")}
                        </Button>
                      )}
                    </div>
                  </div>
                  {activeDownloads.map((ad) => (
                    <div key={ad.id} className="p-3 rounded-2xl bg-s2 border border-primary/20 flex flex-col gap-2">
                      <div className="flex items-center justify-between">
                        <div className="flex-1 min-w-0 pr-2">
                          <div className="text-[13px] font-bold text-on truncate">{ad.title || `Episode ${ad.episode}`}</div>
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
                              className="w-7 h-7 rounded-lg bg-primary text-on-primary flex items-center justify-center pressable"
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
                          className={`h-full transition-all duration-200 ${ad.status === "paused" ? "bg-amber-400" : "bg-primary"}`}
                          style={{ width: `${ad.progress}%` }}
                        />
                      </div>

                      <div className="flex items-center justify-between text-[11px] tabular-nums">
                        <span className="font-bold text-primary">
                          {ad.progress}% · {formatBytes(ad.downloadedBytes)} / {ad.totalBytes > 0 ? formatBytes(ad.totalBytes) : "calculating..."}
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

              {/* Grouped Downloaded Episodes List */}
              {dramaGroups.length > 0 ? (
                <div className="flex flex-col gap-4">
                  {dramaGroups.map((group) => (
                    <div key={group.videoId} className="rounded-2xl bg-s2 border border-edge/60 overflow-hidden">
                      <div
                        onClick={() => {
                          if (!selectMode && group.episodes[0]) {
                            push({
                              kind: "feed",
                              videoIds: [group.videoId],
                              index: 0,
                              title: formatDramaTitle(group.title),
                              startEp: group.episodes[0].episode,
                            });
                          }
                        }}
                        className={`p-3.5 flex items-center gap-3 bg-s3/50 border-b border-edge/60 ${
                          selectMode ? "" : "cursor-pointer pressable hover:bg-s3/80 transition-colors"
                        }`}
                      >
                        <div className="w-12 h-16 rounded-lg overflow-hidden shrink-0 shadow-xs border border-edge/40">
                           <img src={getCoverUrl(group.cover, 160)} className="w-full h-full object-cover" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-[15px] font-bold text-on truncate">{formatDramaTitle(group.title)}</div>
                          <div className="text-[12px] text-mut mt-0.5">
                            {group.episodes.length} episodes · {(group.totalBytes / (1024 * 1024)).toFixed(1)} MB
                          </div>
                        </div>
                      </div>
                      
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
                            className={`p-3.5 flex items-center gap-3 border-b border-edge/30 last:border-b-0 transition-colors cursor-pointer pressable ${
                              isChecked ? "bg-primary/10" : "hover:bg-s3/30 active:bg-s3/50"
                            }`}
                          >
                            {selectMode ? (
                              <div className={`w-5 h-5 rounded-md flex items-center justify-center shrink-0 border ${isChecked ? "bg-primary border-primary" : "border-edge"}`}>
                                {isChecked && <ICheck size={13} className="text-black" strokeWidth={3} />}
                              </div>
                            ) : (
                              <div className="w-6 h-6 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 flex items-center justify-center shrink-0">
                                <IPlayF size={10} />
                              </div>
                            )}
                            
                            <div className="text-[13px] font-medium text-mut w-7 text-right">Ep {item.episode}</div>
                            <div className="flex-1 min-w-0">
                              <div className="text-[14px] font-semibold text-on truncate">{formatDramaTitle(item.title)}</div>
                              <div className="text-[11px] text-mut tabular-nums">{sizeMB} MB</div>
                            </div>
                            <Button
                              onClick={(e) => { e.stopPropagation(); openSingleExport(item.videoId, item.episode, item.title); }}
                              className="ios-icon-button shrink-0"
                              title="Export MP4"
                            >
                              <IExport size={14} />
                            </Button>
                            <Button
                              onClick={async (e) => { 
                                e.stopPropagation();
                                await deleteOfflineEpisode(item.videoId, item.episode);
                                setDownloads(getOfflineEpisodes());
                              }}
                              className="ios-icon-button shrink-0"
                              title="Delete Download"
                            >
                              <ITrash size={14} />
                            </Button>
                          </div>
                        );
                      })}
                    </div>
                  ))}
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
            <div className="flex justify-center py-8"><Loader className="w-7 h-7 spinner" /></div>
          ) : cards.length ? (
            <div className={`ios-media-grid ${wide ? "is-wide" : ""}`}>
              {cards.map((c) => {
                const progress = progressOf(c.id);
                return <MediaCard key={c.id} title={c.title} cover={c.cover} score={c.score}
                  badge={c.is_finished ? "Ended" : `${c.episode_count} eps`}
                  subtitle={c.tags?.slice(0, 2).map(formatDramaTag).join(" · ")}
                  progress={progress ? `Ep. ${progress.ep} · ${fmtTime(progress.t)}` : undefined}
                  onOpen={() => push({
                    kind: "feed", videoIds: cards.map(x => x.id), index: cards.findIndex(x => x.id === c.id),
                    title: tab === "fav" ? t("profile.favorites") : tab === "watchlater" ? t("profile.watch_later") : t("profile.history"), startEp: progress?.ep, startTime: progress?.t,
                  })} />;
              })}
            </div>
          ) : (
            <Empty icon={tab === "fav" ? <IStar size={24} /> : <IClock size={24} />}
              title={tab === "fav" ? t("profile.no_favs") : tab === "watchlater" ? t("profile.no_watch_later") : t("profile.no_hist")}
              sub={tab === "fav" ? t("profile.no_favs_sub") : tab === "watchlater" ? t("profile.no_watch_later_sub") : t("profile.no_hist_sub")}
              action={t("profile.explore")} onAction={() => push({ kind: "ranks" })} />
          )}
          {cards.length > 0 && tab === "fav" && (
            <Button onClick={() => { clearFavs(); toast(t("player.unfavorited"), "info"); }} className="mt-3 w-full h-9 rounded-(--r-ctl) bg-s3 text-[13px] text-mut hover:text-danger pressable transition-colors">{t("search.clear")} {t("profile.favorites")}</Button>
          )}
          {cards.length > 0 && tab === "history" && (
            <Button onClick={clearHistory} className="mt-3 w-full h-9 rounded-(--r-ctl) bg-s3 text-[13px] text-mut pressable">{t("search.clear")} {t("profile.history")}</Button>
          )}
          {cards.length > 0 && tab === "watchlater" && (
            <div className="flex items-center gap-2 mt-3">
              <Button
                onClick={() => {
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
                }}
                className="flex-1 h-9 rounded-(--r-ctl) bg-primary/20 hover:bg-primary/30 text-primary font-bold text-[13px] flex items-center justify-center gap-1.5 pressable"
              >
                <IDownload size={14} /> {t("profile.download_all_watch_later")}
              </Button>
              <Button onClick={clearWatchLater} className="px-3 h-9 rounded-(--r-ctl) bg-s3 text-[13px] text-mut pressable">{t("search.clear")}</Button>
            </div>
          )}
        </div>

        <div className="text-center text-[12px] text-dim mt-5">AuraStream {APP_VERSION} · This App Created by AAA</div>
      </div>

      <Modal open={confirmClearAllOpen} onClose={() => setConfirmClearAllOpen(false)} label={t("profile.confirm_clear_title")}>
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

      <ExportSheet
        isOpen={exportSheetState.isOpen}
        onClose={() => setExportSheetState((s) => ({ ...s, isOpen: false }))}
        videoId={exportSheetState.videoId}
        episode={exportSheetState.episode}
        title={exportSheetState.title}
        batchEpisodes={exportSheetState.batchEpisodes}
        batchItems={exportSheetState.batchItems}
      />

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
