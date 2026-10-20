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
  BookMarked,
  List,
  Settings2,
} from "lucide-react";
import ePub from "epubjs";
import VideoPlayer from "./VideoPlayer";
import { readerColors } from "../../shared/readerColors";
import DOMPurify from "dompurify";
import type { ComicPage, MediaItem, Progress } from "../../shared/types";
import { IconButton } from "./components";
import { act, report, resource, useApp } from "./store";

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
      {item.type === "novel" && <NovelViewer key={item.id} item={item} />}
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
function colorEpubDocument(doc: Document, background: string) {
  const palette = readerColors(background);
  for (const element of [
    doc.documentElement,
    ...doc.querySelectorAll<HTMLElement>("body, body *"),
  ]) {
    if (!(element instanceof doc.defaultView!.HTMLElement)) continue;
    element.style.setProperty("color", palette.foreground, "important");
    element.style.setProperty(
      "-webkit-text-fill-color",
      palette.foreground,
      "important",
    );
    element.style.setProperty("background-color", "transparent", "important");
    element.style.setProperty("background-image", "none", "important");
    element.style.setProperty("opacity", "1", "important");
    element.style.setProperty("filter", "none", "important");
  }
}
function applyEpubColors(rendition: any, background: string) {
  const palette = readerColors(background);
  rendition.themes.default({
    "body, body *": {
      color: `${palette.foreground} !important`,
      background: "transparent !important",
    },
    body: { "font-family": 'Georgia, "Songti SC", SimSun, serif !important' },
  });
  for (const contents of rendition.getContents?.() ?? [])
    colorEpubDocument(contents.document, background);
}
function NovelViewer({ item }: { item: MediaItem }) {
  const settings = useApp((s) => s.settings);
  const setSettings = useApp((s) => s.setSettings);
  const palette = readerColors(settings.readerBackgroundColor);
  const [showOptions, setShowOptions] = useState(false);
  const [tocOpen, setTocOpen] = useState(false);
  const [encoding, setEncoding] = useState("");
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [bookmarks, setBookmarks] = useState<Progress[]>([]);
  const container = useRef<HTMLDivElement>(null);
  const epubHost = useRef<HTMLDivElement>(null);
  const renditionRef = useRef<any>(null);
  const currentProgress = useRef<Progress>(item.progress ?? {});
  const [toc, setToc] = useState<{ label: string; href: string }[]>([]);
  const lastSaved = useRef(0);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const bookmarkKey = `bookmarks:${item.id}`;
  useEffect(() => {
    try {
      setBookmarks(JSON.parse(localStorage.getItem(bookmarkKey) || "[]"));
    } catch {
      setBookmarks([]);
    }
  }, [bookmarkKey]);
  useEffect(() => {
    if (item.ext !== "txt") return;
    let live = true;
    setError("");
    setText("");
    void window.media
      .readText(item.id, encoding || undefined)
      .then((result) => {
        if (live) {
          setText(result.text);
          requestAnimationFrame(() => {
            const el = container.current;
            if (!el) return;
            const progress = item.progress;
            if (settingsRef.current.readerMode === "paged")
              el.scrollLeft =
                (progress?.scroll ?? 0) *
                Math.max(0, el.scrollWidth - el.clientWidth);
            else el.scrollTop = progress?.position ?? 0;
          });
        }
      })
      .catch((err) => {
        if (live) setError(String(err));
      });
    return () => {
      live = false;
    };
  }, [item.id, encoding, item.resourceVersion]);
  useEffect(() => {
    if (item.ext !== "epub" || !epubHost.current) return;
    let live = true;
    let book: ReturnType<typeof ePub> | undefined;
    setError("");
    void (async () => {
      const response = await fetch(resource(item));
      if (!response.ok)
        throw new Error("EPUB 无法读取，文件可能损坏、过大或已被移除");
      const data = await response.arrayBuffer();
      if (!live) return;
      book = ePub(data);
      const s = settingsRef.current;
      const rendition = book.renderTo(epubHost.current!, {
        width: "100%",
        height: "100%",
        spread: "none",
        allowScriptedContent: false,
        flow: s.readerMode === "paged" ? "paginated" : "scrolled-doc",
      });
      renditionRef.current = rendition;
      rendition.hooks.content.register((contents: any) => {
        const doc = contents.document as Document;
        doc
          .querySelectorAll(
            'script,iframe,object,embed,form,meta[http-equiv],link[rel="stylesheet"]',
          )
          .forEach((node) => node.remove());
        doc.body.innerHTML = DOMPurify.sanitize(doc.body.innerHTML, {
          FORBID_TAGS: ["script", "iframe", "object", "embed", "form"],
          FORBID_ATTR: ["srcdoc"],
        });
        doc.querySelectorAll("[src],[href]").forEach((node) => {
          for (const attr of ["src", "href"]) {
            const value = node.getAttribute(attr);
            if (value && /^(https?:|javascript:|file:|\/\/)/i.test(value))
              node.removeAttribute(attr);
          }
        });
        const meta = doc.createElement("meta");
        meta.httpEquiv = "Content-Security-Policy";
        meta.content =
          "default-src 'none'; img-src blob: data: media:; style-src 'unsafe-inline' blob:; font-src blob: data:; script-src 'none'";
        doc.head.prepend(meta);
        colorEpubDocument(doc, settingsRef.current.readerBackgroundColor);
      });
      applyEpubColors(rendition, s.readerBackgroundColor);
      rendition.themes.override("line-height", String(s.lineHeight));
      rendition.themes.fontSize(`${s.fontSize}px`);
      rendition.on("relocated", (location: any) => {
        currentProgress.current = { cfi: location.start.cfi };
        if (Date.now() - lastSaved.current > 2000) {
          lastSaved.current = Date.now();
          void window.media
            .saveProgress(item.id, currentProgress.current)
            .catch(report);
        }
      });
      const navigation = await book.loaded.navigation;
      if (live)
        setToc(
          navigation.toc.map((chapter: any) => ({
            label: chapter.label.trim(),
            href: chapter.href,
          })),
        );
      await rendition.display(item.progress?.cfi || undefined);
    })().catch((err) => {
      if (live) setError(err.message || String(err));
    });
    return () => {
      live = false;
      renditionRef.current = null;
      book?.destroy();
    };
  }, [item.id, item.resourceVersion]);
  useEffect(() => {
    if (renditionRef.current) {
      renditionRef.current.themes.fontSize(`${settings.fontSize}px`);
      renditionRef.current.flow?.(
        settings.readerMode === "paged" ? "paginated" : "scrolled-doc",
      );
      applyEpubColors(renditionRef.current, settings.readerBackgroundColor);
      renditionRef.current.themes.override(
        "line-height",
        String(settings.lineHeight),
      );
    }
  }, [settings]);
  useEffect(() => {
    const el = container.current;
    if (!el) return;
    requestAnimationFrame(() => {
      const progress = currentProgress.current.scroll ?? 0;
      if (settings.readerMode === "paged")
        el.scrollLeft = progress * Math.max(0, el.scrollWidth - el.clientWidth);
      else
        el.scrollTop =
          progress * Math.max(0, el.scrollHeight - el.clientHeight);
    });
  }, [settings.readerMode]);
  useEffect(
    () => () => {
      void window.media
        .saveProgress(item.id, currentProgress.current)
        .catch(report);
    },
    [item.id],
  );
  function bookmark() {
    const next = [...bookmarks, { ...currentProgress.current }].slice(-50);
    setBookmarks(next);
    localStorage.setItem(bookmarkKey, JSON.stringify(next));
    useApp.getState().notify("已添加阅读书签");
  }
  const chapters =
    item.ext === "txt"
      ? [
          ...text.matchAll(
            /^\s*(第[一二三四五六七八九十百千万零〇\d]+[章节卷部篇].{0,55}|chapter\s+\d+.{0,55})$/gim,
          ),
        ]
          .slice(0, 1000)
          .map((match) => ({ label: match[0].trim(), index: match.index! }))
      : [];
  const paragraphs = text.split("\n");
  let position = 0;
  return (
    <div
      className={`reader reader-${settings.readerTheme} ${settings.readerMode === "paged" ? "reader-mode-paged" : "reader-mode-scroll"}`}
      style={
        {
          "--reader-width": `${settings.readerWidth}px`,
          "--reader-size": `${settings.fontSize}px`,
          "--reader-line": settings.lineHeight,
          backgroundColor: palette.background,
          color: palette.foreground,
          "--reader-bg": palette.background,
          "--reader-fg": palette.foreground,
        } as CSSProperties
      }
    >
      <div className="reader-toolbar">
        <IconButton
          label="目录与书签"
          active={tocOpen}
          onClick={() => setTocOpen(!tocOpen)}
        >
          <List size={19} />
        </IconButton>
        <span>{item.ext === "epub" ? "EPUB 阅读" : "沉浸阅读"}</span>
        <span className="spacer" />
        {item.ext === "txt" && (
          <select
            aria-label="文本编码"
            value={encoding}
            onChange={(e) => setEncoding(e.target.value)}
          >
            <option value="">自动识别编码</option>
            <option value="utf-8">UTF-8</option>
            <option value="gb18030">GB18030</option>
            <option value="utf16-le">UTF-16 LE</option>
            <option value="utf16-be">UTF-16 BE</option>
          </select>
        )}
        <IconButton label="添加书签" onClick={bookmark}>
          <BookMarked size={18} />
        </IconButton>
        <IconButton
          label="阅读设置"
          active={showOptions}
          onClick={() => setShowOptions(!showOptions)}
        >
          <Settings2 size={18} />
        </IconButton>
      </div>
      {showOptions && (
        <div className="reader-options">
          <label>
            字号
            <input
              aria-label="阅读字号"
              type="range"
              min="14"
              max="32"
              value={settings.fontSize}
              onChange={(e) =>
                void act(() =>
                  setSettings({
                    ...settings,
                    fontSize: Number(e.target.value),
                  }),
                )
              }
            />
            {settings.fontSize}
          </label>
          <label>
            行距
            <input
              aria-label="阅读行距"
              type="range"
              min="1.4"
              max="2.6"
              step="0.1"
              value={settings.lineHeight}
              onChange={(e) =>
                void act(() =>
                  setSettings({
                    ...settings,
                    lineHeight: Number(e.target.value),
                  }),
                )
              }
            />
          </label>
          <label>
            宽度
            <input
              aria-label="阅读宽度"
              type="range"
              min="500"
              max="1100"
              step="20"
              value={settings.readerWidth}
              onChange={(e) =>
                void act(() =>
                  setSettings({
                    ...settings,
                    readerWidth: Number(e.target.value),
                  }),
                )
              }
            />
          </label>
          <label>
            翻页模式
            <select
              aria-label="小说翻页模式"
              value={settings.readerMode}
              onChange={(event) =>
                void act(() =>
                  setSettings({
                    ...settings,
                    readerMode: event.target
                      .value as typeof settings.readerMode,
                  }),
                )
              }
            >
              <option value="scroll">连续滚动</option>
              <option value="paged">分页翻页</option>
            </select>
          </label>
          <label>
            背景
            <input
              aria-label="小说背景颜色"
              type="color"
              value={settings.readerBackgroundColor}
              onChange={(event) =>
                void act(() =>
                  setSettings({
                    ...settings,
                    readerBackgroundColor: event.target.value,
                  }),
                )
              }
            />
          </label>
          <button
            className="text-button"
            onClick={() => {
              const readerTheme =
                settings.readerTheme === "paper" ? "dark" : "paper";
              const previousDefault =
                settings.readerTheme === "paper" ? "#eee8db" : "#202020";
              const nextDefault =
                readerTheme === "paper" ? "#eee8db" : "#202020";
              void act(() =>
                setSettings({
                  ...settings,
                  readerTheme,
                  readerBackgroundColor:
                    settings.readerBackgroundColor === previousDefault
                      ? nextDefault
                      : settings.readerBackgroundColor,
                }),
              );
            }}
          >
            {settings.readerTheme === "paper" ? "切换深色" : "切换纸色"}
          </button>
        </div>
      )}
      {tocOpen && (
        <aside className="reader-toc">
          <h3>目录</h3>
          {item.ext === "txt"
            ? chapters.map((chapter) => (
                <button
                  key={chapter.index}
                  onClick={() => {
                    container.current
                      ?.querySelector(`[data-offset="${chapter.index}"]`)
                      ?.scrollIntoView();
                  }}
                >
                  {chapter.label}
                </button>
              ))
            : toc.map((chapter) => (
                <button
                  key={chapter.href}
                  onClick={() =>
                    void renditionRef.current?.display(chapter.href)
                  }
                >
                  {chapter.label}
                </button>
              ))}
          {!chapters.length && !toc.length && <p>此书暂无章节目录</p>}
          <h3>我的书签</h3>
          {bookmarks.map((mark, i) => (
            <button
              key={i}
              onClick={() => {
                if (mark.cfi) void renditionRef.current?.display(mark.cfi);
                else if (container.current)
                  container.current.scrollTop = mark.position ?? 0;
              }}
            >
              书签 {i + 1}
              <small
                onClick={(e) => {
                  e.stopPropagation();
                  const next = bookmarks.filter((_, index) => index !== i);
                  setBookmarks(next);
                  localStorage.setItem(bookmarkKey, JSON.stringify(next));
                }}
              >
                移除
              </small>
            </button>
          ))}
        </aside>
      )}
      {error ? (
        <div className="viewer-message">{error}</div>
      ) : item.ext === "txt" ? (
        <div
          ref={container}
          className={`text-scroll ${settings.readerMode === "paged" ? "reader-paged" : ""}`}
          onClick={(event) => {
            const el = container.current;
            if (!el) return;
            const fraction =
              (event.clientX - el.getBoundingClientRect().left) /
              Math.max(1, el.clientWidth);
            const direction = fraction < 0.23 ? -1 : fraction > 0.77 ? 1 : 0;
            if (!direction) return;
            el.scrollBy(
              settings.readerMode === "paged"
                ? {
                    left: direction * el.clientWidth,
                    behavior: settings.reducedMotion ? "instant" : "smooth",
                  }
                : {
                    top: direction * Math.max(240, el.clientHeight * 0.82),
                    behavior: settings.reducedMotion ? "instant" : "smooth",
                  },
            );
          }}
          onWheel={(event) => {
            const el = container.current;
            if (!el || settings.readerMode !== "paged") return;
            if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
            event.preventDefault();
            el.scrollBy({
              left: Math.sign(event.deltaY) * el.clientWidth,
              behavior: settings.reducedMotion ? "instant" : "smooth",
            });
          }}
          onKeyDown={(event) => {
            if (settings.readerMode !== "paged") return;
            const direction =
              event.key === "ArrowLeft" || event.key === "PageUp"
                ? -1
                : event.key === "ArrowRight" || event.key === "PageDown"
                  ? 1
                  : 0;
            if (!direction || !container.current) return;
            event.preventDefault();
            container.current.scrollBy({
              left: direction * container.current.clientWidth,
              behavior: settings.reducedMotion ? "instant" : "smooth",
            });
          }}
          onScroll={() => {
            const el = container.current!;
            currentProgress.current = {
              position:
                settings.readerMode === "paged" ? el.scrollLeft : el.scrollTop,
              scroll:
                settings.readerMode === "paged"
                  ? el.scrollLeft / Math.max(1, el.scrollWidth - el.clientWidth)
                  : el.scrollTop /
                    Math.max(1, el.scrollHeight - el.clientHeight),
            };
            if (Date.now() - lastSaved.current > 2000) {
              lastSaved.current = Date.now();
              void window.media
                .saveProgress(item.id, currentProgress.current)
                .catch(report);
            }
          }}
        >
          <article className="book-text" tabIndex={0}>
            <span className="eyebrow">YOUR QUIET MOMENT</span>
            <h1>{item.title}</h1>
            {text ? (
              paragraphs.map((line, i) => {
                const offset = position;
                position += line.length + 1;
                return (
                  <p data-offset={offset} key={i}>
                    {line || "\u00a0"}
                  </p>
                );
              })
            ) : (
              <p>正在打开书页…</p>
            )}
            <div className="book-end">— 本书完 —</div>
          </article>
        </div>
      ) : (
        <div className="epub-shell">
          <div ref={epubHost} className="epub-host" />
          <button
            className="epub-prev"
            aria-label="上一页"
            onClick={() => void renditionRef.current?.prev()}
          >
            <ChevronLeft />
          </button>
          <button
            className="epub-next"
            aria-label="下一页"
            onClick={() => void renditionRef.current?.next()}
          >
            <ChevronRight />
          </button>
        </div>
      )}
    </div>
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
