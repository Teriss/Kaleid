import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  Minus,
  Plus,
  RotateCw,
  Expand,
} from "lucide-react";
import VideoPlayer from "./VideoPlayer";
import type { ComicPage, MediaItem, Progress } from "../../shared/types";
import { IconButton } from "./components";
import { act, report, resource, useApp } from "./store";
import NovelViewer from "./NovelViewer";

export default function Viewer({
  item,
  items,
  close,
  switchItem,
  navigation,
  passive = false,
  videoSort = "name",
}: {
  passive?: boolean;
  videoSort?: "name" | "added" | "recent";
  item: MediaItem;
  items: MediaItem[];
  close(): void;
  switchItem(item: MediaItem): void;
  navigation?: {
    index: number;
    total: number;
    step(direction: number): Promise<void>;
  };
}) {
  const [tools, setTools] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    if (item.type === "video") return;
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !document.querySelector("dialog[open]"))
        close();
    };
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("keydown", key);
      clearTimeout(timer.current);
    };
  }, [close, item.type]);
  useEffect(() => {
    if (passive) return;
    void act(async () => {
      await window.media.opened(item.id);
      useApp.getState().touch();
    });
  }, [item.id]);
  function activity() {
    setTools(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setTools(false), 3500);
  }
  const group = items.filter(
    (m) =>
      m.type === item.type &&
      (item.type !== "image" || m.folder === item.folder),
  );
  const index = navigation?.index ?? group.findIndex((m) => m.id === item.id);
  function next(direction: number) {
    if (navigation) {
      void navigation.step(direction).catch(report);
      return;
    }
    const target = group[index + direction];
    if (target) switchItem(target);
  }
  if (item.type === "video")
    return (
      <VideoPlayer
        item={item}
        autoPlay={!passive}
        close={close}
        switchItem={switchItem}
        sort={videoSort}
      />
    );
  return (
    <div
      className={`viewer viewer-${item.type} ${tools ? "" : "quiet"}`}
      onMouseMove={activity}
      onFocusCapture={() => setTools(true)}
    >
      <header className="viewer-header">
        <button className="back-button" onClick={close}>
          <ArrowLeft size={19} />
          返回媒体库
        </button>
        <div>
          <strong>{item.title}</strong>
          <small>
            {item.type === "image"
              ? `${index + 1} / ${navigation?.total ?? group.length}`
              : item.ext.toUpperCase()}
          </small>
        </div>
        <IconButton
          label="在文件夹中显示"
          onClick={() => void act(() => window.media.reveal(item.id))}
        >
          <FolderOpen size={19} />
        </IconButton>
      </header>
      {item.type === "image" && (
        <ImageViewer
          key={item.id}
          item={item}
          previous={() => next(-1)}
          next={() => next(1)}
          hasPrevious={index > 0}
          hasNext={index < (navigation?.total ?? group.length) - 1}
        />
      )}
      {item.type === "novel" && <NovelViewer key={item.id} item={item} close={close} />}
      {item.type === "comic" && <ComicViewer key={item.id} item={item} />}
    </div>
  );
}
function ImageViewer({
  item,
  previous,
  next,
  hasPrevious,
  hasNext,
}: {
  item: MediaItem;
  previous(): void;
  next(): void;
  hasPrevious: boolean;
  hasNext: boolean;
}) {
  const canvas = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const [zoom, setZoom] = useState(1);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const [rotation, setRotation] = useState(0);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(
    null,
  );
  const [error, setError] = useState(false);
  useEffect(() => {
    setError(false);
  }, [item.resourceVersion]);
  function fitImage(degrees = rotation) {
    const img = image.current;
    const surface = canvas.current;
    if (!img?.naturalWidth || !surface) return;
    const style = getComputedStyle(surface);
    const availableWidth =
      surface.clientWidth -
      parseFloat(style.paddingLeft) -
      parseFloat(style.paddingRight);
    const availableHeight =
      surface.clientHeight -
      parseFloat(style.paddingTop) -
      parseFloat(style.paddingBottom);
    const sideways = Math.abs(degrees % 180) === 90;
    const width = sideways ? img.naturalHeight : img.naturalWidth;
    const height = sideways ? img.naturalWidth : img.naturalHeight;
    const scale = Math.max(
      0.0001,
      Math.min(availableWidth / width, availableHeight / height),
    );
    setDimensions({
      width: img.naturalWidth * scale,
      height: img.naturalHeight * scale,
    });
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  }
  useEffect(() => {
    const surface = canvas.current;
    if (!surface) return;
    const observer = new ResizeObserver(() => fitImage());
    observer.observe(surface);
    return () => observer.disconnect();
  }, [rotation]);
  useEffect(() => {
    function key(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === "ArrowLeft") previous();
      if (e.key === "ArrowRight") next();
    }
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [previous, next]);
  return (
    <>
      <div
        ref={canvas}
        className="image-canvas"
        onWheel={(e) =>
          setZoom((value) =>
            Math.max(0.2, Math.min(8, value * (e.deltaY > 0 ? 0.9 : 1.1))),
          )
        }
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = {
            x: e.clientX,
            y: e.clientY,
            ox: offset.x,
            oy: offset.y,
          };
        }}
        onPointerMove={(e) => {
          if (drag.current)
            setOffset({
              x: drag.current.ox + e.clientX - drag.current.x,
              y: drag.current.oy + e.clientY - drag.current.y,
            });
        }}
        onPointerUp={(e) => {
          drag.current = null;
          if (e.currentTarget.hasPointerCapture(e.pointerId))
            e.currentTarget.releasePointerCapture(e.pointerId);
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onLostPointerCapture={() => {
          drag.current = null;
        }}
        onDoubleClick={() => {
          setZoom(1);
          setOffset({ x: 0, y: 0 });
        }}
      >
        {error ? (
          <div className="viewer-message">
            图片无法打开，请检查文件是否存在或已损坏。
          </div>
        ) : (
          <img
            ref={image}
            draggable={false}
            src={resource(item)}
            alt={item.title}
            onError={() => setError(true)}
            onLoad={() => {
              setError(false);
              setZoom(1);
              setOffset({ x: 0, y: 0 });
              fitImage();
            }}
            style={{
              width: dimensions.width || undefined,
              height: dimensions.height || undefined,
              visibility: dimensions.width ? "visible" : "hidden",
              maxWidth: "none",
              maxHeight: "none",
              transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px)) rotate(${rotation}deg) scale(${zoom})`,
            }}
          />
        )}
      </div>
      <button
        className="viewer-prev"
        aria-label="上一张"
        disabled={!hasPrevious}
        onClick={previous}
      >
        <ChevronLeft />
      </button>
      <button
        className="viewer-next"
        aria-label="下一张"
        disabled={!hasNext}
        onClick={next}
      >
        <ChevronRight />
      </button>
      <div className="floating-tools">
        <IconButton
          label="缩小"
          onClick={() => setZoom(Math.max(0.2, zoom / 1.2))}
        >
          <Minus size={18} />
        </IconButton>
        <span>{Math.round(zoom * 100)}%</span>
        <IconButton
          label="放大"
          onClick={() => setZoom(Math.min(8, zoom * 1.2))}
        >
          <Plus size={18} />
        </IconButton>
        <i />
        <IconButton
          label="旋转图片"
          onClick={() => {
            const next = rotation + 90;
            setRotation(next);
            fitImage(next);
            setOffset({ x: 0, y: 0 });
          }}
        >
          <RotateCw size={18} />
        </IconButton>
        <IconButton
          label="适应窗口"
          onClick={() => {
            setZoom(1);
            setRotation(0);
            setOffset({ x: 0, y: 0 });
            requestAnimationFrame(() => fitImage(0));
          }}
        >
          <Expand size={18} />
        </IconButton>
      </div>
    </>
  );
}
function ComicViewer({ item }: { item: MediaItem }) {
  const [pages, setPages] = useState<ComicPage[]>([]);
  const [page, setPage] = useState(item.progress?.page ?? 0);
  const [error, setError] = useState("");
  const settings = useApp((s) => s.settings);
  const setSettings = useApp((s) => s.setSettings);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollRestore = useRef(false);
  useEffect(() => {
    let live = true;
    void window.media
      .comicPages(item.id)
      .then((result) => {
        if (live) {
          setPages(result);
          setPage((p) => Math.min(p, Math.max(0, result.length - 1)));
        }
      })
      .catch((err) => {
        if (live) setError(String(err));
      });
    return () => {
      live = false;
    };
  }, [item.id, item.resourceVersion]);
  useEffect(() => {
    if (pages.length)
      void window.media.saveProgress(item.id, { page }).catch(report);
  }, [page, pages.length, item.id]);
  function move(direction: number) {
    const step = settings.comicMode === "double" ? 2 : 1;
    setPage((p) =>
      Math.max(0, Math.min(pages.length - 1, p + direction * step)),
    );
  }
  useEffect(() => {
    function key(e: KeyboardEvent) {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLSelectElement
      )
        return;
      if (e.key === "ArrowLeft") move(settings.comicRtl ? 1 : -1);
      if (e.key === "ArrowRight") move(settings.comicRtl ? -1 : 1);
    }
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [settings.comicRtl, settings.comicMode, pages.length]);
  useEffect(() => {
    if (
      settings.comicMode !== "scroll" ||
      !scrollRef.current ||
      !pages.length
    ) {
      scrollRestore.current = false;
      return;
    }
    const el = scrollRef.current;
    const target = el.querySelector(`[data-page="${page}"]`);
    if (!scrollRestore.current && target) {
      target.scrollIntoView();
      scrollRestore.current = true;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
        if (visible[0])
          setPage(Number((visible[0].target as HTMLElement).dataset.page));
      },
      { root: el, threshold: [0.1, 0.4, 0.6] },
    );
    el.querySelectorAll("[data-page]").forEach((node) =>
      observer.observe(node),
    );
    return () => observer.disconnect();
  }, [pages, settings.comicMode]);
  return (
    <div className="comic-reader">
      <div className="comic-toolbar">
        <span>
          {pages.length ? `${page + 1} / ${pages.length} 页` : "正在加载…"}
        </span>
        <input
          aria-label="漫画页码"
          type="range"
          min="0"
          max={Math.max(0, pages.length - 1)}
          value={page}
          onChange={(e) => {
            const value = Number(e.target.value);
            setPage(value);
            if (settings.comicMode === "scroll")
              scrollRef.current
                ?.querySelector(`[data-page="${value}"]`)
                ?.scrollIntoView();
          }}
        />
        <select
          aria-label="漫画阅读模式"
          value={settings.comicMode}
          onChange={(e) =>
            void act(() =>
              setSettings({
                ...settings,
                comicMode: e.target.value as typeof settings.comicMode,
              }),
            )
          }
        >
          <option value="single">单页阅读</option>
          <option value="double">双页阅读</option>
          <option value="scroll">纵向滚动</option>
        </select>
        <button
          className="text-button"
          onClick={() =>
            void act(() =>
              setSettings({ ...settings, comicRtl: !settings.comicRtl }),
            )
          }
        >
          {settings.comicRtl ? "从右向左" : "从左向右"}
        </button>
      </div>
      {error ? (
        <div className="viewer-message">{error}</div>
      ) : !pages.length ? (
        <div className="viewer-message">
          {pages.length === 0 ? "暂无可显示的页面" : "正在加载…"}
        </div>
      ) : settings.comicMode === "scroll" ? (
        <div className="comic-scroll" ref={scrollRef}>
          {pages.map((p, index) => (
            <div key={p.name} data-page={index}>
              <img loading="lazy" src={p.url} alt={`第 ${index + 1} 页`} />
            </div>
          ))}
        </div>
      ) : (
        <div className={`comic-spread ${settings.comicRtl ? "rtl" : ""}`}>
          <img src={pages[page]?.url} alt={`第 ${page + 1} 页`} />
          {settings.comicMode === "double" && pages[page + 1] && (
            <img src={pages[page + 1].url} alt={`第 ${page + 2} 页`} />
          )}
        </div>
      )}
      {settings.comicMode !== "scroll" && (
        <>
          <button
            className="viewer-prev"
            aria-label="漫画向左翻页"
            onClick={() => move(settings.comicRtl ? 1 : -1)}
          >
            <ChevronLeft />
          </button>
          <button
            className="viewer-next"
            aria-label="漫画向右翻页"
            onClick={() => move(settings.comicRtl ? -1 : 1)}
          >
            <ChevronRight />
          </button>
        </>
      )}
    </div>
  );
}
