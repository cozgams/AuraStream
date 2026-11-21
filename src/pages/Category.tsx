import { Button, Surface } from "../components/ios/controls";
import { Loader } from "../components/ios/effects";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, fmt } from "../api";
import type { Post, VideoCard } from "../types";
import { useStore } from "../store";
import { MediaCard, Masonry, RowCard } from "../components/cards";
import { CollectionLink, CollectionLinks } from "../components/CollectionLink";
import { InplaceSearch } from "../components/InplaceSearch";
import { Empty, Img } from "../components/ui";
import { IBack, IChevR, IGlobe, IGrid, ISearch, ITrophy } from "../icons";
import { localizeError } from "../i18n";

export const CHANNELS = [
  { cate: "ai-duanju", name: "Short Dramas", desc: "Fast-paced & viral short series" },
  { cate: "ai-manju", name: "Anime Dramas", desc: "Animated comic dramas · Weekly updates" },
  { cate: "original", name: "Originals", desc: "Exclusive original series" },
] as const;

/* ================= Category Overview ================= */
export default function Category({ wide, active }: { wide: boolean; active: boolean }) {
  const { push, lineEpoch, t } = useStore();
  const [rows, setRows] = useState<Record<string, VideoCard[]>>({});
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const mounted = useRef(false);
  const started = useRef(false);
  const pending = useRef(new Set<string>());
  const errorsRef = useRef(errors);
  errorsRef.current = errors;
  const lineEpochRef = useRef(lineEpoch);
  lineEpochRef.current = lineEpoch;
  const retryKeys = useRef(new Set<string>());

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const loadPreview = useCallback(async (key: string): Promise<void> => {
    if (pending.current.has(key)) return;
    pending.current.add(key);
    const requestEpoch = lineEpochRef.current;
    if (mounted.current) {
      setLoading(m => ({ ...m, [key]: true }));
      setErrors(m => ({ ...m, [key]: "" }));
    }
    try {
      if (key === "posts") {
        const res = await api.postCategory("remen-chigua", 1, 6, "latest");
        if (mounted.current && requestEpoch === lineEpochRef.current) setPosts(res?.items || []);
      } else {
        const res = key === "original"
          ? await api.originalVideos("all", 1, 6, "new")
          : await api.category(key, 1, 6, "latest");
        if (mounted.current && requestEpoch === lineEpochRef.current) {
          setRows(r => ({ ...r, [key]: res?.items || [] }));
        }
      }
    } catch (error) {
      const stale = requestEpoch !== lineEpochRef.current;
      if (mounted.current && !stale) setErrors(m => ({ ...m, [key]: (error as Error).message || "Failed to load" }));
      if (stale) retryKeys.current.add(key);
    } finally {
      pending.current.delete(key);
      if (mounted.current) setLoading(m => ({ ...m, [key]: false }));
    }
  }, []);

  useEffect(() => {
    if (!active || started.current) return;
    started.current = true;
    for (const c of CHANNELS) void loadPreview(c.cate);
    void loadPreview("posts");
  }, [active, loadPreview]);

  useEffect(() => {
    if (!lineEpoch || !started.current) return;
    const targets = new Set<string>();
    for (const c of CHANNELS) {
      if (errorsRef.current[c.cate] || !(rows[c.cate]?.length) || retryKeys.current.has(c.cate)) {
        targets.add(c.cate);
      }
    }
    if (errorsRef.current.posts || !posts.length || retryKeys.current.has("posts")) targets.add("posts");
    retryKeys.current.clear();
    for (const k of targets) void loadPreview(k);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lineEpoch]);

  return (
    <div className="ios-page absolute inset-0 bg-bg flex flex-col">
      <div className="shrink-0 bg-bg/95 backdrop-blur-md z-10 border-b border-edge/30 px-4 pb-3" style={{ paddingTop: "calc(var(--sat, 0px) + 12px)" }}>
        <h1 className="ios-page-title text-on">{t("cat.title")}</h1>
        <p className="text-[13px] text-mut mt-1">{t("cat.subtitle")}</p>
      </div>

      <div className={`ios-page-body flex-1 scroll-y pt-3 pb-52 ${wide ? "max-w-[1200px] mx-auto" : ""}`}>
        {/* Rankings: full-width featured card */}
        <div className="px-4 mb-2.5">
          <Button
            onClick={() => push({ kind: "ranks" })}
            className="ios-collection-link w-full flex items-center justify-between p-3.5 text-left pressable group transition-all"
          >
            <div className="flex items-center gap-3">
              <span className="w-10 h-10 rounded-(--r-sm) bg-pc text-on-pc flex items-center justify-center shrink-0">
                <ITrophy size={20} strokeWidth={1.8} />
              </span>
              <div className="text-left">
                <div className="text-[15px] font-semibold text-on">{t("cat.rankings")}</div>
                <div className="text-[12px] text-mut">{t("cat.rankings_sub")}</div>
              </div>
            </div>
            <IChevR size={16} className="text-dim group-hover:text-on transition-colors" />
          </Button>
        </div>

        {/* Topics + Tags side-by-side grid */}
        <div className="px-4 mb-3">
          <CollectionLinks className="ios-category-links">
            <CollectionLink
              icon={<IGrid size={18} strokeWidth={1.8} />}
              title={t("cat.topics")}
              subtitle={t("cat.topics_sub")}
              onClick={() => push({ kind: "topics" })}
            />
            <CollectionLink
              icon={<IGlobe size={18} strokeWidth={1.8} />}
              title={t("cat.tags")}
              subtitle={t("cat.tags_sub")}
              onClick={() => push({ kind: "tags" })}
            />
          </CollectionLinks>
        </div>

        {CHANNELS.map((c) => {
          const list = rows[c.cate] || [];
          const isBusy = Boolean(loading[c.cate]);
          const err = errors[c.cate];
          return (
            <section key={c.cate} aria-label={c.name} className="mb-6 a-rise">
              <Button
                onClick={() => push({ kind: "channel", cate: c.cate, name: c.name })}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-left group pressable"
              >
                <span className="w-9 h-9 rounded-(--r-sm) bg-pc text-on-pc flex items-center justify-center shrink-0">
                  <IGrid size={18} strokeWidth={1.8} />
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-[15.5px] font-semibold text-on leading-tight">{c.name}</span>
                  <span className="block text-[12px] text-mut mt-0.5 truncate">{c.desc}</span>
                </span>
                <span className="flex items-center gap-0.5 text-[12px] text-mut group-hover:text-primary transition-colors">
                  {t("cat.all")}<IChevR size={14} />
                </span>
              </Button>
              <div className="scroll-x flex gap-2.5 px-4 snap-x">
                {list.map((v) => (
                  <RowCard key={v.id} v={v} onOpen={() => push({ kind: "feed", videoIds: list.map((x) => x.id), index: Math.max(0, list.findIndex((x) => x.id === v.id)), title: c.name })} />
                ))}
                {!list.length && <PreviewStatus name={c.name} loading={isBusy} error={err} onRetry={() => void loadPreview(c.cate)} />}
              </div>
            </section>
          );
        })}

        <section aria-label="Community" className="mb-6 a-rise">
          <Button onClick={() => push({ kind: "posts" })} className="w-full flex items-center gap-3 px-4 py-2.5 text-left group pressable">
            <span className="w-9 h-9 rounded-(--r-sm) bg-pc text-on-pc flex items-center justify-center shrink-0">
              <IGrid size={18} strokeWidth={1.8} />
            </span>
            <span className="flex-1 min-w-0">
              <span className="block text-[15.5px] font-semibold text-on leading-tight">{t("cat.posts")}</span>
              <span className="block text-[12px] text-mut mt-0.5 truncate">{t("cat.posts_desc")}</span>
            </span>
            <span className="flex items-center gap-0.5 text-[12px] text-mut group-hover:text-primary transition-colors">
              {t("cat.all")}<IChevR size={14} />
            </span>
          </Button>
          <div className="scroll-x flex gap-2.5 px-4 snap-x">
            {posts.map((post) => (
              <div key={post.id} className="ios-row-card"><MediaCard title={post.title} cover={post.cover}
                subtitle={`${fmt(post.hot)} views`} onOpen={() => push({ kind: "post", id: post.id })} /></div>
            ))}
            {!posts.length && <PreviewStatus name="Community" loading={Boolean(loading.posts)} error={errors.posts} onRetry={() => void loadPreview("posts")} />}
          </div>
        </section>

        <div className="px-4 text-center text-[12px] text-dim pt-1">— All Channels Displayed —</div>
      </div>
    </div>
  );
}

function PreviewStatus({ name, loading, error, onRetry }: { name: string; loading: boolean; error?: string; onRetry: () => void }) {
  return <div className="h-[150px] flex flex-col justify-center items-start gap-2 text-[12px] text-dim px-1">
    <span>{loading ? "Loading…" : error || "No content"}</span>
    {!loading && error && <Button aria-label={`Retry ${name}`} onClick={onRetry} className="text-primary pressable">Retry</Button>}
  </div>;
}

/* ================= Channel Detail Page ================= */
const CHANNEL_SORTS = [
  { value: "latest", label: "Latest" },
  { value: "hot_window", label: "Trending" },
  { value: "random", label: "Staff Picks" },
] as const;

const ORIGINAL_CATES = [
  { value: "all", label: "All Originals" },
  { value: "ai-manju", label: "Anime Comics" },
  { value: "ai-duanju", label: "Short Dramas" },
] as const;

const originalSort = (cate: (typeof ORIGINAL_CATES)[number]["value"]) =>
  cate === "all" ? "new" : "latest";

export function ChannelPage({ cate, name, onBack, wide }: { cate: string; name: string; onBack: () => void; wide: boolean }) {
  const { push } = useStore();
  const [searching, setSearching] = useState(false);
  const [serverSort, setServerSort] = useState<(typeof CHANNEL_SORTS)[number]["value"]>("latest");
  const [originalCate, setOriginalCate] = useState<(typeof ORIGINAL_CATES)[number]["value"]>("all");
  const [items, setItems] = useState<VideoCard[]>([]);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const busy = useRef(false);
  const sentinel = useRef<HTMLDivElement>(null);
  const scrollContainer = useRef<HTMLDivElement>(null);
  const requestSeq = useRef(0);

  const loadMore = useCallback(async (reset = false) => {
    if (busy.current) return;
    const next = reset ? 1 : page + 1;
    if (!reset && next > pages) return;
    const seq = ++requestSeq.current;
    busy.current = true;
    setLoading(true);
    if (reset) setErr("");
    try {
      const res = cate === "original"
        ? await api.originalVideos(originalCate, next, 24, originalSort(originalCate))
        : await api.category(cate, next, 24, serverSort);
      if (seq !== requestSeq.current) return;
      setItems((prev) => {
        const base = reset ? [] : prev;
        const seen = new Set(base.map((x) => x.id));
        return [...base, ...(res?.items || []).filter((x) => !seen.has(x.id))];
      });
      setPage(next);
      setPages(res?.pagination?.pages || next);
      setErr("");
    } catch (e) {
      if (seq === requestSeq.current) setErr(localizeError(e));
    } finally {
      if (seq === requestSeq.current) {
        busy.current = false;
        setLoading(false);
      }
    }
  }, [cate, originalCate, page, pages, serverSort]);

  const changeServerSort = (s: typeof serverSort) => {
    if (s === serverSort) return;
    setServerSort(s);
    setItems([]);
    setPage(0);
    setPages(1);
    scrollContainer.current?.scrollTo({ top: 0 });
  };

  const changeOriginalCate = (c: typeof originalCate) => {
    if (c === originalCate) return;
    setOriginalCate(c);
    setItems([]);
    setPage(0);
    setPages(1);
    scrollContainer.current?.scrollTo({ top: 0 });
  };

  useEffect(() => {
    void loadMore(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cate, serverSort, originalCate]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => {
      if (es[0].isIntersecting) void loadMore();
    }, { rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pages]);

  return (
    <div className="ios-page absolute inset-0 bg-bg flex flex-col">
      <div className="shrink-0 bg-s1" style={{ paddingTop: "var(--sat, 0px)" }}>
        <div className="px-3 pt-2 pb-3 flex items-center gap-2.5">
          <Button aria-label="Back" onClick={onBack} className="w-10 h-10 rounded-full flex items-center justify-center text-on hover:bg-s3 pressable"><IBack size={20} /></Button>
          <span className="w-[40px] h-[40px] rounded-(--r-sm) bg-pc text-on-pc flex items-center justify-center"><IGrid size={21} strokeWidth={1.9} /></span>
          <div className="flex-1 min-w-0">
            <div className="text-[17px] font-bold text-on leading-tight">{name}</div>
            <div className="text-[12px] text-mut">{items.length} titles · {page}/{Math.max(pages, 1)} pages</div>
          </div>
          <Button onClick={() => setSearching(true)} aria-label={cate === "original" ? "Search originals" : "Search dramas"} className="w-9 h-9 shrink-0 rounded-full flex items-center justify-center text-on hover:bg-s3 pressable"><ISearch size={19} /></Button>
        </div>
        {cate === "original" && (
          <div className="px-4 pb-2 flex flex-wrap gap-2">
            {ORIGINAL_CATES.map((s) => (
              <Button aria-pressed={originalCate === s.value} key={s.value} onClick={() => changeOriginalCate(s.value)}
                className="ios-filter-pill">{s.label}</Button>
            ))}
          </div>
        )}
        {cate !== "original" && (
          <div className="px-4 pb-3 flex flex-wrap gap-2">
            {CHANNEL_SORTS.map((s) => (
              <Button aria-pressed={serverSort === s.value} key={s.value} onClick={() => changeServerSort(s.value)}
                className="ios-filter-pill">{s.label}</Button>
            ))}
          </div>
        )}
      </div>
      <div ref={scrollContainer} className="flex-1 scroll-y px-4 pt-3 pb-36">
        {items.length ? (
          <Masonry videos={items} wide={wide} onOpen={(v) => push({ kind: "feed", videoIds: items.map((x) => x.id), index: Math.max(0, items.findIndex((x) => x.id === v.id)), title: name })} />
        ) : err ? (
          <Empty icon={<IGrid size={26} />} title="Failed to load" sub={err} action="Retry" onAction={() => void loadMore(true)} />
        ) : loading ? (
          <div className="flex justify-center py-10"><Loader className="w-8 h-8 spinner" /></div>
        ) : (
          <Empty icon={<IGrid size={26} />} title="No titles available" sub="Check back shortly or explore another category." action="Refresh" onAction={() => void loadMore(true)} />
        )}
        <div ref={sentinel} className="h-10" />
        {loading && <div className="flex justify-center py-3"><Loader className="w-6 h-6 spinner" /></div>}
        {!loading && page >= pages && items.length > 0 && (
          <div className="text-center text-[12px] text-dim py-3">— You've reached the end —</div>
        )}
      </div>
      {searching && <InplaceSearch kind="video" scope={cate === "original" ? "original" : undefined} wide={wide} onClose={() => setSearching(false)} onOpenVideo={(v, list) => push({ kind: "feed", videoIds: list.map((x) => x.id), index: Math.max(0, list.findIndex((x) => x.id === v.id)), title: `Search · ${name}` })} />}
    </div>
  );
}
