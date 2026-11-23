import { fmt } from "../api";
import type { VideoCard } from "../types";
import { IPlayF, IStarF } from "../icons";
import { Img } from "./ui";
import { Button } from "./ios/controls";
import { formatDramaAuthor, formatDramaTag, formatDramaTitle } from "../subtitles/dramaTranslator";

function ScoreBadge({ score }: { score: number }) {
  return Number.isFinite(score) && score > 0 ? <span className="ios-score-badge" aria-label={`Rating ${score.toFixed(1)}`}>
    <IStarF size={12} />{score.toFixed(1)}
  </span> : null;
}

export function MediaCard({ title, cover, subtitle, badge, isFinished, progress, score, priority = false, onOpen }: {
  title: string; cover: string; subtitle?: string; badge?: string; isFinished?: boolean; progress?: string; score?: number; priority?: boolean; onOpen: () => void;
}) {
  const displayTitle = formatDramaTitle(title);
  return <Button onClick={onOpen} className="ios-poster" aria-label={displayTitle}>
    <span className={`ios-poster-art ${badge ? "has-poster-badge" : ""}`}>
      <Img src={cover} alt="" eager={priority} />
      {badge && <span className={`ios-poster-badge ${isFinished ? "is-finished" : ""}`}>{badge}</span>}
      {typeof score === "number" && <ScoreBadge score={score} />}
      {progress && <span className="ios-poster-progress"><IPlayF size={12} />{progress}</span>}
      <span className="ios-poster-play" aria-hidden="true"><IPlayF size={23} /></span>
    </span>
    <span className="ios-poster-title">{displayTitle}</span>
    {subtitle && <span className="ios-poster-subtitle">{subtitle}</span>}
  </Button>;
}

export function WaterfallCard({ v, onOpen, priority = false }: { v: VideoCard; onOpen: () => void; priority?: boolean }) {
  const tagsStr = v.tags?.slice(0, 2).map(formatDramaTag).join(" · ");
  const authorStr = v.author?.name ? formatDramaAuthor(v.author.name) : "AAA";
  return <MediaCard title={v.title} cover={v.cover} onOpen={onOpen} priority={priority} score={v.score}
    badge={v.is_finished ? "Finished" : `Ep. ${v.episode_count}`}
    isFinished={v.is_finished}
    subtitle={tagsStr || authorStr}
    progress={`${fmt(v.hot)} plays`} />;
}

export function Masonry({ videos, onOpen, wide = false }: {
  videos: VideoCard[]; onOpen: (v: VideoCard) => void; wide?: boolean; gap?: string;
}) {
  return <div className={`ios-media-grid ${wide ? "is-wide" : ""}`} data-ui="media-grid">
    {videos.map((v, index) => <WaterfallCard key={v.id} v={v} priority={index < 2} onOpen={() => onOpen(v)} />)}
  </div>;
}

export function RowCard({ v, onOpen }: { v: VideoCard; onOpen: () => void }) {
  const tag0 = v.tags?.[0] ? formatDramaTag(v.tags[0]) : "Drama";
  const tagsStr = v.tags?.slice(0, 2).map(formatDramaTag).join(" · ");
  return <div className="ios-row-card"><MediaCard title={v.title} cover={v.cover} score={v.score} onOpen={onOpen}
    badge={v.is_finished ? "Finished" : `${v.episode_count} Eps`}
    isFinished={v.is_finished}
    subtitle={tagsStr || tag0 || "AuraStream"} />
  </div>;
}

export function RankRow({ item, onOpen, metricMax }: {
  item: { rank: number; video_id: number; title: string; cover: string; tags: string[]; score: number; metric_value: number; metric_label: string };
  onOpen: () => void; metricMax: number;
}) {
  const tagsStr = item.tags?.slice(0, 2).map(formatDramaTag).join(" · ") || "Trending · Drama";
  return <Button className="ios-rank-row" onClick={onOpen}>
    <span className={`ios-rank-number ${item.rank < 4 ? "is-top" : ""}`}>{String(item.rank).padStart(2, "0")}</span>
    <span className="ios-rank-cover"><Img src={item.cover} />{typeof item.score === "number" && <ScoreBadge score={item.score} />}</span>
    <span className="ios-rank-copy"><strong>{formatDramaTitle(item.title)}</strong><span>{tagsStr}</span>
      <span className="ios-rank-meter" aria-hidden="true"><span style={{ width: `${Math.max(6, item.metric_value / Math.max(1, metricMax) * 100)}%` }} /></span>
    </span>
    <span className="ios-rank-metric"><IStarF size={13} className="text-amber-400" />{fmt(item.metric_value)}</span>
  </Button>;
}
