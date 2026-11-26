import { Button, Surface } from "../components/ios/controls";
import { Loader } from "../components/ios/effects";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, fmt } from "../api";
import type { UserProfile, VideoCard } from "../types";
import { useStore } from "../store";
import { Masonry } from "../components/cards";
import { InplaceSearch } from "../components/InplaceSearch";
import { Avatar, Empty } from "../components/ui";
import { IBack, IGrid, ISearch, IUser } from "../icons";
import { formatDramaAuthor, formatDramaDesc } from "../subtitles/dramaTranslator";
import { localizeError } from "../i18n";

/* ================= Following Feed ================= */
export function FollowingPage({ onBack, wide }: { onBack: () => void; wide: boolean }) {
  const { push, user, setLoginOpen, toast } = useStore();
  const [searching, setSearching] = useState(false);
  const [items, setItems] = useState<VideoCard[]>([]);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const busy = useRef(false);
  const sentinel = useRef<HTMLDivElement>(null);
  const loadMoreRef = useRef<() => void>(() => {});

  const loadMore = useCallback(async () => {
    if (busy.current || page >= pages) return;
    busy.current = true;
    setLoading(true);
    try {
      const next = page + 1;
      const res = await api.following(next, 20);
      setItems((prev) => {
        const seen = new Set(prev.map((x) => x.id));
        return [...prev, ...(res?.items || []).filter((x) => !seen.has(x.id))];
      });
      setPage(next);
      setPages(res?.pagination?.pages || next);
      setErr("");
    } catch (e) {
      const msg = localizeError(e);
      setErr(msg);
      toast(msg, "info");
    } finally {
      busy.current = false;
      setLoading(false);
    }
  }, [page, pages, toast]);
  loadMoreRef.current = () => { void loadMore(); };

  useEffect(() => {
    if (!user) {
      setItems([]);
      setPage(0);
      setPages(1);
      setErr("");
      return;
    }
    void loadMore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => { if (es[0].isIntersecting) loadMoreRef.current(); }, { rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div className="ios-page absolute inset-0 bg-bg flex flex-col">
      <div className="shrink-0 bg-s1" style={{ paddingTop: "var(--sat, 0px)" }}>
        <div className="px-3 pt-2 pb-3 flex items-center gap-2.5">
          <Button aria-label="Back" onClick={onBack} className="w-10 h-10 rounded-full flex items-center justify-center text-on hover:bg-s3 pressable"><IBack size={20} /></Button>
          <span className="text-[17px] font-bold text-on">Following</span>
          <span className="text-[12px] text-mut">{items.length} titles</span>
          <Button onClick={() => setSearching(true)} aria-label="Search dramas" className="ml-auto w-10 h-10 rounded-full flex items-center justify-center text-on hover:bg-s3 pressable"><ISearch size={19} /></Button>
        </div>
      </div>

      <div className="flex-1 scroll-y px-4 pt-3 pb-[calc(var(--sab,48px)+24px)]">
        {!user ? (
          <Empty icon={<IUser size={26} />} title="Sign in to view following" sub="Follow your favorite creators to stay updated on their latest releases"
            action="Sign In" onAction={() => setLoginOpen(true)} />
        ) : loading && !items.length ? (
          <div className="flex justify-center py-12"><Loader className="w-8 h-8 spinner" /></div>
        ) : err && !items.length ? (
          <Empty icon={<IGrid size={26} />} title="Failed to load" sub={err} action="Retry" onAction={loadMore} />
        ) : items.length ? (
          <Masonry videos={items} wide={wide} onOpen={(v) => push({ kind: "feed", videoIds: items.map((x) => x.id), index: items.findIndex((x) => x.id === v.id), title: "Following" })} />
        ) : (
          <Empty icon={<IGrid size={26} />} title="No followed creators yet" sub="Discover and follow creators to see their updates right here" />
        )}
        <div ref={sentinel} className="h-8" />
        {loading && items.length > 0 && <div className="flex justify-center py-3"><Loader className="w-6 h-6 spinner" /></div>}
        {!loading && items.length > 0 && page >= pages && <div className="text-center text-[12px] text-dim py-3">— You've reached the end —</div>}
      </div>
      {searching && <InplaceSearch kind="video" wide={wide} onClose={() => setSearching(false)} onOpenVideo={(v, list) => push({ kind: "feed", videoIds: list.map((x) => x.id), index: list.findIndex((x) => x.id === v.id), title: "Following" })} />}
    </div>
  );
}

/* ================= Creator Profile Page ================= */
export function UserPage({ id, name, onBack, wide }: { id: number; name?: string; onBack: () => void; wide: boolean }) {
  const { push, toast, follows, toggleFollowLocal, user } = useStore();
  const [searching, setSearching] = useState(false);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [stats, setStats] = useState<{ followers?: number; video_count?: number; post_count?: number; like_count?: number }>({});
  const [items, setItems] = useState<VideoCard[]>([]);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const busy = useRef(false);
  const sentinel = useRef<HTMLDivElement>(null);
  const loadMoreRef = useRef<() => void>(() => {});
  const idRef = useRef(id);
  idRef.current = id;

  useEffect(() => {
    let alive = true;
    api.user(id).then((u) => { if (alive) setProfile(u); }).catch(() => {});
    api.userStats(id).then((s) => { if (alive) setStats(s); }).catch(() => {});
    return () => { alive = false; };
  }, [id]);

  const loadMore = useCallback(async (forcePage?: number) => {
    if (busy.current || (forcePage === undefined && page >= pages)) return;
    const targetId = id;
    busy.current = true;
    setLoading(true);
    try {
      const next = forcePage ?? page + 1;
      const res = await api.userVideos(targetId, next, 20);
      if (idRef.current !== targetId) return;
      setItems((prev) => {
        const base = next === 1 ? [] : prev;
        const seen = new Set(base.map((x) => x.id));
        return [...base, ...(res?.items || []).filter((x) => !seen.has(x.id))];
      });
      setPage(next);
      setPages(res?.pagination?.pages || next);
      setErr("");
    } catch (e) {
      if (idRef.current !== targetId) return;
      const msg = localizeError(e);
      setErr(msg);
      toast(msg, "info");
    } finally {
      busy.current = false;
      setLoading(false);
    }
  }, [id, page, pages, toast]);
  loadMoreRef.current = () => { void loadMore(); };

  useEffect(() => {
    setItems([]);
    setPage(0);
    setPages(1);
    setErr("");
    void loadMore(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => { if (es[0].isIntersecting) loadMoreRef.current(); }, { rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const following = follows.includes(id);
  const onFollow = () => {
    const on = toggleFollowLocal(id);
    toast(on ? `Followed ${profile?.nickname || name || ""}` : "Unfollowed", on ? "ok" : "info");
    if (user) {
      api.follow(id, on).catch(() => {});
    }
  };

  const creatorName = formatDramaAuthor(profile?.nickname || name);

  return (
    <div className="ios-page absolute inset-0 bg-bg flex flex-col">
      <div className="shrink-0 bg-s1" style={{ paddingTop: "var(--sat, 0px)" }}>
        <div className="px-3 pt-2 pb-3 flex items-center gap-2.5">
          <Button aria-label="Back" onClick={onBack} className="w-10 h-10 rounded-full flex items-center justify-center text-on hover:bg-s3 pressable"><IBack size={20} /></Button>
          <span className="text-[16px] font-bold text-on truncate">{creatorName || "Creator Profile"}</span>
          <Button onClick={() => setSearching(true)} aria-label="Search dramas" className="ml-auto w-10 h-10 rounded-full flex items-center justify-center text-on hover:bg-s3 pressable"><ISearch size={19} /></Button>
        </div>
      </div>

      <div className="flex-1 scroll-y px-4 pt-3 pb-[calc(var(--sab,48px)+24px)]">
        {/* Profile Card */}
        <Surface className="rounded-(--r-lg) bg-s1 p-4 elev-1 flex items-center gap-3.5 a-rise">
          <Avatar size={56} src={profile?.avatar} name={creatorName || "U"} hue={220} ring />
          <div className="flex-1 min-w-0">
            <div className="text-[16px] font-bold text-on truncate">{creatorName || "Creator"}</div>
            {profile?.username && <div className="text-[12px] text-mut mt-0.5 truncate">@{profile.username} · ID {id}</div>}
            <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2 text-[12px] text-mut">
              <span>Dramas <b className="text-on">{fmt(stats.video_count)}</b></span>
              <span>Followers <b className="text-on">{fmt(stats.followers)}</b></span>
              <span>Likes <b className="text-on">{fmt(stats.like_count)}</b></span>
            </div>
          </div>
          <Button onClick={onFollow}
            className={`h-9 px-3.5 rounded-full text-[12.5px] font-semibold pressable shrink-0 ${following ? "bg-s3 text-mut" : "bg-primary text-on-primary"}`}>
            {following ? "Following" : "+ Follow"}
          </Button>
        </Surface>

        {profile?.sign && <div className="mt-3 text-[13px] text-mut leading-relaxed">{formatDramaDesc(profile.sign)}</div>}

        <div className="mt-4 mb-2.5 text-[14px] font-bold text-on">Dramas {items.length ? `(${items.length})` : ""}</div>

        {loading && !items.length ? (
          <div className="flex justify-center py-12"><Loader className="w-8 h-8 spinner" /></div>
        ) : err && !items.length ? (
          <Empty icon={<IGrid size={26} />} title="Failed to load" sub={err} action="Retry" onAction={loadMore} />
        ) : items.length ? (
          <Masonry videos={items} wide={wide} onOpen={(v) => push({ kind: "feed", videoIds: items.map((x) => x.id), index: items.findIndex((x) => x.id === v.id), title: creatorName || "Creator Dramas" })} />
        ) : (
          <Empty icon={<IGrid size={26} />} title="No dramas posted yet" />
        )}
        <div ref={sentinel} className="h-8" />
        {loading && items.length > 0 && <div className="flex justify-center py-3"><Loader className="w-6 h-6 spinner" /></div>}
        {!loading && items.length > 0 && page >= pages && <div className="text-center text-[12px] text-dim py-3">— You've reached the end —</div>}
      </div>
      {searching && <InplaceSearch kind="video" wide={wide} onClose={() => setSearching(false)} onOpenVideo={(v, list) => push({ kind: "feed", videoIds: list.map((x) => x.id), index: list.findIndex((x) => x.id === v.id), title: profile?.nickname || name || "Creator Dramas" })} />}
    </div>
  );
}
