import { Button, Form, Input, SegmentedControl, Surface } from "../components/ios/controls";
import { Loader } from "../components/ios/effects";
import { useEffect, useRef, useState } from "react";
import { api, fmt, isMobile } from "../api";
import type { HotSearchVideo, Post, RankItem, VideoCard } from "../types";
import { useStore } from "../store";
import { MediaCard, Masonry, RankRow } from "../components/cards";
import { Empty } from "../components/ui";
import { IBack, IChevR, IClose, IFireF, IPlayF, IRefresh, ISearch, ITrophy } from "../icons";
import { formatDramaTag, formatDramaTitle } from "../subtitles/dramaTranslator";
import { localizeError } from "../i18n";

const DEFAULT_HOT_TAGS = ["Urban", "Revenge", "Costume", "System", "Romance", "Campus", "Fantasy", "Workplace", "Drama", "Action", "Mystery", "Sci-Fi"];
const DISCOVERY_THEMES = ["CEO Romance", "Secret Identity", "Revenge", "Time Travel", "Martial Arts", "Family Drama", "Undercover", "Second Chance"];

export default function Search({ active, wide }: { active: boolean; wide: boolean }) {
  const { push, searchHist, addSearch, removeSearch, clearSearchHist, t, lineEpoch } = useStore();
  const [q, setQ] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [tab, setTab] = useState<"video" | "post">("video");
  const [items, setItems] = useState<VideoCard[]>([]);
  const [posts, setPosts] = useState<Post[]>([]);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const busy = useRef(false);
  const seqRef = useRef(0);
  const [hotVideos, setHotVideos] = useState<HotSearchVideo[]>([]);
  const [hotLoading, setHotLoading] = useState(false);
  const [hotError, setHotError] = useState<string | null>(null);
  const hotBusy = useRef(false);
  const hotLoadedAt = useRef(0);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const [popularTags, setPopularTags] = useState<string[]>(DEFAULT_HOT_TAGS);

  useEffect(() => {
    let alive = true;
    api.hotTags?.()
      .then((res) => {
        if (alive && res?.items?.length) {
          setPopularTags(res.items.map((x) => x.name).filter(Boolean));
        }
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const handler = (e: Event) => {
      const custom = e as CustomEvent<{ tab: string }>;
      if (custom.detail?.tab === "search") {
        scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
      }
    };
    window.addEventListener("hg:scroll-to-top", handler);
    return () => window.removeEventListener("hg:scroll-to-top", handler);
  }, []);

  useEffect(() => {
    const onReset = () => {
      setQ("");
      setSubmitted("");
      setItems([]);
      setPosts([]);
      setErr(null);
    };
    window.addEventListener("hg:search-reset", onReset);
    return () => window.removeEventListener("hg:search-reset", onReset);
  }, []);

  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 1) {
      touchStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (!touchStartRef.current || e.changedTouches.length === 0) return;
    const dx = e.changedTouches[0].clientX - touchStartRef.current.x;
    const dy = e.changedTouches[0].clientY - touchStartRef.current.y;
    touchStartRef.current = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      if (dx < 0 && tab === "video") {
        changeTab("post");
      } else if (dx > 0 && tab === "post") {
        changeTab("video");
      }
    }
  };

  useEffect(() => {
    if (active && !isMobile) inputRef.current?.focus();
  }, [active]);

  const refreshHot = async () => {
    if (hotBusy.current) return;
    hotBusy.current = true;
    setHotLoading(true);
    setHotError(null);
    try {
      const res = await api.searchHot();
      setHotVideos(res.items);
      hotLoadedAt.current = Date.now();
    } catch (e) {
      setHotError(e instanceof Error ? e.message : "Failed to load trending search");
    } finally {
      hotBusy.current = false;
      setHotLoading(false);
    }
  };
  useEffect(() => {
    if (active && Date.now() - hotLoadedAt.current > 60_000) void refreshHot();
  }, [active]);

  useEffect(() => {
    if (!lineEpoch || !active) return;
    hotLoadedAt.current = 0;
    void refreshHot();
  }, [lineEpoch, active]);

  const run = async (keyword: string, p: number, kind: "video" | "post" = tab) => {
    if (p > 1 && (busy.current || p > pages)) return;
    const seq = p === 1 ? ++seqRef.current : seqRef.current;
    busy.current = true;
    setLoading(true);
    try {
      const res = await api.search(keyword, p, 20, kind);
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
        setItems((prev) => {
          const base = p === 1 ? [] : prev;
          const seen = new Set(base.map((x) => x.id));
          return [...base, ...list.filter((x) => !seen.has(x.id))];
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

  const changeTab = (next: "video" | "post") => {
    if (next === tab) return;
    setTab(next);
    setItems([]);
    setPosts([]);
    setPage(0);
    setPages(1);
    setErr(null);
    if (submitted) void run(submitted, 1, next);
  };

  const submit = (keyword: string, forceTab?: "video" | "post") => {
    const k = keyword.trim();
    if (!k) return;
    setSubmitted(k);
    addSearch(k);
    setItems([]);
    setPosts([]);
    setPage(0);
    setPages(1);
    void run(k, 1, forceTab ?? tab);
  };

  const querying = submitted.length > 0;

  return (
    <div className="ios-page absolute inset-0 bg-bg flex flex-col">
      {/* Search Header App Bar */}
      <div
        className="shrink-0 bg-bg/95 backdrop-blur-md z-10 border-b border-edge/30 px-4"
        style={{ paddingTop: "calc(var(--sat, 0px) + 12px)" }}
      >
        <div className={wide ? "max-w-[960px] mx-auto w-full" : ""}>
          <div className="pb-2">
            <h1 className="ios-page-title text-on">{t("nav.search")}</h1>
          </div>
          {/* Search Bar */}
          <div className="pb-3 flex items-center gap-2.5">
            <Form className="ios-search-form flex-1 flex items-center gap-2"
              onSubmit={(e) => { e.preventDefault(); submit(q); }}>
              <ISearch size={17} className="text-mut shrink-0" />
              <Input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("search.placeholder")}
                className="flex-1 min-w-0 bg-transparent text-[14px] text-on placeholder-dim outline-none" />
              {q && <Button aria-label="Clear" type="button" onClick={() => { seqRef.current++; busy.current = false; setLoading(false); setErr(null); setPage(0); setPages(1); setQ(""); setSubmitted(""); setItems([]); setPosts([]); }} className="ios-icon-button ios-search-clear"><IClose size={16} /></Button>}
            </Form>
            <Button onClick={() => push({ kind: "ranks" })} aria-label={t("cat.rankings")}
              className="ios-icon-button ios-search-shortcut">
              <ITrophy size={19} />
            </Button>
          </div>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 scroll-y px-4 pb-[calc(var(--sab,0px)+176px)]">
        <div className={wide ? "max-w-[960px] mx-auto w-full" : ""}>
        {!querying ? (
          <>
            <Surface role="region" aria-label={t("search.hot")} className="mt-3.5 rounded-(--r-md) bg-s2 p-3.5 a-rise">
              <div className="flex items-center justify-between">
                <h2 className="flex items-center gap-1.5 text-[14px] font-semibold text-on/90"><IFireF size={15} className="text-primary" />{t("search.hot")}</h2>
                <Button onClick={() => void refreshHot()} disabled={hotLoading} aria-label="Refresh trending searches"
                  className="flex items-center gap-1 px-2.5 py-1 min-h-7 rounded-full hover:bg-s3 text-[12px] text-mut pressable">
                  {hotLoading ? <Loader className="w-3 h-3" /> : <IRefresh size={12} />}
                </Button>
              </div>
              {hotError && (
                <div className="mt-2 flex items-center justify-between gap-2">
                  <p role="status" className="text-[12px] text-mut leading-relaxed">
                    {hotVideos.length > 0 ? t("search.hot_error_refresh") : t("search.hot_error")}
                  </p>
                  <Button
                    onClick={async () => {
                      await api.lineReset();
                      window.dispatchEvent(new Event("hg:line-changed"));
                      void refreshHot();
                    }}
                    className="text-[11px] text-primary shrink-0 pressable"
                  >
                    Reset Line
                  </Button>
                </div>
              )}
              {hotVideos.length > 0 ? (
                <ol className="ios-search-hot-grid mt-3" aria-busy={hotLoading}>
                  {hotVideos.map((video, i) => (
                    <li key={video.video_id} className="min-w-0">
                      <Button aria-label={`Play ${formatDramaTitle(video.title)}`} title={formatDramaTitle(video.title)} className="ios-search-hot-item"
                        onClick={() => push({ kind: "feed", videoIds: hotVideos.map(item => item.video_id), index: i, title: t("search.hot") })}>
                        <span aria-hidden="true" className={`ios-search-hot-rank ${i < 3 ? "text-primary" : "text-mut"}`}>{String(i + 1).padStart(2, "0")}</span>
                        <span className="ios-search-hot-content">
                          <span className="ios-search-hot-title">{formatDramaTitle(video.title)}</span>
                          {video.plays && (
                            <span className="ios-search-hot-plays">
                              <IPlayF size={10} />
                              {(() => {
                                const raw = video.plays;
                                const yiMatch = raw.match(/(\d+(?:\.\d+)?)\s*亿(?:\s*播放量)?/i);
                                if (yiMatch) {
                                  const val = Number(yiMatch[1]) * 100_000_000;
                                  return val >= 1_000_000_000
                                    ? `${+(val / 1_000_000_000).toFixed(2)}B plays`
                                    : `${+(val / 1_000_000).toFixed(1)}M plays`;
                                }
                                const wanMatch = raw.match(/(\d+(?:\.\d+)?)\s*[w万](?:\s*播放量)?/i);
                                if (wanMatch) {
                                  const val = Number(wanMatch[1]) * 10_000;
                                  if (val >= 1_000_000) return `${+(val / 1_000_000).toFixed(1)}M plays`;
                                  if (val >= 1_000) return `${Math.round(val / 1_000)}K plays`;
                                  return `${Math.round(val)} plays`;
                                }
                                const plainMatch = raw.match(/(\d+(?:\.\d+)?)\s*播放量/i);
                                if (plainMatch) {
                                  const val = Number(plainMatch[1]);
                                  if (val >= 1_000_000) return `${+(val / 1_000_000).toFixed(1)}M plays`;
                                  if (val >= 1_000) return `${Math.round(val / 1_000)}K plays`;
                                  return `${Math.round(val)} plays`;
                                }
                                return raw.replace(/播放量/g, " plays").trim();
                              })()}
                            </span>
                          )}
                        </span>
                        <IChevR size={15} className="text-mut" />
                      </Button>
                    </li>
                  ))}
                </ol>
              ) : !hotError && <p role="status" className="mt-3 text-[12px] text-mut">{hotLoading ? "Loading..." : "No items"}</p>}
            </Surface>

            {searchHist.length > 0 && (
              <div className="mt-5 a-rise">
                <div className="flex items-center justify-between">
                  <span className="text-[14px] font-bold text-on">{t("search.history")}</span>
                  <Button onClick={clearSearchHist} className="px-2 py-0.5 rounded-full text-[12px] text-dim hover:bg-s3 transition-colors pressable">{t("search.clear")}</Button>
                </div>
                <div className="flex flex-wrap gap-2 mt-2.5">
                  {searchHist.map((h) => (
                    <div
                      key={h}
                      className="group inline-flex items-center gap-1.5 pl-3 pr-1.5 h-8 rounded-(--r-ctl) bg-s3 text-[13px] text-on/85 border border-edge/40 hover:border-primary/40 shadow-2xs transition-all"
                    >
                      <button
                        type="button"
                        onClick={() => { setTab("video"); setQ(h); submit(h, "video"); }}
                        className="bg-transparent border-none p-0 text-inherit cursor-pointer select-none"
                      >
                        {h}
                      </button>
                      <button
                        type="button"
                        aria-label={`Remove ${h}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          removeSearch(h);
                        }}
                        className="w-6 h-6 -mr-0.5 rounded-full flex items-center justify-center text-mut hover:text-on hover:bg-white/15 transition-colors cursor-pointer"
                      >
                        <IClose size={11} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <Surface className="mt-5 rounded-(--r-md) bg-s2 p-3.5 a-rise">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-[14px] font-semibold text-on/90"><IFireF size={15} className="text-primary" />{t("search.trending_genres")}</span>
                <Button onClick={() => push({ kind: "ranks" })} className="text-[12px] text-primary font-semibold pressable">{t("search.full_rankings")}</Button>
              </div>
              <div className="flex flex-wrap gap-2 mt-3">
                {popularTags.map((t) => {
                  const display = formatDramaTag(t);
                  return (
                    <Button key={t} onClick={() => { setQ(t); submit(t); }}
                      className="px-3 h-7 rounded-(--r-ctl) bg-s3 border border-edge/30 hover:border-primary/40 hover:text-primary text-[13px] text-on/85 transition-colors pressable">{display}</Button>
                  );
                })}
              </div>
            </Surface>

            <div className="flex items-center justify-between mt-6 mb-2.5">
              <span className="text-[14px] font-bold text-on">{t("search.popular_tropes")}</span>
              <Button onClick={() => {
                const picked = DISCOVERY_THEMES[Math.floor(Math.random() * DISCOVERY_THEMES.length)];
                setQ(picked);
                submit(picked);
              }}
                className="flex items-center gap-1 text-[12px] text-primary font-semibold pressable"><IRefresh size={13} />{t("search.surprise_me")}</Button>
            </div>
            <div className="flex flex-wrap gap-2 mt-2">
              {DISCOVERY_THEMES.map((theme) => (
                <Button key={theme} onClick={() => { setTab("video"); setQ(theme); submit(theme, "video"); }}
                  className="px-3 h-7 rounded-(--r-ctl) bg-primary/10 hover:bg-primary/20 text-primary text-[12.5px] font-semibold pressable transition-colors">
                  {theme}
                </Button>
              ))}
            </div>
          </>
        ) : (
          <div onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd} className="touch-pan-y">
            <SegmentedControl className="mt-1 mb-3" aria-label="Result Type" activeIndex={tab === "video" ? 0 : 1}>
              {([["video", "Dramas"], ["post", "Posts"]] as const).map(([k, label]) => (
                <Button aria-pressed={tab === k} key={k} onClick={() => changeTab(k)}>{label}</Button>
              ))}
            </SegmentedControl>
            {!loading && !err && (tab === "video" ? items.length : posts.length) > 0 && (
              <div className="text-[12px] text-mut mb-2.5">"{submitted}" found <span className="text-primary font-bold">{tab === "video" ? items.length : posts.length}</span> results</div>
            )}
            {(tab === "video" ? items.length : posts.length) ? (
              <>
                {tab === "video" ? (
                  <Masonry videos={items} wide={wide} onOpen={(v) => push({ kind: "feed", videoIds: items.map((x) => x.id), index: Math.max(0, items.findIndex((x) => x.id === v.id)), title: `Search · ${submitted}` })} />
                ) : (
                  <div className={`ios-media-grid ${wide ? "is-wide" : ""}`}>
                    {posts.map((post) => (
                      <MediaCard key={post.id} title={post.title} cover={post.cover} subtitle={`${fmt(post.hot)} views`} onOpen={() => push({ kind: "post", id: post.id })} />
                    ))}
                  </div>
                )}
                <div className="flex justify-center py-4">
                  {loading ? <Loader className="w-6 h-6 spinner" />
                    : page < pages ? (
                      <Button onClick={() => run(submitted, page + 1)} className="px-5 h-9 rounded-(--r-ctl) bg-s3 text-[13px] text-on/85 pressable">Load More</Button>
                    ) : <span className="text-[12px] text-dim">— You've reached the end —</span>}
                </div>
              </>
            ) : loading ? (
              <div className="flex justify-center py-12"><Loader className="w-8 h-8 spinner" /></div>
            ) : (
              <Empty
                icon={<ISearch size={26} />}
                title={err || "No results found"}
                sub={err ? "Check your network connection and try again." : "Try other keywords such as 'Urban' or 'Revenge'"}
                action={err ? "Retry" : "View Rankings"}
                onAction={err ? () => run(submitted, 1) : () => push({ kind: "ranks" })}
              />
            )}
          </div>
        )}
        </div>
      </div>
    </div>
  );
}

/* ================= Top Rankings Page ================= */
const RANK_TABS = [
  { k: "hot", label: "Top Hits", desc: "Ranked by popularity & watch index" },
  { k: "recommend", label: "Recommended", desc: "Ranked by editor & algorithm scores" },
  { k: "potential", label: "Rising", desc: "Ranked by fastest growth" },
] as const;

export function RankPage({ onBack, wide }: { onBack: () => void; wide: boolean }) {
  const { push, toast } = useStore();
  const [tab, setTab] = useState<"hot" | "recommend" | "potential">("hot");
  const [items, setItems] = useState<RankItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.rank(tab)
      .then((res) => { if (alive) setItems(res?.items || []); })
      .catch((e) => { if (alive) { setItems([]); toast((e as Error).message || "Failed to load rankings", "info"); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [tab, toast]);

  const max = Math.max(1, ...items.map((x) => x.metric_value || 0));
  const meta = RANK_TABS.find((t) => t.k === tab) || RANK_TABS[0];

  return (
    <div className="ios-page absolute inset-0 bg-bg flex flex-col">
      <div className="shrink-0 relative overflow-hidden bg-s1" style={{ paddingTop: "var(--sat, 0px)" }}>
        <div className="absolute inset-0 pointer-events-none" style={{ background: "radial-gradient(90% 120% at 100% 0%, var(--p-pc) 0%, transparent 60%)", opacity: 0.32 }} />
        <div className={`relative px-3 pt-2 pb-4 ${wide ? "max-w-[960px] mx-auto w-full" : ""}`}>
          <Button aria-label="Back" onClick={onBack} className="w-10 h-10 rounded-full flex items-center justify-center text-on hover:bg-s3 pressable"><IBack size={20} /></Button>
          <div className="px-2 mt-1 flex items-end justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="w-9 h-9 rounded-(--r-sm) bg-pc text-on-pc flex items-center justify-center shrink-0"><ITrophy size={20} /></span>
                <span className="text-[22px] sm:text-[24px] font-bold tracking-wide text-on leading-tight truncate">AuraStream Rankings</span>
              </div>
              <div className="text-[12px] text-mut mt-1">{meta.desc} · Updated every 10 min</div>
            </div>
          </div>
          <SegmentedControl className="mt-3" aria-label="Ranking Type" activeIndex={RANK_TABS.findIndex(item => item.k === tab)}>
            {RANK_TABS.map((t) => (
              <Button aria-pressed={tab === t.k} key={t.k} onClick={() => setTab(t.k)}>{t.label}</Button>
            ))}
          </SegmentedControl>
        </div>
      </div>

      <div className="flex-1 scroll-y px-3.5 pt-3 pb-[calc(var(--sab,0px)+120px)]">
        <div className={wide ? "max-w-[960px] mx-auto w-full" : ""}>
        {loading ? (
          <div className="flex justify-center py-12"><Loader className="w-8 h-8 spinner" /></div>
        ) : items.length ? (
          items.map((it) => (
            <RankRow key={`${it.video_id}-${it.rank}`} item={it} metricMax={max}
              onOpen={() => push({ kind: "feed", videoIds: items.map((x) => x.video_id), index: Math.max(0, items.findIndex((x) => x.video_id === it.video_id)), title: "AuraStream Rankings" })} />
          ))
        ) : (
          <Empty icon={<ITrophy size={26} />} title="Rankings are currently empty" sub="Check back shortly or explore the home feed." />
        )}
        {wide && <div className="h-2" />}
        </div>
      </div>
    </div>
  );
}
