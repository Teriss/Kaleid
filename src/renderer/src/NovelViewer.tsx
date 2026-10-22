import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  ArrowLeft,
  BookMarked,
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  List,
  MoreHorizontal,
  Settings2,
  Type,
  X,
} from "lucide-react";
import { EpubReaderSession } from "./EpubReaderSession";
import { archivePath } from "./epubResources";
import type { MediaItem, Progress, Settings } from "../../shared/types";
import { READER_FONTS, readerColors } from "../../shared/readerColors";
import { attachReaderGestures } from "../../shared/readerGestures";
import { ReaderSeekController } from "../../shared/readerProgress";
import { IconButton } from "./components";
import ReaderPreferences from "./ReaderPreferences";
import { act, report, resource, useApp } from "./store";

function textOffsetAtViewport(container: HTMLElement, paged: boolean) {
  const doc = container.ownerDocument;
  const view = doc.defaultView;
  if (!view) return undefined;
  const box = container.getBoundingClientRect();
  const x = paged ? box.left + 4 : box.left + Math.min(54, box.width / 5);
  const y = box.top + (paged ? 36 : 54);
  const caret = doc.caretRangeFromPoint?.(x, y);
  const paragraph =
    caret?.startContainer.parentElement?.closest<HTMLElement>("p[data-offset]");
  if (caret && paragraph && container.contains(paragraph)) {
    const prefix = doc.createRange();
    prefix.selectNodeContents(paragraph);
    prefix.setEnd(caret.startContainer, caret.startOffset);
    return Number(paragraph.dataset.offset ?? 0) + prefix.toString().length;
  }
  const visible = [
    ...container.querySelectorAll<HTMLElement>("p[data-offset]"),
  ].find((element) => {
    const rect = element.getBoundingClientRect();
    return paged
      ? rect.left >= box.left - 1 && rect.left < box.right
      : rect.bottom > box.top + 32 && rect.top < box.bottom;
  });
  return visible ? Number(visible.dataset.offset ?? 0) : undefined;
}

function restoreTextOffset(
  container: HTMLElement,
  offset: number,
  paged: boolean,
) {
  const paragraphs = container.querySelectorAll<HTMLElement>("p[data-offset]");
  let paragraph: HTMLElement | undefined;
  for (const candidate of paragraphs) {
    if (Number(candidate.dataset.offset ?? 0) <= offset) paragraph = candidate;
    else break;
  }
  if (!paragraph) return false;
  const within = Math.max(
    0,
    Math.min(
      paragraph.textContent?.length ?? 0,
      offset - Number(paragraph.dataset.offset ?? 0),
    ),
  );
  const walker = paragraph.ownerDocument.createTreeWalker(
    paragraph,
    NodeFilter.SHOW_TEXT,
  );
  let node = walker.nextNode();
  let remaining = within;
  let target: Text | null = null;
  let targetOffset = 0;
  while (node) {
    const length = node.textContent?.length ?? 0;
    if (remaining <= length) {
      target = node as Text;
      targetOffset = remaining;
      break;
    }
    remaining -= length;
    node = walker.nextNode();
  }
  if (!target) {
    const range = paragraph.ownerDocument.createRange();
    range.selectNodeContents(paragraph);
    range.collapse(true);
    target =
      range.startContainer.nodeType === Node.TEXT_NODE
        ? (range.startContainer as Text)
        : null;
    targetOffset = 0;
  }
  if (!target) return false;
  const range = paragraph.ownerDocument.createRange();
  range.setStart(target, Math.min(targetOffset, target.length));
  range.collapse(true);
  const rect = range.getBoundingClientRect();
  const bounds = container.getBoundingClientRect();
  if (paged) {
    const width =
      container
        .querySelector<HTMLElement>(".book-text")
        ?.getBoundingClientRect().width || container.clientWidth;
    const absoluteX = container.scrollLeft + rect.left - bounds.left;
    container.scrollLeft = Math.floor((absoluteX + 1) / width) * width;
  } else container.scrollTop += rect.top - bounds.top - 42;
  if (!rect.width && !rect.height) {
    paragraph.scrollIntoView({ block: "start", inline: "nearest" });
  }
  return true;
}

function epubAppearance(settings: Settings, selecting: boolean) {
  const palette = readerColors(settings.readerTheme);
  return `
    html, body { background: transparent !important; overflow-anchor: none !important; }
    body, body * {
      color: ${palette.foreground} !important;
      -webkit-text-fill-color: ${palette.foreground} !important;
      user-select: ${selecting ? "text" : "none"} !important;
      -webkit-user-select: ${selecting ? "text" : "none"} !important;
    }
    html { touch-action: none; }
    body {
      font-family: ${READER_FONTS[settings.readerFont].family} !important;
      font-size: ${settings.fontSize}px !important;
      line-height: ${settings.lineHeight} !important;
      ${settings.readerMode === "scroll" ? "padding: 0 !important; margin: 0 !important;" : ""}
    }
    img, svg { max-width: 100%; object-fit: contain; }
    img { height: auto; -webkit-user-drag: none; }
    svg image { -webkit-user-drag: none; }
  `;
}

export default function NovelViewer({
  item,
  close,
}: {
  item: MediaItem;
  close(): void;
}) {
  const settings = useApp((state) => state.settings);
  const setSettings = useApp((state) => state.setSettings);
  const palette = readerColors(settings.readerTheme);
  const [showChrome, setShowChrome] = useState(true);
  const [showOptions, setShowOptions] = useState(false);
  const [showToc, setShowToc] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [tocTab, setTocTab] = useState<"chapters" | "bookmarks">("chapters");
  const [selecting, setSelecting] = useState(false);
  const [encoding, setEncoding] = useState("");
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [bookmarks, setBookmarks] = useState<Progress[]>([]);
  const [toc, setToc] = useState<{ label: string; href: string }[]>([]);
  const [progressReady, setProgressReady] = useState(false);
  const [, setProgressTick] = useState(0);
  const [wholeBookReady, setWholeBookReady] = useState(false);
  const [wholeBookProgress, setWholeBookProgress] = useState(0);
  const [chapterProgress, setChapterProgress] = useState(0);
  const [progressPreview, setProgressPreview] = useState<number>();
  const applySeek = useRef<(value: number) => Promise<boolean>>(
    async () => false,
  );
  const [txtViewport, setTxtViewport] = useState({ width: 0, height: 0 });
  const container = useRef<HTMLDivElement>(null);
  const epubHost = useRef<HTMLDivElement>(null);
  const pageAnimation = useRef<Animation | null>(null);
  const renditionRef = useRef<any>(null);
  const sessionRef = useRef<EpubReaderSession | null>(null);
  const [epubRevision, setEpubRevision] = useState(0);
  const recovery = useRef({ id: item.id, attempts: 0 });
  if (recovery.current.id !== item.id)
    recovery.current = { id: item.id, attempts: 0 };
  const currentProgress = useRef<Progress>(item.progress ?? {});
  const lastSaved = useRef(0);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settingsRef = useRef(settings);
  const stateRef = useRef({
    mode: settings.readerMode,
    selecting,
    text,
    showMore,
    showOptions,
    showToc,
    showChrome,
  });
  const keyHandlerRef = useRef<(event: KeyboardEvent, doc: Document) => void>(
    () => {},
  );
  const appearanceRef = useRef({
    fontSize: settings.fontSize,
    lineHeight: settings.lineHeight,
    readerPadding: settings.readerPadding,
    readerFont: settings.readerFont,
  });
  const scrollFrame = useRef<number | null>(null);
  settingsRef.current = settings;
  stateRef.current = {
    mode: settings.readerMode,
    selecting,
    text,
    showMore,
    showOptions,
    showToc,
    showChrome,
  };
  const bookmarkKey = `bookmarks:${item.id}`;
  const seekController = useMemo(
    () =>
      new ReaderSeekController(
        (value) => applySeek.current(value),
        setProgressPreview,
        report,
      ),
    [item.id, item.ext, settings.readerMode, epubRevision],
  );
  useEffect(() => {
    setProgressPreview(undefined);
    return () => seekController.dispose();
  }, [seekController]);

  function animatePageIn(element: HTMLElement | null, direction: number) {
    if (!element || settingsRef.current.reducedMotion) return;
    pageAnimation.current?.cancel();
    const animation = element.animate(
      [
        {
          transform: `translateX(${direction > 0 ? 20 : -20}px)`,
          opacity: 0.82,
        },
        { transform: "translateX(0)", opacity: 1 },
      ],
      {
        duration: 180,
        easing: "cubic-bezier(0.22, 0.61, 0.36, 1)",
      },
    );
    pageAnimation.current = animation;
    animation.onfinish = () => {
      if (pageAnimation.current === animation) pageAnimation.current = null;
    };
  }

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(bookmarkKey) || "[]");
      setBookmarks(Array.isArray(saved) ? saved : []);
    } catch {
      setBookmarks([]);
    }
  }, [bookmarkKey]);

  useEffect(() => {
    let live = true;
    setProgressReady(false);
    void window.media
      .item(item.id)
      .then((latest) => {
        if (!live) return;
        currentProgress.current = latest.progress ?? item.progress ?? {};
        setProgressReady(true);
      })
      .catch((err) => {
        if (!live) return;
        currentProgress.current = item.progress ?? {};
        setProgressReady(true);
        report(err);
      });
    return () => {
      live = false;
    };
  }, [item.id]);

  const chapters =
    item.ext === "txt"
      ? [
          ...text.matchAll(
            /^\s*(第[一二三四五六七八九十百千万零〇\d]+[章节卷部篇].{0,55}|chapter\s+\d+.{0,55})\s*$/gim,
          ),
        ]
          .slice(0, 1000)
          .map((match) => ({
            label: match[0].trim(),
            index: match.index! + match[0].search(/\S/),
          }))
      : [];
  const textLines = useMemo(() => text.split("\n"), [text]);
  const textParagraphs = useMemo(() => {
    let offset = 0;
    return textLines.map((line) => {
      const paragraph = { line, offset };
      offset += line.length + 1;
      return paragraph;
    });
  }, [textLines]);
  const currentChapter = chapters.reduce<
    { label: string; index: number } | undefined
  >(
    (active, chapter) =>
      chapter.index <= (currentProgress.current.textOffset ?? 0)
        ? chapter
        : active,
    undefined,
  );
  const activeTocIndex = currentProgress.current.cfi
    ? toc.findIndex(
        (chapter) =>
          chapter.href.split("#")[0] ===
          (currentProgress.current as any).href?.split("#")[0],
      )
    : -1;

  function persistProgress(next: Progress) {
    currentProgress.current = next;
    setProgressTick((tick) => tick + 1);
    const now = Date.now();
    const save = () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = null;
      lastSaved.current = now;
      void window.media
        .saveProgress(item.id, currentProgress.current)
        .catch(report);
    };
    if (now - lastSaved.current >= 1800) {
      save();
    } else if (!saveTimer.current) {
      saveTimer.current = setTimeout(
        () => {
          lastSaved.current = Date.now();
          saveTimer.current = null;
          void window.media
            .saveProgress(item.id, currentProgress.current)
            .catch(report);
        },
        1800 - (now - lastSaved.current),
      );
    }
  }

  function moveTextPage(direction: number) {
    const el = container.current;
    if (!el || !direction) return;
    if (settingsRef.current.readerMode === "paged") {
      const article = el.querySelector<HTMLElement>(".book-text");
      const width = article?.getBoundingClientRect().width || el.clientWidth;
      const max = Math.max(0, el.scrollWidth - el.clientWidth);
      const target = Math.max(
        0,
        Math.min(
          max,
          (Math.round(el.scrollLeft / width) + Math.sign(direction)) * width,
        ),
      );
      if (target === el.scrollLeft) return;
      el.scrollLeft = target;
      animatePageIn(article, direction);
    } else {
      el.scrollBy({
        top: direction * Math.max(240, el.clientHeight * 0.82),
        behavior: settingsRef.current.reducedMotion ? "instant" : "smooth",
      });
    }
  }

  function movePage(direction: number) {
    if (!direction) return;
    if (item.ext === "epub") {
      sessionRef.current?.page(direction);
    } else {
      moveTextPage(direction);
    }
  }

  function handleReaderKey(event: KeyboardEvent, doc: Document) {
    if (event.isComposing) return;
    if (event.key === "Escape") {
      if (
        stateRef.current.showMore ||
        stateRef.current.showOptions ||
        stateRef.current.showToc
      ) {
        setShowMore(false);
        setShowOptions(false);
        setShowToc(false);
      } else if (stateRef.current.selecting) {
        setSelecting(false);
        doc.getSelection()?.removeAllRanges();
        window.getSelection()?.removeAllRanges();
        for (const contents of renditionRef.current?.getContents?.() ?? [])
          contents.document.getSelection()?.removeAllRanges();
      } else if (!stateRef.current.showChrome) setShowChrome(true);
      else close();
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const ElementType = doc.defaultView?.HTMLElement;
    if (
      ElementType &&
      event.target instanceof ElementType &&
      event.target.closest(
        "input,select,textarea,button,[contenteditable='true']",
      )
    )
      return;
    if (stateRef.current.selecting && !doc.getSelection()?.isCollapsed) return;
    const direction =
      event.key === "ArrowLeft" ||
      event.key === "ArrowUp" ||
      event.key === "PageUp"
        ? -1
        : event.key === "ArrowRight" ||
            event.key === "ArrowDown" ||
            event.key === "PageDown" ||
            event.key === " "
          ? 1
          : 0;
    if (!direction) return;
    event.preventDefault();
    setShowChrome(true);
    movePage(direction);
  }
  keyHandlerRef.current = handleReaderKey;

  function restoreTxtProgress() {
    const el = container.current;
    if (!el) return;
    const progress = currentProgress.current;
    const paged = settingsRef.current.readerMode === "paged";
    const max = Math.max(
      0,
      paged
        ? el.scrollWidth - el.clientWidth
        : el.scrollHeight - el.clientHeight,
    );
    if (
      progress.scroll !== undefined &&
      (progress.scroll <= 0 || progress.scroll >= 1)
    ) {
      if (paged) el.scrollLeft = progress.scroll >= 1 ? max : 0;
      else el.scrollTop = progress.scroll >= 1 ? max : 0;
      captureTextProgress(el);
      return;
    }
    if (progress.textOffset != null && text) {
      if (
        restoreTextOffset(
          el,
          progress.textOffset,
          settingsRef.current.readerMode === "paged",
        )
      ) {
        captureTextProgress(el);
        return;
      }
    }
    const target =
      progress.scroll !== undefined
        ? progress.scroll * max
        : (progress.position ?? 0);
    if (paged) el.scrollLeft = target;
    else el.scrollTop = target;
    captureTextProgress(el);
  }

  useEffect(() => {
    if (item.ext !== "txt" || !progressReady) return;
    let live = true;
    setError("");
    setText("");
    void window.media
      .readText(item.id, encoding || undefined)
      .then((result) => {
        if (!live) return;
        setText(result.text);
      })
      .catch((err) => {
        if (live) setError(String(err));
      });
    return () => {
      live = false;
    };
  }, [item.id, encoding, item.resourceVersion, progressReady]);

  useEffect(() => {
    if (item.ext !== "epub" || !progressReady || !epubHost.current) return;
    let live = true;
    let failureHandled = false;
    setError("");
    setWholeBookReady(false);
    const handleFailure = (error: unknown) => {
      if (!live || failureHandled || sessionRef.current !== session) return;
      failureHandled = true;
      if (recovery.current.attempts++ === 0)
        setEpubRevision((value) => value + 1);
      else setError(error instanceof Error ? error.message : String(error));
    };
    const session = new EpubReaderSession(
      epubHost.current,
      settingsRef.current.readerMode,
      epubAppearance(settingsRef.current, stateRef.current.selecting),
      {
        content(doc, sectionHref) {
          renditionRef.current = session.rendition;
          const gestures = attachReaderGestures(doc.documentElement, {
            mode: () => stateRef.current.mode,
            textSelection: () => stateRef.current.selecting,
            onPage: (direction) => session.page(direction),
            onWheelPage: (direction) => session.wheelPage(direction),
            onScroll: (x, y) => session.scroll(x, y),
            onCenter: () => toggleReaderChrome(),
            scrollTarget: () => session.rendition?.manager?.container ?? null,
          });
          const key = (event: KeyboardEvent) =>
            keyHandlerRef.current(event, doc);
          const link = (event: MouseEvent) => {
            const anchor = (event.target as Element)?.closest?.("a[href]");
            if (!anchor || event.button !== 0) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            const href = anchor.getAttribute("href") ?? "";
            const base = session.book?.resolve(sectionHref, false) ?? "/";
            const path = archivePath(href, base);
            if (path && session.book) {
              const fragment = href.includes("#")
                ? `#${href.split("#")[1]}`
                : "";
              session.display(session.book.path.relative(path) + fragment);
            }
          };
          doc.addEventListener("keydown", key);
          doc.addEventListener("click", link, true);
          return () => {
            gestures();
            doc.removeEventListener("keydown", key);
            doc.removeEventListener("click", link, true);
          };
        },
        location(location) {
          if (!live || sessionRef.current !== session) return;
          persistProgress({
            ...currentProgress.current,
            cfi: location.start.cfi,
            href: location.start.href,
          });
          setChapterProgress(location.chapter);
          setWholeBookProgress(location.whole);
        },
        indexReady() {
          if (live && sessionRef.current === session) setWholeBookReady(true);
        },
        navigation(direction) {
          if (live && sessionRef.current === session)
            animatePageIn(epubHost.current, direction);
        },
        failure: handleFailure,
      },
    );
    sessionRef.current = session;
    const hostGestures = attachReaderGestures(epubHost.current, {
      mode: () => stateRef.current.mode,
      textSelection: () => stateRef.current.selecting,
      onPage: (direction) => session.page(direction),
      onWheelPage: (direction) => session.wheelPage(direction),
      onScroll: (x, y) => session.scroll(x, y),
      onCenter: toggleReaderChrome,
      scrollTarget: () => session.rendition?.manager?.container ?? null,
    });
    const abort = new AbortController();
    void (async () => {
      const response = await fetch(resource(item), { signal: abort.signal });
      if (!response.ok)
        throw new Error("EPUB 无法读取，文件可能损坏或已被移除");
      const data = await response.arrayBuffer();
      if (!live) return;
      await session.start(
        data,
        currentProgress.current.cfi || item.progress?.cfi,
      );
      if (!live) return;
      renditionRef.current = session.rendition;
      const navigation = await session.book!.loaded.navigation;
      if (live)
        setToc(
          navigation.toc.map((chapter: any) => ({
            label: chapter.label.trim(),
            href: chapter.href,
          })),
        );
    })().catch(handleFailure);
    return () => {
      session.flushProgress();
      live = false;
      abort.abort();
      hostGestures();
      pageAnimation.current?.cancel();
      session.dispose();
      if (sessionRef.current === session) {
        sessionRef.current = null;
        renditionRef.current = null;
      }
    };
  }, [
    item.id,
    item.resourceVersion,
    item.ext,
    settings.readerMode,
    progressReady,
    epubRevision,
  ]);

  useEffect(() => {
    const previous = appearanceRef.current;
    const reflowed =
      settings.fontSize !== previous.fontSize ||
      settings.lineHeight !== previous.lineHeight ||
      settings.readerPadding !== previous.readerPadding ||
      settings.readerFont !== previous.readerFont;
    appearanceRef.current = {
      fontSize: settings.fontSize,
      lineHeight: settings.lineHeight,
      readerPadding: settings.readerPadding,
      readerFont: settings.readerFont,
    };
    sessionRef.current?.updateAppearance(
      epubAppearance(settings, selecting),
      reflowed,
    );
  }, [
    settings.fontSize,
    settings.lineHeight,
    settings.readerPadding,
    settings.readerFont,
    settings.readerTheme,
    selecting,
  ]);

  useEffect(() => {
    if (item.ext !== "txt" || !container.current) return;
    return attachReaderGestures(container.current, {
      mode: () => stateRef.current.mode,
      textSelection: () => stateRef.current.selecting,
      onPage: movePage,
      onCenter: toggleReaderChrome,
    });
  }, [item.ext]);

  useEffect(() => {
    if (item.ext !== "txt" || !container.current) return;
    const element = container.current;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const width = element.clientWidth,
          height = element.clientHeight;
        setTxtViewport((previous) =>
          previous.width === width && previous.height === height
            ? previous
            : { width, height },
        );
      });
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    update();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [item.ext, settings.readerPadding]);

  useLayoutEffect(() => {
    if (item.ext !== "txt" || !text) return;
    const el = container.current;
    if (!el) return;
    restoreTxtProgress();
  }, [
    settings.readerMode,
    settings.readerFont,
    settings.fontSize,
    settings.lineHeight,
    settings.readerPadding,
    text,
    txtViewport.width,
    txtViewport.height,
  ]);

  useEffect(() => {
    const key = (event: KeyboardEvent) =>
      keyHandlerRef.current(event, document);
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [item.ext]);

  useEffect(
    () => () => {
      if (scrollFrame.current != null)
        cancelAnimationFrame(scrollFrame.current);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (progressReady)
        void window.media
          .saveProgress(item.id, currentProgress.current)
          .catch(report);
    },
    [item.id, progressReady],
  );

  function toggleReaderChrome() {
    if (
      stateRef.current.showOptions ||
      stateRef.current.showToc ||
      stateRef.current.showMore
    ) {
      setShowOptions(false);
      setShowToc(false);
      setShowMore(false);
      return;
    }
    setShowChrome((visible) => !visible);
  }

  function toggleTextSelection() {
    setSelecting((active) => {
      const next = !active;
      if (!next) {
        window.getSelection()?.removeAllRanges();
        for (const contents of renditionRef.current?.getContents?.() ?? [])
          contents.document.getSelection()?.removeAllRanges();
      }
      return next;
    });
    setShowChrome(true);
    setShowOptions(false);
    setShowToc(false);
    setShowMore(false);
  }

  function bookmark() {
    const next = [...bookmarks, { ...currentProgress.current }].slice(-50);
    setBookmarks(next);
    localStorage.setItem(bookmarkKey, JSON.stringify(next));
    useApp.getState().notify("已添加阅读书签");
  }

  function removeBookmark(index: number) {
    const next = bookmarks.filter((_, position) => position !== index);
    setBookmarks(next);
    localStorage.setItem(bookmarkKey, JSON.stringify(next));
  }

  function restoreBookmark(progress: Progress) {
    if (progress.cfi) sessionRef.current?.display(progress.cfi);
    else if (container.current) {
      currentProgress.current = { ...progress };
      restoreTxtProgress();
    }
    setShowToc(false);
  }

  function onTextScroll() {
    const el = container.current;
    if (!progressReady || !el || scrollFrame.current != null) return;
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = null;
      captureTextProgress(el);
    });
  }

  function captureTextProgress(el: HTMLElement) {
    const paged = settingsRef.current.readerMode === "paged";
    const max = paged
      ? el.scrollWidth - el.clientWidth
      : el.scrollHeight - el.clientHeight;
    const position = Math.max(
      0,
      Math.min(Math.max(0, max), paged ? el.scrollLeft : el.scrollTop),
    );
    const fraction =
      max > 0 ? (max - position <= 2 ? 1 : position / max) : text ? 1 : 0;
    persistProgress({
      position,
      scroll: fraction,
      completed: fraction === 1,
      textOffset:
        textOffsetAtViewport(el, paged) ?? currentProgress.current.textOffset,
    });
  }

  applySeek.current = async (value: number) => {
    const fraction = value / 1000;
    if (item.ext === "txt") {
      const el = container.current;
      if (!el || !text) return false;
      const paged = settingsRef.current.readerMode === "paged";
      const max = Math.max(
        0,
        paged
          ? el.scrollWidth - el.clientWidth
          : el.scrollHeight - el.clientHeight,
      );
      if (paged) {
        const width =
          el.querySelector<HTMLElement>(".book-text")?.getBoundingClientRect()
            .width || el.clientWidth;
        el.scrollLeft =
          fraction >= 1
            ? max
            : Math.min(max, Math.round((fraction * max) / width) * width);
      } else el.scrollTop = fraction * max;
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      if (!el.isConnected) return false;
      captureTextProgress(el);
      return true;
    }
    return sessionRef.current?.seek(fraction) ?? false;
  };

  const actualProgressValue =
    item.ext === "txt"
      ? Math.round(
          Math.max(0, Math.min(1, currentProgress.current.scroll ?? 0)) * 1000,
        )
      : wholeBookReady
        ? Math.round(wholeBookProgress * 1000)
        : Math.round(chapterProgress * 1000);
  const progressValue = progressPreview ?? actualProgressValue;
  const progressLabel =
    item.ext === "txt" || wholeBookReady
      ? `${Math.min(100, progressValue / 10).toFixed(1)}%`
      : `本章 ${(chapterProgress * 100).toFixed(0)}%`;

  return (
    <div
      className={`reader reader-${settings.readerTheme} reader-mode-${settings.readerMode} ${selecting ? "reader-selecting" : ""} ${showChrome ? "" : "reader-immersive"}`}
      style={
        {
          "--reader-padding": `${settings.readerPadding}%`,
          "--reader-size": `${settings.fontSize}px`,
          "--reader-line": settings.lineHeight,
          "--reader-bg": palette.background,
          "--reader-fg": palette.foreground,
          "--reader-panel": palette.panel,
          "--reader-muted": palette.muted,
          "--reader-border": palette.border,
          "--reader-accent": palette.accent,
          "--reader-selection": palette.selection,
          "--reader-font": READER_FONTS[settings.readerFont].family,
        } as CSSProperties
      }
      onMouseMove={(event) => {
        if (event.clientY < 54) setShowChrome(true);
      }}
      onMouseUp={() => {
        if (!window.getSelection()?.isCollapsed) setShowChrome(true);
      }}
    >
      <header className="reader-chrome reader-topbar">
        <div className="reader-top-left">
          <IconButton label="返回媒体库" onClick={close}>
            <ArrowLeft size={18} />
          </IconButton>
          <IconButton
            label="目录与书签"
            active={showToc}
            onClick={() => {
              setShowToc(!showToc);
              setShowOptions(false);
              setShowMore(false);
            }}
          >
            <List size={18} />
          </IconButton>
        </div>
        <div className="reader-book-title" title={item.title}>
          {item.title}
        </div>
        <div className="reader-top-actions">
          <IconButton label="添加书签" onClick={bookmark}>
            <BookMarked size={18} />
          </IconButton>
          <IconButton
            label={selecting ? "退出文字选择" : "选择文字"}
            active={selecting}
            onClick={toggleTextSelection}
          >
            <Type size={18} />
          </IconButton>
          <IconButton
            label="阅读外观"
            active={showOptions}
            onClick={() => {
              setShowOptions(!showOptions);
              setShowToc(false);
              setShowMore(false);
            }}
          >
            <Settings2 size={18} />
          </IconButton>
          <IconButton
            label="更多"
            active={showMore}
            onClick={() => {
              setShowMore(!showMore);
              setShowOptions(false);
              setShowToc(false);
            }}
          >
            <MoreHorizontal size={18} />
          </IconButton>
        </div>
      </header>

      {showMore && (
        <div className="reader-more-popover">
          {item.ext === "txt" && (
            <label className="reader-more-row">
              <span>文本编码</span>
              <select
                aria-label="文本编码"
                value={encoding}
                onChange={(event) => setEncoding(event.target.value)}
              >
                <option value="">自动识别</option>
                <option value="utf-8">UTF-8</option>
                <option value="gb18030">GB18030</option>
                <option value="utf16-le">UTF-16 LE</option>
                <option value="utf16-be">UTF-16 BE</option>
              </select>
            </label>
          )}
          <button
            className="reader-more-row"
            onClick={() => void act(() => window.media.reveal(item.id))}
          >
            <FolderOpen size={16} />
            <span>在文件夹中显示</span>
          </button>
        </div>
      )}

      {showToc && (
        <aside className="reader-drawer reader-toc">
          <div className="reader-drawer-heading">
            <strong>阅读导航</strong>
            <IconButton label="关闭目录" onClick={() => setShowToc(false)}>
              <X size={17} />
            </IconButton>
          </div>
          <div
            className="reader-drawer-tabs"
            role="tablist"
            aria-label="阅读导航"
          >
            <button
              role="tab"
              aria-selected={tocTab === "chapters"}
              onClick={() => setTocTab("chapters")}
            >
              目录
            </button>
            <button
              role="tab"
              aria-selected={tocTab === "bookmarks"}
              onClick={() => setTocTab("bookmarks")}
            >
              书签 <span>{bookmarks.length}</span>
            </button>
          </div>
          <div className="reader-drawer-list">
            {tocTab === "chapters"
              ? item.ext === "txt"
                ? chapters.map((chapter) => (
                    <button
                      key={chapter.index}
                      className={
                        currentChapter?.index === chapter.index ? "current" : ""
                      }
                      onClick={() => {
                        const target =
                          container.current?.querySelector<HTMLElement>(
                            `[data-offset="${chapter.index}"]`,
                          );
                        target?.scrollIntoView({ block: "start" });
                        currentProgress.current = {
                          ...currentProgress.current,
                          textOffset: chapter.index,
                        };
                        setShowToc(false);
                      }}
                    >
                      {chapter.label}
                    </button>
                  ))
                : toc.map((chapter, index) => (
                    <button
                      key={chapter.href}
                      className={index === activeTocIndex ? "current" : ""}
                      onClick={() => {
                        sessionRef.current?.display(chapter.href);
                        setShowToc(false);
                      }}
                    >
                      {chapter.label}
                    </button>
                  ))
              : bookmarks.map((mark, index) => (
                  <div
                    className="reader-bookmark-row"
                    key={`${mark.cfi ?? mark.textOffset ?? mark.position}-${index}`}
                  >
                    <button onClick={() => restoreBookmark(mark)}>
                      <BookMarked size={15} />
                      <span>书签 {String(index + 1).padStart(2, "0")}</span>
                    </button>
                    <button
                      className="reader-bookmark-remove"
                      aria-label={`移除书签 ${index + 1}`}
                      onClick={() => removeBookmark(index)}
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))}
            {tocTab === "chapters" && !chapters.length && !toc.length && (
              <p>此书暂无章节目录</p>
            )}
            {tocTab === "bookmarks" && !bookmarks.length && (
              <p>还没有添加书签</p>
            )}
          </div>
        </aside>
      )}

      {showOptions && (
        <aside className="reader-drawer reader-appearance">
          <div className="reader-drawer-heading">
            <strong>阅读外观</strong>
            <IconButton
              label="关闭阅读外观"
              onClick={() => setShowOptions(false)}
            >
              <X size={17} />
            </IconButton>
          </div>
          <ReaderPreferences compact />
        </aside>
      )}

      {error && (
        <div className="reader-error" role="alert">
          <div>
            <p>{error}</p>
            <button
              className="button"
              onClick={() => {
                recovery.current.attempts = 0;
                setError("");
                setEpubRevision((value) => value + 1);
              }}
            >
              重试打开
            </button>
          </div>
        </div>
      )}
      {item.ext === "txt" ? (
        <div
          ref={container}
          className={`text-scroll ${settings.readerMode === "paged" ? "reader-paged" : ""}`}
          tabIndex={0}
          onScroll={onTextScroll}
        >
          <article className="book-text">
            <h1>{item.title}</h1>
            {text ? (
              textParagraphs.map(({ line, offset }, index) => (
                <p data-offset={offset} key={`${offset}-${index}`}>
                  {line || "\u00a0"}
                </p>
              ))
            ) : (
              <p>正在打开书页…</p>
            )}
            <div className="book-end">— 本书完 —</div>
          </article>
        </div>
      ) : (
        <div className="epub-shell">
          <div ref={epubHost} className="epub-host" />
        </div>
      )}

      <footer className="reader-chrome reader-footer">
        <IconButton
          label="上一页"
          disabled={
            item.ext === "txt" &&
            settings.readerMode === "scroll" &&
            (container.current?.scrollTop ?? 0) <= 0
          }
          onClick={() => movePage(-1)}
        >
          <ChevronLeft size={18} />
        </IconButton>
        <div
          className="reader-progress-label"
          title={currentChapter?.label ?? item.title}
        >
          {item.ext === "txt"
            ? (currentChapter?.label ?? "阅读进度")
            : wholeBookReady
              ? "全书阅读进度"
              : "章节阅读进度"}
        </div>
        <input
          type="range"
          min="0"
          max="1000"
          value={progressValue}
          aria-label="阅读进度"
          disabled={item.ext === "epub" && !wholeBookReady}
          onPointerDown={(event) => {
            seekController.begin();
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerUp={() => seekController.finish()}
          onPointerCancel={() => seekController.finish()}
          onLostPointerCapture={() => seekController.finish()}
          onBlur={() => seekController.finish()}
          onKeyUp={() => seekController.finish()}
          onChange={(event) => seekController.input(Number(event.target.value))}
        />
        <output className="reader-progress-value">{progressLabel}</output>
        <IconButton label="下一页" onClick={() => movePage(1)}>
          <ChevronRight size={18} />
        </IconButton>
      </footer>
    </div>
  );
}
