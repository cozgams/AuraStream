import { MediaCard } from "../components/cards";
import { Button, Surface } from "../components/ios/controls";
import { Loader } from "../components/ios/effects";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, cover, fmt, isMobile } from "../api";
import type { Post } from "../types";
import { useStore } from "../store";
import { copyText } from "../clipboard";
import { Empty, Img } from "../components/ui";
import Player from "../components/Player";
import { IBack, IFireF, IPlayF, ISearch } from "../icons";
import { handleArticleClick, parseInternalVideoId, sanitizeHtml } from "../html";
import { InplaceSearch } from "../components/InplaceSearch";
import { formatDramaTag, formatDramaTitle } from "../subtitles/dramaTranslator";
import { localizeError } from "../i18n";

/* ================= Community Buzz List ================= */
export function PostsPage({ onBack, wide }: { onBack: () => void; wide: boolean }) {
  const { push } = useStore();
  const [searching, setSearching] = useState(false);
  const [items, setItems] = useState<Post[]>([]);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const busy = useRef(false);
  const sentinel = useRef<HTMLDivElement>(null);

  const loadMore = async (reset = false) => {
    if (busy.current) return;
    const next = reset ? 1 : page + 1;
    if (!reset && next > pages) return;
    busy.current = true;
    setLoading(true);
    if (reset) setErr("");
    try {
      const res = await api.postCategory("remen-chigua", next, 20, "latest");
      setItems((prev) => {
        const base = reset ? [] : prev;
        const seen = new Set(base.map((x) => x.id));
        return [...base, ...(res?.items || []).filter((x) => x && typeof x.id === "number" && !seen.has(x.id))];
      });
      setPage(next);
      setPages(res?.pagination?.pages || next);
      setErr("");
    } catch (e) {
      setErr(localizeError(e));
    } finally {
      busy.current = false;
      setLoading(false);
    }
  };

  useEffect(() => { loadMore(true); /* eslint-disable-next-line */ }, []);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => { if (es[0].isIntersecting) loadMore(); }, { rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pages]);

  return (
    <div className="ios-page absolute inset-0 bg-bg flex flex-col">
      <div className="shrink-0 flex items-center gap-2 px-2 bg-s1" style={{ paddingTop: "var(--sat, 0px)" }}>
        <Button aria-label="Back" onClick={onBack} className="w-9 h-9 rounded-full flex items-center justify-center text-on hover:bg-s3 pressable"><IBack size={19} /></Button>
        <span className="text-[15px] font-bold text-on">Community Buzz</span>
        <span className="text-[12px] text-mut ml-1">Creator News · Daily Updates</span>
        <Button onClick={() => setSearching(true)} aria-label="Search community" className="ml-auto w-9 h-9 rounded-full flex items-center justify-center text-on hover:bg-s3 pressable"><ISearch size={19} /></Button>
      </div>
      <div className="flex-1 scroll-y px-3 pt-3 pb-36">
        {items.length ? (
          <div className={`ios-media-grid ${wide ? "is-wide" : ""}`}>
            {items.map((p) => (
              <MediaCard key={p.id} title={formatDramaTitle(p.title)} cover={p.cover} subtitle={`${fmt(p.hot)} views`} onOpen={() => push({ kind: "post", id: p.id })} />
            ))}
          </div>
        ) : err ? (
          <Empty icon={<IFireF size={26} />} title="Failed to load posts" sub={err} action="Retry" onAction={() => void loadMore(true)} />
        ) : loading ? (
          <div className="flex justify-center py-12"><Loader className="w-8 h-8 spinner" /></div>
        ) : (
          <Empty icon={<IFireF size={26} />} title="No community posts yet" sub="Check back soon for new updates" action="Refresh" onAction={() => void loadMore(true)} />
        )}
        <div ref={sentinel} className="h-10" />
        {loading && <div className="flex justify-center py-2"><Loader className="w-6 h-6 spinner" /></div>}
      </div>
      {searching && <InplaceSearch kind="post" postLabel="Community Posts" wide={wide} onClose={() => setSearching(false)} onOpenPost={(p) => push({ kind: "post", id: p.id })} />}
    </div>
  );
}

const isHtml = (s: string) => /<(p|div|br|img|h[1-6]|ul|ol|li|blockquote|span|strong|em)\b/i.test(s);
const HIDDEN_POST_TAG = "\u9ec4\u679c";

/* ================= Community Post Detail ================= */
export function PostDetail({ id, onBack, active = true }: { id: number; onBack: () => void; active?: boolean }) {
  const { toast, strictSecurity, muted, setMuted, push } = useStore();
  const [post, setPost] = useState<(Post & { content?: string; video_url?: string }) | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [play, setPlay] = useState(false);
  const [segs, setSegs] = useState<string[]>([]);
  const [seg, setSeg] = useState(0);
  const [resolving, setResolving] = useState(false);
  const content = post?.content || "";
  const src = segs[seg] || "";
  const safeHtml = useMemo(() => sanitizeHtml(content), [content, strictSecurity]);
  const openSafeLink = (url: string) => {
    const videoId = parseInternalVideoId(url);
    if (videoId !== null) {
      push({ kind: "feed", videoIds: [videoId], index: 0, title: post?.title || "Community Buzz" });
      return;
    }
    api.openUrl(url).catch(() => {
      copyText(url).then(() => toast("Link copied", "ok")).catch(() => toast("Failed to copy", "info"));
    });
  };

  const loadPost = useCallback((isMounted: () => boolean = () => true) => {
    setErr(null);
    setPost(null);
    setPlay(false);
    setSegs([]);
    setSeg(0);
    api.post(id)
      .then((p) => {
        if (!isMounted()) return;
        setPost(p);
        if (p.video_url) { setSegs((prev) => (prev.length ? prev : [p.video_url!])); setPlay(true); }
      })
      .catch((e) => { if (isMounted()) setErr(localizeError(e)); });
    setResolving(true);
    api.postPlayback(id)
      .then((r) => {
        if (!isMounted()) return;
        const list = (r?.videos || []).map((v) => v?.url || "").filter(Boolean);
        if (list.length) { setSegs(list); setPlay(true); }
      })
      .catch(() => { /* No video */ })
      .finally(() => { if (isMounted()) setResolving(false); });
  }, [id]);

  useEffect(() => {
    let alive = true;
    loadPost(() => alive);
    return () => { alive = false; };
  }, [loadPost]);

  return (
    <div className="ios-page absolute inset-0 bg-bg flex flex-col">
      <div className="shrink-0 flex items-center gap-2 px-2 bg-s1" style={{ paddingTop: isMobile ? "var(--sat, 0px)" : 0, height: isMobile ? "calc(44px + var(--sat, 0px))" : 44 }}>
        <Button aria-label="Back" onClick={onBack} className="w-9 h-9 rounded-full flex items-center justify-center text-on hover:bg-s3 pressable"><IBack size={19} /></Button>
        <span className="text-[14px] font-semibold text-on">Post Details</span>
      </div>

      <div className="flex-1 scroll-y pb-[calc(var(--sab,48px)+24px)]">
        {err ? (
          <Empty icon={<IFireF size={26} />} title="Failed to load post" sub={err} action="Retry" onAction={() => loadPost()} />
        ) : !post ? (
          <div className="flex justify-center py-12"><Loader className="w-8 h-8 spinner" /></div>
        ) : (
          <>
            <div className="relative w-full bg-black" style={{ height: "min(40vh, 360px)" }}>
              {play && src ? (
                <Player src={src} poster={cover(post.cover)} autoPlay active={active} controls muted={muted}
                  onToggleMute={() => setMuted((m) => !m)} diagnosticContext={{ video_id: id, active }} className="w-full h-full"
                  onEnded={() => {
                    if (seg < segs.length - 1) setSeg(seg + 1); else setPlay(false);
                  }} />
              ) : (
                <Button aria-label={src ? "Play video" : "Post cover"} onClick={() => { if (src) setPlay(true); else if (!resolving) toast("No video attached to this post", "info"); }} className="absolute inset-0">
                  <Img src={post.cover} eager />
                  {src && (
                    <span className="absolute inset-0 flex items-center justify-center">
                      <span className="w-14 h-14 rounded-full bg-black/50 backdrop-blur-sm flex items-center justify-center elev-2">
                        <IPlayF size={24} className="text-white ml-0.5" />
                      </span>
                    </span>
                  )}
                </Button>
              )}
              {segs.length > 1 && (
                <div className="absolute top-2 right-2 z-30 flex items-center gap-1 max-w-[70%] overflow-x-auto no-bar">
                  {segs.map((_, i) => (
                    <Button key={i} onClick={() => { setSeg(i); setPlay(true); }}
                      className="shrink-0 h-6 px-2 rounded-full text-[12px] font-semibold pressable"
                      style={i === seg
                        ? { background: "var(--p-primary)", color: "var(--p-on-primary)" }
                        : { background: "rgba(0,0,0,.55)", color: "rgba(255,255,255,.85)" }}>
                      {i + 1}
                    </Button>
                  ))}
                </div>
              )}
            </div>
            <div className="px-4 pt-3.5">
              <h1 className="text-[17px] font-bold text-on leading-snug">{formatDramaTitle(post.title)}</h1>
              <div className="flex items-center gap-2 mt-2 text-[12px] text-mut">
                <span>{post.publish_time || post.created_at}</span>
                <span className="flex items-center gap-1"><IFireF size={10} />{fmt(post.hot)}</span>
              </div>
              <div className="flex flex-wrap gap-1.5 mt-2.5">
                {(post.tags || []).filter((t) => typeof t === "string" && !t.includes(HIDDEN_POST_TAG)).slice(0, 8).map((t) => (
                  <span key={t} className="px-2 py-0.5 rounded-(--r-ctl) bg-s3 text-[12px] text-on/75">#{formatDramaTag(t)}</span>
                ))}
              </div>
              {post.content && (
                (isHtml(post.content) || (!strictSecurity && /<[a-z][\s\S]*>/i.test(post.content)))
                  ? <div className="article-body mt-3.5" onClick={(e) => handleArticleClick(e, openSafeLink)} dangerouslySetInnerHTML={{ __html: safeHtml }} />
                  : <Surface className="mt-3.5 rounded-(--r-md) bg-s2 p-3.5 text-[14px] leading-relaxed text-on/80 whitespace-pre-wrap">{post.content}</Surface>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
