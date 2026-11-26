import { Button, Surface } from "../components/ios/controls";
import { Loader } from "../components/ios/effects";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, fmt } from "../api";
import type { TopicCard, TagGroup, VideoCard } from "../types";
import { useStore } from "../store";
import { Masonry } from "../components/cards";
import { InplaceSearch } from "../components/InplaceSearch";
import { Empty, Img } from "../components/ui";
import { IBack, IClose, IGrid, IGlobe, IPin, IPinF, IRefresh, ISearch } from "../icons";
import { formatDramaDesc, formatDramaTag, formatDramaTitle } from "../subtitles/dramaTranslator";
import { localizeError } from "../i18n";

const TopicIcon = IGrid;
const TagIcon = IGlobe;
const PINNED_TAGS_STORAGE_KEY = "aurastream_pinned_tags_v1";

function readPinnedTags(): string[] {
  try {
    const raw = localStorage.getItem(PINNED_TAGS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function writePinnedTags(tags: string[]) {
  try {
    localStorage.setItem(PINNED_TAGS_STORAGE_KEY, JSON.stringify(tags.slice(0, 24)));
    window.dispatchEvent(new CustomEvent("aurastream:pinned-tags-changed"));
  } catch {}
}

/* ================= Topics List Page ================= */
export function TopicsPage({ onBack, wide, active = true }: { onBack: () => void; wide: boolean; active?: boolean }) {
  const { push, toast, t } = useStore();
  const [searching, setSearching] = useState(false);
  const [items, setItems] = useState<TopicCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const load = useCallback(() => {
    let alive = true;
    setLoading(true);
    setErr("");
    api.topics()
      .then((r) => { if (alive) setItems(r?.items || []); })
      .catch((e) => {
        if (!alive) return;
        const msg = localizeError(e);
        setErr(msg);
        toast(msg, "info");
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [toast]);

  useEffect(() => {
    const cancel = load();
    return () => { if (cancel) cancel(); };
  }, [load]);

  return (
    <div className="ios-page absolute inset-0 bg-bg flex flex-col">
      <div className="shrink-0 bg-s1 border-b border-edge/20" style={{ paddingTop: "var(--sat, 0px)" }}>
        <div className="pt-2 pb-3 flex items-center gap-2.5 max-w-[1040px] mx-auto w-full">
          <Button aria-label="Back" onClick={onBack} className="w-10 h-10 rounded-full flex items-center justify-center text-on hover:bg-s3 pressable shrink-0"><IBack size={20} /></Button>
          <div className="flex-1 min-w-0">
            <div className="text-[17px] font-bold text-on truncate leading-tight">{t("cat.topics_title")}</div>
            <div className="text-[11.5px] text-mut mt-0.5 leading-tight">{items.length} {t("cat.topics").toLowerCase()}</div>
          </div>
          <Button onClick={() => setSearching(true)} aria-label="Search dramas" className="w-10 h-10 rounded-full flex items-center justify-center text-on hover:bg-s3 pressable shrink-0"><ISearch size={19} /></Button>
          <Button aria-label="Refresh" onClick={load} className="w-10 h-10 rounded-full flex items-center justify-center text-mut hover:bg-s3 pressable shrink-0"><IRefresh size={16} /></Button>
        </div>
      </div>

      <div className="flex-1 scroll-y pt-3 pb-[calc(var(--sab,0px)+28px)]">
        <div className="max-w-[1040px] mx-auto w-full">
        {loading ? (
          <div className="flex justify-center py-12"><Loader className="w-8 h-8" /></div>
        ) : err && !items.length ? (
          <Empty icon={<TopicIcon size={26} />} title="Failed to load topics" sub={err} action="Retry" onAction={load} />
        ) : items.length ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {items.map((t, index) => (
              <Button key={t.id} onClick={() => push({ kind: "topic", slug: t.slug, name: formatDramaTitle(t.title) })}
                className="ios-topic-card text-left overflow-hidden bg-s1 elev-1 pressable a-rise">
                <div className="relative w-full" style={{ paddingTop: "56%" }}>
                  <Img src={t.cover} eager={index < 6} />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent" />
                  <span className="absolute bottom-2 left-2 px-2 py-0.5 rounded-full bg-black/55 backdrop-blur-sm text-[12px] font-semibold text-white/90">
                    {t.video_count ?? 0} titles
                  </span>
                </div>
                <div className="p-2.5">
                  <div className="text-[14px] font-semibold text-on clamp-1 leading-tight">{formatDramaTitle(t.title)}</div>
                  {t.intro && <div className="text-[12px] text-mut clamp-2 mt-1 leading-relaxed">{formatDramaDesc(t.intro)}</div>}
                </div>
              </Button>
            ))}
          </div>
        ) : (
          <Empty icon={<TopicIcon size={26} />} title="No topics available" />
        )}
        </div>
        {wide && <div className="h-2" />}
      </div>
      {searching && <InplaceSearch active={active} kind="video" wide={wide} onClose={() => setSearching(false)} onOpenVideo={(v, list) => push({ kind: "feed", videoIds: list.map((x) => x.id), index: Math.max(0, list.findIndex((x) => x.id === v.id)), title: "Search · Topics" })} />}
    </div>
  );
}

/* ================= Topic Detail Page ================= */
export function TopicPage({ slug, name, onBack, wide, active = true }: { slug: string; name: string; onBack: () => void; wide: boolean; active?: boolean }) {
  const { push, toast, t } = useStore();
  const [searching, setSearching] = useState(false);
  const [topic, setTopic] = useState<TopicCard | null>(null);
  const [related, setRelated] = useState<TopicCard[]>([]);
  const [videos, setVideos] = useState<VideoCard[]>([]);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const busy = useRef(false);

  const loadMore = useCallback(async () => {
    if (busy.current || page >= pages) return;
    busy.current = true;
    setLoading(true);
    try {
      const res = await api.topic(slug);
      setTopic(res?.topic || null);
      setRelated(res?.related || []);
      const next = page + 1;
      const items = res?.videos?.items || [];
      const pag = res?.videos?.pagination;
      setVideos(items);
      setPage(pag?.page || next);
      setPages(pag?.pages || 1);
      setErr("");
    } catch (e) {
      const msg = localizeError(e);
      setErr(msg);
      toast(msg, "info");
    } finally {
      busy.current = false;
      setLoading(false);
    }
  }, [page, pages, slug, toast]);

  useEffect(() => { loadMore(); /* eslint-disable-next-line */ }, []);

  return (
    <div className="ios-page absolute inset-0 bg-bg flex flex-col">
      <div className="shrink-0 bg-s1" style={{ paddingTop: "var(--sat, 0px)" }}>
        <div className="px-3 pt-2 pb-3 flex items-center gap-2.5">
          <Button aria-label="Back" onClick={onBack} className="w-10 h-10 rounded-full flex items-center justify-center text-on hover:bg-s3 pressable"><IBack size={20} /></Button>
          <div className="flex-1 min-w-0">
            <div className="text-[16px] font-bold text-on truncate">{formatDramaTitle(topic?.title || name)}</div>
            <div className="text-[12px] text-mut">{topic?.video_count ?? 0} titles · {videos.length} loaded</div>
          </div>
          <Button onClick={() => setSearching(true)} aria-label="Search dramas" className="ml-auto w-9 h-9 rounded-full flex items-center justify-center text-on hover:bg-s3 pressable"><ISearch size={19} /></Button>
        </div>
        {topic?.intro && <div className="px-4 pb-3 text-[12px] text-mut leading-relaxed clamp-3">{formatDramaDesc(topic.intro)}</div>}
      </div>

      <div className="flex-1 scroll-y px-4 pt-3 pb-[calc(var(--sab,48px)+24px)]">
        {related.length > 0 && (
          <div className="mb-4">
            <div className="text-[13px] font-semibold text-on/80 mb-2">{t("cat.related_topics")}</div>
            <div className="scroll-x flex gap-2.5 snap-x">
              {related.map((r) => (
                <Button key={r.id} onClick={() => push({ kind: "topic", slug: r.slug, name: formatDramaTitle(r.title) })}
                  className="ios-topic-card w-[140px] shrink-0 text-left snap-start pressable">
                  <Surface className="ios-topic-art relative w-full overflow-hidden bg-s1 elev-1" style={{ paddingTop: "56%" }}>
                    <Img src={r.cover} />
                    <span className="absolute bottom-1.5 left-1.5 px-1.5 py-0.5 rounded-full bg-black/55 text-[12px] font-semibold text-white/90">{r.video_count ?? 0} titles</span>
                  </Surface>
                  <div className="mt-1.5 text-[12px] font-medium text-on clamp-1 leading-tight">{formatDramaTitle(r.title)}</div>
                </Button>
              ))}
            </div>
          </div>
        )}

        {loading && !videos.length ? (
          <div className="flex justify-center py-12"><Loader className="w-8 h-8 spinner" /></div>
        ) : err && !videos.length ? (
          <Empty icon={<TopicIcon size={26} />} title="Failed to load" sub={err} action="Retry" onAction={loadMore} />
        ) : videos.length ? (
          <Masonry videos={videos} wide={wide} onOpen={(v) => push({ kind: "feed", videoIds: videos.map((x) => x.id), index: Math.max(0, videos.findIndex((x) => x.id === v.id)), title: topic?.title || name })} />
        ) : (
          <Empty icon={<TopicIcon size={26} />} title="No content available" />
        )}
        {loading && videos.length > 0 && <div className="flex justify-center py-3"><Loader className="w-6 h-6 spinner" /></div>}
        {!loading && videos.length > 0 && page >= pages && <div className="text-center text-[12px] text-dim py-3">— You've reached the end —</div>}
        {wide && <div className="h-2" />}
      </div>
      {searching && <InplaceSearch active={active} kind="video" wide={wide} onClose={() => setSearching(false)} onOpenVideo={(v, list) => push({ kind: "feed", videoIds: list.map((x) => x.id), index: Math.max(0, list.findIndex((x) => x.id === v.id)), title: topic?.title || name })} />}
    </div>
  );
}

/* ================= Tags Directory Page ================= */
export function TagsPage({ onBack, wide, active = true }: { onBack: () => void; wide: boolean; active?: boolean }) {
  const { push, toast, t } = useStore();
  const [searching, setSearching] = useState(false);
  const [groups, setGroups] = useState<TagGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [pinnedTags, setPinnedTags] = useState<string[]>(readPinnedTags);

  useEffect(() => {
    const onPinChange = () => setPinnedTags(readPinnedTags());
    window.addEventListener("aurastream:pinned-tags-changed", onPinChange);
    return () => window.removeEventListener("aurastream:pinned-tags-changed", onPinChange);
  }, []);

  const togglePin = useCallback((name: string) => {
    const isPinned = pinnedTags.includes(name);
    const updated = isPinned ? pinnedTags.filter((t) => t !== name) : [name, ...pinnedTags].slice(0, 24);
    setPinnedTags(updated);
    writePinnedTags(updated);
    try { (navigator as any).vibrate?.(25); } catch {}
    toast(isPinned ? `Unpinned ${name}` : `Pinned ${name} to top`, "ok");
  }, [pinnedTags, toast]);

  const load = useCallback(() => {
    let alive = true;
    setLoading(true);
    setErr("");
    api.tags()
      .then((r) => { if (alive) setGroups(r?.categories || []); })
      .catch((e) => {
        if (!alive) return;
        const msg = localizeError(e);
        setErr(msg);
        toast(msg, "info");
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [toast]);

  useEffect(() => {
    const cancel = load();
    return () => { if (cancel) cancel(); };
  }, [load]);

  return (
    <div className="ios-page absolute inset-0 bg-bg flex flex-col">
      <div className="shrink-0 bg-s1" style={{ paddingTop: "var(--sat, 0px)" }}>
        <div className="px-3 pt-2 pb-3 flex items-center gap-2.5">
          <Button aria-label="Back" onClick={onBack} className="w-10 h-10 rounded-full flex items-center justify-center text-on hover:bg-s3 pressable"><IBack size={20} /></Button>
          <span className="text-[17px] font-bold text-on">{t("cat.tags_title")}</span>
          <Button onClick={() => setSearching(true)} aria-label="Search dramas" className="ml-auto w-10 h-10 rounded-full flex items-center justify-center text-on hover:bg-s3 pressable"><ISearch size={19} /></Button>
          <Button aria-label="Refresh" onClick={load} className="w-10 h-10 rounded-full flex items-center justify-center text-mut hover:bg-s3 pressable"><IRefresh size={16} /></Button>
        </div>
      </div>

      <div className="flex-1 scroll-y px-4 pt-3 pb-[calc(var(--sab,48px)+24px)]">
        {pinnedTags.length > 0 && (
          <section className="mb-5 p-3 rounded-2xl bg-s1/60 border border-s3 a-rise">
            <div className="flex items-center gap-2 mb-2">
              <IPinF size={14} className="text-primary" />
              <span className="text-[14px] font-bold text-on">Pinned Tags</span>
              <span className="text-[11px] text-dim ml-auto">Tap to view · Unpin</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {pinnedTags.map((name) => (
                <div key={name} className="inline-flex items-center rounded-full border border-primary/40 bg-primary/10 text-primary overflow-hidden min-h-8">
                  <Button onClick={() => push({ kind: "tag", tag: name, name: formatDramaTag(name) })}
                    className="flex items-center gap-1.5 pl-3 pr-2 py-1.5 text-[12.5px] font-medium pressable">
                    <IPin size={11} />
                    <span>{formatDramaTag(name)}</span>
                  </Button>
                  <Button
                    aria-label={`Unpin ${formatDramaTag(name)}`}
                    onClick={() => togglePin(name)}
                    className="min-w-8 h-8 px-1.5 flex items-center justify-center text-primary/75 hover:text-danger pressable">
                    <IClose size={12} />
                  </Button>
                </div>
              ))}
            </div>
          </section>
        )}
        {loading ? (
          <div className="flex justify-center py-12"><Loader className="w-8 h-8 spinner" /></div>
        ) : err && !groups.length ? (
          <Empty icon={<TagIcon size={26} />} title="Failed to load tags" sub={err} action="Retry" onAction={load} />
        ) : groups.length ? (
          groups.map((g) => {
            const seenLabels = new Set<string>();
            const dedupedTags = (g.tags || []).filter((tag) => {
              const labelKey = formatDramaTag(tag.name).trim().toLowerCase();
              if (!labelKey || seenLabels.has(labelKey)) return false;
              seenLabels.add(labelKey);
              return true;
            });
            return (
              <section key={g.name} className="mb-5 a-rise">
                <div className="flex items-center gap-2 mb-2.5">
                  <span className="text-[14px] font-bold text-on">{formatDramaTag(g.name)}</span>
                  <span className="text-[12px] text-dim">{dedupedTags.length} tags</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {dedupedTags.map((t) => {
                    const isPinned = pinnedTags.includes(t.name);
                    return (
                      <Button key={t.id} onClick={() => push({ kind: "tag", tag: t.name, name: formatDramaTag(t.name) })}
                        onContextMenu={(e) => { e.preventDefault(); togglePin(t.name); }}
                        className={`ios-filter-pill flex items-center gap-1 min-h-8 ${isPinned ? "border-primary/40 bg-primary/10 text-primary" : ""}`}>
                        {isPinned && <IPin size={11} />}
                        {formatDramaTag(t.name)}
                        {!!t.hot_score && <span className="text-[12px] text-dim">{fmt(t.hot_score)}</span>}
                      </Button>
                    );
                  })}
                </div>
              </section>
            );
          })
        ) : (
          <Empty icon={<TagIcon size={26} />} title="No tags available" />
        )}
        {wide && <div className="h-2" />}
      </div>
      {searching && <InplaceSearch active={active} kind="video" wide={wide} onClose={() => setSearching(false)} onOpenVideo={(v, list) => push({ kind: "feed", videoIds: list.map((x) => x.id), index: Math.max(0, list.findIndex((x) => x.id === v.id)), title: "Search · Tags" })} />}
    </div>
  );
}

/* ================= Tag Videos Page ================= */
const TAG_SORTS = [
  { id: "default", label: "Default" },
  { id: "rating", label: "Top Rated" },
  { id: "episodes", label: "Episodes" },
] as const;

export function TagPage({ tag, name, onBack, wide, active = true }: { tag: string; name: string; onBack: () => void; wide: boolean; active?: boolean }) {
  const { push, toast } = useStore();
  const [searching, setSearching] = useState(false);
  const [items, setItems] = useState<VideoCard[]>([]);
  const [tagSort, setTagSort] = useState<"default" | "rating" | "episodes">("default");
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const busy = useRef(false);
  const sentinel = useRef<HTMLDivElement>(null);
  const [pinnedTags, setPinnedTags] = useState<string[]>(readPinnedTags);
  const isPinned = pinnedTags.includes(tag);

  const togglePin = useCallback(() => {
    const nextPinned = isPinned ? pinnedTags.filter((t) => t !== tag) : [tag, ...pinnedTags].slice(0, 24);
    setPinnedTags(nextPinned);
    writePinnedTags(nextPinned);
    try { (navigator as any).vibrate?.(25); } catch {}
    toast(isPinned ? `Unpinned ${name}` : `Pinned ${name} to top`, "ok");
  }, [isPinned, name, pinnedTags, tag, toast]);

  const displayedItems = useMemo(() => {
    if (tagSort === "default") return items;
    const copy = [...items];
    if (tagSort === "rating") {
      copy.sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));
    } else if (tagSort === "episodes") {
      copy.sort((a, b) => (b.episode_count || 0) - (a.episode_count || 0));
    }
    return copy;
  }, [items, tagSort]);

  const loadMore = useCallback(async () => {
    if (busy.current || page >= pages) return;
    busy.current = true;
    setLoading(true);
    try {
      const next = page + 1;
      const res = await api.tagVideos(tag, next, 20);
      setItems((prev) => {
        const seen = new Set(prev.map((x) => x.id));
        return [...prev, ...(res?.items || []).filter((x) => !seen.has(x.id))];
      });
      setPage(next);
      setPages(res?.pagination?.pages || ((res?.items?.length || 0) >= 20 ? next + 1 : next));
      setErr("");
    } catch (e) {
      const msg = localizeError(e);
      setErr(msg);
      toast(msg, "info");
    } finally {
      busy.current = false;
      setLoading(false);
    }
  }, [page, pages, tag, toast]);

  useEffect(() => { loadMore(); /* eslint-disable-next-line */ }, []);

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
      <div className="shrink-0 bg-s1" style={{ paddingTop: "var(--sat, 0px)" }}>
        <div className="px-3 pt-2 pb-3 flex items-center gap-2">
          <Button aria-label="Back" onClick={onBack} className="w-10 h-10 rounded-full flex items-center justify-center text-on hover:bg-s3 pressable shrink-0"><IBack size={20} /></Button>
          <div className="flex-1 min-w-0">
            <div className="text-[16px] font-bold text-on truncate leading-tight">{name}</div>
            <div className="text-[11.5px] text-mut mt-0.5 leading-tight">{items.length} titles</div>
          </div>
          <Button onClick={togglePin} aria-label={isPinned ? "Unpin tag" : "Pin tag"} className={`w-10 h-10 rounded-full flex items-center justify-center pressable shrink-0 ${isPinned ? "text-primary bg-primary/10" : "text-mut hover:bg-s3"}`}>
            {isPinned ? <IPinF size={18} /> : <IPin size={18} />}
          </Button>
          <Button onClick={() => setSearching(true)} aria-label="Search dramas" className="w-10 h-10 rounded-full flex items-center justify-center text-on hover:bg-s3 pressable shrink-0"><ISearch size={19} /></Button>
        </div>
        {items.length > 1 && (
          <div className="px-4 pb-2.5 flex items-center gap-2">
            <span className="text-[12px] font-semibold text-mut">Sort:</span>
            <div className="inline-flex rounded-full bg-s2 p-0.5 text-[12px]">
              {TAG_SORTS.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  aria-pressed={tagSort === s.id}
                  onClick={() => setTagSort(s.id)}
                  className={`h-8 px-3 rounded-full text-[11.5px] font-semibold transition-all pressable ${
                    tagSort === s.id
                      ? "bg-primary text-on-primary shadow-xs"
                      : "text-mut hover:text-on"
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="flex-1 scroll-y px-4 pt-3 pb-[calc(var(--sab,0px)+28px)]">
        {loading && !items.length ? (
          <div className="flex justify-center py-12"><Loader className="w-8 h-8 spinner" /></div>
        ) : err && !items.length ? (
          <Empty icon={<TagIcon size={26} />} title="Failed to load" sub={err} action="Retry" onAction={loadMore} />
        ) : displayedItems.length ? (
          <Masonry videos={displayedItems} wide={wide} onOpen={(v) => push({ kind: "feed", videoIds: displayedItems.map((x) => x.id), index: Math.max(0, displayedItems.findIndex((x) => x.id === v.id)), title: name })} />
        ) : (
          <Empty icon={<TagIcon size={26} />} title="No dramas found in this tag" />
        )}
        <div ref={sentinel} className="h-8" />
        {loading && items.length > 0 && <div className="flex justify-center py-3"><Loader className="w-6 h-6 spinner" /></div>}
        {err && items.length > 0 && !loading && (
          <div className="flex flex-col items-center gap-2 py-4">
            <span className="text-[12px] text-mut">{err}</span>
            <Button onClick={loadMore} className="h-8 px-4 rounded-full bg-s3 text-[12px] font-semibold text-on pressable">Retry</Button>
          </div>
        )}
        {!loading && !err && items.length > 0 && page >= pages && <div className="text-center text-[12px] text-dim py-3">— You've reached the end —</div>}
        {wide && <div className="h-2" />}
      </div>
      {searching && <InplaceSearch active={active} kind="video" wide={wide} onClose={() => setSearching(false)} onOpenVideo={(v, list) => push({ kind: "feed", videoIds: list.map((x) => x.id), index: Math.max(0, list.findIndex((x) => x.id === v.id)), title: name })} />}
    </div>
  );
}
