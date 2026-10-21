import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  BookmarkPlus,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Expand,
  FolderOpen,
  Grid2X2,
  Minus,
  Plus,
  Settings2,
  X,
} from "lucide-react";
import type {
  ComicContext,
  ComicPage,
  MediaItem,
  Progress,
} from "../../shared/types";
import {
  comicPreferences,
  comicPageSize,
  comicSpreads,
  comicWindow,
  comicReadState,
  restoredComicPage,
  type ComicPreferences,
} from "../../shared/comic";
import { IconButton } from "./components";
import { report, useApp } from "./store";
import ComicLibraryPanel from "./ComicLibraryPanel";
import { ComicImageCache, type ComicImageResource } from "./comicImageCache";
import "./comic.css";

function ComicImage({
  page,
  index,
  cache,
  thumbnail = false,
}: {
  page: ComicPage;
  index: number;
  cache: ComicImageCache;
  thumbnail?: boolean;
}) {
  const [loaded, setLoaded] = useState<{
    cache: ComicImageCache;
    source: string;
    value?: ComicImageResource;
    error?: boolean;
  }>(() => ({ cache, source: page.url, value: cache.peek(page) }));
  const [retry, setRetry] = useState(0);
  useLayoutEffect(() => {
    let live = true;
    const request = cache.acquire(page, retry > 0);
    setLoaded({ cache, source: page.url, value: request.value });
    void request.ready.then(
      (value) => {
        if (live) setLoaded({ cache, source: page.url, value });
      },
      () => {
        if (live) setLoaded({ cache, source: page.url, error: true });
      },
    );
    return () => {
      live = false;
      request.release();
    };
  }, [cache, page.url, retry]);
  const current =
    loaded.cache === cache && loaded.source === page.url ? loaded : undefined;
  const status = current?.error
    ? "error"
    : current?.value
      ? "ready"
      : "loading";
  return (
    <div className={`comic-image ${status}`}>
      {current?.value && status === "ready" && (
        <img
          draggable={false}
          src={current.value.url}
          alt={`第 ${index + 1} 页`}
          onError={() => setLoaded({ cache, source: page.url, error: true })}
        />
      )}
      {status === "loading" && (
        <span className="comic-image-message" role="status">
          正在加载第 {index + 1} 页…
        </span>
      )}
      {status === "error" && (
        <div className="comic-image-message" role="alert">
          <p>第 {index + 1} 页加载失败</p>
          {!thumbnail && (
            <button
              className="text-button"
              onClick={() => {
                setRetry((n) => n + 1);
              }}
            >
              重试此页
            </button>
          )}
          {!thumbnail && <small>可继续翻页跳过</small>}
        </div>
      )}
    </div>
  );
}

export default function ComicViewer({
  item,
  close,
  switchItem,
}: {
  item: MediaItem;
  close(): void;
  switchItem(item: MediaItem): void;
}) {
  const settings = useApp((s) => s.settings);
  const [pages, setPages] = useState<ComicPage[]>([]);
  const [context, setContext] = useState<ComicContext>();
  const [prefs, setPrefs] = useState(() => comicPreferences(settings));
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [reload, setReload] = useState(0);
  const [page, setPage] = useState(0),
    [zoom, setZoom] = useState(1),
    [pan, setPan] = useState({ x: 0, y: 0 });
  const [tools, setTools] = useState(true),
    [panel, setPanel] = useState<
      "settings" | "pages" | "chapters" | "bookmarks" | null
    >(null);
  const [organize, setOrganize] = useState(false),
    [notice, setNotice] = useState("");
  const viewport = useRef<HTMLDivElement>(null),
    scroll = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 1000, height: 700 });
  const [scrollTop, setScrollTop] = useState(0);
  const position = useRef<Progress>({ ...item.progress });
  const ready = useRef(false),
    switching = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined),
    hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const saveChain = useRef(Promise.resolve());
  const lastSave = useRef(0);
  const drag = useRef<{
    x: number;
    y: number;
    ox: number;
    oy: number;
    moved: boolean;
  } | null>(null);
  const wheelAt = useRef(0),
    restoring = useRef(false),
    scrollFrame = useRef(0);
  const prefsSave = useRef(Promise.resolve());
  const [panelTop, setPanelTop] = useState(0);
  const imageCache = useMemo(
    () =>
      new ComicImageCache((loaded, width, height) => {
        setPages((old) => {
          const index = old.findIndex((page) => page.url === loaded.url);
          if (
            index < 0 ||
            (old[index].width === width && old[index].height === height)
          )
            return old;
          const next = [...old];
          next[index] = { ...next[index], width, height };
          return next;
        });
      }),
    [item.id, item.resourceVersion, reload],
  );
  useEffect(() => () => imageCache.dispose(), [imageCache]);
  function flush() {
    clearTimeout(saveTimer.current);
    saveTimer.current = undefined;
    if (!ready.current) return saveChain.current;
    lastSave.current = performance.now();
    const value = { ...position.current };
    saveChain.current = saveChain.current
      .then(() => window.media.saveProgress(item.id, value))
      .catch(report);
    return saveChain.current;
  }
  function remember(index: number, offset = 0) {
    if (!ready.current || !pages[index]) return;
    position.current = {
      ...position.current,
      page: index,
      comicPageId: pages[index].id,
      comicOffset: Math.max(0, Math.min(1, offset)),
    };
    const wait = Math.max(0, 250 - (performance.now() - lastSave.current));
    if (!wait) void flush();
    else if (!saveTimer.current)
      saveTimer.current = setTimeout(() => void flush(), wait);
  }
  useEffect(() => {
    let live = true;
    const session = crypto.randomUUID();
    ready.current = false;
    setLoading(true);
    setError("");
    const unloading = () => {
      void flush();
    };
    window.addEventListener("beforeunload", unloading);
    void Promise.all([
      window.media.comicPages(item.id, session),
      window.media.comicContext(item.id),
    ])
      .then(([result, ctx]) => {
        if (!live) return;
        const index = restoredComicPage(result, position.current);
        setPages(result);
        setPage(index);
        setContext(ctx);
        setPrefs(comicPreferences(settings, ctx.preferences));
        position.current = {
          ...position.current,
          page: index,
          comicPageId: result[index]?.id,
          comicOffset: position.current.comicOffset ?? 0,
        };
        ready.current = result.length > 0;
        setLoading(false);
        void flush();
      })
      .catch((e) => {
        if (live) {
          setError(String(e));
          setLoading(false);
        }
      });
    return () => {
      live = false;
      window.removeEventListener("beforeunload", unloading);
      void flush().finally(() =>
        window.media.releaseComic(item.id, session).catch(() => {}),
      );
      clearTimeout(hideTimer.current);
      cancelAnimationFrame(scrollFrame.current);
    };
  }, [item.id, item.resourceVersion, reload]);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(() =>
      setSize({ width: element.clientWidth, height: element.clientHeight }),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const pageSizes = useMemo(
    () => pages.map((page) => comicPageSize(page, size, prefs.fit, 1, zoom)),
    [pages, size.width, size.height, prefs.fit, zoom],
  );
  const offsets = useMemo(() => {
    const result = [0];
    for (const size of pageSizes) result.push(result.at(-1)! + size.height);
    return result;
  }, [pageSizes]);
  useLayoutEffect(() => {
    const element = scroll.current;
    if (!element || !ready.current || prefs.mode !== "scroll") return;
    const index = Math.max(
      0,
      Math.min(pages.length - 1, position.current.page ?? 0),
    );
    restoring.current = true;
    element.scrollTop =
      (offsets[index] ?? 0) +
      (offsets[index + 1] - offsets[index]) *
        (position.current.comicOffset ?? 0);
    setScrollTop(element.scrollTop);
    const frame = requestAnimationFrame(() => {
      restoring.current = false;
    });
    return () => cancelAnimationFrame(frame);
  }, [offsets, prefs.mode, size.height]);
  const spreads = useMemo(() => comicSpreads(pages, prefs), [pages, prefs]);
  const spreadIndex = Math.max(
      0,
      spreads.findIndex((s) => s.includes(page)),
    ),
    spread = spreads[spreadIndex] ?? [];
  const windowRange = comicWindow(offsets, scrollTop, size.height);
  const chapterIndex =
    context?.chapters.findIndex((c) => c.id === item.id) ?? -1;
  function wake() {
    setTools(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setTools(false), 3000);
  }
  useEffect(() => {
    wake();
  }, []);
  useEffect(() => {
    if (!ready.current || !pages.length) return;
    const last = prefs.mode === "double" ? (spread.at(-1) ?? page) : page;
    const indices = [last + 1, last + 2, last + 3, page - 1].filter(
      (index) => index >= 0 && index < pages.length,
    );
    imageCache.preload(indices.map((index) => pages[index]));
  }, [page, pages.length, imageCache, prefs.mode, spread.join(",")]);
  function updatePreferences(changes: Partial<ComicPreferences>) {
    const next = { ...prefs, ...changes };
    setPrefs(next);
    setZoom(1);
    setPan({ x: 0, y: 0 });
    prefsSave.current = prefsSave.current
      .then(() => window.media.saveComicPreferences(item.id, next))
      .catch(report);
    if (changes.mode || changes.rtl !== undefined)
      void useApp
        .getState()
        .setSettings({ ...settings, comicMode: next.mode, comicRtl: next.rtl })
        .catch(report);
  }
  function jump(index: number, offset = 0) {
    if (!pages.length) return;
    index = Math.max(0, Math.min(pages.length - 1, index));
    setPage(index);
    setPan({ x: 0, y: 0 });
    setZoom(1);
    remember(index, offset);
    if (scroll.current && prefs.mode === "scroll") {
      scroll.current.scrollTop =
        offsets[index] + (offsets[index + 1] - offsets[index]) * offset;
      setScrollTop(scroll.current.scrollTop);
    }
  }
  async function chapter(direction: number, complete = false) {
    if (switching.current) return;
    if (complete) {
      position.current.completed = true;
      await flush();
    }
    const target = context?.chapters[chapterIndex + direction];
    if (!target) {
      setNotice(direction > 0 ? "已读到作品末尾" : "已经是第一章");
      wake();
      return;
    }
    switching.current = true;
    try {
      await flush();
      const fresh = await window.media.item(target.id);
      switchItem({
        ...fresh,
        progress:
          direction > 0
            ? {
                ...fresh.progress,
                page: 0,
                comicPageId: undefined,
                comicOffset: 0,
              }
            : {
                ...fresh.progress,
                page: 20000,
                comicPageId: undefined,
                comicOffset: 0,
              },
      });
    } catch (e) {
      report(e);
      switching.current = false;
    }
  }
  function move(direction: number) {
    if (loading || error || !pages.length || zoom !== 1) return;
    setNotice("");
    if (prefs.mode === "scroll") {
      scroll.current?.scrollBy({
        top: direction * size.height * 0.85,
        behavior: settings.reducedMotion ? "instant" : "smooth",
      });
      return;
    }
    const target = spreads[spreadIndex + direction];
    if (target) jump(target[0]);
    else void chapter(direction, direction > 0);
  }
  function onScroll() {
    const element = scroll.current;
    if (!element || restoring.current) return;
    cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = requestAnimationFrame(() => {
      if (restoring.current) return;
      const top = element.scrollTop;
      setScrollTop(top);
      const index = comicWindow(offsets, top + 1, 0, 0).start;
      setPage(index);
      remember(
        index,
        (top - offsets[index]) /
          Math.max(1, offsets[index + 1] - offsets[index]),
      );
    });
  }
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        document.querySelector("dialog[open]")
      )
        return;
      if (event.key === "Escape") {
        event.preventDefault();
        if (panel) setPanel(null);
        else if (zoom !== 1) {
          setZoom(1);
          setPan({ x: 0, y: 0 });
        } else {
          void flush();
          close();
        }
        return;
      }
      if (
        (event.target as HTMLElement)?.closest(
          "input,select,textarea,[contenteditable=true]",
        )
      )
        return;
      if (
        (event.target as HTMLElement)?.closest("button") &&
        [" ", "Enter"].includes(event.key)
      )
        return;
      const direction =
        event.key === "ArrowLeft"
          ? prefs.rtl
            ? 1
            : -1
          : event.key === "ArrowRight"
            ? prefs.rtl
              ? -1
              : 1
            : ["PageDown", " ", "ArrowDown"].includes(event.key)
              ? 1
              : ["PageUp", "ArrowUp"].includes(event.key)
                ? -1
                : 0;
      if (direction) {
        event.preventDefault();
        const paged =
          viewport.current?.querySelector<HTMLDivElement>(".comic-paged");
        if (
          prefs.mode !== "scroll" &&
          !["ArrowLeft", "ArrowRight"].includes(event.key) &&
          paged &&
          paged.scrollHeight > paged.clientHeight + 1 &&
          ((direction > 0 &&
            paged.scrollTop + paged.clientHeight < paged.scrollHeight - 1) ||
            (direction < 0 && paged.scrollTop > 1))
        ) {
          paged.scrollBy({
            top: direction * paged.clientHeight * 0.85,
            behavior: settings.reducedMotion ? "instant" : "smooth",
          });
          return;
        }
        if (
          prefs.mode === "scroll" &&
          direction > 0 &&
          scroll.current &&
          scroll.current.scrollTop + scroll.current.clientHeight >=
            scroll.current.scrollHeight - 2
        )
          void chapter(1, true);
        else move(direction);
      }
      if (event.key === "Home") {
        event.preventDefault();
        jump(0);
      }
      if (event.key === "End") {
        event.preventDefault();
        jump(pages.length - 1);
      }
      if (event.key.toLowerCase() === "f") {
        event.preventDefault();
        void toggleFullscreen();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await viewport.current?.parentElement?.requestFullscreen();
    } catch (e) {
      report(e);
    }
  }
  async function addBookmark() {
    if (!pages[page]) return;
    const bookmark = {
      id: crypto.randomUUID(),
      mediaId: item.id,
      pageId: pages[page].id,
      page,
      offset: position.current.comicOffset ?? 0,
      createdAt: Date.now(),
    };
    try {
      await window.media.saveComicBookmark(bookmark);
      setContext((old) =>
        old ? { ...old, bookmarks: [...old.bookmarks, bookmark] } : old,
      );
      setNotice("已添加页面书签");
      wake();
    } catch (e) {
      report(e);
    }
  }
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.stopPropagation();
      if (panel || loading || error || !pages.length) return;
      if (event.ctrlKey) {
        event.preventDefault();
        setZoom((z) =>
          Math.max(0.5, Math.min(5, z * (event.deltaY < 0 ? 1.15 : 1 / 1.15))),
        );
        return;
      }
      if (zoom !== 1) return;
      if (prefs.mode === "scroll") {
        const el = scroll.current;
        if (
          el &&
          event.deltaY > 0 &&
          el.scrollTop + el.clientHeight >= el.scrollHeight - 2 &&
          performance.now() - wheelAt.current > 700
        ) {
          wheelAt.current = performance.now();
          void chapter(1, true);
        }
        return;
      }
      if (
        performance.now() - wheelAt.current > 200 &&
        Math.abs(event.deltaY) > 2
      ) {
        const paged = element.querySelector<HTMLDivElement>(".comic-paged");
        if (
          paged &&
          paged.scrollHeight > paged.clientHeight + 1 &&
          ((event.deltaY > 0 &&
            paged.scrollTop + paged.clientHeight < paged.scrollHeight - 1) ||
            (event.deltaY < 0 && paged.scrollTop > 1))
        )
          return;
        wheelAt.current = performance.now();
        event.preventDefault();
        move(event.deltaY > 0 ? 1 : -1);
      }
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  });
  const visibleTools = tools || panel !== null || organize;
  const toolbar = (
    <>
      <IconButton
        label="章节与作品"
        active={panel === "chapters"}
        onClick={() => setPanel(panel === "chapters" ? null : "chapters")}
      >
        <BookOpen size={18} />
      </IconButton>
      <IconButton
        label="页面缩略图"
        active={panel === "pages"}
        onClick={() => {
          setPanel(panel === "pages" ? null : "pages");
          setPanelTop(Math.max(0, Math.floor(page / 3) * 160 - 160));
        }}
      >
        <Grid2X2 size={18} />
      </IconButton>
      <IconButton
        label="添加漫画书签"
        disabled={!pages.length}
        onClick={() => void addBookmark()}
      >
        <BookmarkPlus size={18} />
      </IconButton>
      <button
        className="text-button"
        onClick={() => setPanel(panel === "bookmarks" ? null : "bookmarks")}
      >
        书签 {context?.bookmarks.length ?? 0}
      </button>
      <IconButton
        label="漫画阅读设置"
        active={panel === "settings"}
        onClick={() => setPanel(panel === "settings" ? null : "settings")}
      >
        <Settings2 size={18} />
      </IconButton>
    </>
  );
  return (
    <div
      className={`viewer comic-viewer ${visibleTools ? "" : "comic-quiet"}`}
      onPointerMove={wake}
      onFocusCapture={wake}
    >
      <header className="comic-chrome comic-header" onPointerEnter={wake}>
        <button
          className="back-button"
          onClick={() => {
            void flush();
            close();
          }}
        >
          <ArrowLeft size={18} />
          返回媒体库
        </button>
        <div className="comic-title">
          <strong>{context?.work?.title ?? item.title}</strong>
          <small>{context?.work ? item.title : "本地漫画"}</small>
        </div>
        <div className="comic-actions">
          {toolbar}
          <IconButton label="漫画全屏" onClick={() => void toggleFullscreen()}>
            <Expand size={18} />
          </IconButton>
        </div>
      </header>
      <div className="comic-viewport" ref={viewport}>
        {loading ? (
          <div className="comic-message" role="status">
            正在读取漫画…
          </div>
        ) : error ? (
          <div className="comic-message" role="alert">
            <p>{error}</p>
            <button className="button" onClick={() => setReload((n) => n + 1)}>
              重新加载
            </button>
          </div>
        ) : !pages.length ? (
          <div className="comic-message">这本漫画中没有可显示的图片</div>
        ) : prefs.mode === "scroll" ? (
          <div className="comic-webtoon" ref={scroll} onScroll={onScroll}>
            <div
              style={{
                height: offsets.at(-1),
                position: "relative",
                minWidth: Math.max(0, ...pageSizes.map((p) => p.width)),
              }}
            >
              {pages.slice(windowRange.start, windowRange.end).map((p, i) => {
                const index = windowRange.start + i;
                return (
                  <div
                    className="comic-webtoon-page"
                    key={p.id}
                    data-page={index}
                    style={{
                      top: offsets[index],
                      height: offsets[index + 1] - offsets[index],
                      width: pageSizes[index].width,
                    }}
                  >
                    <ComicImage page={p} index={index} cache={imageCache} />
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div
            className="comic-paged"
            onDoubleClick={(event) => {
              if (!(event.target as HTMLElement).closest("button")) {
                setZoom((z) => (z === 1 ? 2 : 1));
                setPan({ x: 0, y: 0 });
              }
            }}
            onPointerDown={(e) => {
              if (
                zoom === 1 ||
                e.button !== 0 ||
                (e.target as HTMLElement).closest("button")
              )
                return;
              drag.current = {
                x: e.clientX,
                y: e.clientY,
                ox: pan.x,
                oy: pan.y,
                moved: false,
              };
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              if (!d) return;
              d.moved = true;
              setPan({ x: d.ox + e.clientX - d.x, y: d.oy + e.clientY - d.y });
            }}
            onPointerUp={() => {
              drag.current = null;
            }}
            onPointerCancel={() => {
              drag.current = null;
            }}
          >
            <div
              className={`comic-canvas ${prefs.rtl ? "rtl" : ""}`}
              style={{
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              }}
            >
              {spread.map((index) => {
                const p = pages[index];
                const dimensions = comicPageSize(
                  p,
                  size,
                  prefs.fit,
                  spread.length,
                );
                return (
                  <div
                    key={p.id}
                    className="comic-sheet"
                    style={{
                      width: dimensions.width,
                      height: dimensions.height,
                    }}
                  >
                    <ComicImage page={p} index={index} cache={imageCache} />
                  </div>
                );
              })}
            </div>
          </div>
        )}
        {!loading &&
          pages.length > 0 &&
          prefs.mode !== "scroll" &&
          zoom === 1 && (
            <>
              <button
                className="comic-page-zone left"
                aria-label="漫画向左翻页"
                onClick={() => move(prefs.rtl ? 1 : -1)}
              >
                <ChevronLeft />
              </button>
              <button
                className="comic-page-zone right"
                aria-label="漫画向右翻页"
                onClick={() => move(prefs.rtl ? -1 : 1)}
              >
                <ChevronRight />
              </button>
            </>
          )}
      </div>
      {notice && (
        <div
          className="comic-notice"
          role="status"
          onClick={() => setNotice("")}
        >
          {notice}
        </div>
      )}
      <footer className="comic-chrome comic-footer">
        <IconButton
          label="上一章"
          disabled={chapterIndex <= 0}
          onClick={() => void chapter(-1)}
        >
          <ChevronLeft size={18} />
        </IconButton>
        <input
          aria-label="漫画页码"
          type="number"
          min={1}
          max={pages.length || 1}
          value={pages.length ? page + 1 : 1}
          onChange={(e) => {
            if (e.target.value) jump(Number(e.target.value) - 1);
          }}
        />
        <span>/ {pages.length} 页</span>
        <input
          aria-label="漫画阅读进度"
          type="range"
          min={0}
          max={Math.max(0, pages.length - 1)}
          value={page}
          onChange={(e) => jump(Number(e.target.value))}
        />
        <IconButton
          label="缩小漫画"
          onClick={() => setZoom((z) => Math.max(0.5, z / 1.25))}
        >
          <Minus size={16} />
        </IconButton>
        <button
          onClick={() => {
            setZoom(1);
            setPan({ x: 0, y: 0 });
          }}
        >
          {Math.round(zoom * 100)}%
        </button>
        <IconButton
          label="放大漫画"
          onClick={() => setZoom((z) => Math.min(5, z * 1.25))}
        >
          <Plus size={16} />
        </IconButton>
        <IconButton
          label="下一章"
          disabled={!context?.chapters[chapterIndex + 1]}
          onClick={() => void chapter(1)}
        >
          <ChevronRight size={18} />
        </IconButton>
      </footer>
      {panel && (
        <aside
          className="comic-drawer"
          aria-label={
            {
              settings: "漫画阅读设置",
              pages: "页面缩略图",
              chapters: "章节与作品",
              bookmarks: "漫画书签",
            }[panel]
          }
        >
          <header>
            <strong>
              {
                {
                  settings: "阅读设置",
                  pages: "页面导航",
                  chapters: "章节与作品",
                  bookmarks: "页面书签",
                }[panel]
              }
            </strong>
            <IconButton label="关闭漫画侧栏" onClick={() => setPanel(null)}>
              <X size={18} />
            </IconButton>
          </header>
          {panel === "settings" && (
            <div className="comic-options">
              <label>
                阅读模式
                <select
                  aria-label="漫画阅读模式"
                  value={prefs.mode}
                  onChange={(e) =>
                    updatePreferences({
                      mode: e.target.value as ComicPreferences["mode"],
                    })
                  }
                >
                  <option value="single">单页阅读</option>
                  <option value="double">双页阅读</option>
                  <option value="scroll">纵向条漫</option>
                </select>
              </label>
              <label>
                阅读方向
                <select
                  aria-label="漫画阅读方向"
                  value={prefs.rtl ? "rtl" : "ltr"}
                  onChange={(e) =>
                    updatePreferences({ rtl: e.target.value === "rtl" })
                  }
                >
                  <option value="ltr">从左向右</option>
                  <option value="rtl">从右向左</option>
                </select>
              </label>
              <label>
                图片适配
                <select
                  aria-label="漫画图片适配"
                  value={prefs.fit}
                  onChange={(e) =>
                    updatePreferences({
                      fit: e.target.value as ComicPreferences["fit"],
                    })
                  }
                >
                  <option value="window">适应窗口</option>
                  <option value="width">适应宽度</option>
                  <option value="original">原始尺寸</option>
                </select>
              </label>
              {prefs.mode === "double" && (
                <>
                  <label>
                    <input
                      type="checkbox"
                      checked={prefs.coverAlone}
                      onChange={(e) =>
                        updatePreferences({ coverAlone: e.target.checked })
                      }
                    />
                    封面单独显示
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={prefs.pairingOffset}
                      onChange={(e) =>
                        updatePreferences({ pairingOffset: e.target.checked })
                      }
                    />
                    调整双页配对
                  </label>
                </>
              )}
              <p>
                设置自动保存到{context?.work ? "这部作品" : "这本漫画"}
                。横向跨页图单独显示。
              </p>
              <p>
                方向键／滚轮翻页，Ctrl＋滚轮缩放，双击放大，放大后拖动。F
                全屏，Esc 收起面板或返回。
              </p>
            </div>
          )}
          {panel === "pages" && (
            <div
              className="comic-thumbnails"
              ref={(el) => {
                if (el && Math.abs(el.scrollTop - panelTop) > 160)
                  el.scrollTop = panelTop;
              }}
              onScroll={(e) => setPanelTop(e.currentTarget.scrollTop)}
            >
              <div
                style={{
                  height: Math.ceil(pages.length / 3) * 160,
                  position: "relative",
                }}
              >
                {pages
                  .slice(
                    Math.floor(panelTop / 160) * 3,
                    Math.min(
                      pages.length,
                      (Math.floor(panelTop / 160) + 6) * 3,
                    ),
                  )
                  .map((p, i) => {
                    const index = Math.floor(panelTop / 160) * 3 + i;
                    return (
                      <button
                        className={index === page ? "active" : ""}
                        key={p.id}
                        aria-label={`跳到第 ${index + 1} 页`}
                        style={{
                          top: Math.floor(index / 3) * 160,
                          left: `${(index % 3) * 33.333}%`,
                        }}
                        onClick={() => {
                          jump(index);
                          setPanel(null);
                        }}
                      >
                        <ComicImage
                          page={p}
                          index={index}
                          cache={imageCache}
                          thumbnail
                        />
                        <span>{index + 1}</span>
                      </button>
                    );
                  })}
              </div>
            </div>
          )}
          {panel === "chapters" && (
            <div className="comic-chapter-list">
              <button className="button" onClick={() => setOrganize(true)}>
                {context?.work ? "整理这部作品" : "设为作品／整理章节"}
              </button>
              {context?.chapters.map((c, index) => (
                <button
                  className={c.id === item.id ? "active" : ""}
                  key={c.id}
                  onClick={async () => {
                    if (c.id === item.id) return;
                    await flush();
                    switchItem(await window.media.item(c.id));
                  }}
                >
                  <span>
                    {index + 1}. {c.title}
                  </span>
                  <small>
                    {(
                      c.id === item.id
                        ? position.current.completed
                        : c.progress?.completed
                    )
                      ? "已读"
                      : c.id === item.id ||
                          comicReadState(c.progress) === "reading"
                        ? "阅读中"
                        : "未读"}
                  </small>
                </button>
              ))}
              <button
                className="text-button"
                onClick={() => void window.media.reveal(item.id).catch(report)}
              >
                <FolderOpen size={16} />
                在文件夹中显示
              </button>
            </div>
          )}
          {panel === "bookmarks" && (
            <div className="comic-bookmarks">
              {context?.bookmarks.length ? (
                context.bookmarks.map((mark) => (
                  <div key={mark.id}>
                    <button
                      onClick={() => {
                        jump(
                          restoredComicPage(pages, {
                            page: mark.page,
                            comicPageId: mark.pageId,
                          }),
                          mark.offset,
                        );
                        setPanel(null);
                      }}
                    >
                      第 {mark.page + 1} 页{" "}
                      <small>
                        {new Date(mark.createdAt).toLocaleDateString()}
                      </small>
                    </button>
                    <IconButton
                      label={`删除第 ${mark.page + 1} 页书签`}
                      onClick={() => {
                        void window.media
                          .deleteComicBookmark(mark.id)
                          .then(() =>
                            setContext((old) =>
                              old
                                ? {
                                    ...old,
                                    bookmarks: old.bookmarks.filter(
                                      (m) => m.id !== mark.id,
                                    ),
                                  }
                                : old,
                            ),
                          )
                          .catch(report);
                      }}
                    >
                      <X size={15} />
                    </IconButton>
                  </div>
                ))
              ) : (
                <p>还没有书签。点击顶部书签按钮保存当前阅读位置。</p>
              )}
            </div>
          )}
        </aside>
      )}
      {organize && (
        <ComicLibraryPanel
          initialItem={item}
          close={() => {
            setOrganize(false);
            void window.media
              .comicContext(item.id)
              .then(setContext)
              .catch(report);
          }}
          onRead={async (target) => {
            setOrganize(false);
            await flush();
            switchItem(target);
          }}
        />
      )}
    </div>
  );
}
