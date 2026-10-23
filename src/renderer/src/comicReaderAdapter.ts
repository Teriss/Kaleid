import type {
  ComicReaderAdapter,
  OnlineChapterRef,
} from "../../shared/onlineComics";
import type { MediaItem } from "../../shared/types";

const refs = new Map<string, OnlineChapterRef>();
const ref = (item: MediaItem) => {
  const value = item.remoteData?.comicRef as OnlineChapterRef | undefined;
  if (!value) throw new Error("在线章节标识缺失");
  refs.set(item.id, value);
  return value;
};
const local: ComicReaderAdapter = {
  local: true,
  pages: (item, session) => window.media.comicPages(item.id, session),
  context: (item) => window.media.comicContext(item.id),
  saveProgress: (item, progress) =>
    window.media.saveProgress(item.id, progress),
  preferences: (item, preferences) =>
    window.media.saveComicPreferences(item.id, preferences),
  bookmark: (_item, bookmark) => window.media.saveComicBookmark(bookmark),
  deleteBookmark: (id) => window.media.deleteComicBookmark(id),
  item: (id) => window.media.item(id),
  release: (item, session) => window.media.releaseComic(item.id, session),
};
const online: ComicReaderAdapter = {
  local: false,
  pages: (item, session) => window.media.onlineComics.pages(ref(item), session),
  context: async (item) => {
    const context = await window.media.onlineComics.context(ref(item));
    for (const chapter of context.chapters) ref(chapter);
    return context;
  },
  saveProgress: (item, progress) =>
    window.media.onlineComics.saveProgress(ref(item), progress),
  preferences: (item, preferences) =>
    window.media.onlineComics.preferences(ref(item), preferences),
  bookmark: (item, bookmark) =>
    window.media.onlineComics.bookmark(ref(item), bookmark),
  deleteBookmark: (id) => window.media.onlineComics.deleteBookmark(id),
  item: (id) => {
    const value = refs.get(id);
    if (!value) throw new Error("章节已失效");
    return window.media.onlineComics.readerItem(value);
  },
  release: (item, session) =>
    window.media.onlineComics.release(ref(item), session),
};
export function comicReaderAdapter(item: MediaItem) {
  return item.remoteData?.comicRef ? online : local;
}
