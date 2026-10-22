import type { ComponentType, CSSProperties, ReactNode } from "react";
import {
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  Heart,
  ListMusic,
  Pause,
  Play,
  Maximize2,
  X,
} from "lucide-react";
import { Cover, IconButton } from "../components";
import { act, usePlayback } from "../store";
import type { MediaItem } from "../../../shared/types";
import type { LayoutProps } from "./shared";
import {
  showcaseIndex,
  showcasePose,
  showcaseSize,
  type ShowcaseKind,
} from "./showcaseModel";
import { useShowcase } from "./useShowcase";
import "./mediaShowcase.css";
import CardVideo from "../CardVideo";

function MusicCardControls({
  item,
  play,
  expand,
}: {
  item: MediaItem;
  play(): void;
  expand(): void;
}) {
  const trackId = usePlayback((s) => s.track?.id),
    playing = usePlayback((s) => s.playing);
  const position = usePlayback((s) => s.position),
    duration = usePlayback((s) => s.duration);
  const current = item.id === trackId;
  return (
    <div
      className="showcase-card-toolbar"
      aria-label={`音乐卡片控制 ${item.title}`}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button
        aria-label={current && playing ? "暂停卡片音乐" : "播放卡片音乐"}
        onClick={play}
      >
        {current && playing ? <Pause size={18} /> : <Play size={18} />}
      </button>
      <input
        aria-label="卡片音乐进度"
        type="range"
        min={0}
        max={current ? duration || 1 : item.duration || 1}
        step={0.1}
        value={current ? Math.min(position, duration || 1) : 0}
        disabled={!current}
        onChange={(event) =>
          usePlayback.getState().seekTo(Number(event.target.value))
        }
      />
      <button
        aria-label="打开播放队列"
        disabled={!trackId}
        onClick={() => usePlayback.setState({ queueVisible: true })}
      >
        <ListMusic size={17} />
      </button>
      <button aria-label="展开音乐播放器" onClick={expand}>
        <Maximize2 size={17} />
      </button>
    </div>
  );
}

export interface ShowcaseFaceProps {
  item?: MediaItem;
  active: boolean;
  playing: boolean;
}
export function ShowcaseCover({
  item,
  children,
}: {
  item?: MediaItem;
  children?: ReactNode;
}) {
  return item?.kind ? (
    <span className="showcase-collection">
      <Cover item={item} />
      <span className="showcase-folder-placeholder">
        <FolderOpen size={38} strokeWidth={1} />
      </span>
      <span className="showcase-folder-badge">
        <FolderOpen size={16} strokeWidth={1.5} />
        {item.folderCount !== undefined ? `${item.folderCount} 项` : "媒体合集"}
      </span>
      <strong className="showcase-folder-title">{item.title}</strong>
    </span>
  ) : item ? (
    <span className="showcase-cover">
      <Cover item={item} />
      <span className="showcase-fallback-title">{item.title}</span>
      {children}
    </span>
  ) : (
    <span className="showcase-placeholder" />
  );
}

export default function MediaShowcase({
  kind,
  title,
  eyebrow,
  Face,
  metadata,
  ...props
}: LayoutProps & {
  kind: ShowcaseKind;
  title: string;
  eyebrow: string;
  Face: ComponentType<ShowcaseFaceProps>;
  metadata(item: MediaItem): string;
}) {
  const flow = useShowcase(props, kind);
  const { source, interactive, favorite, removeRecent } = props;
  const { item, index, mode, geometry, snapshot } = flow;
  const mediaItem =
    props.inlineMusic && item?.id === props.inlineMusic.anchorId
      ? props.inlineMusic.item
      : props.cardVideo && item?.id === props.cardVideo.anchorId
        ? props.cardVideo.item
        : item;
  const trackId = usePlayback((state) => state.track?.id);
  const playing = usePlayback((state) => state.playing);
  const current = mediaItem && !mediaItem.kind && mediaItem.id === trackId;
  const looping = mode === "infinite";
  return (
    <section
      ref={flow.ref}
      tabIndex={-1}
      className={`media-showcase showcase-${kind}`}
      aria-label={title}
      data-layout={kind}
      data-layout-ready={snapshot.ready}
      data-mode={mode}
      data-moving={flow.moving}
      data-reduced={flow.reduced}
      data-paused={!interactive || flow.hidden}
    >
      <div className="showcase-content">
        <header className="showcase-heading">
          <span>{eyebrow}</span>
          <i />
          <div
            className="showcase-mode"
            role="group"
            aria-label={`${title}范围`}
          >
            {(["finite", "infinite"] as const).map((value) => (
              <button
                key={value}
                type="button"
                disabled={!interactive}
                aria-pressed={mode === value}
                onClick={() => flow.changeMode(value)}
              >
                {value === "finite" ? "有限" : "无限"}
              </button>
            ))}
          </div>
        </header>
        <div
          className="showcase-stage"
          style={{ height: geometry.stageHeight }}
          {...flow.stageHandlers}
        >
          {kind === "screeningRoom" && item && !item.kind && (
            <div className="screen-ambience" aria-hidden="true" key={item.id}>
              <Cover item={item} />
            </div>
          )}
          <div className="showcase-floor" aria-hidden="true" />
          <div className="showcase-world">
            {flow.slots.map((slot) => {
              const at = showcaseIndex(slot, source.total),
                entry = source.peek(at),
                active = slot === flow.lane;
              const displayEntry =
                active &&
                props.inlineMusic &&
                entry?.id === props.inlineMusic.anchorId
                  ? props.inlineMusic.item
                  : active &&
                      props.cardVideo &&
                      entry?.id === props.cardVideo.anchorId
                    ? props.cardVideo.item
                    : entry;
              const size = showcaseSize(kind, geometry, displayEntry),
                collection = Boolean(
                  entry?.kind &&
                  !(entry.kind === "folder" && entry.folderCount === 1),
                ),
                pose = showcasePose(
                  kind,
                  slot,
                  flow.position.current,
                  geometry,
                );
              return (
                <div
                  key={slot}
                  className={`showcase-item ${entry?.missing ? "is-missing" : ""}`}
                  data-media-id={entry?.id}
                  data-index={at}
                  data-active={active}
                  data-slot={slot}
                  data-playing={
                    active &&
                    !displayEntry?.kind &&
                    displayEntry?.id === trackId &&
                    playing
                  }
                  ref={(node) => {
                    if (node) flow.nodes.current.set(slot, node);
                    else flow.nodes.current.delete(slot);
                  }}
                  style={
                    {
                      width: size.width,
                      height: size.height,
                      transform: pose.transform,
                      opacity: pose.opacity,
                      zIndex: pose.zIndex,
                      "--showcase-focus": pose.focus,
                    } as CSSProperties
                  }
                  onContextMenu={(event) => flow.contextMenu(slot, event)}
                >
                  <button
                    type="button"
                    className="showcase-hit"
                    tabIndex={active ? 0 : -1}
                    disabled={!interactive || !entry}
                    aria-label={`${active ? "打开" : "聚焦"} ${entry?.title ?? "正在加载"}`}
                    onClick={() => flow.activate(slot)}
                  >
                    <Face
                      item={displayEntry}
                      active={active}
                      playing={
                        active &&
                        !displayEntry?.kind &&
                        displayEntry?.id === trackId &&
                        playing
                      }
                    />
                    {entry?.missing && (
                      <span className="showcase-unavailable">文件不可用</span>
                    )}
                  </button>
                  {active &&
                    displayEntry &&
                    !displayEntry.kind &&
                    kind === "recordCrate" && (
                      <MusicCardControls
                        item={displayEntry}
                        play={() =>
                          void props.playInline?.(displayEntry, at, entry!)
                        }
                        expand={flow.openCurrent}
                      />
                    )}
                  {active &&
                    kind === "screeningRoom" &&
                    (!props.cardVideo ||
                      props.cardVideo.anchorId !== entry?.id) && (
                      <button
                        className="showcase-start"
                        aria-label={
                          collection ? "打开媒体合集" : "播放卡片视频"
                        }
                        disabled={!interactive}
                        onClick={() => flow.activate(slot)}
                      >
                        {collection ? (
                          <FolderOpen size={24} />
                        ) : (
                          <Play size={24} />
                        )}
                      </button>
                    )}
                </div>
              );
            })}
          </div>
          {kind === "screeningRoom" &&
            props.cardVideo &&
            !props.cardVideo.expanded && (
              <CardVideo
                id={props.cardVideo.id}
                item={props.cardVideo.item}
                anchor={flow.nodes.current.get(flow.lane) ?? null}
                blocked={!interactive}
                stop={() => props.stopCardVideo?.()}
                expand={() => props.expandCardVideo?.()}
              />
            )}
        </div>
        <div className="showcase-caption">
          <button
            type="button"
            className="showcase-open"
            disabled={!interactive || !item}
            onClick={flow.openCurrent}
            aria-label={item ? `打开 ${item.title}` : "正在加载媒体"}
          >
            <span>
              <strong>{mediaItem?.title ?? "正在加载…"}</strong>
              <small>
                {mediaItem?.missing
                  ? "文件不可用"
                  : mediaItem?.kind
                    ? `${mediaItem.kind === "folder" ? "文件夹" : "媒体合集"}${mediaItem.folderCount !== undefined ? ` · ${mediaItem.folderCount} 项` : ""}`
                    : mediaItem
                      ? metadata(mediaItem)
                      : ""}
              </small>
            </span>
            <ArrowUpRight size={23} />
          </button>
          {mediaItem && !mediaItem.kind && (
            <div className="showcase-actions">
              {kind === "recordCrate" && (
                <>
                  <IconButton
                    label={current && playing ? "暂停当前音乐" : "播放当前音乐"}
                    disabled={!interactive}
                    onClick={() =>
                      current
                        ? usePlayback.getState().toggle()
                        : flow.activate(flow.lane)
                    }
                  >
                    {current && playing ? (
                      <Pause size={20} />
                    ) : (
                      <Play size={20} />
                    )}
                  </IconButton>
                  <IconButton
                    label="打开播放队列"
                    disabled={!interactive || !trackId}
                    onClick={() => usePlayback.setState({ queueVisible: true })}
                  >
                    <ListMusic size={20} />
                  </IconButton>
                </>
              )}
              <IconButton
                label={`${mediaItem.favorite ? "取消收藏" : "收藏"} ${mediaItem.title}`}
                disabled={!interactive}
                active={mediaItem.favorite}
                onClick={() => favorite(mediaItem)}
              >
                <Heart
                  size={18}
                  fill={mediaItem.favorite ? "currentColor" : "none"}
                />
              </IconButton>
              {removeRecent && (
                <IconButton
                  label={`从历史记录移除 ${mediaItem.title}`}
                  disabled={!interactive}
                  onClick={() =>
                    void act(() => Promise.resolve(removeRecent(mediaItem)))
                  }
                >
                  <X size={17} />
                </IconButton>
              )}
            </div>
          )}
        </div>
        <footer className="showcase-pagination">
          <IconButton
            label="上一项"
            disabled={
              !interactive || source.total < 2 || (!looping && index === 0)
            }
            onClick={() => flow.step(-1)}
          >
            <ChevronLeft size={19} />
          </IconButton>
          <output
            aria-label={`${title}位置`}
            aria-live="polite"
            aria-atomic="true"
          >
            {String(source.total ? index + 1 : 0).padStart(2, "0")} /{" "}
            {String(source.total).padStart(2, "0")}
          </output>
          <IconButton
            label="下一项"
            disabled={
              !interactive ||
              source.total < 2 ||
              (!looping && index === source.total - 1)
            }
            onClick={() => flow.step(1)}
          >
            <ChevronRight size={19} />
          </IconButton>
        </footer>
        {snapshot.error && (
          <div className="showcase-error" role="status">
            {snapshot.error}
            <button disabled={!interactive} onClick={() => source.retry()}>
              重试加载
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
