import { useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, ListFilter, Search, X } from "lucide-react";
import { useApp } from "../store";
import "../music/music-wall.css";

export interface WallFilter {
  query: string;
  update(value: string): void;
  total: number;
  loaded: number;
  originalTotal: number;
}
export const openWallSearch = (mode = "filter") =>
  window.dispatchEvent(new CustomEvent("wall:search", { detail: mode }));

export default function WallMenu({
  identity,
  title,
  music = false,
  online = false,
  filter,
  submit,
  children,
}: {
  identity: string;
  title: string;
  music?: boolean;
  online?: boolean;
  filter: WallFilter;
  submit(value: string): void;
  children: ReactNode;
}) {
  const reduced = useApp((s) => s.settings.reducedMotion);
  const [open, setOpen] = useState(false),
    [mode, setMode] = useState("filter");
  const [draft, setDraft] = useState(""),
    [query, setQuery] = useState(filter.query);
  const composing = useRef(false),
    input = useRef<HTMLInputElement>(null);
  const presentation = (value: boolean) =>
    window.dispatchEvent(
      new CustomEvent("wall:search-presentation", { detail: value }),
    );
  const close = () => {
    composing.current = false;
    setOpen(false);
    presentation(false);
  };
  useEffect(() => {
    const show = (event: Event) => {
      setMode((event as CustomEvent).detail === "filter" ? "filter" : "search");
      setOpen(true);
      presentation(true);
    };
    window.addEventListener("wall:search", show);
    const dismiss = () => {
      composing.current = false;
      setOpen(false);
    };
    window.addEventListener("wall:search-dismiss", dismiss);
    return () => {
      window.removeEventListener("wall:search", show);
      window.removeEventListener("wall:search-dismiss", dismiss);
      presentation(false);
    };
  }, []);
  useEffect(() => {
    close();
    setQuery("");
  }, [identity]);
  useEffect(() => {
    if (!composing.current) setQuery(filter.query);
  }, [filter.query]);
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.isComposing ||
        document.querySelector("dialog[open]") ||
        event.target instanceof HTMLInputElement
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
    };
    document.addEventListener("keydown", escape, true);
    return () => document.removeEventListener("keydown", escape, true);
  }, [open]);
  function attachInput(node: HTMLInputElement | null) {
    input.current = node;
    if (node)
      requestAnimationFrame(
        () => node.isConnected && node.focus({ preventScroll: true }),
      );
  }
  return (
    <section
      className={`music-wall-menu ${open ? "is-search" : ""}`}
      aria-label={music ? "音乐墙面菜单" : "墙面菜单"}
    >
      <AnimatePresence initial={false} mode="wait">
        <motion.div
          className="music-wall-face"
          key={open ? "search" : "home"}
          initial={reduced ? { opacity: 0 } : { rotateY: -90 }}
          animate={reduced ? { opacity: 1 } : { rotateY: 0 }}
          exit={reduced ? { opacity: 0 } : { rotateY: 90 }}
          transition={{ duration: reduced ? 0.09 : 0.18 }}
        >
          {open ? (
            <>
              <header>
                <button
                  aria-label={music ? "关闭音乐搜索菜单" : "关闭墙面搜索菜单"}
                  onClick={close}
                >
                  <ArrowLeft size={16} />
                </button>
                <strong>{title} › 搜索</strong>
              </header>
              <div className="music-search-tabs">
                <button
                  className={mode === "filter" ? "active" : ""}
                  onClick={() => setMode("filter")}
                >
                  <ListFilter size={16} />
                  过滤当前视图
                </button>
                <button
                  className={mode === "search" ? "active" : ""}
                  onClick={() => setMode("search")}
                >
                  <Search size={16} />
                  {online ? "搜索在线平台" : "搜索当前媒体库"}
                </button>
              </div>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (mode === "search" && draft.trim()) {
                    close();
                    submit(draft.trim());
                  }
                }}
              >
                <label className="music-wall-search-field">
                  <Search size={18} />
                  <input
                    ref={attachInput}
                    aria-label={
                      mode === "filter"
                        ? music
                          ? "过滤当前音乐视图"
                          : "过滤当前墙面"
                        : online
                          ? "搜索在线音乐平台"
                          : "搜索当前媒体库"
                    }
                    placeholder={
                      mode === "filter"
                        ? music
                          ? "过滤名称、歌手、专辑…"
                          : "过滤已加载的卡片…"
                        : "输入后按 Enter 搜索…"
                    }
                    value={mode === "filter" ? query : draft}
                    onCompositionStart={() => {
                      composing.current = true;
                    }}
                    onCompositionEnd={(event) => {
                      composing.current = false;
                      if (mode === "filter") {
                        setQuery(event.currentTarget.value);
                        filter.update(event.currentTarget.value);
                      }
                    }}
                    onChange={(event) => {
                      const value = event.target.value;
                      if (mode !== "filter") setDraft(value);
                      else {
                        setQuery(value);
                        if (!composing.current) filter.update(value);
                      }
                    }}
                    onKeyDown={(event) => {
                      if (event.nativeEvent.isComposing) return;
                      if (event.key === "Escape") {
                        event.preventDefault();
                        event.stopPropagation();
                        if (mode === "filter" && query) {
                          setQuery("");
                          filter.update("");
                        } else close();
                      }
                    }}
                  />
                  <button
                    type="button"
                    aria-label="清除搜索输入"
                    onClick={() => {
                      if (mode === "filter") {
                        setQuery("");
                        filter.update("");
                      } else setDraft("");
                      input.current?.focus();
                    }}
                  >
                    <X size={15} />
                  </button>
                </label>
                <p className="music-wall-search-hint">
                  {mode === "filter"
                    ? `匹配 ${filter.total} 项 · 当前已加载 ${filter.loaded} / ${filter.originalTotal} 项，不补抓数据。`
                    : online
                      ? "提交后在独立结果页搜索当前在线平台。"
                      : "提交后搜索当前媒体库的全部已索引内容。"}
                </p>
                {mode === "search" && (
                  <button type="submit" className="button secondary">
                    <Search size={16} />
                    搜索
                  </button>
                )}
              </form>
            </>
          ) : (
            children
          )}
        </motion.div>
      </AnimatePresence>
    </section>
  );
}
