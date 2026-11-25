import { Button, Form, Input } from "./ios/controls";
import { Loader } from "./ios/effects";
import { useEffect, useRef, useState } from "react";
import { api, fmt } from "../api";
import type { Post, VideoCard } from "../types";
import { MediaCard, Masonry } from "./cards";
import { Empty } from "./ui";
import { IBack, IClose, ISearch } from "../icons";
import { localizeError } from "../i18n";
import { registerOverlayBack } from "../back";

export function InplaceSearch({ kind, postLabel = "Community", scope, onOpenVideo, onOpenPost, onClose, wide }: {
  kind: "video" | "post";
  postLabel?: string;
  scope?: "original";
  onOpenVideo?: (v: VideoCard, list: VideoCard[]) => void;
  onOpenPost?: (p: Post) => void;
  onClose: () => void;
  wide?: boolean;
}) {
  const [q, setQ] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [items, setItems] = useState<VideoCard[]>([]);
  const [posts, setPosts] = useState<Post[]>([]);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const busy = useRef(false);
  const seqRef = useRef(0);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const unsub = registerOverlayBack(() => {
      onCloseRef.current();
      return true;
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      unsub();
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const run = async (keyword: string, p: number) => {
    if (p > 1 && busy.current) return;
    const seq = p === 1 ? ++seqRef.current : seqRef.current;
    busy.current = true;
    setLoading(true);
    try {
      const res = kind === "post"
        ? await api.searchPosts(keyword, p, 20)
        : await api.search(keyword, p, 20, "video");
      if (seq !== seqRef.current) return;
      if (kind === "post") {
        const list = (res?.items || []) as unknown as Post[];
        setPosts((prev) => {
          const base = p === 1 ? [] : prev;
          const seen = new Set(base.map((x) => x.id));
          return [...base, ...list.filter((x) => !seen.has(x.id))];
        });
      } else {
        const list = (res?.items || []) as unknown as VideoCard[];
        const scoped = scope === "original" ? list.filter((v) => v.is_original === 1) : list;
        setItems((prev) => {
          const base = p === 1 ? [] : prev;
          const seen = new Set(base.map((x) => x.id));
          return [...base, ...scoped.filter((x) => !seen.has(x.id))];
        });
      }
      setPage(p);
      setPages(res?.pagination?.pages || 1);
      setErr(null);
    } catch (e) {
      if (seq !== seqRef.current) return;
      setErr(localizeError(e));
    } finally {
      if (seq === seqRef.current) {
        busy.current = false;
        setLoading(false);
      }
    }
  };

  const submit = (k: string) => {
    const kk = k.trim();
    if (!kk) return;
    setSubmitted(kk);
    setItems([]);
    setPosts([]);
    setPage(0);
    setPages(1);
    run(kk, 1);
  };

  const count = kind === "post" ? posts.length : items.length;
  const videoLabel = scope === "original" ? "Original Dramas" : "Dramas";

  return (
    <div className="ios-page absolute inset-0 z-20 bg-bg flex flex-col">
      <div className="shrink-0 px-4 pb-3 flex items-center gap-2.5 bg-s1" style={{ paddingTop: "calc(var(--sat, 0px) + 12px)" }}>
        <Button onClick={onClose} className="w-9 h-9 rounded-full flex items-center justify-center text-on hover:bg-s3 pressable" aria-label="Exit search"><IBack size={19} /></Button>
        <Form className="flex-1 flex items-center gap-2 h-11 rounded-(--r-ctl) bg-s3 px-3.5 focus-within:bg-s4 transition-colors"
          onSubmit={(e) => { e.preventDefault(); submit(q); }}>
          <ISearch size={17} className="text-mut shrink-0" />
          <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={kind === "post" ? `Search ${postLabel}…` : `Search ${videoLabel}…`}
            className="flex-1 min-w-0 bg-transparent text-[14px] text-on placeholder-dim outline-none" />
          {q && <Button aria-label="Clear search" type="button" onClick={() => { seqRef.current++; busy.current = false; setLoading(false); setErr(null); setQ(""); setSubmitted(""); setItems([]); setPosts([]); }} className="w-5 h-5 rounded-full bg-s4 flex items-center justify-center text-mut pressable"><IClose size={11} /></Button>}
        </Form>
      </div>

      <div className="flex-1 scroll-y px-4 pt-3 pb-8">
        {!submitted ? (
          <div className="flex justify-center py-20"><span className="text-[13px] text-mut">{kind === "post" ? `Type keywords to search ${postLabel}` : `Type keywords to search ${videoLabel}`}</span></div>
        ) : loading && !count ? (
          <div className="flex justify-center py-12"><Loader className="w-8 h-8 spinner" /></div>
        ) : count ? (
          kind === "post" ? (
            <>
              <div className="text-[12px] text-mut mb-2.5">"{submitted}" found <span className="text-primary font-bold">{count}</span> posts</div>
              <div className={`ios-media-grid ${wide ? "is-wide" : ""}`}>
                {posts.map((post) => (
                  <MediaCard key={post.id} title={post.title} cover={post.cover} subtitle={`${fmt(post.hot)} views`} onOpen={() => onOpenPost?.(post)} />
                ))}
              </div>
              <div className="flex justify-center py-4">
                {loading ? <Loader className="w-6 h-6 spinner" /> : page < pages ? <Button onClick={() => run(submitted, page + 1)} className="px-5 h-9 rounded-(--r-ctl) bg-s3 text-[13px] text-on/85 pressable">Load More</Button> : <span className="text-[12px] text-dim">— You've reached the end —</span>}
              </div>
            </>
          ) : (
            <>
              <div className="text-[12px] text-mut mb-2.5">"{submitted}" found <span className="text-primary font-bold">{count}</span> dramas</div>
              <Masonry videos={items} wide={wide} onOpen={(v) => onOpenVideo?.(v, items)} />
              <div className="flex justify-center py-4">
                {loading ? <Loader className="w-6 h-6 spinner" /> : page < pages ? <Button onClick={() => run(submitted, page + 1)} className="px-5 h-9 rounded-(--r-ctl) bg-s3 text-[13px] text-on/85 pressable">Load More</Button> : <span className="text-[12px] text-dim">— You've reached the end —</span>}
              </div>
            </>
          )
        ) : (
          <Empty icon={<ISearch size={26} />} title={err || "No results found"} sub="Try searching with other keywords" />
        )}
      </div>
    </div>
  );
}
