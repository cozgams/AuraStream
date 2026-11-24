import { Button } from "../components/ios/controls";
import { Loader } from "../components/ios/effects";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Feed from "../components/Feed";
import LinePicker from "../components/LinePicker";
import { api, logLine } from "../api";
import type { VideoCard } from "../types";
import { useStore } from "../store";
import { ISearch } from "../icons";
import { Empty } from "../components/ui";
import { localizeError } from "../i18n";
import { ensureOfflineSyncReady, getOfflineEpisodes } from "../offline/downloadService";
import { autoLineEnabled, triggerImmediateFailover } from "../autoLine";

/* Fisher-Yates shuffle: randomize initial feed items for fresh discovery */
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export default function Home({ active, bottomInset }: { active: boolean; bottomInset: number }) {
  const { toast, lineEpoch } = useStore();
  const [items, setItems] = useState<VideoCard[]>([]);
  const [offlineFallbackMode, setOfflineFallbackMode] = useState(false);
  const [linePickerOpen, setLinePickerOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const loadingRef = useRef(false);
  const failoverAttempted = useRef(false);
  /* Pagination backoff: 5s cooldown on error before retry */
  const retryAt = useRef(0);
  const failStreak = useRef(0);
  const lineEpochRef = useRef(lineEpoch);
  lineEpochRef.current = lineEpoch;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const offlineFallbackRef = useRef(offlineFallbackMode);
  offlineFallbackRef.current = offlineFallbackMode;

  const tryLoadOfflineHome = async (): Promise<boolean> => {
    await ensureOfflineSyncReady().catch(() => {});
    const offline = getOfflineEpisodes();
    if (offline.length === 0) return false;
    const seenDramas = new Set<number>();
    const offlineCards: VideoCard[] = [];
    for (const ep of offline) {
      if (!seenDramas.has(ep.videoId)) {
        seenDramas.add(ep.videoId);
        offlineCards.push({
          id: ep.videoId,
          title: ep.title,
          cover: ep.cover,
          tags: [],
          score: 9.9,
          episode_count: offline.filter((x) => x.videoId === ep.videoId).length,
          total_episodes: offline.filter((x) => x.videoId === ep.videoId).length,
          hot: 1000,
          like_count: 0,
          comment_count: 0,
          collect_count: 0,
          is_finished: false,
          is_original: 1,
        });
      }
    }
    if (offlineCards.length > 0) {
      setOfflineFallbackMode(true);
      setItems(offlineCards);
      setDone(true);
      toast("Offline mode: Playing downloaded dramas", "ok");
      return true;
    }
    return false;
  };

  const load = useCallback(async (p: number): Promise<void> => {
    if (loadingRef.current || (done && p > 1)) return;
    const requestEpoch = lineEpochRef.current;
    let retryAfterLineChange = false;
    loadingRef.current = true;
    setLoading(true);
    setError("");
    try {
      if (p === 1 && (!itemsRef.current.length || offlineFallbackRef.current) && typeof navigator !== "undefined" && navigator.onLine === false) {
        if (await tryLoadOfflineHome()) return;
      }
      const res = await api.feed(p, 30);
      const list = res?.items || [];
      const ordered = p === 1 ? shuffle(list) : list;
      const recoveringOffline = p === 1 && offlineFallbackRef.current;
      setOfflineFallbackMode(false);
      setItems((prev) => {
        if (recoveringOffline) return ordered;
        const seen = new Set(prev.map((x) => x.id));
        return [...prev, ...ordered.filter((x) => !seen.has(x.id))];
      });
      setPage(p);
      failStreak.current = 0;
      retryAt.current = 0;
      if (!list.length || (res?.pagination && p >= res.pagination.pages)) setDone(true);
      else if (p === 1) setDone(false);
    } catch (e) {
      const message = localizeError(e);
      const stale = requestEpoch !== lineEpochRef.current;
      if (!stale) {
        // Fallback to offline downloaded dramas if first page fails and offline dramas exist
        if (p === 1 && !itemsRef.current.length) {
          if (await tryLoadOfflineHome()) return;
          if (autoLineEnabled() && !failoverAttempted.current && /HTTP (500|502|503|504)|network/i.test(message)) {
            failoverAttempted.current = true;
            logLine("[feed] upstream line returned 50x/network error, triggering auto failover");
            try {
              await triggerImmediateFailover("feed-error");
              retryAfterLineChange = true;
            } catch {
              /* Ignore failover errors and display error message */
            }
          }
        }
        setError(message);
        if (p > 1) retryAt.current = Date.now() + 5000;
        if (failStreak.current++ === 0) toast(message, "info");
      }
      /* Re-fetch on new line if line switched while request was in flight */
      if (stale && !itemsRef.current.length) retryAfterLineChange = true;
    } finally {
      loadingRef.current = false;
      setLoading(false);
      if (retryAfterLineChange) {
        setDone(false);
        setError("");
        void load(1);
      }
    }
  }, [done, toast]);

  useEffect(() => { if (!items.length) load(1); /* eslint-disable-next-line */ }, []);

  /* Re-fetch on new line or network recovery if home feed is empty or in offline fallback */
  useEffect(() => {
    if (!lineEpoch || loadingRef.current) return;
    if (itemsRef.current.length && !offlineFallbackRef.current) return;
    setDone(false);
    setError("");
    void load(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lineEpoch]);

  useEffect(() => {
    const onOnline = () => {
      if (loadingRef.current) return;
      if (offlineFallbackRef.current || !itemsRef.current.length || error) {
        setDone(false);
        setError("");
        void load(1);
      }
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [error, load]);

  const ids = useMemo(() => items.map((v) => v.id), [items]);

  return (
    <div className="absolute inset-0 bg-black">
      {items.length ? (
        <Feed videoIds={ids} mode="home" active={active} bottomInset={bottomInset} offlineOnly={offlineFallbackMode}
          onNearEnd={() => { if (!loading && !done && Date.now() >= retryAt.current) load(page + 1); }} />
      ) : !loading && error ? (
        <div className="absolute inset-0 flex items-center justify-center bg-bg">
          <div className="ios-empty flex flex-col items-center justify-center py-8 pb-24 sm:py-14 sm:pb-14 px-6 text-center a-rise">
            <div className="w-14 h-14 rounded-(--r-md) tonal flex items-center justify-center mb-3.5"><ISearch size={26} /></div>
            <div className="text-[15px] sm:text-[16px] font-semibold text-on/90">Failed to load feed</div>
            {error && <div className="text-xs text-mut mt-1 leading-relaxed max-w-xs">{error}</div>}
            <div className="flex items-center gap-3 mt-4">
              <Button onClick={() => void load(1)} className="px-5 h-9 rounded-(--r-ctl) bg-primary text-on-primary text-[13px] font-bold pressable">Retry</Button>
              <Button onClick={() => setLinePickerOpen(true)} className="px-4 h-9 rounded-(--r-ctl) bg-s3 text-on text-[13px] font-medium pressable">Switch Line</Button>
            </div>
          </div>
          <LinePicker open={linePickerOpen} onClose={() => setLinePickerOpen(false)} />
        </div>
      ) : !loading && done ? (
        <div className="absolute inset-0 flex items-center justify-center bg-bg"><Empty icon={<ISearch size={26} />} title="No dramas available" /></div>
      ) : (
        <div className="absolute inset-0 flex items-center justify-center"><Loader className="w-9 h-9 spinner" /></div>
      )}
    </div>
  );
}
