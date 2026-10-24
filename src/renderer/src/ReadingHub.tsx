// Shared presentation for the comic and novel hubs. Existing class names preserve the comic visual language.
import {
  useEffect,
  useLayoutEffect,
  useRef,
  forwardRef,
  type HTMLAttributes,
  type MouseEvent as ReactMouseEvent,
  type ReactEventHandler,
  type ReactNode,
} from "react";
import {
  BookmarkPlus,
  ChevronDown,
  ChevronRight,
  LoaderCircle,
  X,
  type LucideIcon,
} from "lucide-react";
import { IconButton, Modal } from "./components";
import { createPortal } from "react-dom";
import "./readingHub.css";
import type { MediaItem, MediaLayout } from "../../shared/types";
import type { LayoutProps } from "./layouts/shared";
import { ComicResultContent } from "./layouts/shared";
import StandardGrid from "./layouts/StandardGrid";
import ArchiveShelf from "./layouts/ArchiveShelf";
import SpatialGrid from "./layouts/SpatialGrid";
export const ReadingPageShell = forwardRef<
  HTMLElement,
  HTMLAttributes<HTMLElement>
>(function ReadingPageShell({ className = "", ...props }, ref) {
  return (
    <section ref={ref} className={`online-comics ${className}`} {...props} />
  );
});
export function ReadingResults({
  layout,
  single = false,
  props,
  alternate,
}: {
  layout: MediaLayout;
  single?: boolean;
  props: LayoutProps;
  alternate?: ReactNode;
}) {
  if (layout === "archiveShelf")
    return <ArchiveShelf {...props} allowInfinite={!single} />;
  if (layout === "carousel" || layout === "spatial")
    return (
      <SpatialGrid {...props} forceCarousel={single || layout === "carousel"} />
    );
  return alternate || <StandardGrid {...props} />;
}
export function ReadingDetailHero({
  source,
  title,
  cover,
  subtitle,
  metadata,
  actions,
  onCoverLoad,
}: {
  source: string;
  title: string;
  cover?: string;
  subtitle?: string;
  metadata?: ReactNode;
  actions: ReactNode;
  onCoverLoad?: ReactEventHandler<HTMLImageElement>;
}) {
  return (
    <section className="comic-detail-hero">
      <div className="comic-detail-cover-wrap">
        {cover && (
          <img
            className="comic-detail-cover-backdrop"
            src={cover}
            alt=""
            style={{ pointerEvents: "none" }}
          />
        )}
        {cover ? (
          <img
            className="comic-detail-cover"
            src={cover}
            alt={`${title}封面`}
            onLoad={onCoverLoad}
          />
        ) : (
          <div className="comic-detail-cover comic-detail-cover-empty" />
        )}
      </div>
      <div className="comic-detail-intro" style={{ position: "relative" }}>
        <div className="comic-detail-source">{source}</div>
        <h1>{title}</h1>
        {subtitle && <p className="comic-detail-subtitle">{subtitle}</p>}
        {metadata}
        <div className="comic-detail-primary-actions">{actions}</div>
      </div>
    </section>
  );
}

export function ReadingHubCards<T>({
  items,
  identity,
  title,
  cover,
  open,
  toggleLater,
  isLater,
  remove,
  contextMenu,
  transitionId,
  empty = "暂无作品",
  large = false,
  className = "",
  richItem,
  richWrap = false,
}: {
  items: T[];
  identity(item: T): string;
  title(item: T): string;
  cover(item: T): ReactNode;
  open(item: T): void;
  toggleLater?: (item: T, value: boolean) => void;
  isLater?: (item: T) => boolean;
  remove?: (item: T) => void;
  contextMenu?(item: T, event: ReactMouseEvent): void;
  transitionId?: (item: T) => string | undefined;
  empty?: string;
  large?: boolean;
  className?: string;
  /** Supplies a rich result tile for items that have online metadata. */
  richItem?(item: T): MediaItem | undefined;
  /** Lay rich tiles out as a wrapping grid instead of a scrolling rail. */
  richWrap?: boolean;
}) {
  if (!items.length) return <div className="comic-hub-empty">{empty}</div>;
  const rich = Boolean(richItem && items.some((item) => richItem(item)));
  return (
    <div
      className={`comic-hub-cards ${large ? "is-large" : ""} ${rich ? "is-rich" : ""} ${rich && richWrap ? "is-wrap" : ""} ${className}`}
    >
      {items.map((item) => {
        const media = richItem?.(item);
        return (
          <article
            className={`comic-hub-card ${media ? "is-rich" : ""}`}
            key={identity(item)}
            data-hub-id={identity(item)}
            data-comic-transition-id={transitionId?.(item)}
            onContextMenu={(event) => contextMenu?.(item, event)}
          >
            <button
              className={`comic-hub-cover ${media ? "is-rich" : ""}`}
              onClick={() => open(item)}
            >
              {media ? (
                <ComicResultContent item={media} />
              ) : (
                <>
                  {cover(item)}
                  <span className="comic-hub-card-title">{title(item)}</span>
                </>
              )}
            </button>
            {toggleLater && (
              <IconButton
                label={isLater?.(item) ? "从稍后阅读移除" : "加入稍后阅读"}
                active={isLater?.(item)}
                onClick={() => toggleLater(item, !isLater?.(item))}
              >
                <BookmarkPlus size={15} />
              </IconButton>
            )}
            {remove && (
              <IconButton label="从最近阅读移除" onClick={() => remove(item)}>
                <X size={15} />
              </IconButton>
            )}
          </article>
        );
      })}
    </div>
  );
}

export function ReadingHubMenu({
  title,
  open,
  close,
  section,
  items,
  navigate,
}: {
  title: string;
  open: boolean;
  close(): void;
  section: string;
  items: { section: string; label: string; Icon: LucideIcon }[];
  navigate(section: string): void;
}) {
  const layer = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    layer.current
      ?.querySelector<HTMLButtonElement>("aside button")
      ?.focus({ preventScroll: true });
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const buttons = Array.from(
        layer.current?.querySelectorAll<HTMLButtonElement>("aside button") ||
          [],
      );
      const edge = event.shiftKey ? buttons[0] : buttons.at(-1);
      if (document.activeElement === edge) {
        event.preventDefault();
        (event.shiftKey ? buttons.at(-1) : buttons[0])?.focus();
      }
    };
    const node = layer.current;
    node?.addEventListener("keydown", keydown);
    return () => {
      node?.removeEventListener("keydown", keydown);
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus({ preventScroll: true });
    };
  }, [open]);
  return (
    <div
      ref={layer}
      className={`comic-main-menu-layer ${open ? "is-open" : ""}`}
      aria-hidden={!open}
      inert={!open}
    >
      <button
        type="button"
        className="comic-main-menu-backdrop"
        aria-label={`关闭${title}菜单`}
        onClick={close}
      />
      <aside
        className="comic-main-menu-drawer"
        aria-label={`${title}主菜单`}
        onMouseLeave={close}
      >
        <div className="comic-main-menu-heading">
          <strong>{title}</strong>
          <IconButton label={`关闭${title}菜单`} onClick={close}>
            <X size={18} />
          </IconButton>
        </div>
        <nav aria-label={`${title}页面`}>
          {items.map(({ section: key, label, Icon }) => (
            <button
              type="button"
              key={key}
              className={section === key ? "active" : ""}
              aria-current={section === key ? "page" : undefined}
              onClick={() => {
                close();
                navigate(key);
              }}
            >
              <Icon size={18} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
      </aside>
    </div>
  );
}

export function ReadingDetailSkeleton({
  sourceName,
  title,
  cover,
  exiting = false,
  kind = "漫画",
}: {
  sourceName: string;
  title?: string;
  cover?: string;
  exiting?: boolean;
  kind?: string;
}) {
  return (
    <main
      className={`online-detail comic-detail-loading${exiting ? " is-exiting" : ""}`}
      role={exiting ? undefined : "status"}
      aria-label={exiting ? undefined : `正在加载${kind}详情`}
      aria-hidden={exiting || undefined}
    >
      {!exiting && (
        <div className="comic-detail-loading-indicator">
          <LoaderCircle className="spin" size={16} />
          <span>正在加载{kind}详情</span>
        </div>
      )}
      <section className="comic-detail-hero comic-detail-skeleton-hero">
        <div className="comic-detail-cover-wrap">
          {cover ? (
            <img
              className="comic-detail-cover comic-detail-shimmer"
              src={cover}
              alt=""
            />
          ) : (
            <div className="comic-detail-cover comic-detail-cover-empty comic-detail-shimmer" />
          )}
        </div>
        <div className="comic-detail-intro">
          <div className="comic-detail-source">{sourceName}</div>
          {title ? (
            <h1>{title}</h1>
          ) : (
            <div className="comic-detail-shimmer comic-detail-skeleton-title" />
          )}
          <div className="comic-detail-shimmer comic-detail-skeleton-line is-short" />
          <div className="comic-detail-skeleton-actions" aria-hidden="true">
            <span className="comic-detail-shimmer" />
            <span className="comic-detail-shimmer" />
            <span className="comic-detail-shimmer is-small" />
          </div>
        </div>
      </section>
      <section
        className="comic-detail-section comic-detail-skeleton-section"
        aria-hidden="true"
      >
        <div className="comic-detail-shimmer comic-detail-skeleton-heading" />
        <div className="comic-detail-shimmer comic-detail-skeleton-line" />
        <div className="comic-detail-shimmer comic-detail-skeleton-line is-short" />
      </section>
      <section
        className="comic-detail-section comic-detail-skeleton-section"
        aria-hidden="true"
      >
        <div className="comic-detail-shimmer comic-detail-skeleton-heading" />
        <div className="comic-detail-skeleton-chapters">
          <span className="comic-detail-shimmer" />
          <span className="comic-detail-shimmer" />
          <span className="comic-detail-shimmer" />
        </div>
      </section>
    </main>
  );
}

export function HomeSectionToggle({
  title,
  count,
  collapsed,
  onClick,
}: {
  title: string;
  count?: number;
  collapsed: boolean;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      className="comic-home-section-toggle"
      aria-expanded={!collapsed}
      onClick={onClick}
    >
      {collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
      <span className="comic-home-section-title">{title}</span>
      {count != null && <span>{count}</span>}
    </button>
  );
}

export interface DownloadQueueGroup {
  id: string;
  title: string;
  subtitle: string;
  /** Every unfinished task, used by the destructive cancel action. */
  taskIds: string[];
  /** Running or waiting tasks; pause applies to these. */
  activeTaskIds: string[];
  /** Tasks the user paused; they stay listed so they can be resumed. */
  pausedTaskIds: string[];
  downloading: number;
  queued: number;
  paused: number;
  progress?: number;
  progressLabel: string;
}

export function DownloadQueueModal({
  groups,
  close,
  pause,
  resume,
  cancel,
}: {
  groups: DownloadQueueGroup[];
  close(): void;
  pause(taskIds: string[]): void;
  resume(taskIds: string[]): void;
  cancel(taskIds: string[]): void;
}) {
  const activeTasks = groups.reduce(
    (sum, group) => sum + group.activeTaskIds.length,
    0,
  );
  const pausedTasks = groups.reduce(
    (sum, group) => sum + group.pausedTaskIds.length,
    0,
  );
  return (
    <Modal
      title="下载中"
      subtitle={[
        `${groups.length} 部作品`,
        activeTasks ? `${activeTasks} 个章节任务` : "",
        pausedTasks ? `${pausedTasks} 个已暂停` : "",
      ]
        .filter(Boolean)
        .join(" · ")}
      className="download-queue-modal"
      close={close}
    >
      {groups.length ? (
        <div className="download-queue-list">
          {groups.map((group) => (
            <article className="download-queue-item" key={group.id}>
              <div className="download-queue-copy">
                <strong title={group.title}>{group.title}</strong>
                <small>{group.subtitle}</small>
                <div
                  className="download-queue-progress"
                  aria-label={`${group.title}：${group.progressLabel}`}
                >
                  {group.progress === undefined ? (
                    <progress aria-label={`${group.title} 下载准备进度`} />
                  ) : (
                    <progress
                      value={group.progress}
                      max={100}
                      aria-label={`${group.title} 下载进度`}
                    />
                  )}
                  <small>{group.progressLabel}</small>
                </div>
              </div>
              <div className="download-queue-actions">
                {group.activeTaskIds.length > 0 && (
                  <button
                    className="button secondary"
                    onClick={() => pause(group.activeTaskIds)}
                  >
                    暂停
                  </button>
                )}
                {group.pausedTaskIds.length > 0 && (
                  <button
                    className="button secondary"
                    onClick={() => resume(group.pausedTaskIds)}
                  >
                    继续
                  </button>
                )}
                <button
                  className="text-button danger-text"
                  onClick={() => cancel(group.taskIds)}
                >
                  取消
                </button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <p className="download-queue-empty">当前没有正在下载或排队的内容。</p>
      )}
    </Modal>
  );
}

export interface HubMenuItem {
  label: string;
  Icon?: LucideIcon;
  danger?: boolean;
  onSelect(): void;
}

export function HubContextMenu({
  heading,
  items,
  point,
  close,
}: {
  heading?: string;
  items: HubMenuItem[];
  point: { x: number; y: number };
  close(): void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = menu.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    node.style.left = `${Math.max(8, Math.min(point.x, window.innerWidth - rect.width - 8))}px`;
    node.style.top = `${Math.max(8, Math.min(point.y, window.innerHeight - rect.height - 8))}px`;
    node.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus({
      preventScroll: true,
    });
  }, [point.x, point.y, items.length]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    window.addEventListener("keydown", keydown, true);
    const scroll = (event: Event) => {
      if (!menu.current?.contains(event.target as Node)) close();
    };
    window.addEventListener("scroll", scroll, true);
    return () => {
      window.removeEventListener("keydown", keydown, true);
      window.removeEventListener("scroll", scroll, true);
    };
  }, [close]);
  if (!items.length) return null;
  return createPortal(
    <div
      className="context-dismiss"
      onMouseDown={close}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div
        ref={menu}
        className="media-context-menu hub-context-menu"
        role="menu"
        aria-label="内容操作"
        style={{ left: point.x, top: point.y }}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          const buttons = [
            ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
              "[role=menuitem]",
            ),
          ];
          const current = buttons.indexOf(
            document.activeElement as HTMLButtonElement,
          );
          buttons[
            (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) %
              buttons.length
          ]?.focus();
        }}
      >
        {heading && <div className="context-heading">{heading}</div>}
        {items.map((item) => (
          <button
            role="menuitem"
            key={item.label}
            className={item.danger ? "danger" : ""}
            onClick={() => {
              close();
              item.onSelect();
            }}
          >
            {item.Icon ? <item.Icon size={15} /> : <span />}
            <span>{item.label}</span>
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}
