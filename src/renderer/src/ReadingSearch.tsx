import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { ChevronDown, X } from "lucide-react";
import type {
  ReadingResultLayout,
  ReadingResultMode,
} from "../../shared/readingSearch";
export function useReadingSearchPanel(route: {
  section: string;
  remoteId?: string;
  mode?: string;
  sourceId?: string;
  pageId?: string;
}) {
  const [searchPanelVisible, setSearchPanelVisible] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null),
    searchPanel = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const clearSearchPanelHideTimer = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
  }, []);
  const scheduleSearchPanelAutoHide = useCallback(() => {
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = undefined;
      const panel = searchPanel.current;
      if (!panel?.matches(":hover") && !panel?.contains(document.activeElement))
        setSearchPanelVisible(false);
    }, 500);
  }, []);
  useEffect(() => {
    clearSearchPanelHideTimer();
    setSearchPanelVisible(false);
  }, [route.section, route.remoteId, route.mode, route.sourceId, route.pageId]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        route.mode === "single" &&
        searchPanelVisible &&
        !event.defaultPrevented &&
        !document.querySelector("dialog[open]")
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        clearSearchPanelHideTimer();
        setSearchPanelVisible(false);
        return;
      }

      if (
        route.section !== "search" ||
        route.remoteId ||
        !(event.ctrlKey || event.metaKey) ||
        event.key.toLowerCase() !== "f"
      )
        return;
      event.preventDefault();
      clearSearchPanelHideTimer();
      setSearchPanelVisible(true);
      requestAnimationFrame(() => searchInput.current?.focus());
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [
    route.section,
    route.remoteId,
    route.mode,
    searchPanelVisible,
    clearSearchPanelHideTimer,
  ]);
  useEffect(() => () => clearSearchPanelHideTimer(), []);
  const onSearchPointerMove = (event: {
    clientY: number;
    target: EventTarget | null;
  }) => {
    if (route.section !== "search" || route.remoteId || route.mode !== "single")
      return;
    if (event.clientY <= 42) {
      clearSearchPanelHideTimer();
      setSearchPanelVisible(true);
    } else if (searchPanelVisible) {
      const panel = searchPanel.current;
      if (panel?.matches(":hover") || panel?.contains(document.activeElement))
        clearSearchPanelHideTimer();
      else scheduleSearchPanelAutoHide();
    }
  };
  const onSearchPointerDown = (event: { target: EventTarget | null }) => {
    if (
      route.mode === "single" &&
      searchPanelVisible &&
      !searchPanel.current?.contains(event.target as Node)
    ) {
      clearSearchPanelHideTimer();
      setSearchPanelVisible(false);
    }
  };
  return {
    searchPanelVisible,
    setSearchPanelVisible,
    searchInput,
    searchPanel,
    clearSearchPanelHideTimer,
    scheduleSearchPanelAutoHide,
    onSearchPointerMove,
    onSearchPointerDown,
  };
}
export function ReadingSearchPanel({
  kind,
  mode,
  sourceName,
  query,
  change,
  submit,
  clear,
  hasQuery,
  canSearch,
  visible,
  inputRef,
  panelRef,
  sources,
  selected,
  select,
  extra,
  children,
}: {
  kind: string;
  mode: "single" | "aggregate";
  sourceName?: string;
  query: string;
  change(value: string): void;
  submit(): void;
  clear(): void;
  hasQuery: boolean;
  canSearch: boolean;
  visible: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  panelRef: RefObject<HTMLDivElement | null>;
  sources: { id: string; name: string }[];
  selected: string[];
  select(ids: string[]): void;
  extra?: ReactNode;
  children?: ReactNode;
}) {
  const all =
    sources.length > 0 && sources.every((s) => selected.includes(s.id));
  return (
    <div
      ref={panelRef}
      inert={mode === "single" && hasQuery && !visible}
      aria-hidden={mode === "single" && hasQuery && !visible}
      className={`comic-search-panel ${mode === "aggregate" || !hasQuery ? "is-inline is-visible" : visible ? "is-visible" : ""}`}
    >
      <div className="comic-search-panel-content">
        <form
          className="online-row comic-search-form"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <input
            ref={inputRef}
            aria-label={
              mode === "single" ? `搜索当前${kind}源` : `聚合搜索${kind}`
            }
            placeholder={
              mode === "single"
                ? `搜索 ${sourceName || "当前源"}`
                : `搜索所有已选${kind}源`
            }
            value={query}
            onChange={(event) => change(event.target.value)}
          />
          <button className="button primary" disabled={!canSearch}>
            搜索
          </button>
          {hasQuery && (
            <button type="button" className="text-button" onClick={clear}>
              清除
            </button>
          )}
        </form>
        {mode === "aggregate" && (
          <>
            <div
              className="comic-source-pills online-source-selector"
              aria-label={`参与聚合搜索的${kind}源`}
            >
              {sources.map((source) => (
                <label className="comic-source-check" key={source.id}>
                  <input
                    type="checkbox"
                    checked={selected.includes(source.id)}
                    onChange={(event) =>
                      select(
                        event.target.checked
                          ? [...new Set([...selected, source.id])]
                          : selected.filter((id) => id !== source.id),
                      )
                    }
                  />
                  {source.name}
                </label>
              ))}
              {!sources.length && (
                <span className="muted">还没有启用可搜索的{kind}源</span>
              )}
            </div>
            <label className="comic-aggregate-toggle comic-search-mode-toggle">
              <input
                type="checkbox"
                aria-label={all ? `取消全选${kind}源` : `全选${kind}源`}
                checked={all}
                disabled={!sources.length}
                onChange={(event) =>
                  select(event.target.checked ? sources.map((s) => s.id) : [])
                }
              />
              全选
            </label>
          </>
        )}
        {mode === "single" && extra}
        {children}
      </div>
    </div>
  );
}
export function ReadingSearchHistory({
  terms,
  collapsed,
  toggle,
  clear,
  remove,
  submit,
  disabled = false,
}: {
  terms: string[];
  collapsed: boolean;
  toggle(): void;
  clear(): void;
  remove(term: string): void;
  submit(term: string): void;
  disabled?: boolean;
}) {
  return (
    <section className="comic-search-history" aria-label="搜索历史">
      <div className="comic-search-history-heading">
        <button
          type="button"
          className="comic-search-history-toggle"
          aria-expanded={!collapsed}
          onClick={toggle}
        >
          <ChevronDown className={collapsed ? "is-collapsed" : ""} size={16} />
          <strong>搜索历史</strong>
          <span>{terms.length}</span>
        </button>
        <button
          type="button"
          className="text-button"
          disabled={!terms.length}
          onClick={clear}
        >
          清除全部
        </button>
      </div>
      {!collapsed &&
        (terms.length ? (
          <div className="comic-search-history-list">
            {terms.map((term) => (
              <div className="comic-search-history-item" key={term}>
                <button
                  type="button"
                  className="comic-search-history-term"
                  disabled={disabled}
                  onClick={() => submit(term)}
                >
                  {term}
                </button>
                <button
                  type="button"
                  className="comic-search-history-remove"
                  aria-label={`删除搜索历史：${term}`}
                  onClick={() => remove(term)}
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="comic-search-history-empty">暂无搜索历史</p>
        ))}
    </section>
  );
}
export function ReadingResultControls({
  layout,
  mode,
  changeLayout,
  changeMode,
}: {
  layout: ReadingResultLayout;
  mode: ReadingResultMode;
  changeLayout(layout: ReadingResultLayout): void;
  changeMode(mode: ReadingResultMode): void;
}) {
  return (
    <div className="comic-result-controls">
      <label>
        布局
        <select
          aria-label="单源结果布局"
          value={layout}
          onChange={(event) =>
            changeLayout(event.target.value as ReadingResultLayout)
          }
        >
          <option value="grid">标准网格</option>
          <option value="archiveShelf">立体书架</option>
          <option value="carousel">封面流</option>
        </select>
      </label>
      <label>
        结果
        <select
          aria-label="结果加载方式"
          value={mode}
          onChange={(event) =>
            changeMode(event.target.value as ReadingResultMode)
          }
        >
          <option value="pagination">分页</option>
          <option value="waterfall">瀑布流</option>
        </select>
      </label>
    </div>
  );
}

export function ReadingPagination({
  page,
  maxPage,
  busy,
  hasMore,
  jump,
  changeJump,
  go,
}: {
  page: number;
  maxPage?: number;
  busy: boolean;
  hasMore: boolean;
  jump?: string;
  changeJump?(value: string): void;
  go(page: number): void;
}) {
  return (
    <footer className="online-pagination">
      <button
        className="button secondary"
        disabled={busy || page <= 1}
        onClick={() => go(page - 1)}
      >
        上一页
      </button>
      <span>
        第 {page} 页{maxPage ? ` / ${maxPage}` : ""}
      </span>
      {changeJump && (
        <form
          className="comic-page-jump"
          onSubmit={(event) => {
            event.preventDefault();
            const target = Math.max(1, Math.floor(Number(jump) || 1));
            go(maxPage ? Math.min(target, maxPage) : target);
          }}
        >
          <label>
            跳至
            <input
              type="number"
              min="1"
              max={maxPage}
              value={jump || ""}
              onChange={(event) => changeJump(event.target.value)}
              aria-label="跳转到搜索结果页"
            />
            页
          </label>
          <button className="button secondary" disabled={busy || !jump}>
            跳转
          </button>
        </form>
      )}
      <button
        className="button secondary"
        disabled={busy || !hasMore}
        onClick={() => go(page + 1)}
      >
        下一页
      </button>
    </footer>
  );
}

type WaterfallState = {
  startPage: number;
  endPage: number;
  cards: unknown[];
  maxPage?: number;
  busy: boolean;
  jumpPage: string;
  loadingOperation?: string;
  error: string;
  beforeError: string;
  afterError: string;
  beforePaused: boolean;
  afterPaused: boolean;
  jumpError: string;
  failedPage?: number;
};
export function ReadingWaterfallStart({
  state,
  load,
}: {
  state: WaterfallState;
  load(): void;
}) {
  return (
    <div className="comic-waterfall-start" role="status">
      {state.startPage > 1 && (
        <>
          {state.loadingOperation === "prepend" ? (
            <span>正在加载上一页…</span>
          ) : (
            (state.beforeError || state.beforePaused) && (
              <button
                className="text-button"
                disabled={state.busy}
                onClick={load}
              >
                {state.beforeError
                  ? "重试加载上一页"
                  : "上一页无新增结果，继续向前加载"}
              </button>
            )
          )}
          {state.beforeError && <span role="alert">{state.beforeError}</span>}
        </>
      )}
    </div>
  );
}
export function ReadingWaterfallControls({
  state,
  hasMore,
  changeJump,
  go,
  load,
}: {
  state: WaterfallState;
  hasMore: boolean;
  changeJump(value: string): void;
  go(page: number): void;
  load(): void;
}) {
  const locating = state.loadingOperation === "jump";
  return (
    <div className="comic-waterfall-status" role="status">
      <span>{`已加载第 ${state.startPage}–${state.endPage} 页${state.maxPage != null ? ` / ${state.maxPage}` : "（总页数未知）"}，共 ${state.cards.length} 条${!hasMore ? (state.startPage === 1 ? " · 已加载全部结果" : " · 已到末页") : ""}`}</span>
      {state.busy && <span>{locating ? "正在定位…" : "正在加载…"}</span>}
      {state.afterError && (
        <span role="alert" title={state.afterError}>
          {state.afterError}
        </span>
      )}
      {hasMore && (state.afterError || state.afterPaused) && (
        <button className="text-button" disabled={state.busy} onClick={load}>
          {state.afterError ? "重试加载" : "本页无新增结果，继续加载"}
        </button>
      )}
      <form
        className="comic-page-jump"
        onSubmit={(event) => {
          event.preventDefault();
          const page = Math.max(1, Math.floor(Number(state.jumpPage) || 1));
          go(state.maxPage ? Math.min(page, state.maxPage) : page);
        }}
      >
        <label>
          跳至{" "}
          <input
            type="number"
            min="1"
            max={state.maxPage}
            value={state.jumpPage}
            aria-label="跳转到搜索结果页"
            onChange={(event) => changeJump(event.target.value)}
          />{" "}
          页
        </label>
        <button className="button secondary" disabled={!state.jumpPage}>
          跳转
        </button>
      </form>
      {state.jumpError && (
        <>
          <span role="alert">{state.jumpError}</span>
          <button
            className="text-button"
            disabled={state.busy}
            onClick={() => go(state.failedPage ?? Number(state.jumpPage))}
          >
            重试定位
          </button>
        </>
      )}
    </div>
  );
}
