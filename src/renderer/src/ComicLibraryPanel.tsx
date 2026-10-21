import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  GripVertical,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import type { ComicWork, MediaItem } from "../../shared/types";
import { comicReadState } from "../../shared/comic";
import { IconButton, Modal } from "./components";
import { report, resource, useApp } from "./store";
import "./comic.css";

const stateLabels = { unread: "未读", reading: "阅读中", completed: "已读" };
export default function ComicLibraryPanel({
  initialItem,
  close,
  onRead,
}: {
  initialItem?: MediaItem;
  close(): void;
  onRead(item: MediaItem): void;
}) {
  const [items, setItems] = useState<MediaItem[]>([]),
    [works, setWorks] = useState<ComicWork[]>([]);
  const [work, setWork] = useState<ComicWork>(),
    [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all"),
    [tab, setTab] = useState<"works" | "files" | "candidates">("works");
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [dirty, setDirty] = useState(false),
    [pendingWork, setPendingWork] = useState<ComicWork | null | undefined>(
      undefined,
    );
  const [deleteWork, setDeleteWork] = useState<ComicWork>();
  const dragId = useRef<string>(undefined);
  const resultsScroll = useRef<HTMLDivElement>(null);
  const chaptersScroll = useRef<HTMLDivElement>(null);
  const [listTop, setListTop] = useState(0),
    [chapterTop, setChapterTop] = useState(0);
  useEffect(() => {
    if (resultsScroll.current) resultsScroll.current.scrollTop = 0;
    setListTop(0);
  }, [search, filter, tab]);
  useEffect(() => {
    if (chaptersScroll.current) chaptersScroll.current.scrollTop = 0;
    setChapterTop(0);
  }, [work?.id]);
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  async function load() {
    const result: MediaItem[] = [];
    for (let offset = 0; ; offset += 200) {
      const page = await window.media.query({
        type: "comic",
        sort: "name",
        limit: 200,
        offset,
      });
      result.push(...page.items);
      if (offset + page.items.length >= page.total || !page.items.length) break;
    }
    const allWorks = await window.media.comicWorks();
    setItems(result);
    setWorks(allWorks);
    return { result, allWorks };
  }
  useEffect(() => {
    let live = true;
    void load()
      .then(({ allWorks }) => {
        if (!live || !initialItem) return;
        const existing = allWorks.find((w) =>
          w.chapterIds.includes(initialItem.id),
        );
        setWork(
          existing ?? {
            id: crypto.randomUUID(),
            title: initialItem.title,
            chapterIds: [initialItem.id],
          },
        );
        setDirty(!existing);
      })
      .catch((e) => {
        if (live) setError(String(e));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, []);
  function choose(next?: ComicWork) {
    if (dirty) setPendingWork(next ?? null);
    else {
      setWork(next);
      setDirty(Boolean(next && !works.some((w) => w.id === next.id)));
      setChapterTop(0);
    }
  }
  function edit(patch: Partial<ComicWork>) {
    if (work) {
      setWork({ ...work, ...patch });
      setDirty(true);
    }
  }
  async function save() {
    if (!work) return;
    setBusy(true);
    setError("");
    try {
      const saved = await window.media.saveComicWork(work);
      await load();
      setWork(saved);
      setDirty(false);
      useApp.getState().touch();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  function reorder(id: string, target: number) {
    if (!work) return;
    const ids = work.chapterIds.filter((i) => i !== id);
    ids.splice(Math.max(0, Math.min(target, ids.length)), 0, id);
    edit({ chapterIds: ids });
  }
  async function read(target?: ComicWork | MediaItem) {
    if (!target || busy) return;
    if ("chapterIds" in target) {
      const chapters = target.chapterIds
        .map((id) => byId.get(id))
        .filter((i): i is MediaItem => Boolean(i && !i.missing));
      const latest = [...chapters].sort(
        (a, b) => (b.lastOpened ?? 0) - (a.lastOpened ?? 0),
      )[0];
      const candidate = latest?.lastOpened
        ? latest.progress?.completed
          ? (chapters
              .slice(chapters.indexOf(latest) + 1)
              .find((c) => !c.progress?.completed) ?? latest)
          : latest
        : (chapters.find((c) => !c.progress?.completed) ?? chapters[0]);
      if (candidate) onRead(await window.media.item(candidate.id));
    } else onRead(await window.media.item(target.id));
  }
  async function mark(item: MediaItem, completed: boolean) {
    const progress = completed ? { ...item.progress, completed: true } : {};
    try {
      await window.media.saveProgress(item.id, progress);
      setItems((old) =>
        old.map((i) => (i.id === item.id ? { ...i, progress } : i)),
      );
      useApp.getState().touch();
    } catch (e) {
      report(e);
    }
  }
  const matches = (item: MediaItem) =>
    (!search.trim() ||
      `${item.title} ${item.path} ${item.comicInfo?.writer ?? ""}`
        .toLowerCase()
        .includes(search.trim().toLowerCase())) &&
    (filter === "all" || comicReadState(item.progress) === filter);
  const visibleItems = items.filter(matches);
  const candidates = useMemo(() => {
    const grouped = new Set(works.flatMap((w) => w.chapterIds)),
      groups = new Map<string, MediaItem[]>();
    for (const item of items)
      if (!grouped.has(item.id)) {
        const list = groups.get(item.folder) ?? [];
        list.push(item);
        groups.set(item.folder, list);
      }
    return [...groups]
      .filter(([, entries]) => entries.length > 1)
      .map(([folder, entries]) => ({
        folder,
        title: folder.split(/[\\/]/).at(-1) ?? folder,
        entries: entries.sort((a, b) =>
          a.title.localeCompare(b.title, "zh-CN", { numeric: true }),
        ),
      }));
  }, [items, works]);
  const chapterItems =
    work?.chapterIds
      .map((id) => byId.get(id))
      .filter((i): i is MediaItem => Boolean(i)) ?? [];
  return (
    <Modal
      title="漫画作品"
      subtitle="整理作品、接着阅读；原文件保留在原处"
      close={() => {
        if (dirty) setPendingWork(null);
        else close();
      }}
      className="comic-library-modal"
    >
      <div className="comic-library-toolbar">
        <input
          aria-label="搜索漫画作品"
          placeholder="搜索作品、文件或作者"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setListTop(0);
          }}
        />
        <select
          aria-label="漫画阅读状态"
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            setListTop(0);
          }}
        >
          <option value="all">全部状态</option>
          <option value="unread">未读</option>
          <option value="reading">阅读中</option>
          <option value="completed">已读</option>
        </select>
        <button
          className="button"
          onClick={() =>
            choose({ id: crypto.randomUUID(), title: "新作品", chapterIds: [] })
          }
        >
          <Plus size={16} />
          新建作品
        </button>
      </div>
      {error && (
        <p className="comic-library-error" role="alert">
          {error}
        </p>
      )}
      {loading ? (
        <p className="comic-library-loading" role="status">
          正在读取本地漫画…
        </p>
      ) : (
        <div className="comic-library-columns">
          <section className="comic-library-browser">
            <nav aria-label="漫画管理分类">
              {(["works", "files", "candidates"] as const).map((t) => (
                <button
                  aria-pressed={tab === t}
                  key={t}
                  className={tab === t ? "active" : ""}
                  onClick={() => {
                    setTab(t);
                    setListTop(0);
                  }}
                >
                  {t === "works"
                    ? `作品 ${works.length}`
                    : t === "files"
                      ? `本地漫画 ${items.length}`
                      : `待整理 ${candidates.length}`}
                </button>
              ))}
            </nav>
            <div
              className="comic-library-results"
              ref={resultsScroll}
              onScroll={(e) => setListTop(e.currentTarget.scrollTop)}
            >
              {tab === "works" && (
                <>
                  {works
                    .filter(
                      (w) =>
                        w.chapterIds.some(
                          (id) => byId.has(id) && matches(byId.get(id)!),
                        ) ||
                        (!search && filter === "all" && !w.chapterIds.length),
                    )
                    .map((w) => (
                      <div
                        className={`comic-work-row ${work?.id === w.id ? "active" : ""}`}
                        key={w.id}
                      >
                        <button
                          className="comic-work-title"
                          onClick={() => choose(w)}
                        >
                          <BookOpen size={23} />
                          <span>
                            <strong>{w.title}</strong>
                            <small>
                              {w.chapterIds.length} 章 ·{" "}
                              {
                                w.chapterIds.filter(
                                  (id) => byId.get(id)?.progress?.completed,
                                ).length
                              }{" "}
                              章已读
                            </small>
                          </span>
                        </button>
                        <button
                          className="text-button"
                          disabled={!w.chapterIds.some((id) => byId.has(id))}
                          onClick={() => void read(w).catch(report)}
                        >
                          继续阅读
                        </button>
                      </div>
                    ))}
                  {!works.length && (
                    <p className="comic-library-hint">
                      从“待整理”选择目录，或新建作品并添加本地漫画。
                    </p>
                  )}
                </>
              )}
              {tab === "candidates" && (
                <>
                  {candidates
                    .filter(
                      (c) =>
                        !search ||
                        c.title.toLowerCase().includes(search.toLowerCase()) ||
                        c.entries.some(matches),
                    )
                    .map((c) => (
                      <button
                        className="comic-candidate"
                        key={c.folder}
                        onClick={() =>
                          choose({
                            id: crypto.randomUUID(),
                            title: c.title,
                            chapterIds: c.entries.map((i) => i.id),
                          })
                        }
                      >
                        <strong>{c.title}</strong>
                        <small>
                          {c.entries.length} 个文件／目录，点击预览分组
                        </small>
                        <span>{c.folder}</span>
                      </button>
                    ))}
                  {!candidates.length && (
                    <p className="comic-library-hint">
                      没有待整理的同目录漫画。可新建作品，跨目录添加章节。
                    </p>
                  )}
                </>
              )}
              {tab === "files" && (
                <div
                  style={{
                    height: visibleItems.length * 76,
                    position: "relative",
                  }}
                >
                  {visibleItems
                    .slice(
                      Math.floor(listTop / 76),
                      Math.floor(listTop / 76) + 12,
                    )
                    .map((entry, i) => (
                      <div
                        className="comic-file-row"
                        style={{ top: (Math.floor(listTop / 76) + i) * 76 }}
                        key={entry.id}
                      >
                        <img
                          src={
                            entry.cover ? resource(entry, "cover") : undefined
                          }
                          alt=""
                        />
                        <button
                          className="comic-file-title"
                          onClick={() => void read(entry).catch(report)}
                        >
                          <strong>{entry.title}</strong>
                          <small>
                            {stateLabels[comicReadState(entry.progress)]}
                          </small>
                        </button>
                        <button
                          className="text-button"
                          onClick={() =>
                            void mark(entry, !entry.progress?.completed)
                          }
                        >
                          {entry.progress?.completed ? "标为未读" : "标为已读"}
                        </button>
                        {work && (
                          <input
                            type="checkbox"
                            aria-label={`将 ${entry.title} 加入作品`}
                            checked={work.chapterIds.includes(entry.id)}
                            onChange={(e) =>
                              edit({
                                chapterIds: e.target.checked
                                  ? [...work.chapterIds, entry.id]
                                  : work.chapterIds.filter(
                                      (id) => id !== entry.id,
                                    ),
                              })
                            }
                          />
                        )}
                      </div>
                    ))}
                </div>
              )}
            </div>
          </section>
          <section className="comic-work-editor" aria-label="作品整理">
            {work ? (
              <>
                <label>
                  作品名称
                  <input
                    aria-label="作品名称"
                    value={work.title}
                    maxLength={200}
                    onChange={(e) => edit({ title: e.target.value })}
                  />
                </label>
                <div className="comic-work-summary">
                  <span>
                    {chapterItems.length} 章 {dirty ? "· 有未保存的修改" : ""}
                  </span>
                  <button
                    className="text-button"
                    onClick={() => setTab("files")}
                  >
                    添加章节
                  </button>
                </div>
                {chapterItems[0]?.comicInfo?.writer && (
                  <small>作者：{chapterItems[0].comicInfo.writer}</small>
                )}
                {chapterItems[0]?.comicInfo?.summary && (
                  <p className="comic-summary">
                    {chapterItems[0].comicInfo.summary}
                  </p>
                )}
                <div
                  className="comic-work-chapters"
                  ref={chaptersScroll}
                  onScroll={(e) => setChapterTop(e.currentTarget.scrollTop)}
                >
                  <div
                    style={{
                      height: chapterItems.length * 56,
                      position: "relative",
                    }}
                  >
                    {chapterItems
                      .slice(
                        Math.floor(chapterTop / 56),
                        Math.floor(chapterTop / 56) + 14,
                      )
                      .map((entry, i) => {
                        const index = Math.floor(chapterTop / 56) + i;
                        return (
                          <div
                            className="comic-edit-chapter"
                            draggable
                            key={entry.id}
                            style={{ top: index * 56 }}
                            onDragStart={() => {
                              dragId.current = entry.id;
                            }}
                            onDragOver={(e) => e.preventDefault()}
                            onDrop={(e) => {
                              e.preventDefault();
                              if (dragId.current)
                                reorder(dragId.current, index);
                              dragId.current = undefined;
                            }}
                          >
                            <GripVertical size={14} />
                            <span title={entry.path}>
                              {index + 1}. {entry.title}
                              <small>
                                {stateLabels[comicReadState(entry.progress)]}
                              </small>
                            </span>
                            <IconButton
                              label={`上移 ${entry.title}`}
                              disabled={index === 0}
                              onClick={() => reorder(entry.id, index - 1)}
                            >
                              <ArrowUp size={14} />
                            </IconButton>
                            <IconButton
                              label={`下移 ${entry.title}`}
                              disabled={index === chapterItems.length - 1}
                              onClick={() => reorder(entry.id, index + 1)}
                            >
                              <ArrowDown size={14} />
                            </IconButton>
                            <IconButton
                              label={`移除章节 ${entry.title}`}
                              onClick={() =>
                                edit({
                                  chapterIds: work.chapterIds.filter(
                                    (id) => id !== entry.id,
                                  ),
                                })
                              }
                            >
                              <X size={14} />
                            </IconButton>
                          </div>
                        );
                      })}
                  </div>
                </div>
                {!chapterItems.length && (
                  <p className="comic-library-hint">
                    在“本地漫画”中勾选章节。文件已属于其他作品时，保存会将其移入当前作品。
                  </p>
                )}
                <footer>
                  <button
                    className="text-button danger"
                    disabled={busy}
                    onClick={() => setDeleteWork(work)}
                  >
                    <Trash2 size={15} />
                    删除作品分组
                  </button>
                  <button
                    className="button primary"
                    disabled={busy || !work.title.trim() || !dirty}
                    onClick={() => void save()}
                  >
                    {busy ? "保存中…" : "保存作品"}
                  </button>
                </footer>
              </>
            ) : (
              <div className="comic-library-hint">
                <BookOpen size={32} />
                <p>选择作品查看章节，或从待整理目录创建作品。</p>
                <p>分组和排序只保存在应用中。</p>
              </div>
            )}
          </section>
        </div>
      )}
      {pendingWork !== undefined && (
        <Modal
          title="有未保存的作品修改"
          close={() => setPendingWork(undefined)}
        >
          <div className="comic-confirm">
            <p>离开会丢弃本次分组和排序修改。</p>
            <button
              className="button"
              onClick={() => setPendingWork(undefined)}
            >
              继续编辑
            </button>
            <button
              className="button"
              onClick={() => {
                if (pendingWork === null) close();
                else {
                  setWork(pendingWork);
                  setDirty(!works.some((w) => w.id === pendingWork.id));
                  setChapterTop(0);
                }
                setPendingWork(undefined);
              }}
            >
              丢弃修改
            </button>
          </div>
        </Modal>
      )}
      {deleteWork && (
        <Modal title="删除作品分组？" close={() => setDeleteWork(undefined)}>
          <div className="comic-confirm">
            <p>章节文件、收藏、书签和进度会保留。</p>
            <button className="button" onClick={() => setDeleteWork(undefined)}>
              取消
            </button>
            <button
              className="button"
              onClick={() => {
                void window.media
                  .deleteComicWork(deleteWork.id)
                  .then(async () => {
                    setWork(undefined);
                    setDirty(false);
                    setDeleteWork(undefined);
                    await load();
                  })
                  .catch(report);
              }}
            >
              删除分组
            </button>
          </div>
        </Modal>
      )}
    </Modal>
  );
}
