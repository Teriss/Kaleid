import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  Image,
  Music2,
  Film,
  BookOpen,
  PanelsTopLeft,
  Heart,
  Play,
  FolderOpen,
  X,
  Check,
  Plus,
  MoreHorizontal,
  ArrowUpRight,
} from "lucide-react";
import type { Library, MediaItem, MediaType } from "../../shared/types";
import { act, bytes, report, resource, time, useApp } from "./store";

export const TYPES = [
  {
    id: "image",
    name: "图片",
    plural: "每一帧，皆是风景",
    icon: Image,
    color: "#a9c6b1",
    en: "PHOTOGRAPHS",
  },
  {
    id: "music",
    name: "音乐",
    plural: "让旋律陪伴此刻",
    icon: Music2,
    color: "#c6b3ed",
    en: "SOUND & SOUL",
  },
  {
    id: "video",
    name: "视频",
    plural: "故事，正在发生",
    icon: Film,
    color: "#cda990",
    en: "MOTION PICTURES",
  },
  {
    id: "novel",
    name: "小说",
    plural: "翻开另一个世界",
    icon: BookOpen,
    color: "#d5c49b",
    en: "BETWEEN THE LINES",
  },
  {
    id: "comic",
    name: "漫画",
    plural: "在画格之间漫游",
    icon: PanelsTopLeft,
    color: "#a8bfd8",
    en: "PANEL BY PANEL",
  },
] as const;
export function typeInfo(type: MediaType) {
  return TYPES.find((t) => t.id === type)!;
}
export function IconButton({
  children,
  label,
  onClick,
  active = false,
  disabled = false,
}: {
  children: ReactNode;
  label: string;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      className={`icon-button ${active ? "active" : ""}`}
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
export function Modal({
  title,
  subtitle,
  children,
  close,
  className = "",
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  close(): void;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const closing = useRef(false);
  const reducedMotion = useApp((state) => state.settings.reducedMotion);
  const closeAnimated = () => {
    if (closing.current) return;
    closing.current = true;
    if (reducedMotion || !ref.current) {
      close();
      return;
    }
    const dialog = ref.current;
    dialog.classList.add("is-closing");
    void dialog
      .animate(
        [
          { opacity: 1, transform: "translateY(0) scale(1)" },
          { opacity: 0, transform: "translateY(5px) scale(.99)" },
        ],
        { duration: 140, fill: "forwards", easing: "ease-in" },
      )
      .finished.catch(() => {})
      .then(close);
  };
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    if (!reducedMotion)
      dialog.animate(
        [
          { opacity: 0, transform: "translateY(6px) scale(.99)" },
          { opacity: 1, transform: "translateY(0) scale(1)" },
        ],
        { duration: 160, easing: "ease-out" },
      );
    if (dialog.classList.contains("settings-modal")) dialog.focus();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      tabIndex={-1}
      className={`modal ${className}`}
      onCancel={(event) => {
        event.preventDefault();
        closeAnimated();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) closeAnimated();
      }}
    >
      <header>
        <div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <IconButton label="关闭" onClick={closeAnimated}>
          <X size={20} />
        </IconButton>
      </header>
      {children}
    </dialog>
  );
}
export function LibraryModal({
  close,
  initialType = "image",
  library,
  onSaved,
}: {
  close(): void;
  initialType?: MediaType;
  library?: Library;
  onSaved?(library: Library): void;
}) {
  const [type, setType] = useState<MediaType>(library?.type ?? initialType);
  const [name, setName] = useState(library?.name ?? "");
  const [roots, setRoots] = useState<string[]>(library?.roots ?? []);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  async function choose() {
    try {
      const selected = await window.media.chooseFolders();
      setRoots((current) => [...new Set([...current, ...selected])]);
    } catch (error) {
      report(error);
    }
  }
  async function submit() {
    setBusy(true);
    try {
      let saved = library;
      if (library) {
        await window.media.renameLibrary(library.id, name);
        const added = roots.filter((r) => !library.roots.includes(r));
        if (added.length) await window.media.addRoots(library.id, added);
        for (const root of library.roots.filter((r) => !roots.includes(r)))
          await window.media.removeRoot(library.id, root);
        await window.media.scan(library.id);
      } else {
        const created = await window.media.createLibrary({
          name: name.trim(),
          type,
          roots,
        });
        await window.media.scan(created.id);
        saved = created;
      }
      await useApp.getState().refresh();
      if (saved && onSaved) onSaved(saved);
      else close();
    } catch (error) {
      report(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={library ? "管理媒体库" : "新建媒体库"} close={close}>
      <label className="field-label">媒体类型</label>
      <div className="type-picker">
        {TYPES.map((t) => (
          <button
            key={t.id}
            disabled={Boolean(library)}
            className={type === t.id ? "chosen" : ""}
            onClick={() => setType(t.id)}
          >
            <t.icon size={22} />
            <span>{t.name}</span>
          </button>
        ))}
      </div>
      <label className="field-label" htmlFor="library-name">
        媒体库名称
      </label>
      <input
        id="library-name"
        maxLength={80}
        autoFocus
        placeholder="媒体库名称"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <div className="label-row">
        <label className="field-label">来源文件夹</label>
        <button className="text-button" onClick={choose}>
          <Plus size={14} />
          添加文件夹
        </button>
      </div>
      <div className="root-list">
        {roots.length ? (
          roots.map((root) => (
            <div key={root}>
              <FolderOpen size={17} />
              <span title={root}>{root}</span>
              <IconButton
                label={`移除来源 ${root}`}
                onClick={() => setRoots(roots.filter((r) => r !== root))}
              >
                <X size={15} />
              </IconButton>
            </div>
          ))
        ) : (
          <button className="folder-drop" onClick={choose}>
            <FolderOpen size={30} />
            <strong>选择本地文件夹</strong>
            <span>可以添加多个文件夹 · 不复制或上传文件</span>
          </button>
        )}
      </div>
      {type === "comic" && (
        <p className="form-note">
          每个包含图片的文件夹作为一本漫画，也支持 CBZ 压缩包。
        </p>
      )}
      {confirmRemove && (
        <div className="inline-confirm">
          仅移除媒体库与索引关系，源文件不会删除。
          <button
            className="danger-text"
            onClick={() =>
              void act(async () => {
                await window.media.removeLibrary(library!.id);
                await useApp.getState().refresh();
                close();
              })
            }
          >
            确认移除
          </button>
        </div>
      )}
      <footer>
        {library && (
          <button
            className="danger-text"
            onClick={() => setConfirmRemove(true)}
          >
            移除媒体库
          </button>
        )}
        <span className="spacer" />
        <button className="button secondary" onClick={close}>
          取消
        </button>
        <button
          className="button primary"
          disabled={busy || !name.trim() || !roots.length}
          onClick={() => void submit()}
        >
          <Check size={16} />
          {busy ? "保存中…" : library ? "保存并扫描" : "创建媒体库"}
        </button>
      </footer>
    </Modal>
  );
}
export function Cover({
  item,
  className = "",
}: {
  item: MediaItem;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const info = typeInfo(item.type);
  useEffect(() => setFailed(false), [item.id, item.cover]);
  return (
    <div
      className={`cover ${className} cover-${item.type}`}
      style={{ "--media-color": info.color } as React.CSSProperties}
    >
      {item.cover && !failed ? (
        <img
          draggable={false}
          loading="lazy"
          decoding="async"
          src={resource(item, "cover")}
          alt=""
          onError={() => setFailed(true)}
        />
      ) : (
        <div className="cover-fallback">
          <info.icon
            size={item.type === "novel" || item.type === "comic" ? 36 : 42}
            strokeWidth={1}
          />
        </div>
      )}
    </div>
  );
}
export function MediaCard({
  item,
  open,
  favorite,
}: {
  item: MediaItem;
  open(): void;
  favorite(): void;
}) {
  const info = typeInfo(item.type);
  const notify = useApp((s) => s.notify);
  return (
    <article
      data-cover={item.cover ? resource(item, "cover") : ""}
      className={`media-card type-${item.type} ${item.missing ? "unavailable" : ""}`}
    >
      <button
        className="cover-button"
        onClick={open}
        aria-label={`打开 ${item.title}`}
      >
        <Cover item={item} />
        <div className="cover-shade" />
        <span className="open-bubble">
          {item.type === "music" || item.type === "video" ? (
            <Play size={22} fill="currentColor" />
          ) : (
            <ArrowUpRight size={23} />
          )}
        </span>
        {item.type === "video" && item.duration && (
          <span className="duration-badge">{time(item.duration)}</span>
        )}
        {item.missing && <span className="missing-badge">文件不可用</span>}
      </button>
      <button
        className={`favorite-bubble ${item.favorite ? "is-favorite" : ""}`}
        title={item.favorite ? "取消收藏" : "收藏"}
        aria-label={
          item.favorite ? `取消收藏 ${item.title}` : `收藏 ${item.title}`
        }
        onClick={favorite}
      >
        <Heart size={15} fill={item.favorite ? "currentColor" : "none"} />
      </button>
      <div className="card-caption">
        <button onClick={open} title={item.title}>
          {item.title}
        </button>
        <p>
          {item.artist ||
            `${info.name} · ${item.ext === "folder" ? "图片文件夹" : item.ext.toUpperCase()}`}
        </p>
      </div>
      <button
        className="card-more"
        title="在文件夹中显示"
        aria-label={`显示 ${item.title} 的位置`}
        onClick={() =>
          void window.media.reveal(item.id).catch((error) => {
            notify(String(error), "error");
          })
        }
      >
        <MoreHorizontal size={17} />
      </button>
    </article>
  );
}
export function MediaRow({
  item,
  open,
  favorite,
  selected = false,
  select,
  contextMenu,
  removeRecent,
}: {
  item: MediaItem;
  open(): void;
  favorite(): void;
  selected?: boolean;
  select?(event: ReactMouseEvent): void;
  contextMenu?(event: ReactMouseEvent): void;
  removeRecent?(): void;
}) {
  return (
    <div
      className={`media-row ${selected ? "is-selected" : ""} ${item.kind === "folder" ? "directory-row" : ""}`}
      data-media-id={item.id}
      onContextMenu={(event) => contextMenu?.(event)}
    >
      <button
        className="row-open"
        onDragStart={(event) => event.preventDefault()}
        onClick={(event) => {
          select?.(event);
          if (item.kind) open();
        }}
        onDoubleClick={() => {
          if (!item.kind) open();
        }}
      >
        <span className="row-cover-wrap">
          <Cover item={item} />
          {item.kind === "folder" && (
            <span className="folder-corner">
              <FolderOpen size={12} />
            </span>
          )}
        </span>
        <span>
          <strong>{item.title}</strong>
          <small>
            {item.kind === "folder"
              ? `${item.folderCount ?? 0} 项`
              : item.artist || item.folder}
          </small>
        </span>
      </button>
      <span className="row-album">
        {item.kind === "folder"
          ? "文件夹"
          : item.album || item.ext.toUpperCase()}
      </span>
      <span className="row-size">{bytes(item.size)}</span>
      <span className="row-duration">
        {item.duration ? time(item.duration) : "—"}
      </span>
      {removeRecent && (
        <IconButton
          label={`从历史记录移除 ${item.title}`}
          onClick={removeRecent}
        >
          <X size={15} />
        </IconButton>
      )}
      {!item.kind && (
        <IconButton
          label={item.favorite ? "取消收藏" : "收藏"}
          active={item.favorite}
          onClick={favorite}
        >
          <Heart size={16} fill={item.favorite ? "currentColor" : "none"} />
        </IconButton>
      )}
    </div>
  );
}
