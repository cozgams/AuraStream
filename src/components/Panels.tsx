import { Button, Form, Image, Input } from "./ios/controls";
import { Loader } from "./ios/effects";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, fmt, cover as imageCover } from "../api";
import { handleArticleClick, sanitizeHtml } from "../html";
import type { Comment, CommentPage, Episode } from "../types";
import { useStore } from "../store";
import { copyText } from "../clipboard";
import { Avatar, Empty } from "./ui";
import { ICheck, IClose, ICommentF, IDownload, ISendF, IStar, IStarF, IVertSwap } from "../icons";
import { formatCommentText, formatDramaAuthor, formatDramaTitle } from "../subtitles/dramaTranslator";
import { commentText, formatRelativeTime } from "../commentText";
import { isEpisodeDownloaded } from "../offline/downloadService";
import { localizeError } from "../i18n";
import BatchDownloadSheet from "./BatchDownloadSheet";

/* ================= Episode Selector ================= */
export function EpisodesPanel({ videoId, episodes, current, onPick, onClose, bare = false, title, cover }: {
  videoId: number; episodes: Episode[]; current: number; onPick: (ep: number) => void; onClose: () => void;
  /** Hides internal header when embedded in split drawer */
  bare?: boolean;
  title?: string;
  cover?: string;
}) {
  const { t } = useStore();
  const [asc, setAsc] = useState(true);
  const [batchOpen, setBatchOpen] = useState(false);
  const [, setDlRev] = useState(0);
  const activeEpRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const onDownloadsChanged = () => setDlRev((r) => r + 1);
    window.addEventListener("aurastream:downloads-changed", onDownloadsChanged);
    return () => window.removeEventListener("aurastream:downloads-changed", onDownloadsChanged);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      activeEpRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 180);
    return () => window.clearTimeout(timer);
  }, []);

  const list = asc ? (episodes || []) : [...(episodes || [])].reverse();
  const epCount = episodes?.length || 0;
  return (
    <div className="flex flex-col h-full">
      {bare ? (
        <div className="shrink-0 flex items-center gap-2 px-4 pb-2">
          <span className="text-[12px] text-mut">{epCount} Episodes</span>
          {epCount > 1 && (
            <Button
              onClick={() => setBatchOpen(true)}
              className="ml-auto px-2.5 py-1 rounded-lg bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 text-[11px] font-bold flex items-center gap-1 pressable"
            >
              <IDownload size={12} /> Batch Download
            </Button>
          )}
          <Button
            onClick={() => setAsc((v) => !v)}
            className="px-2 py-1 rounded-lg bg-black/5 dark:bg-white/10 text-[11px] font-semibold text-on/80 flex items-center gap-1 pressable hover:bg-black/10 dark:hover:bg-white/15 transition-colors"
            aria-label={asc ? "Sort descending" : "Sort ascending"}
          >
            <IVertSwap size={12} className="text-mut" />
            <span>{asc ? "1-N" : "N-1"}</span>
          </Button>
        </div>
      ) : (
        <div className="shrink-0 flex items-center gap-2 px-4 h-12">
          <span className="text-[14px] font-bold text-on">{t("player.episodes")}</span>
          <span className="text-[12px] text-mut">{(episodes?.length || 0)} Episodes</span>
          {(episodes?.length || 0) > 1 && (
            <Button
              onClick={() => setBatchOpen(true)}
              className="ml-auto px-2.5 py-1 rounded-lg bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 text-[11px] font-bold flex items-center gap-1 pressable"
            >
              <IDownload size={12} /> Batch
            </Button>
          )}
          <Button
            onClick={() => setAsc((v) => !v)}
            className="px-2 py-1 rounded-lg bg-black/5 dark:bg-white/10 text-[11px] font-semibold text-on/80 flex items-center gap-1 pressable hover:bg-black/10 dark:hover:bg-white/15 transition-colors"
            aria-label={asc ? "Sort descending" : "Sort ascending"}
          >
            <IVertSwap size={12} className="text-mut" />
            <span>{asc ? "1-N" : "N-1"}</span>
          </Button>
          <Button onClick={onClose} aria-label={t("common.close")} className="w-7 h-7 rounded-full bg-s3 flex items-center justify-center text-mut pressable">
            <IClose size={13} />
          </Button>
        </div>
      )}
      <div className="flex-1 scroll-y px-4 pb-[calc(var(--sab,48px)+24px)]">
        <div className="grid grid-cols-4 gap-2">
          {list.map((e) => {
            const isDl = isEpisodeDownloaded(videoId, e.ep_num);
            return (
              <Button key={e.ep_num} onClick={() => onPick(e.ep_num)}
                aria-label={`Episode ${e.ep_num}`}
                ref={e.ep_num === current ? (el) => { activeEpRef.current = el; } : undefined}
                className={`h-10 rounded-(--r-sm) text-[13px] font-semibold relative pressable ${e.ep_num === current ? "bg-primary text-on-primary" : "bg-s3 text-on/80"}`}>
                <span>{e.ep_num}</span>
                {isDl && (
                  <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-sm" />
                )}
              </Button>
            );
          })}
        </div>
        {!(episodes?.length || 0) && <div className="text-center text-[12px] text-dim py-8">No episodes available</div>}
      </div>
      {!bare && (
        <div className="shrink-0 px-4 py-2.5 text-[12px] text-dim bg-s2/60 truncate">
          {title ? `${formatDramaTitle(title)} · Tap to play` : `Series #${videoId} · Tap to play`}
        </div>
      )}

      <BatchDownloadSheet
        isOpen={batchOpen}
        onClose={() => setBatchOpen(false)}
        videoId={videoId}
        title={title || `Series #${videoId}`}
        cover={cover || ""}
        totalEpisodes={epCount}
      />
    </div>
  );
}

/* ================= Comments ================= */
export function CommentsPanel({ videoId, ep, total, kind = "video", onClose }: {
  videoId: number; ep: number; total: number; kind?: "video" | "post"; onClose: () => void;
}) {
  const { user, setLoginOpen, toast, t } = useStore();
  const [items, setItems] = useState<Comment[]>([]);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [likedComments, setLikedComments] = useState<Record<number, boolean>>({});
  const inputRef = useRef<HTMLInputElement>(null);
  const reqSeqRef = useRef(0);
  const isUpstreamUser = Boolean(user && user.user_type !== "firebase" && user.user_type !== "offline");

  const toggleCommentLike = (commentId: number) => {
    const next = !likedComments[commentId];
    setLikedComments((prev) => ({ ...prev, [commentId]: next }));
    setItems((list) =>
      list.map((it) => (it.id === commentId ? { ...it, like_count: Math.max(0, (it.like_count || 0) + (next ? 1 : -1)) } : it))
    );
    try { navigator.vibrate?.(12); } catch {}
  };

  const load = useCallback(async (p: number) => {
    const seq = ++reqSeqRef.current;
    setLoading(true);
    try {
      const res: CommentPage | null = kind === "post"
        ? await api.postComments(videoId, p, 20)
        : await api.comments(videoId, ep, p, 20);
      if (seq !== reqSeqRef.current) return;
      setItems((prev) => {
        const base = p === 1 ? [] : prev;
        const seen = new Set(base.map((x) => x.id));
        return [...base, ...(res?.items || []).filter((x) => !seen.has(x.id))];
      });
      setPage(p);
      setPages(res?.pagination?.pages || 1);
    } catch {
      if (seq === reqSeqRef.current && p === 1) setItems([]);
    } finally {
      if (seq === reqSeqRef.current) setLoading(false);
    }
  }, [videoId, ep, kind]);

  useEffect(() => {
    setItems([]);
    setPage(0);
    setPages(1);
    void load(1);
    return () => {
      reqSeqRef.current++;
    };
  }, [load]);

  const send = async () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (!user) { setLoginOpen(true); return; }
    if (!isUpstreamUser) {
      toast("Comments require an upstream mirror account; local/cloud-sync profiles are read-only here.", "info");
      return;
    }
    setSending(true);
    try {
      await api.commentSend(videoId, ep, trimmed);
      setText("");
      toast("Comment submitted for review", "ok");
      void load(1);
    } catch (e) {
      toast(localizeError(e), "info");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 flex items-center gap-2 px-4 h-12">
        <span className="text-[14px] font-bold text-on">{t("player.comments")}</span>
        <span className="text-[12px] text-mut">{fmt(total)} · {t("player.episode_num", { num: ep })}</span>
        <Button onClick={onClose} aria-label={t("common.close")} className="ml-auto w-7 h-7 rounded-full bg-s3 flex items-center justify-center text-mut pressable">
          <IClose size={13} />
        </Button>
      </div>

      <div className="flex-1 scroll-y px-4">
        {items.length ? items.map((c) => (
          <div key={c.id} className="flex gap-2.5 py-3 border-b border-s3 last:border-0">
            <Avatar size={32} src={c.avatar} name={formatDramaAuthor(c.nickname)} hue={((Number(c.user_id) || 0) * 37) % 360} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-[12px] font-semibold text-on/90">{formatDramaAuthor(c.nickname)}</span>
                <span className="text-[12px] text-dim">{formatRelativeTime(c.time)}</span>
              </div>
              <p className="text-[14px] text-on/80 mt-1 leading-relaxed whitespace-pre-wrap">{formatCommentText(commentText(c.text))}</p>
              <div className="flex items-center gap-3 mt-1.5 text-[12px] text-dim">
                <button
                  type="button"
                  onClick={() => toggleCommentLike(c.id)}
                  className={`flex items-center gap-1 pressable transition-colors ${
                    likedComments[c.id] ? "text-amber-400 font-semibold" : "text-dim hover:text-on"
                  }`}
                  aria-label="Star comment"
                  aria-pressed={Boolean(likedComments[c.id])}
                >
                  {likedComments[c.id] ? <IStarF size={12} className="text-amber-400" /> : <IStar size={12} />}
                  <span>{c.like_count || 0}</span>
                </button>
                {c.reply_count > 0 && <span>{c.reply_count} replies</span>}
              </div>
            </div>
          </div>
        )) : loading ? (
          <div className="flex justify-center py-10"><Loader className="w-7 h-7 spinner" /></div>
        ) : (
          <Empty icon={<ICommentF size={24} className="text-primary" />} title="No comments yet" sub="Be the first to share your thoughts" />
        )}
        {items.length > 0 && (
          <div className="flex justify-center py-4">
            {loading ? <Loader className="w-5 h-5 spinner" />
              : page < pages ? (
                <Button onClick={() => load(page + 1)} className="px-4 h-8 rounded-(--r-ctl) bg-s3 text-[12px] text-on/80 pressable">Load More</Button>
              ) : <span className="text-[12px] text-dim">— End of comments —</span>}
          </div>
        )}
      </div>

      <Form className="shrink-0 flex items-center gap-2 px-3 pt-2.5 pb-[calc(var(--sab,48px)+12px)] bg-s2/70 border-t border-s3/40" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <Avatar size={30} src={user?.avatar} name={user?.nickname || "Me"} hue={322} />
        <Input ref={inputRef} value={text} onChange={(e) => setText(e.target.value)}
          readOnly={!isUpstreamUser}
          onClick={() => {
            if (!user) setLoginOpen(true);
            else if (!isUpstreamUser) toast("Comments require an upstream mirror account; local/cloud-sync profiles are read-only here.", "info");
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !isUpstreamUser) {
              event.preventDefault();
              if (!user) setLoginOpen(true);
              else toast("Comments require an upstream mirror account; local/cloud-sync profiles are read-only here.", "info");
            }
          }}
          placeholder={!user ? "Sign in to comment" : !isUpstreamUser ? "Mirror account required to comment" : "Add a comment..."}
          className="flex-1 min-w-0 h-9 rounded-(--r-ctl) bg-s4 px-3.5 text-[14px] text-on placeholder-dim outline-none focus:bg-s3" />
        <Button type="submit" disabled={!isUpstreamUser || !text.trim() || sending}
          className={`w-9 h-9 rounded-full flex items-center justify-center pressable ${isUpstreamUser && text.trim() ? "brand-grad glow-neon" : "bg-s3 text-dim"}`}>
          {sending ? <Loader className="w-4 h-4 spinner" /> : <ISendF size={16} />}
        </Button>
      </Form>
    </div>
  );
}
/* ================= Community Post Content ================= */
export function ArticlePanel({ title, html, cover, hot, onClose }: {
  title: string; html: string; cover?: string; hot?: number; onClose: () => void;
}) {
  const { toast, strictSecurity } = useStore();
  const safeHtml = useMemo(() => sanitizeHtml(html), [html, strictSecurity]);
  const openSafeLink = (url: string) => {
    api.openUrl(url).catch(() => {
      copyText(url).then(() => toast("Link copied", "ok")).catch(() => toast("Failed to copy", "info"));
    });
  };
  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 flex items-center gap-2 px-4 h-12">
        <span className="text-[14px] font-bold text-on">Article Details</span>
        {hot ? <span className="text-[12px] text-mut">{fmt(hot)} views</span> : null}
        <Button onClick={onClose} aria-label="Close" className="ml-auto w-7 h-7 rounded-full bg-s3 flex items-center justify-center text-mut pressable">
          <IClose size={13} />
        </Button>
      </div>
      <div className="flex-1 scroll-y px-4 pb-[calc(var(--sab,48px)+24px)]">
        {cover && <Image src={imageCover(cover)} alt="" className="w-full rounded-(--r-md) mb-3 object-cover" />}
        <h2 className="text-[16px] font-bold text-on leading-snug">{title}</h2>
        <div className="article-body mt-3" onClick={(e) => handleArticleClick(e, openSafeLink)} dangerouslySetInnerHTML={{ __html: safeHtml }} />
        {!safeHtml && <p className="text-[13px] text-dim mt-4">No article text available for this post.</p>}
      </div>
    </div>
  );
}
