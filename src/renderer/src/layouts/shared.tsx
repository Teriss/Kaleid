import {
  useEffect,
  useRef,
  useState,
  lazy,
  Suspense,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  Heart,
  ArrowUpRight,
  Play,
  Pause,
  FolderOpen,
  Folder,
  ListMusic,
  Maximize2,
  X,
} from "lucide-react";
import type { BrowseMemory, MediaItem } from "../../../shared/types";
import { Cover, IconButton } from "../components";
import { act, resource, time, useApp, usePlayback } from "../store";
import type { PagedMediaSource } from "./source";
const CardLyrics = lazy(() => import("../music/CardLyrics"));

export interface LayoutProps {
  scope?: import("../../../shared/navigation").BrowseLocation;
  source: PagedMediaSource;
  memory: BrowseMemory;
  interactive: boolean;
  reducedMotion: boolean;
  remember(patch: Partial<BrowseMemory>): void;
  open(item: MediaItem, index: number): void;
  /** Undefined means a newer navigation/open request superseded this attempt. */
  openSingle?(item: MediaItem, index: number): Promise<boolean | undefined>;
  resolveSingle?(item: MediaItem): Promise<MediaItem | undefined>;
  playInline?(item: MediaItem, index: number, anchor: MediaItem): Promise<void>;
  onBrowseMotion?(keepControls?: boolean): void;
  cardVideo?: {
    id: string;
    item: MediaItem;
    anchorId: string;
    expanded: boolean;
  };
  inlineMusic?: { anchorId: string; item: MediaItem };
  stopCardVideo?(): void;
  expandCardVideo?(): void;
  favorite(item: MediaItem): void;
  selected?(item: MediaItem, index: number): boolean;
  clearFocus?(): void;
  select?(item: MediaItem, index: number, event?: ReactMouseEvent): void;
  contextMenu?(item: MediaItem, index: number, event: ReactMouseEvent): void;
  removeRecent?(item: MediaItem): void | Promise<void>;
  onReachEnd?(): void;
  onReachStart?(): void;
  onViewportAnchorChange?(item: MediaItem, index: number): void;
  minimumCellWidth?: number;
}
export function resolveFocusIndex(
  source: PagedMediaSource,
  memory: BrowseMemory,
) {
  const hint = memory.focusIndex;
  const index =
    memory.focusId &&
    hint !== undefined &&
    ((memory.revealFocus && memory.focusRequest) ||
      source.peek(hint)?.id === memory.focusId)
      ? hint
      : source.getSnapshot().anchorIndex;
  return Math.max(0, Math.min(source.total - 1, index));
}
export function useViewport() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({
    width: window.innerWidth,
    height: window.innerHeight,
  });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(() =>
      setSize({ width: el.clientWidth, height: el.clientHeight }),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return { ref, ...size };
}
export function useWindowKey(handler: (event: KeyboardEvent) => void) {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    const listener = (event: KeyboardEvent) => latest.current(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
}
export function canHandleKey(event: KeyboardEvent, interactive: boolean) {
  const target = event.target as HTMLElement;
  return (
    interactive &&
    !event.defaultPrevented &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName) &&
    !(
      event.key === "Enter" &&
      target.closest("button") &&
      !target.closest(".poster-hit")
    )
  );
}
function WallMusicControls({ item }: { item: MediaItem }) {
  const trackId = usePlayback((state) => state.track?.id);
  const playing = usePlayback((state) => state.playing);
  const queued = usePlayback((state) => state.queueIds.includes(item.id));
  const position = usePlayback((state) => state.position);
  const duration = usePlayback((state) => state.duration);
  const current = trackId === item.id;
  return (
    <div
      className="wall-playback-controls"
      aria-label={`音乐控制 ${item.title}`}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        aria-label={current && playing ? "暂停音乐" : "播放音乐"}
        onClick={() => {
          if (current) usePlayback.getState().toggle();
          else usePlayback.getState().play(item);
        }}
      >
        {current && playing ? (
          <Pause size={14} fill="currentColor" />
        ) : (
          <Play size={14} fill="currentColor" />
        )}
      </button>
      <span>{queued ? "已在队列" : "播放"}</span>
      <button
        type="button"
        aria-label="打开播放队列"
        onClick={() => usePlayback.setState({ queueVisible: true })}
      >
        <ListMusic size={14} />
      </button>
      <button
        type="button"
        aria-label="展开音乐播放器"
        onClick={() => usePlayback.setState({ expanded: true })}
      >
        <Maximize2 size={13} />
      </button>
      {current && (
        <input
          aria-label="墙面音乐进度"
          type="range"
          min="0"
          max={duration || 1}
          step="0.1"
          value={Math.min(position, duration || 1)}
          onClick={(event) => event.stopPropagation()}
          onChange={(event) =>
            usePlayback.getState().seekTo(Number(event.target.value))
          }
        />
      )}
    </div>
  );
}
export function Poster({
  item,
  index,
  active,
  instance,
  style,
  activate,
  favorite,
  selected = false,
  select,
  contextMenu,
  removeRecent,
  mode = "wall",
}: {
  item?: MediaItem;
  index: number;
  active?: boolean;
  instance?: string;
  style?: CSSProperties;
  activate(): void;
  favorite(item: MediaItem): void;
  selected?: boolean;
  select?(item: MediaItem, index: number, event?: ReactMouseEvent): void;
  contextMenu?(item: MediaItem, index: number, event: ReactMouseEvent): void;
  removeRecent?(item: MediaItem): void | Promise<void>;
  mode?: "wall" | "spatial" | "grid";
}) {
  const currentTrackId = usePlayback((state) => state.track?.id);
  const reducedMotion = useApp((state) => state.settings.reducedMotion);
  const showCardLyrics =
    active &&
    mode !== "grid" &&
    item?.type === "music" &&
    !item.kind &&
    item.id === currentTrackId;
  return (
    <article
      className={`poster ${mode}-poster ${active ? "is-focused" : ""} ${selected ? "is-selected" : ""} ${item?.kind === "folder" ? "directory-poster" : ""} ${item?.type === "image" ? "image-poster" : ""} ${mode === "grid" && item?.type === "comic" && item.remoteData?.comicRef ? "comic-result-card" : ""} ${item?.missing ? "is-missing" : ""}`}
      style={style}
      data-index={index}
      data-media-id={item?.id}
      data-entry-kind={item?.kind ?? "media"}
      data-instance={instance}
    >
      <button
        className="poster-hit"
        aria-label={`${item?.kind === "folder" ? (mode === "grid" || active ? "进入" : "聚焦") : mode === "grid" || active ? "打开" : "聚焦"} ${item?.title ?? "加载中"}`}
        disabled={!item}
        onDragStart={(event) => event.preventDefault()}
        onClick={(event) => {
          if (!item || (mode === "grid" && event.detail > 1)) return;
          select?.(item, index, event);
          activate();
        }}
        onContextMenu={(event) => item && contextMenu?.(item, index, event)}
      >
        {mode === "grid" &&
        item?.type === "comic" &&
        item.remoteData?.comicRef ? (
          <ComicResultContent item={item} />
        ) : item ? (
          <Cover item={item} />
        ) : (
          <div className="poster-placeholder" />
        )}
        {item?.kind === "folder" && (
          <span
            className="folder-corner"
            aria-label={`文件夹，${item.folderCount ?? 0} 项`}
          >
            <Folder size={14} />
          </span>
        )}
        {!(
          mode === "grid" &&
          item?.type === "comic" &&
          item.remoteData?.comicRef
        ) && <span className="poster-shade" />}
        {item &&
          !(
            mode === "grid" &&
            item.type === "comic" &&
            item.remoteData?.comicRef
          ) && (
            <span className="poster-caption">
              <strong>{item.title}</strong>
              {active && item.artist && <small>{item.artist}</small>}
            </span>
          )}
        {item?.type === "video" && item.duration ? (
          <span className="poster-duration">{time(item.duration)}</span>
        ) : null}
        {active && !item?.sourceRef && (
          <span className="poster-open">
            {!item?.kind &&
            (item?.type === "music" || item?.type === "video") ? (
              <Play size={18} fill="currentColor" />
            ) : (
              <ArrowUpRight size={19} />
            )}
          </span>
        )}
        {item?.missing && (
          <span className="poster-unavailable">文件不可用</span>
        )}
      </button>
      {showCardLyrics && (
        <Suspense fallback={null}>
          <CardLyrics item={item!} reducedMotion={reducedMotion} />
        </Suspense>
      )}
      {item && !item.kind && (
        <div className="tile-actions">
          {removeRecent && (
            <IconButton
              label={`从历史记录移除 ${item.title}`}
              onClick={() =>
                void Promise.resolve(removeRecent(item)).catch(console.error)
              }
            >
              <X size={15} />
            </IconButton>
          )}
          <IconButton
            label={
              item.favorite ? `取消收藏 ${item.title}` : `收藏 ${item.title}`
            }
            active={item.favorite}
            onClick={() => favorite(item)}
          >
            <Heart size={15} fill={item.favorite ? "currentColor" : "none"} />
          </IconButton>
          {active && !item?.sourceRef && (
            <IconButton
              label="在文件夹中显示"
              onClick={() => void act(() => window.media.reveal(item.id))}
            >
              <FolderOpen size={15} />
            </IconButton>
          )}
        </div>
      )}
      {item &&
        item.type === "music" &&
        !item.kind &&
        active &&
        mode !== "grid" && <WallMusicControls item={item} />}
    </article>
  );
}

/**
 * Rich online-comic tile: cover, `[<pages>p]` title, tags, rating and upload
 * time. Shared by the result grid and every hub/section card so all sources
 * present their comics the same way.
 */
export function ComicResultContent({ item }: { item: MediaItem }) {
  const comic = item.remoteData?.comic as
    | {
        maxPage?: number;
        stars?: number;
        uploadTime?: string;
        description?: string;
        tags?: unknown;
        tagDisplay?: {
          namespace: string;
          tags: { value: string; label: string }[];
        }[];
      }
    | undefined;
  const maxPage =
    typeof comic?.maxPage === "number" && comic.maxPage > 0
      ? comic.maxPage
      : undefined;
  const translatedTags = comic?.tagDisplay
    ?.filter(
      (group) =>
        !/^(category|categories|uploader|upload.?time|time|pages|max.?page)$/i.test(
          group.namespace,
        ),
    )
    .flatMap((group) =>
      group.tags.map((tag) => ({ value: tag.value, label: tag.label })),
    );
  const rawTags = Array.isArray(comic?.tags)
    ? comic.tags
        .filter((tag): tag is string => typeof tag === "string")
        .map((tag) => ({
          value: tag,
          label: tag.split(":").at(-1)?.replaceAll("_", " ") ?? tag,
        }))
    : [];
  // Keep descriptive tags (language, artist, parody, character, genre) and
  // leave source metadata such as category/uploader to the detail view.
  const tags = (translatedTags ?? rawTags)
    .filter(
      ({ value }) =>
        !/^(category|uploader|upload.?time|max.?page):/i.test(value),
    )
    .slice(0, 10);
  const rating =
    typeof comic?.stars === "number" && Number.isFinite(comic.stars)
      ? Math.max(0, Math.min(5, comic.stars))
      : undefined;
  // Venera's detailed comic tile also displays the list item's description
  // below the rating when the detail-only uploadTime field is unavailable.
  const uploaded = comic?.uploadTime?.trim() || comic?.description?.trim();
  const date = uploaded ? new Date(uploaded) : undefined;
  const timeLabel =
    date && Number.isFinite(date.getTime())
      ? new Intl.DateTimeFormat("zh-CN", {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).format(date)
      : uploaded;
  const title = `${maxPage ? `[${maxPage}p]` : ""}${item.title.replace(/\s*\n\s*/g, " ").trim()}`;
  return (
    <span className="comic-result-content">
      <Cover item={item} className="comic-result-cover" />
      <span className="comic-result-info">
        <strong className="comic-result-title" title={title}>
          {title}
        </strong>
        {item.artist && (
          <small className="comic-result-subtitle" title={item.artist}>
            {item.artist}
          </small>
        )}
        <span className="comic-result-tags" aria-label="漫画标签">
          {tags.map(({ value, label }, index) => (
            <span
              className="comic-result-tag"
              key={`${value}-${index}`}
              title={value}
            >
              {label}
            </span>
          ))}
        </span>
        <span className="comic-result-meta">
          {rating !== undefined && (
            <span
              className="comic-result-rating"
              aria-label={`评分 ${rating.toFixed(2)} / 5`}
            >
              <span aria-hidden="true">
                {"★".repeat(Math.round(rating))}
                {"☆".repeat(5 - Math.round(rating))}
              </span>
              <small>{rating.toFixed(2)}</small>
            </span>
          )}
          {timeLabel && (
            <small
              className="comic-result-time"
              aria-label={`上传时间 ${timeLabel}`}
            >
              {timeLabel}
            </small>
          )}
        </span>
      </span>
    </span>
  );
}

export function Backdrop({
  item,
  reducedMotion,
}: {
  item?: MediaItem;
  reducedMotion: boolean;
}) {
  const url = item?.cover ? resource(item, "cover") : "";
  const [pictures, setPictures] = useState<string[]>([]);
  useEffect(() => {
    if (!url) {
      setPictures([]);
      return;
    }
    setPictures((previous) =>
      reducedMotion
        ? [url]
        : [...previous.filter((p) => p !== url).slice(-1), url],
    );
    const timer = setTimeout(() => setPictures([url]), 800);
    return () => clearTimeout(timer);
  }, [url, reducedMotion]);
  return (
    <div className="scene-backdrop" aria-hidden="true">
      {pictures.map((picture) => (
        <img key={picture} src={picture} alt="" />
      ))}
      <div />
    </div>
  );
}
