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
import { IconButton } from "./components";
import ReaderPreferences from "./ReaderPreferences";
import { act, report, resource, useApp } from "./store";
import type {
  NovelBookmark,
  OnlineNovelDetails,
} from "../../shared/onlineNovels";

export interface OnlineNovelReader {
  details: OnlineNovelDetails;
  bookmarks: NovelBookmark[];
  chapterId: string;
  navigateChapter(
    id: string,
    progress?: Progress,
    entry?: "start" | "end",
  ): Promise<void> | void;
}
type ReaderBookmark = Progress & {
  onlineId?: string;
  onlineChapterId?: string;
  label?: string;
};
const readerBookmarks = (marks: NovelBookmark[]): ReaderBookmark[] =>
  marks.map((mark) => ({
    ...mark.progress,
    onlineId: mark.id,
    onlineChapterId: mark.chapterId,
    label: mark.title,
  }));
function saveReadingProgress(item: MediaItem, progress: Progress) {
  return item.onlineNovelRef
    ? window.media.onlineNovels.saveProgress(
        item.onlineNovelRef,
        progress,
        item.resourceVersion,
      )
    : window.media.saveProgress(item.id, progress);
}

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

function epubAppearance(
  settings: Settings,
  selecting: boolean,
  requiredFont = false,
) {
  const palette = readerColors(settings.readerTheme);
  return `
    html, body { background: ${palette.background} !important; overflow-anchor: none !important; }
    body, body * {
      color: ${palette.foreground} !important;
      -webkit-text-fill-color: ${palette.foreground} !important;
      user-select: ${selecting ? "text" : "none"} !important;
      -webkit-user-select: ${selecting ? "text" : "none"} !important;
    }
    html { touch-action: none; }
    body {
      ${requiredFont ? "" : `font-family: ${READER_FONTS[settings.readerFont].family} !important;`}
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
  online,
}: {
  item: MediaItem;
  close(): void;
  online?: OnlineNovelReader;
}) {
  const settings = useApp((state) => state.settings);
  const setSettings = useApp((state) => state.setSettings);
  const palette = readerColors(settings.readerTheme);
  const [showChrome, setShowChrome] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const onlineRef = useRef(online);
  onlineRef.current = online;
  const changingChapter = useRef(false);
  const [chapterPending, setChapterPending] = useState(false);
  const [chapterFailure, setChapterFailure] = useState<{
    direction: number;
    message: string;
  }>();
  const chapterFailureRef = useRef(chapterFailure);
  chapterFailureRef.current = chapterFailure;
  const [endNotice, setEndNotice] = useState("");
  const [seekDraft, setSeekDraft] = useState("");
  const [showOptions, setShowOptions] = useState(false);
  const [showToc, setShowToc] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [tocTab, setTocTab] = useState<"chapters" | "bookmarks">("chapters");
  const [selecting, setSelecting] = useState(false);
  const [encoding, setEncoding] = useState("");
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [bookmarks, setBookmarks] = useState<ReaderBookmark[]>([]);
  const [toc, setToc] = useState<{ label: string; href: string }[]>([]);
  const [progressReady, setProgressReady] = useState(false);
  const [, setProgressTick] = useState(0);
  const [wholeBookReady, setWholeBookReady] = useState(false);
  const [wholeBookProgress, setWholeBookProgress] = useState(0);
  const [chapterProgress, setChapterProgress] = useState(0);
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
  const entryApplied = useRef<string | undefined>(undefined);
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
    if (online) {
      setBookmarks(readerBookmarks(online.bookmarks));
      return;
    }
    try {
      const saved = JSON.parse(localStorage.getItem(bookmarkKey) || "[]");
      setBookmarks(Array.isArray(saved) ? saved : []);
    } catch {
      setBookmarks([]);
    }
  }, [bookmarkKey, online?.bookmarks]);

  useEffect(() => {
    let live = true;
    setProgressReady(false);
    if (item.onlineNovelRef) {
      currentProgress.current = item.progress ?? {};
      setProgressReady(true);
      return;
    }
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
      void saveReadingProgress(item, currentProgress.current).catch(report);
    };
    if (now - lastSaved.current >= 1800) {
      save();
    } else if (!saveTimer.current) {
      saveTimer.current = setTimeout(
        () => {
          lastSaved.current = Date.now();
          saveTimer.current = null;
          void saveReadingProgress(item, currentProgress.current).catch(report);
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
      } else {
        close();
      }
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
    epubHost.current.dataset.readerPositioned = "false";
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
      epubAppearance(
        settingsRef.current,
        stateRef.current.selecting,
        item.novelRequiredFont,
      ),
      {
        content(doc, sectionHref) {
          renditionRef.current = session.rendition;
          const gestures = attachReaderGestures(doc.documentElement, {
            mode: () => stateRef.current.mode,
            textSelection: () => stateRef.current.selecting,
            onPage: (direction) => session.page(direction),
            onWheelPage: (direction) => session.wheelPage(direction),
            onScroll: (x, y, source) => session.scroll(x, y, source),
            onCenter: () => toggleReaderChrome(),
            scrollTarget: () => session.rendition?.manager?.container ?? null,
          });
          const key = (event: KeyboardEvent) =>
            keyHandlerRef.current(event, doc);
          const backButton = (event: MouseEvent) => {
            if (event.button !== 3 && event.button !== 4) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            close();
          };
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
          doc.addEventListener("mouseup", backButton, true);
          doc.addEventListener("auxclick", backButton, true);
          doc.addEventListener("click", link, true);
          return () => {
            gestures();
            doc.removeEventListener("keydown", key);
            doc.removeEventListener("mouseup", backButton, true);
            doc.removeEventListener("auxclick", backButton, true);
            doc.removeEventListener("click", link, true);
          };
        },
        location(location) {
          if (!live || sessionRef.current !== session) return;
          persistProgress({
            ...currentProgress.current,
            cfi: location.start.cfi,
            href: location.start.href,
            scroll: location.whole,
            completed: location.whole >= 0.999,
          });
          setEndNotice((value) =>
            value === "已经是第一章"
              ? location.atStart
                ? value
                : ""
              : location.atEnd
                ? value
                : "",
          );
          setChapterProgress(location.chapter);
          setWholeBookProgress(location.whole);
          if (item.onlineNovelRef && session.book) {
            const cfi = location.start.cfi;
            void session.book
              .getRange(cfi)
              .then((range: Range) => {
                if (!live || currentProgress.current.cfi !== cfi) return;
                const prefix =
                  range.startContainer.ownerDocument!.createRange();
                prefix.selectNodeContents(
                  range.startContainer.ownerDocument!.body,
                );
                prefix.setEnd(range.startContainer, range.startOffset);
                currentProgress.current = {
                  ...currentProgress.current,
                  textOffset: prefix.toString().length,
                };
              })
              .catch(() => {});
          }
        },
        indexReady() {
          if (live && sessionRef.current === session) setWholeBookReady(true);
        },
        navigation(direction) {
          if (live && sessionRef.current === session)
            animatePageIn(epubHost.current, direction);
        },
        boundary: online
          ? (direction) => void crossChapter(direction)
          : undefined,
        failure: handleFailure,
      },
    );
    sessionRef.current = session;
    const hostGestures = attachReaderGestures(epubHost.current, {
      mode: () => stateRef.current.mode,
      textSelection: () => stateRef.current.selecting,
      onPage: (direction) => session.page(direction),
      onWheelPage: (direction) => session.wheelPage(direction),
      onScroll: (x, y, source) => session.scroll(x, y, source),
      onCenter: toggleReaderChrome,
      scrollTarget: () => session.rendition?.manager?.container ?? null,
    });
    const abort = new AbortController();
    void (async () => {
      const response = await fetch(resource(item), { signal: abort.signal });
      if (!response.ok)
        throw new Error(
          item.onlineNovelRef
            ? await response.text()
            : "EPUB 无法读取，文件可能损坏或已被移除",
        );
      const data = await response.arrayBuffer();
      if (!live) return;
      const initialCfi =
        item.onlineNovelRef && recovery.current.attempts > 0
          ? undefined
          : currentProgress.current.cfi || item.progress?.cfi;
      await session.start(data, initialCfi);
      if (item.remoteData?.novelEntry && entryApplied.current !== item.id) {
        await session.displayBoundary(
          item.remoteData.novelEntry === "end" ? 1 : -1,
        );
        if (!live) return;
        entryApplied.current = item.id;
        session.holdBoundaryWheel();
      }
      if (item.onlineNovelRef && !initialCfi && item.progress?.textOffset) {
        const contents = session.rendition?.getContents?.()[0];
        const doc = contents?.document as Document | undefined;
        if (doc) {
          const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
          let remaining = item.progress.textOffset,
            node = walker.nextNode();
          while (node) {
            if (remaining <= (node.textContent?.length || 0)) {
              const range = doc.createRange();
              range.setStart(node, remaining);
              range.collapse(true);
              await session.display(contents.cfiFromRange(range));
              break;
            }
            remaining -= node.textContent?.length || 0;
            node = walker.nextNode();
          }
        }
      }
      if (!live) return;
      epubHost.current!.dataset.readerPositioned = "true";
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
      epubAppearance(settings, selecting, item.novelRequiredFont),
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
    const backButton = (event: MouseEvent) => {
      if (event.button !== 3 && event.button !== 4) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
    };
    window.addEventListener("keydown", key);
    window.addEventListener("mouseup", backButton, true);
    window.addEventListener("auxclick", backButton, true);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("mouseup", backButton, true);
      window.removeEventListener("auxclick", backButton, true);
    };
  }, [item.ext, close]);

  useEffect(
    () => () => {
      if (scrollFrame.current != null)
        cancelAnimationFrame(scrollFrame.current);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (progressReady)
        void saveReadingProgress(item, currentProgress.current).catch(report);
    },
    [item.id, progressReady],
  );

  useEffect(() => {
    if (!showChrome) return;
    setSeekDraft((actualProgressValue / 10).toFixed(1));
    const node = panel.current;
    node
      ?.querySelector<HTMLButtonElement>("button")
      ?.focus({ preventScroll: true });
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const controls = Array.from(
        node?.querySelectorAll<HTMLElement>("button,input,select") || [],
      ).filter((el) => !(el as HTMLButtonElement).disabled);
      if (
        document.activeElement ===
        (event.shiftKey ? controls[0] : controls.at(-1))
      ) {
        event.preventDefault();
        (event.shiftKey ? controls.at(-1) : controls[0])?.focus();
      }
    };
    node?.addEventListener("keydown", key);
    return () => {
      node?.removeEventListener("keydown", key);
      (container.current || epubHost.current?.querySelector("iframe"))?.focus({
        preventScroll: true,
      });
    };
  }, [showChrome]);
  async function crossChapter(direction: number) {
    const context = onlineRef.current;
    if (!context || changingChapter.current || chapterFailureRef.current)
      return;
    const index = context.details.chapters.findIndex(
      (chapter) => chapter.id === context.chapterId,
    );
    const target = context.details.chapters[index + Math.sign(direction)];
    if (!target) {
      setEndNotice(direction > 0 ? "— 本书完 —" : "已经是第一章");
      sessionRef.current?.releaseBoundary();
      return;
    }
    changingChapter.current = true;
    setChapterPending(true);
    setEndNotice("");
    try {
      sessionRef.current?.flushProgress();
      await saveReadingProgress(item, {
        ...currentProgress.current,
        ...(direction > 0 ? { completed: true } : {}),
      });
      await context.navigateChapter(
        target.id,
        undefined,
        direction > 0 ? "start" : "end",
      );
    } catch (error) {
      const failure = {
        direction,
        message: error instanceof Error ? error.message : String(error),
      };
      chapterFailureRef.current = failure;
      setChapterFailure(failure);
      sessionRef.current?.releaseBoundary();
    } finally {
      changingChapter.current = false;
      setChapterPending(false);
    }
  }

  function toggleReaderChrome() {
    setShowOptions(false);
    setShowToc(false);
    setShowMore(false);
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
    setShowChrome(false);
    setShowOptions(false);
    setShowToc(false);
    setShowMore(false);
  }

  function bookmark() {
    if (item.onlineNovelRef) {
      void act(async () => {
        setBookmarks(
          readerBookmarks(
            await window.media.onlineNovels.bookmark(
              item.onlineNovelRef!,
              currentProgress.current,
            ),
          ),
        );
        useApp.getState().notify("已添加阅读书签");
      });
      return;
    }
    const next = [...bookmarks, { ...currentProgress.current }].slice(-50);
    setBookmarks(next);
    localStorage.setItem(bookmarkKey, JSON.stringify(next));
    useApp.getState().notify("已添加阅读书签");
  }

  function removeBookmark(index: number) {
    if (item.onlineNovelRef && bookmarks[index]?.onlineId) {
      void act(async () =>
        setBookmarks(
          readerBookmarks(
            await window.media.onlineNovels.deleteBookmark(
              item.onlineNovelRef!,
              bookmarks[index].onlineId!,
            ),
          ),
        ),
      );
      return;
    }
    const next = bookmarks.filter((_, position) => position !== index);
    setBookmarks(next);
    localStorage.setItem(bookmarkKey, JSON.stringify(next));
  }

  function restoreBookmark(progress: ReaderBookmark) {
    if (
      online &&
      progress.onlineChapterId &&
      progress.onlineChapterId !== online.chapterId
    ) {
      void act(async () => {
        await online.navigateChapter(progress.onlineChapterId!, progress);
      });
      return;
    }
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
  const progressValue = actualProgressValue;
  const progressLabel =
    item.ext === "txt" || wholeBookReady
      ? `${Math.min(100, progressValue / 10).toFixed(1)}%`
      : "计算进度…";

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
    >
      <button
        className="reader-exit-button"
        type="button"
        aria-label="返回媒体库"
        title="返回媒体库（Esc）"
        onClick={close}
      >
        <ArrowLeft size={18} />
      </button>
      {showChrome && (
        <section
          ref={panel}
          className="reader-bottom-panel"
          role="dialog"
          aria-label="阅读菜单"
          aria-modal="true"
        >
          <header className="reader-panel-heading">
            <div className="reader-book-title" title={item.title}>
              {item.title}
            </div>
            <IconButton
              label="关闭阅读菜单"
              onClick={() => {
                setShowChrome(false);
                setShowOptions(false);
                setShowToc(false);
                setShowMore(false);
              }}
            >
              <X size={18} />
            </IconButton>
          </header>
          <div className="reader-panel-actions">
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
          <div className="reader-panel-controls">
            <label>
              阅读方式
              <select
                aria-label="小说翻页模式"
                value={settings.readerMode}
                onChange={(event) =>
                  void act(() =>
                    setSettings({
                      ...settings,
                      readerMode: event.target.value as Settings["readerMode"],
                    }),
                  )
                }
              >
                <option value="scroll">连续滚动</option>
                <option value="paged">分页翻页</option>
              </select>
            </label>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void act(async () => {
                  await applySeek.current(
                    Math.max(0, Math.min(100, Number(seekDraft) || 0)) * 10,
                  );
                });
              }}
            >
              <label>
                {online ? "章内进度" : "全书进度"}
                <input
                  aria-label="阅读进度百分比"
                  type="number"
                  min="0"
                  max="100"
                  step="0.1"
                  value={seekDraft}
                  onChange={(event) => setSeekDraft(event.target.value)}
                />
                %
              </label>
              <button
                type="submit"
                className="text-button"
                disabled={item.ext === "epub" && !wholeBookReady}
              >
                跳转
              </button>
            </form>
            {online && (
              <label>
                章节
                <select
                  aria-label="跳转章节"
                  value={online.chapterId}
                  onChange={(event) => {
                    setShowChrome(false);
                    void act(async () => {
                      await online.navigateChapter(event.target.value);
                    });
                  }}
                >
                  {online.details.chapters.map((chapter, index) => (
                    <option key={chapter.id} value={chapter.id}>
                      {index + 1}. {chapter.volume} · {chapter.title}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
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
              {item.onlineNovelRef ? (
                <button
                  className="reader-more-row"
                  onClick={() =>
                    void act(() =>
                      window.media.onlineNovels.enqueue(item.onlineNovelRef!, [
                        item.onlineNovelRef!.chapterId,
                      ]),
                    )
                  }
                >
                  下载当前章
                </button>
              ) : (
                <button
                  className="reader-more-row"
                  onClick={() => void act(() => window.media.reveal(item.id))}
                >
                  <FolderOpen size={16} />
                  <span>在文件夹中显示</span>
                </button>
              )}
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
                  ? online
                    ? online.details.chapters.map((chapter, index, all) => (
                        <div key={chapter.id}>
                          {(index === 0 ||
                            all[index - 1].volume !== chapter.volume) && (
                            <p>{chapter.volume}</p>
                          )}
                          <button
                            className={
                              chapter.id === online.chapterId ? "current" : ""
                            }
                            onClick={() => {
                              void act(async () => {
                                await online.navigateChapter(chapter.id);
                              });
                              setShowToc(false);
                            }}
                          >
                            {chapter.title}
                            {chapter.downloaded ? " · 已下载" : ""}
                          </button>
                        </div>
                      ))
                    : item.ext === "txt"
                      ? chapters.map((chapter) => (
                          <button
                            key={chapter.index}
                            className={
                              currentChapter?.index === chapter.index
                                ? "current"
                                : ""
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
                            className={
                              index === activeTocIndex ? "current" : ""
                            }
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
                          <span>
                            {mark.label ||
                              `书签 ${String(index + 1).padStart(2, "0")}`}
                          </span>
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
              <ReaderPreferences compact hideMode />
            </aside>
          )}
        </section>
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

      {!showChrome && (
        <output className="reader-corner-progress" aria-label="阅读进度文本">
          {online
            ? `${Math.max(1, online.details.chapters.findIndex((chapter) => chapter.id === online.chapterId) + 1)}/${online.details.chapters.length}章 · ${(Math.max(0, Math.min(1, wholeBookReady ? wholeBookProgress : chapterProgress)) * 100).toFixed(1)}%`
            : progressLabel}
        </output>
      )}
      {chapterPending && (
        <div className="reader-chapter-notice" role="status">
          正在打开相邻章节…
        </div>
      )}
      {chapterFailure && (
        <div className="reader-chapter-notice" role="alert">
          <span>{chapterFailure.message}</span>
          <button
            onClick={() => {
              const direction = chapterFailure.direction;
              chapterFailureRef.current = undefined;
              setChapterFailure(undefined);
              void crossChapter(direction);
            }}
          >
            重试切章
          </button>
          <button
            onClick={() => {
              chapterFailureRef.current = undefined;
              setChapterFailure(undefined);
            }}
          >
            关闭
          </button>
        </div>
      )}
      {endNotice && !chapterPending && !chapterFailure && (
        <div className="reader-end-notice" role="status">
          {endNotice}
        </div>
      )}
    </div>
  );
}
