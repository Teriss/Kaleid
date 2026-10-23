import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowDownUp,
  BookmarkPlus,
  BookOpen,
  Check,
  ChevronDown,
  Circle,
  Clock3,
  Compass,
  Download,
  FileUp,
  FolderDown,
  GripVertical,
  Heart,
  Home as HomeIcon,
  LoaderCircle,
  Plus,
  RefreshCw,
  Search,
  Shapes,
  X,
} from "lucide-react";
import type { BrowseLocation } from "../../shared/navigation";
import type { NavigationMode } from "../../shared/navigation";
import type { BrowseMemory, MediaItem } from "../../shared/types";
import type {
  ComicDownloadTask,
  ComicFollowState,
  ComicHubRef,
  ComicRepositoryEntry,
  ComicSearchPage,
  ComicSourceInfo,
  ComicUIRequest,
  OnlineComic,
  OnlineComicDetails,
  SourceOption,
} from "../../shared/onlineComics";
import { DEFAULT_COMIC_REPOSITORY } from "../../shared/onlineComics";
import { formatOnlineComicError as formatComicError } from "../../shared/onlineComicErrors";
import { IconButton, Modal } from "./components";
import { report, useApp } from "./store";
import ComicViewer from "./ComicViewer";
import BravaisWall from "./layouts/BravaisWall";
import { Cover } from "./components";
import { ContentNavigationContext } from "./layouts/ContentNavigation";
import { PagedMediaSource } from "./layouts/source";
import { ReadingHubCards, ReadingHubMenu, ReadingPageShell, ReadingResults, ReadingDetailHero, ReadingDetailSkeleton as ComicDetailSkeleton, HomeSectionToggle } from "./ReadingHub";
import { useReadingSearchPanel, ReadingSearchPanel, ReadingSearchHistory, ReadingResultControls, ReadingPagination } from "./ReadingSearch";
import { emptyReadingSearchPage, readingResultModePatch, loadReadingSearchPage, searchSourcePool, type ReadingSearchPage } from "../../shared/readingSearch";
import "./onlineComics.css";

const api = () => window.media.onlineComics;
const hub = () => window.media.comicHub;
const COMIC_SEARCH_HISTORY_KEY = "comic:search-history";
const COMIC_SEARCH_HISTORY_COLLAPSED_KEY = "comic:search-history-collapsed";
const MAX_COMIC_SEARCH_HISTORY = 30;
const optionValue = (o: any) =>
  typeof o === "string"
    ? o.slice(0, o.lastIndexOf("-") < 0 ? o.length : o.lastIndexOf("-"))
    : String(o.value ?? "");
// Venera passes multi-select selections to source scripts as a JSON string,
// even when the source declares its default as a string array. Keep that
// contract consistent for both interactive and aggregate searches.
const sourceOptionDefault = (spec: SourceOption) => {
  const value =
    spec.default ??
    (spec.type === "multi-select"
      ? []
      : optionValue(spec.options?.[0] || ""));
  if (spec.type !== "multi-select") return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return JSON.stringify(Array.isArray(parsed) ? parsed : [parsed]);
    } catch {
      return JSON.stringify([value]);
    }
  }
  return JSON.stringify(Array.isArray(value) ? value : []);
};
const optionText = (o: any) =>
  typeof o === "string"
    ? o.includes("-")
      ? o.slice(o.lastIndexOf("-") + 1)
      : o
    : o.text || o.value;
const mapEntries = (value: any): [string, any][] =>
  value?.$map || Object.entries(value || {});

type HubCardItem = OnlineComic | MediaItem;
type AggregateSearchGroup = {
  source: ComicSourceInfo;
  comics: OnlineComic[];
};
type AggregateSearchFailure = {
  source: ComicSourceInfo;
  error: string;
};
type ComicTransitionRect = Pick<DOMRect, "left" | "top" | "width" | "height">;
type ComicCardOrigin = {
  identity: string;
  cover: string;
  rect: ComicTransitionRect;
};
type ComicDetailPreview = {
  identity: string;
  sourceId: string;
  comicId: string;
  title: string;
  cover: string;
  sourceName: string;
  origin?: ComicTransitionRect;
};
type ComicDetailRecord = {
  key: string;
  status: "loading" | "ready" | "error";
  details?: OnlineComicDetails;
  error?: string;
};
type SingleSearchPageState = ReadingSearchPage<OnlineComic, ComicSearchPage>;
const emptySingleSearchPage = (defaults: Partial<SingleSearchPageState> = {}) => emptyReadingSearchPage<OnlineComic, ComicSearchPage>(defaults);
function singleSearchPageDefaults(sourceId: string | undefined, query: string, options: unknown[] = []) {
  let resultLayout: SingleSearchPageState["resultLayout"] = "grid";
  let resultMode: SingleSearchPageState["resultMode"] = "pagination";
  if (sourceId) {
    try {
      const stored = JSON.parse(localStorage.getItem(`comic:single-result:${sourceId}`) || "{}");
      if (["grid", "archiveShelf", "carousel"].includes(stored.layout))
        resultLayout = stored.layout;
      if (stored.mode === "waterfall") resultMode = "waterfall";
    } catch {}
  }
  return emptySingleSearchPage({ query, options, resultLayout, resultMode });
}
function makeSingleSearchRequestKey(pageId: string, sourceId: string, query: string) {
  return JSON.stringify([pageId, sourceId, query]);
}
function newComicSearchId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
function comicId(item: HubCardItem) {
  return "sourceId" in item
    ? `online:${item.sourceId}:${item.comicId}`
    : `local:${item.id}`;
}
function isOnlineComic(item: HubCardItem): item is OnlineComic {
  return "sourceId" in item;
}
function ComicCards({
  items,
  open,
  toggleLater,
  laterIds,
  large = false,
}: {
  items: HubCardItem[];
  open(item: HubCardItem): void;
  toggleLater?: (item: HubCardItem, value: boolean) => void;
  laterIds?: Set<string>;
  large?: boolean;
}) {
  return <ReadingHubCards items={items} identity={comicId} title={item => item.title}
    cover={item => isOnlineComic(item) ? (item.cover ? <img src={item.cover} alt="" /> : <span />) : <Cover item={item} />}
    open={open} toggleLater={toggleLater} isLater={item => !!laterIds?.has(comicId(item))}
    transitionId={item => isOnlineComic(item) ? `comic-online-card:${item.sourceId}:${item.comicId}` : undefined}
    empty="暂无漫画" large={large} />;
}

const refOf = (c: OnlineComic) => ({
  sourceId: c.sourceId,
  comicId: c.comicId,
});
const COMIC_MENU_ITEMS = [
  { section: "home", label: "首页", Icon: HomeIcon },
  { section: "favorites", label: "本地收藏", Icon: Heart },
  { section: "discover", label: "发现", Icon: Compass },
  { section: "categories", label: "分类", Icon: Shapes },
  { section: "search", label: "搜索", Icon: Search },
  { section: "readLater", label: "稍后阅读", Icon: Clock3 },
  { section: "following", label: "追更", Icon: BookmarkPlus },
  { section: "downloads", label: "已下载", Icon: FolderDown },
];

function SourceOptions({
  specs,
  values,
  change,
}: {
  specs: SourceOption[];
  values: unknown[];
  change(values: unknown[]): void;
}) {
  return (
    <>
      {specs.map((spec, index) => (
        <label className="online-option" key={index}>
          {spec.label || "筛选"}
          <select
            aria-label={spec.label || "筛选"}
            multiple={spec.type === "multi-select"}
            value={
              spec.type === "multi-select"
                ? (() => {
                    try {
                      return JSON.parse(String(values[index] || "[]"));
                    } catch {
                      return [];
                    }
                  })()
                : String(
                    values[index] ??
                      spec.default ??
                      optionValue(spec.options?.[0] || ""),
                  )
            }
            onChange={(e) => {
              const next = [...values];
              next[index] =
                spec.type === "multi-select"
                  ? JSON.stringify(
                      [...e.target.selectedOptions].map((o) => o.value),
                    )
                  : e.target.value;
              change(next);
            }}
          >
            {(spec.options || []).map((o, i) => (
              <option key={i} value={optionValue(o)}>
                {optionText(o)}
              </option>
            ))}
          </select>
        </label>
      ))}
    </>
  );
}

export function ComicSourceDialogs({ pageKey }: { pageKey: string }) {
  const [requests, setRequests] = useState<ComicUIRequest[]>([]);
  const [value, setValue] = useState("");
  const requestsRef = useRef(requests);
  requestsRef.current = requests;
  const pageKeyRef = useRef(pageKey);
  useEffect(() => {
    if (pageKeyRef.current === pageKey) return;
    pageKeyRef.current = pageKey;
    const pending = requestsRef.current;
    requestsRef.current = [];
    setRequests([]);
    for (const request of pending)
      void api()
        .respondUI(request.id, request.kind === "showLoading" ? true : null)
        .catch(report);
  }, [pageKey]);
  useEffect(
    () => () => {
      for (const request of requestsRef.current)
        void api()
          .respondUI(request.id, request.kind === "showLoading" ? true : null)
          .catch(report);
    },
    [],
  );
  useEffect(
    () =>
      api().onUI((request) => {
        if (request.kind === "dismiss")
          setRequests((list) => list.filter((item) => item.id !== request.id));
        else if (request.kind === "message")
          useApp.getState().notify(request.message || "漫画源消息");
        else setRequests((list) => [...list, request]);
      }),
    [],
  );
  const request = pageKeyRef.current === pageKey ? requests[0] : undefined;
  useEffect(() => setValue(""), [request?.id]);
  if (!request) return null;
  const activeRequest = request;
  function respond(result: unknown) {
    void api().respondUI(activeRequest.id, result).catch(report);
    setRequests((list) => list.slice(1));
  }
  return (
    <Modal
      key={activeRequest.id}
      title={activeRequest.title || "漫画源"}
      dismissible={
        activeRequest.kind !== "showLoading" || activeRequest.cancelable === true
      }
      close={() => {
        if (activeRequest.kind !== "showLoading" || activeRequest.cancelable)
          respond(activeRequest.kind === "showLoading" ? true : null);
      }}
      className="comic-source-dialog"
    >
      {activeRequest.kind === "showLoading" && (
        <div className="online-loading">
          <LoaderCircle className="spin" />
          处理中…
          {activeRequest.cancelable && (
            <button className="button" onClick={() => respond(true)}>
              取消
            </button>
          )}
        </div>
      )}
      {activeRequest.content && <p className="online-prewrap">{activeRequest.content}</p>}
      {activeRequest.image && (
        <img
          className="online-captcha"
          src={activeRequest.image}
          alt="登录验证图片"
        />
      )}
      {activeRequest.kind === "showInputDialog" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            respond(value);
          }}
        >
          <input
            aria-label="漫画源输入"
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <footer>
            <button type="submit" className="button primary">
              确定
            </button>
          </footer>
        </form>
      )}
      {activeRequest.kind === "showSelectDialog" &&
        activeRequest.options?.map((o, i) => (
          <button className="button" key={i} onClick={() => respond(i)}>
            {o}
          </button>
        ))}
      {activeRequest.kind === "showDialog" && (
        <footer>
          {activeRequest.actions?.map((action, index) => (
            <button
              key={index}
              className={`button ${action.style === "filled" ? "primary" : "secondary"}`}
              onClick={() => respond(index)}
            >
              {action.text}
            </button>
          ))}
          {!activeRequest.actions?.length && (
            <button className="button" onClick={() => respond(null)}>
              关闭
            </button>
          )}
        </footer>
      )}
    </Modal>
  );
}

function SourceImportDialog({
  sources,
  close,
  refresh,
}: {
  sources: ComicSourceInfo[];
  close(): void;
  refresh(): Promise<void>;
}) {
  const [repositories, setRepositories] = useState<string[]>([]);
  const [address, setAddress] = useState(DEFAULT_COMIC_REPOSITORY);
  const [entries, setEntries] = useState<ComicRepositoryEntry[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<Record<string, { state: "installing" | "failed" | "imported"; error?: string }>>({});
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    void api().repositories().then(setRepositories).catch((reason) => setError(formatComicError(reason)));
  }, []);

  const installedEntry = (entry: ComicRepositoryEntry) =>
    sources.find((source) => source.url === entry.url || (entry.key && source.key === entry.key));
  const toggleAll = (checked: boolean) => {
    setSelected((old) => {
      const next = new Set(old);
      for (const entry of entries) {
        if (installedEntry(entry)) next.delete(entry.url);
        else if (checked) next.add(entry.url);
        else next.delete(entry.url);
      }
      return next;
    });
  };
  const loadAddress = async (value = address) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api().openAddress(value.trim());
      if (result.kind === "repository") {
        setEntries(result.entries);
        setSelected(new Set(result.entries.filter((entry) => !installedEntry(entry)).map((entry) => entry.url)));
        setStatus({});
        setNotice(`已读取仓库，共 ${result.entries.length} 个源；未导入的源已默认勾选。`);
      } else {
        setEntries([]);
        setSelected(new Set());
        setNotice(`已导入漫画源：${result.source.name}`);
        await refresh();
      }
      setRepositories(await api().repositories());
    } catch (reason) {
      setError(formatComicError(reason));
    } finally {
      setBusy(false);
    }
  };
  const installOne = async (entry: ComicRepositoryEntry) => {
    setStatus((old) => ({ ...old, [entry.url]: { state: "installing" } }));
    setError("");
    try {
      await api().install(entry.url);
      setStatus((old) => ({ ...old, [entry.url]: { state: "imported" } }));
      setSelected((old) => {
        const next = new Set(old);
        next.delete(entry.url);
        return next;
      });
      await refresh();
    } catch (reason) {
      setStatus((old) => ({ ...old, [entry.url]: { state: "failed", error: formatComicError(reason) } }));
    }
  };
  const installSelected = async () => {
    const pending = entries.filter((entry) => selected.has(entry.url) && !installedEntry(entry));
    if (!pending.length || busy) return;
    setBusy(true);
    for (const entry of pending) await installOne(entry);
    await refresh();
    setBusy(false);
  };
  const importFile = async () => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const source = await api().importFile();
      if (source) {
        setNotice(`已导入漫画源：${source.name}`);
        await refresh();
      }
    } catch (reason) {
      setError(formatComicError(reason));
    } finally {
      setBusy(false);
    }
  };
  const visibleEntries = entries.filter((entry) =>
    `${entry.name} ${entry.description || ""}`.toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <Modal
      title="添加漫画源"
      subtitle="导入 Venera 兼容源。仓库中未安装的源会默认勾选，可批量导入。"
      close={close}
      className="comic-source-import-modal"
    >
      <form className="comic-import-address" onSubmit={(event) => { event.preventDefault(); void loadAddress(); }}>
        <label htmlFor="comic-source-address">仓库地址或单个脚本链接</label>
        <div className="online-row">
          <input id="comic-source-address" aria-label="漫画源仓库或脚本地址" value={address} onChange={(event) => setAddress(event.target.value)} />
          <button className="button primary" type="submit" disabled={busy || !address.trim()}>
            {busy ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}
            {busy ? "读取中…" : "读取／导入"}
          </button>
          <button className="button secondary" type="button" disabled={busy} onClick={() => void importFile()}>
            <FileUp size={15} /> 导入文件
          </button>
        </div>
      </form>
      {repositories.length > 0 && (
        <div className="comic-import-repositories" aria-label="已保存的仓库">
          {repositories.map((url) => (
            <span key={url}>
              <button className="text-button" title={url} onClick={() => { setAddress(url); void loadAddress(url); }}>{url}</button>
              <IconButton label={`移除仓库 ${url}`} onClick={() => void api().removeRepository(url).then(() => api().repositories()).then(setRepositories).catch((reason) => setError(formatComicError(reason)))}><X size={14} /></IconButton>
            </span>
          ))}
        </div>
      )}
      {entries.length > 0 && (
        <>
          <div className="comic-import-toolbar">
            <div className="comic-import-status-legend" aria-label="源状态说明">
              <span><Check size={14} /> 已导入</span>
              <span><Circle size={14} /> 已勾选</span>
              <span><Circle size={14} /> 未勾选</span>
            </div>
            <input aria-label="筛选漫画源" placeholder="筛选漫画源" value={filter} onChange={(event) => setFilter(event.target.value)} />
          </div>
          <div className="comic-import-select-actions">
            <button className="text-button" onClick={() => toggleAll(true)}>全选未导入</button>
            <button className="text-button" onClick={() => toggleAll(false)}>取消选择</button>
            <span className="spacer" />
            <span>{selected.size} 个待导入</span>
            <button className="button primary" disabled={busy || selected.size === 0} onClick={() => void installSelected()}>
              {busy ? "正在批量导入…" : `批量导入 (${selected.size})`}
            </button>
          </div>
          <div className="comic-import-list">
            {visibleEntries.map((entry) => {
              const installed = installedEntry(entry);
              const itemStatus = status[entry.url];
              const checked = selected.has(entry.url);
              return (
                <article className={`comic-import-item ${installed || itemStatus?.state === "imported" ? "is-imported" : checked ? "is-checked" : ""}`} key={entry.url}>
                  <button
                    type="button"
                    className="comic-import-toggle"
                    disabled={!!installed || itemStatus?.state === "installing" || busy}
                    aria-pressed={!!installed || checked}
                    aria-label={`${entry.name}，${installed ? "已导入" : checked ? "已勾选" : "未勾选"}`}
                    onClick={() => setSelected((old) => { const next = new Set(old); checked ? next.delete(entry.url) : next.add(entry.url); return next; })}
                  >
                    {installed || itemStatus?.state === "imported" ? <Check size={19} /> : checked ? <Check size={19} /> : <Circle size={19} />}
                  </button>
                  <div className="comic-import-item-info">
                    <strong>{entry.name}</strong>
                    <span>{entry.version ? `v${entry.version}` : "Venera 兼容源"}{entry.description ? ` · ${entry.description}` : ""}</span>
                    {itemStatus?.state === "failed" && <small role="alert">{itemStatus.error}</small>}
                  </div>
                  <span className={`comic-import-state ${itemStatus?.state || ""}`}>
                    {installed || itemStatus?.state === "imported" ? "已导入" : itemStatus?.state === "installing" ? "导入中…" : itemStatus?.state === "failed" ? "导入失败" : checked ? "已勾选" : "未勾选"}
                  </span>
                  {itemStatus?.state === "failed" && (
                    <button className="text-button" disabled={busy} onClick={() => void installOne(entry)}>重试</button>
                  )}
                </article>
              );
            })}
          </div>
        </>
      )}
      {notice && <p className="comic-import-notice" role="status">{notice}</p>}
      {error && <p className="online-error" role="alert">{error}</p>}
    </Modal>
  );
}

function SourceManager({
  sources,
  close,
  refresh,
}: {
  sources: ComicSourceInfo[];
  close(): void;
  refresh(): Promise<void>;
}) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [importing, setImporting] = useState(false);
  const [editing, setEditing] = useState<ComicSourceInfo>();
  const [accounting, setAccounting] = useState<ComicSourceInfo>();
  const [values, setValues] = useState<Record<string, any>>({});
  const [directory, setDirectory] = useState("");
  async function action(key: string, run: () => Promise<unknown>) {
    setBusy(key);
    setError("");
    try {
      await run();
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy("");
    }
  }
  useEffect(() => {
    void api().downloadDirectory().then(setDirectory).catch(report);
  }, []);
  return (
    <main className="online-source-manager-page">
      <header className="online-source-manager-heading">
        <button className="text-button" onClick={close}>
          <ArrowLeft size={16} /> 返回漫画
        </button>
        <div>
          <h1>漫画源</h1>
          <p>管理兼容源、账号与源设置</p>
        </div>
      </header>
      <div className="online-row">
        <button className="button primary" disabled={!!busy} onClick={() => setImporting(true)}>
          <Plus size={16} /> 添加漫画源
        </button>
        <h3>已安装 · {sources.length}</h3>
        <span className="spacer" />
        <button
          className="text-button"
          disabled={!!busy}
          onClick={() => void action("updates", () => api().checkUpdates())}
        >
          检查更新
        </button>
      </div>
      <div className="online-source-list">
        {sources.map((source) => (
          <div className="online-source-row" key={source.id}>
            <label>
              <input
                type="checkbox"
                checked={source.enabled}
                disabled={!!busy}
                onChange={(e) =>
                  void action(source.id, () =>
                    api().enable(source.id, e.target.checked),
                  )
                }
              />
              <span>
                {source.name}
                <small>
                  {source.version}
                  {source.error ? ` · ${source.error}` : ""}
                </small>
              </span>
            </label>
            <button
              className="text-button"
              disabled={!!busy}
              onClick={() => {
                setEditing(source);
                setValues({ ...source.settingValues });
              }}
            >
              源设置
            </button>
            {source.capabilities.login.length > 0 && (
              <button
                className="text-button"
                disabled={!!busy}
                onClick={() => setAccounting(source)}
              >
                {source.logged ? "账号 · 已登录" : "登录"}
              </button>
            )}
            {source.update && (
              <button
                className="button"
                disabled={!!busy}
                onClick={() =>
                  void action(source.id, () => api().update(source.id))
                }
              >
                更新
              </button>
            )}
            <button
              className="text-button"
              disabled={!!busy}
              onClick={() =>
                void action(source.id, () => api().uninstall(source.id))
              }
            >
              卸载
            </button>
          </div>
        ))}
        {!sources.length && (
          <p className="muted">读取仓库后，选择需要的漫画源安装。</p>
        )}
      </div>
      {editing && (
        <section className="online-settings">
          <h3>{editing.name} · 设置</h3>
          {Object.entries(editing.settings || {}).map(([key, spec]) => (
            <label key={key}>
              {spec.title || key}
              {spec.type === "callback" ? (
                <button
                  className="button secondary"
                  disabled={!!busy}
                  onClick={() =>
                    void action("setting-action", () =>
                      api().settingAction(editing.id, key),
                    )
                  }
                >
                  {(spec as any).buttonText || spec.title || "执行"}
                </button>
              ) : spec.type === "select" ? (
                <select
                  value={String(values[key] ?? spec.default ?? "")}
                  onChange={(e) =>
                    setValues((v) => ({ ...v, [key]: e.target.value }))
                  }
                >
                  {spec.options?.map((o: any, i: number) => (
                    <option key={i} value={optionValue(o)}>
                      {optionText(o)}
                    </option>
                  ))}
                </select>
              ) : spec.type === "switch" ? (
                <input
                  type="checkbox"
                  checked={Boolean(values[key] ?? spec.default)}
                  onChange={(e) =>
                    setValues((v) => ({ ...v, [key]: e.target.checked }))
                  }
                />
              ) : (
                <input
                  value={String(values[key] ?? spec.default ?? "")}
                  onChange={(e) =>
                    setValues((v) => ({ ...v, [key]: e.target.value }))
                  }
                />
              )}
            </label>
          ))}
          <button
            className="button primary"
            disabled={!!busy}
            onClick={() =>
              void action("settings", async () => {
                await api().settings(editing.id, values);
                setEditing(undefined);
              })
            }
          >
            保存源设置
          </button>
        </section>
      )}
      <div className="online-download-directory">
        <label>
          下载位置（修改后用于新任务）<small>{directory}</small>
        </label>
        <button
          className="text-button"
          onClick={() =>
            void api().downloadDirectory(true).then(setDirectory).catch(report)
          }
        >
          选择文件夹
        </button>
      </div>
      {busy && <p role="status">正在处理…</p>}
      {error && (
        <p role="alert" className="online-error">
          {formatComicError(error)}
        </p>
      )}
      {accounting && (
        <SourceAccount
          source={accounting}
          close={() => setAccounting(undefined)}
          refresh={refresh}
        />
      )}
      {importing && <SourceImportDialog sources={sources} refresh={refresh} close={() => setImporting(false)} />}
    </main>
  );
}

function SourceAccount({
  source,
  close,
  refresh,
}: {
  source: ComicSourceInfo;
  close(): void;
  refresh(): Promise<void>;
}) {
  const [kind, setKind] = useState(source.capabilities.login[0] || "password");
  const [values, setValues] = useState<string[]>([]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Modal title={`${source.name} · 账号`} close={close}>
      <div className="online-row">
        {source.capabilities.login.map((k) => (
          <button
            className={`button ${kind === k ? "primary" : "secondary"}`}
            key={k}
            onClick={() => {
              setKind(k);
              setValues([]);
            }}
          >
            {
              (
                {
                  password: "账号密码",
                  cookies: "Cookie",
                  webview: "网页登录",
                } as any
              )[k]
            }
          </button>
        ))}
      </div>
      <form
        className="online-settings"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            if (source.logged) await api().logout(source.id);
            else await api().login(source.id, kind, values);
            await refresh();
            close();
          } catch (e) {
            setError(String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {!source.logged &&
          kind !== "webview" &&
          (kind === "cookies"
            ? source.cookieFields || []
            : ["账号", "密码"]
          ).map((label, index) => (
            <label key={label}>
              {label}
              <input
                autoComplete="off"
                type={kind === "password" && index === 1 ? "password" : "text"}
                value={values[index] || ""}
                onChange={(e) => {
                  const next = [...values];
                  next[index] = e.target.value;
                  setValues(next);
                }}
              />
            </label>
          ))}
        {error && (
          <p role="alert" className="online-error">
            {error}
          </p>
        )}
        <footer>
          <button className="button primary" disabled={busy}>
            {busy
              ? "处理中…"
              : source.logged
                ? "退出登录"
                : kind === "webview"
                  ? "打开登录窗口"
                  : "登录"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

export default function OnlineComics({
  scope,
  navigate,
  onBack,
  local,
  openLocal,
  openLayout,
  memory,
  remember,
}: {
  scope: BrowseLocation;
  navigate(scope: BrowseLocation, mode?: NavigationMode): void;
  onBack(): boolean;
  local(): void;
  openLocal(item: MediaItem): void;
  openLayout(): void;
  memory: BrowseMemory;
  remember(patch: Partial<BrowseMemory>): void;
}) {
  const [sources, setSources] = useState<ComicSourceInfo[]>([]);
  const [sourcesLoaded, setSourcesLoaded] = useState(false);
  const [cards, setCards] = useState<OnlineComic[]>([]),
    [pageInfo, setPageInfo] = useState<ComicSearchPage>();
  const [aggregateGroups, setAggregateGroups] = useState<AggregateSearchGroup[]>([]);
  const [aggregateFailures, setAggregateFailures] = useState<AggregateSearchFailure[]>([]);
  const [aggregateTotal, setAggregateTotal] = useState(0);
  const [aggregateBusy, setAggregateBusy] = useState(false);
  const [aggregateError, setAggregateError] = useState("");
  const [singleSearchPages, setSingleSearchPages] = useState<Record<string, SingleSearchPageState>>({});
  const [aggregateRetrying, setAggregateRetrying] = useState<Set<string>>(new Set());
  const [detailRecord, setDetailRecord] = useState<ComicDetailRecord>(),
    [reader, setReader] = useState<MediaItem>();
  const [tasks, setTasks] = useState<ComicDownloadTask[]>([]);
  const [laterRefs, setLaterRefs] = useState<ComicHubRef[]>([]),
    [laterItems, setLaterItems] = useState<HubCardItem[]>([]);
  const [follows, setFollows] = useState<ComicFollowState[]>([]),
    [followItems, setFollowItems] = useState<OnlineComic[]>([]),
    [localRecent, setLocalRecent] = useState<MediaItem[]>([]),
    [localLibrary, setLocalLibrary] = useState<MediaItem[]>([]),
    [localFavorites, setLocalFavorites] = useState<MediaItem[]>([]),
    [onlineHistory, setOnlineHistory] = useState<OnlineComic[]>([]),
    [onlineFavorites, setOnlineFavorites] = useState<OnlineComic[]>([]),
    [downloaded, setDownloaded] = useState<OnlineComic[]>([]);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [sourceSort, setSourceSort] = useState<"default" | "name-asc" | "name-desc" | "custom">(() => {
    const saved = localStorage.getItem("comic:home-source-sort");
    return saved === "name-asc" || saved === "name-desc" || saved === "custom" ? saved : "default";
  });
  const [sourceOrder, setSourceOrder] = useState<string[]>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem("comic:home-source-order") || "[]");
      return Array.isArray(saved) ? saved.filter((id): id is string => typeof id === "string") : [];
    } catch {
      return [];
    }
  });
  const [draggingSourceId, setDraggingSourceId] = useState<string>();
  const [dragOverSourceId, setDragOverSourceId] = useState<string>();
  const [sourceQuickMenuOpen, setSourceQuickMenuOpen] = useState(false);
  const [sourceQuickBusy, setSourceQuickBusy] = useState(false);
  const sourceQuickMenu = useRef<HTMLDivElement>(null);
  const [resultLayout, setResultLayout] = useState<"grid" | "archiveShelf" | "carousel">("grid");
  const [resultMode, setResultMode] = useState<"pagination" | "waterfall">("pagination");
  const [jumpPage, setJumpPage] = useState("1");
  const [collapsedHome, setCollapsedHome] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem("comic:home-collapsed") || "{}");
    } catch {
      return {};
    }
  });
  const [query, setQuery] = useState(scope.search || ""),
    [searchSubmitRevision, setSearchSubmitRevision] = useState(0),
    [options, setOptions] = useState<unknown[]>([]);
  const [searchHistory, setSearchHistory] = useState<string[]>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(COMIC_SEARCH_HISTORY_KEY) || "[]");
      return Array.isArray(saved)
        ? saved
            .filter((term): term is string => typeof term === "string")
            .map((term) => term.trim())
            .filter((term, index, terms) => term.length > 0 && terms.indexOf(term) === index)
            .slice(0, MAX_COMIC_SEARCH_HISTORY)
        : [];
    } catch {
      return [];
    }
  });
  const searchHistoryRef = useRef(searchHistory);
  searchHistoryRef.current = searchHistory;
  const [searchHistoryCollapsed, setSearchHistoryCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COMIC_SEARCH_HISTORY_COLLAPSED_KEY) === "true";
    } catch {
      return false;
    }
  });
  const [optionsSourceId, setOptionsSourceId] = useState<string>();
  const [comicMenuOpen, setComicMenuOpen] = useState(false);
  const { searchPanelVisible, setSearchPanelVisible, searchInput, searchPanel, clearSearchPanelHideTimer, onSearchPointerMove, onSearchPointerDown } = useReadingSearchPanel({ section: scope.section || "home", remoteId: scope.remoteId, mode: scope.searchMode, sourceId: scope.providerId, pageId: scope.comicSearchId });
  const [selected, setSelected] = useState<(string | null)[]>([]);
  const [chapterOrderReversed, setChapterOrderReversed] = useState(false);
  const [aggregateIds, setAggregateIds] = useState<string[]>([]);
  const [categoryData, setCategoryData] = useState<{
    sourceId: string;
    value: any;
  }>();
  const [rankingOption, setRankingOption] = useState<string>();
  const [exploreIndex, setExploreIndex] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("comic:active-explore") || "null");
      return Number.isInteger(saved?.index) ? saved.index : 0;
    } catch {
      return 0;
    }
  });
  const page = useRef(1),
    maxPage = useRef<number | undefined>(undefined),
    cursors = useRef<(string | null | undefined)[]>([null]),
    loadingMore = useRef(false);
  const section = scope.section === "siteFavorites" ? "favorites" : scope.section || "home";
  const searchMode = scope.searchMode || "aggregate";
  const detailKey = `${scope.providerId || ""}\u0000${scope.remoteId || ""}`;
  const detailKeyRef = useRef(detailKey);
  detailKeyRef.current = detailKey;
  const details = detailRecord?.key === detailKey && detailRecord.status === "ready"
    ? detailRecord.details
    : undefined;
  const detailStatus = detailRecord?.key === detailKey ? detailRecord.status : "loading";
  const detailError = detailRecord?.key === detailKey ? detailRecord.error || "" : "";
  const setDetails = (value: OnlineComicDetails | undefined) => {
    setDetailRecord(value
      ? { key: `${value.sourceId}\u0000${value.comicId}`, status: "ready", details: value }
      : { key: detailKey, status: "loading" },
    );
  };
  const finishDetailSkeleton = (key: string) => {
    if (detailSkeletonExitTimer.current != null)
      window.clearTimeout(detailSkeletonExitTimer.current);
    if (reducedMotion) {
      detailSkeletonExitKey.current = null;
      setSkeletonExitIdentity(null);
      detailSkeletonExitTimer.current = undefined;
      return;
    }
    detailSkeletonExitKey.current = key;
    setSkeletonExitIdentity(key);
    detailSkeletonExitTimer.current = window.setTimeout(() => {
      if (detailSkeletonExitKey.current !== key) return;
      detailSkeletonExitKey.current = null;
      setSkeletonExitIdentity(null);
      detailSkeletonExitTimer.current = undefined;
    }, 240);
  };
  const reducedMotion = useApp((s) => s.settings.reducedMotion);
  const comicRoot = useRef<HTMLElement>(null);
  const cardOrigin = useRef<ComicCardOrigin | null>(null);
  const detailPreview = useRef<ComicDetailPreview | null>(null);
  const previousDetailPage = useRef(false);
  const previousRemoteKind = useRef(scope.remoteKind);
  const lastDetailCover = useRef<ComicCardOrigin | null>(null);
  const enteringDetailIdentity = useRef<string | null>(null);
  const activeComicFlight = useRef<{
    node: HTMLImageElement;
    target: HTMLElement;
    originalVisibility: string;
    animation?: Animation;
  } | null>(null);
  const comicFlightToken = useRef(0);
  const comicFlightFrame = useRef<number | undefined>(undefined);
  const detailSkeletonExitKey = useRef<string | null>(null);
  const detailSkeletonExitTimer = useRef<number | undefined>(undefined);
  const detailFallbackFadeTimer = useRef<number | undefined>(undefined);
  const [skeletonExitIdentity, setSkeletonExitIdentity] = useState<string | null>(null);
  const [detailFallbackFade, setDetailFallbackFade] = useState(false);
  const homeSources = useMemo(() => {
    const ordered = [...sources];
    if (sourceSort === "name-asc") ordered.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
    if (sourceSort === "name-desc") ordered.sort((a, b) => b.name.localeCompare(a.name, "zh-CN"));
    if (sourceSort === "custom") {
      const positions = new Map(sourceOrder.map((id, index) => [id, index]));
      ordered.sort((a, b) => (positions.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (positions.get(b.id) ?? Number.MAX_SAFE_INTEGER));
    }
    return ordered;
  }, [sources, sourceSort, sourceOrder]);
  const current =
    homeSources.find((s) => s.id === scope.providerId) ||
    sources.find(
      (s) => s.enabled && s.id === localStorage.getItem("comic:active-source"),
    ) || homeSources.find((s) => s.enabled);
  const sourceId = scope.providerId || current?.id;
  const pageStateKey = [
    section,
    scope.comicSearchId || "",
    sourceId || "",
    scope.search || "",
    scope.remoteId || "",
    scope.remoteKind || "",
    scope.comicChapterId || "",
    scope.comicCategory || "",
    scope.comicCategoryParam || "",
  ].join(":");
  const pageStateKeyRef = useRef(pageStateKey);
  pageStateKeyRef.current = pageStateKey;
  const exploreTabs = useMemo(
    () =>
      homeSources.flatMap((source) =>
        source.enabled
          ? source.explore.map((entry, index) => ({
              key: `${source.id}:${index}`,
              sourceId: source.id,
              sourceName: source.name,
              index,
              title: entry.title,
              type: entry.type,
            }))
          : [],
      ),
    [homeSources],
  );
  const activeExploreTab =
    exploreTabs.find(
      (tab) => tab.sourceId === sourceId && tab.index === exploreIndex,
    ) || exploreTabs[0];
  const searchableSources = homeSources.filter(
    (source) => source.enabled && source.capabilities.search,
  );
  const mounted = useRef(true),
    generation = useRef(0),
    aggregateGeneration = useRef(0),
    loadedSearchKeys = useRef(new Set<string>()),
    autoStartSearchPageIds = useRef(new Set<string>()),
    singleSearchRequestIds = useRef(new Map<string, number>());
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
      aggregateGeneration.current++;
      for (const [key, requestId] of singleSearchRequestIds.current)
        singleSearchRequestIds.current.set(key, requestId + 1);
    };
  }, []);
  const refresh = useCallback(async () => {
    const results = await Promise.allSettled([
      api().sources(),
      api().downloads(),
      hub().list("readLater"),
      hub().following(),
      api().library("history"),
      api().library("shelf"),
      api().library("downloads"),
      window.media.query({ type: "comic", recent: true, sort: "recent", limit: 12 }),
      window.media.query({ type: "comic", favorite: true, sort: "recent", limit: 24 }),
      window.media.query({ type: "comic", sort: "added", limit: 10 }),
    ]);
    const value = (index: number, fallback: any) =>
      results[index].status === "fulfilled" ? results[index].value : fallback;
    const refs = value(2, []) as ComicHubRef[];
    if (!mounted.current) return;
    setSources(value(0, []));
    setSourcesLoaded(true);
    setTasks(value(1, []));
    setLaterRefs(refs);
    setFollows(value(3, []));
    setOnlineHistory(value(4, []));
    setOnlineFavorites(value(5, []));
    setDownloaded(value(6, []));
    setLocalRecent(value(7, { items: [] }).items || []);
    setLocalFavorites(value(8, { items: [] }).items || []);
    setLocalLibrary(value(9, { items: [] }).items || []);
  }, []);
  useEffect(() => {
    void refresh().catch(report);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = api().onChange(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        setRevision((value) => value + 1);
        void refresh().catch(report);
      }, 180);
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [refresh]);
  const laterRefsKey = laterRefs.map((ref) =>
    ref.kind === "local" ? `local:${ref.mediaId}` : `online:${ref.sourceId}:${ref.comicId}`,
  ).join("\n");
  const lastLaterRefsKey = useRef<string | undefined>(undefined);
  const laterRefsRef = useRef(laterRefs);
  laterRefsRef.current = laterRefs;
  useEffect(() => {
    if (lastLaterRefsKey.current === laterRefsKey) return;
    lastLaterRefsKey.current = laterRefsKey;
    let live = true;
    void Promise.allSettled(
      laterRefsRef.current.map((ref) =>
        ref.kind === "local" ? window.media.item(ref.mediaId) : api().details(ref),
      ),
    ).then((results) => {
      if (live)
        setLaterItems(
          results.flatMap((result) =>
            result.status === "fulfilled" && result.value
              ? [result.value as HubCardItem]
              : [],
          ),
        );
    });
    return () => {
      live = false;
    };
  }, [laterRefsKey]);
  const followsKey = follows.map((state) => `${state.ref.sourceId}:${state.ref.comicId}`).join("\n");
  const lastFollowsKey = useRef<string | undefined>(undefined);
  const followsRef = useRef(follows);
  followsRef.current = follows;
  useEffect(() => {
    if (lastFollowsKey.current === followsKey) return;
    lastFollowsKey.current = followsKey;
    let live = true;
    void Promise.all(
      followsRef.current.map((state) => api().details(state.ref).catch(() => undefined)),
    ).then((values) => {
      if (live)
        setFollowItems(
          values.filter(
            (value): value is OnlineComicDetails => value !== undefined,
          ),
        );
    });
    return () => {
      live = false;
    };
  }, [followsKey]);
  const go = (
    patch: Partial<BrowseLocation>,
    mode: NavigationMode = "replace",
  ) => {
    // Invalidate shared browse-page work immediately; aggregate and single
    // source searches keep their own request identities while off screen.
    generation.current++;
    setBusy(false);
    setError("");
    if (patch.section === "history") patch = { ...patch, section: "home" };
    const nextSection = patch.section || section;
    const sectionChanged = Boolean(patch.section && patch.section !== section);
    navigate(
      {
        ...scope,
        view: "comic",
        type: "comic",
        providerId: sourceId,
        section,
        remoteId: undefined,
        remoteKind: undefined,
        comicChapterId: undefined,
        ...((patch.section && patch.section !== section) ||
        (patch.providerId && patch.providerId !== sourceId)
          ? { search: undefined }
          : {}),
        ...(sectionChanged && nextSection !== "categoryResults"
          ? { comicCategory: undefined, comicCategoryParam: undefined }
          : {}),
        ...patch,
      },
      mode,
    );
  };
  useEffect(() => {
    if (!sourceQuickMenuOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!sourceQuickMenu.current?.contains(event.target as Node))
        setSourceQuickMenuOpen(false);
    };
    window.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => window.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [sourceQuickMenuOpen]);
  useEffect(() => {
    // Also cover browser back/forward and navigation initiated outside go().
    generation.current++;
    setBusy(false);
    setError("");
  }, [pageStateKey]);
  useEffect(() => {
    if (section !== "discover" || !activeExploreTab) return;
    if (activeExploreTab.sourceId !== sourceId) {
      localStorage.setItem("comic:active-source", activeExploreTab.sourceId);
      localStorage.setItem(
        "comic:active-explore",
        JSON.stringify({ sourceId: activeExploreTab.sourceId, index: activeExploreTab.index }),
      );
      setExploreIndex(activeExploreTab.index);
      go({ section: "discover", providerId: activeExploreTab.sourceId }, "replace");
      return;
    }
    if (activeExploreTab.index !== exploreIndex) {
      localStorage.setItem(
        "comic:active-explore",
        JSON.stringify({ sourceId: activeExploreTab.sourceId, index: activeExploreTab.index }),
      );
      setExploreIndex(activeExploreTab.index);
    }
  }, [section, sourceId, exploreIndex, activeExploreTab?.key]);
  useEffect(() => {
    setOptionsSourceId(undefined);
    const optionSourceId = current?.id;
    setOptions(
      ((section === "categories" || section === "categoryResults")
        ? current?.categoryOptions || []
        : current?.searchOptions || []).map(sourceOptionDefault),
    );
    setOptionsSourceId(optionSourceId);
    setRankingOption(undefined);
    if (section === "discover") {
      try {
        const saved = JSON.parse(localStorage.getItem("comic:active-explore") || "null");
        setExploreIndex(saved?.sourceId === current?.id && Number.isInteger(saved?.index) ? saved.index : 0);
      } catch {
        setExploreIndex(0);
      }
    } else setExploreIndex(0);
  }, [current?.id, section]);
  useEffect(() => {
    setQuery(scope.search || "");
  }, [scope.search]);
  useEffect(() => {
    if (!sources.length) return;
    let saved: string[] = [];
    try {
      saved = JSON.parse(localStorage.getItem("comic:aggregate-sources") || "[]");
    } catch {}
    const hasSaved = localStorage.getItem("comic:aggregate-sources") !== null;
    setAggregateIds(
      hasSaved
        ? saved.filter((id) => sources.some((source) => source.id === id && source.enabled && source.capabilities.search))
        : homeSources.filter((source) => source.enabled && source.capabilities.search).map((source) => source.id),
    );
  }, [sources]);
  const aggregateSelectionInitialized = useRef(false);
  useEffect(() => {
    if (sources.length) aggregateSelectionInitialized.current = true;
  }, [sources]);
  useEffect(() => {
    if (aggregateSelectionInitialized.current)
      localStorage.setItem("comic:aggregate-sources", JSON.stringify(aggregateIds));
  }, [aggregateIds]);
  useEffect(() => {
    if (!comicMenuOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setComicMenuOpen(false);
      }
    };
    window.addEventListener("keydown", closeOnEscape, true);
    return () => window.removeEventListener("keydown", closeOnEscape, true);
  }, [comicMenuOpen]);
  const singleResultPage =
    section === "categoryResults" ||
    (section === "search" && searchMode === "single" && Boolean(scope.search));
  const isAggregateSearchPage =
    section === "search" && searchMode !== "single" && Boolean(scope.search);
  const isSingleSearchRoute = section === "search" && searchMode === "single";
  const isSingleSearchPage = isSingleSearchRoute && Boolean(scope.search);
  const singleSearchPageKey = scope.comicSearchId || "legacy-single-search";
  const defaultSingleSearchPage = singleSearchPages[singleSearchPageKey] ||
    singleSearchPageDefaults(
      sourceId,
      scope.search || "",
      (current?.searchOptions || []).map(sourceOptionDefault),
    );
  const singleSearchPage = defaultSingleSearchPage;
  const singleSearchRequestKey = makeSingleSearchRequestKey(
    singleSearchPageKey,
    sourceId || "",
    scope.search || "",
  );
  const singleSearchPending =
    isSingleSearchPage &&
    Boolean(sourceId) &&
    (searchSubmitRevision > 0 || autoStartSearchPageIds.current.has(singleSearchPageKey)) &&
    !loadedSearchKeys.current.has(singleSearchRequestKey) &&
    (!sourcesLoaded || current?.id === sourceId);
  const updateSingleSearchPage = (patch: Partial<SingleSearchPageState>) => {
    setSingleSearchPages((pages) => ({
      ...pages,
      [singleSearchPageKey]: {
        ...(pages[singleSearchPageKey] || defaultSingleSearchPage),
        ...patch,
      },
    }));
  };
  const setSearchQueryDraft = (value: string) => {
    if (isSingleSearchRoute) updateSingleSearchPage({ query: value });
    else setQuery(value);
  };
  const setSearchOptionsDraft = (value: unknown[]) => {
    if (isSingleSearchRoute) updateSingleSearchPage({ options: value });
    else setOptions(value);
  };
  const saveSearchHistory = (next: string[]) => {
    searchHistoryRef.current = next;
    setSearchHistory(next);
    try {
      // Search history intentionally stores only plain query strings.
      localStorage.setItem(COMIC_SEARCH_HISTORY_KEY, JSON.stringify(next));
    } catch {}
  };
  const rememberSearch = (term: string) => {
    if (!term) return;
    saveSearchHistory(
      [term, ...searchHistoryRef.current.filter((item) => item !== term)].slice(
        0,
        MAX_COMIC_SEARCH_HISTORY,
      ),
    );
  };
  const removeSearchHistoryItem = (term: string) => {
    saveSearchHistory(searchHistoryRef.current.filter((item) => item !== term));
  };
  const clearSearchHistory = () => saveSearchHistory([]);
  const setSearchHistoryCollapsedPersisted = (collapsed: boolean) => {
    setSearchHistoryCollapsed(collapsed);
    try {
      localStorage.setItem(COMIC_SEARCH_HISTORY_COLLAPSED_KEY, String(collapsed));
    } catch {}
  };
  const displaySearchQuery = isSingleSearchRoute ? singleSearchPage.query : query;
  const displaySearchOptions = isSingleSearchRoute ? singleSearchPage.options : options;
  const displayResultLayout = isSingleSearchPage ? singleSearchPage.resultLayout : resultLayout;
  const displayResultMode = isSingleSearchPage ? singleSearchPage.resultMode : resultMode;
  const displayCards = isSingleSearchPage ? singleSearchPage.cards : cards;
  const displayPageInfo = isSingleSearchPage ? singleSearchPage.pageInfo : pageInfo;
  const displayPage = isSingleSearchPage ? singleSearchPage.page : page.current;
  const displayJumpPage = isSingleSearchPage ? singleSearchPage.jumpPage : jumpPage;
  const displayBusy = isAggregateSearchPage
    ? aggregateBusy
    : isSingleSearchPage
      ? singleSearchPage.busy || singleSearchPending
      : busy;
  const displayError = isAggregateSearchPage
    ? aggregateError
    : isSingleSearchPage
      ? singleSearchPage.error
      : error;
  const canSearch = searchMode === "aggregate"
    ? aggregateIds.some((id) => sources.some((source) => source.id === id && source.enabled && source.capabilities.search))
    : Boolean(current?.capabilities.search);
  const submitSearch = (rawQuery: string) => {
    clearSearchPanelHideTimer();
    setSearchPanelVisible(false);
    const submittedQuery = rawQuery.trim();
    rememberSearch(submittedQuery);
    const submittedSource = searchMode === "single" ? sourceId || "" : "";
    const pageId =
      section === "search" && !scope.remoteId && scope.comicSearchId
        ? scope.comicSearchId
        : newComicSearchId();
    if (searchMode === "single") {
      loadedSearchKeys.current.delete(
        makeSingleSearchRequestKey(pageId, submittedSource, submittedQuery),
      );
      setSingleSearchPages((pages) => ({
        ...pages,
        [pageId]: {
          ...(pages[pageId] || defaultSingleSearchPage),
          query: submittedQuery,
          options: singleSearchPage.options,
          submittedOptions: singleSearchPage.options,
          ...(submittedQuery !== scope.search
            ? { cards: [], pageInfo: undefined, page: 1, cursors: [null], maxPage: undefined, jumpPage: "1", error: "" }
            : {}),
        },
      }));
    } else {
      loadedSearchKeys.current.delete(`aggregate:${pageId}:${submittedQuery}`);
    }
    go({
      section: "search",
      providerId: searchMode === "single" ? sourceId : undefined,
      search: submittedQuery || undefined,
      searchMode,
      comicSearchId: pageId,
    });
    setSearchSubmitRevision((value) => value + 1);
  };
  useEffect(() => {
    if (!sourceId) return;
    try {
      const stored = JSON.parse(
        localStorage.getItem(`comic:single-result:${sourceId}`) || "{}",
      );
      setResultLayout(
        ["grid", "archiveShelf", "carousel"].includes(stored.layout)
          ? stored.layout
          : "grid",
      );
      setResultMode(stored.mode === "waterfall" ? "waterfall" : "pagination");
    } catch {
      setResultLayout("grid");
      setResultMode("pagination");
    }
  }, [sourceId]);
  function saveResultPreference(
    key: "layout" | "mode",
    value: "grid" | "archiveShelf" | "carousel" | "pagination" | "waterfall",
  ) {
    if (isSingleSearchPage) {
      updateSingleSearchPage(
        key === "layout"
          ? { resultLayout: value as SingleSearchPageState["resultLayout"] }
          : readingResultModePatch(singleSearchPage, value as SingleSearchPageState["resultMode"], singleSearchPage.pageInfo?.comics || []),
      );
      return;
    }
    if (!sourceId) return;
    const storageKey = `comic:single-result:${sourceId}`;
    let stored: Record<string, unknown> = {};
    try {
      stored = JSON.parse(localStorage.getItem(storageKey) || "{}");
    } catch {}
    localStorage.setItem(storageKey, JSON.stringify({ ...stored, [key]: value }));
    if (key === "layout")
      setResultLayout(value as "grid" | "archiveShelf" | "carousel");
    else setResultMode(value as "pagination" | "waterfall");
  }
  function toggleHomeSection(key: string) {
    setCollapsedHome((old) => {
      const next = { ...old, [key]: !old[key] };
      localStorage.setItem("comic:home-collapsed", JSON.stringify(next));
      return next;
    });
  }
  useEffect(() => {
    setCategoryData(undefined);
    if (current?.capabilities.categories) {
      let live = true;
      void api()
        .categories(current.id)
        .then((value) => {
          if (live) setCategoryData({ sourceId: current.id, value });
        })
        .catch(() => {});
      return () => {
        live = false;
      };
    }
  }, [current?.id, current?.logged]);
  const localRevision = ["favorites", "downloads"].includes(section)
    ? revision
    : 0;
  const loadPage = useCallback(
    async (number: number, append = false) => {
      const aggregateRequest =
        section === "search" && searchMode !== "single" && Boolean(scope.search);
      const token = aggregateRequest
        ? ++aggregateGeneration.current
        : ++generation.current;
      if (aggregateRequest) {
        setAggregateBusy(true);
        setAggregateError("");
      } else {
        setBusy(true);
        setError("");
      }
      if (section === "discover" && !append) setCards([]);
      if (section === "search" && searchMode !== "single") {
        setAggregateGroups([]);
        setAggregateFailures([]);
        setAggregateTotal(0);
      }
      try {
        let result: ComicSearchPage;
        if (section === "search" && scope.search && searchMode !== "single") {
          const selectedSources = homeSources.filter(
            (source) =>
              aggregateIds.includes(source.id) &&
              source.enabled &&
              source.capabilities.search,
          );
          if (!selectedSources.length) {
            setAggregateGroups([]);
            setAggregateFailures([]);
            setAggregateTotal(0);
            setAggregateError("请至少选择一个已启用的漫画源进行搜索。");
            return;
          }
          setAggregateTotal(selectedSources.length);
          setAggregateGroups([]);
          setAggregateFailures([]);
          // Keep a small pool active like Venera's lazy source sections: starting
          // every site at once can saturate the network and trigger rate limits.
          // Publish each completed source immediately so slow sites do not delay
          // previews from the rest.
          const searchSource = async (source: ComicSourceInfo) => {
              const sourceOptions = source.searchOptions.map(sourceOptionDefault);
              try {
                const result = await api().search(
                  source.id,
                  scope.search!,
                  sourceOptions,
                  1,
                  null,
                );
                if (token !== aggregateGeneration.current || !mounted.current) return;
                setAggregateFailures((current) => token !== aggregateGeneration.current || !mounted.current
                  ? current
                  : current.filter((failure) => failure.source.id !== source.id));
                setAggregateGroups((current) => {
                  if (token !== aggregateGeneration.current || !mounted.current) return current;
                  const next = current.filter((group) => group.source.id !== source.id);
                  if (result.comics.length)
                    next.push({ source, comics: result.comics.slice(0, 8) });
                  const order = new Map(selectedSources.map((item, index) => [item.id, index]));
                  return next.sort(
                    (left, right) =>
                      (order.get(left.source.id) ?? 0) -
                      (order.get(right.source.id) ?? 0),
                  );
                });
              } catch (reason) {
                if (token !== aggregateGeneration.current || !mounted.current) return;
                setAggregateFailures((current) => {
                  if (token !== aggregateGeneration.current || !mounted.current) return current;
                  const next = current.filter((failure) => failure.source.id !== source.id);
                  next.push({ source, error: formatComicError(reason) });
                  const order = new Map(selectedSources.map((item, index) => [item.id, index]));
                  return next.sort(
                    (left, right) =>
                      (order.get(left.source.id) ?? 0) -
                      (order.get(right.source.id) ?? 0),
                  );
                });
              }
          };
          await searchSourcePool(selectedSources, searchSource, () => token === aggregateGeneration.current && mounted.current);
          if (token !== aggregateGeneration.current || !mounted.current) return;
          return;
        }
        if (!(section === "search" && searchMode === "single")) {
          setAggregateGroups([]);
          setAggregateFailures([]);
          setAggregateTotal(0);
        }
        if (section === "home" || section === "categories" || section === "sourceManager") {
          result = { comics: [], maxPage: 1 };
        } else if (["favorites", "downloads"].includes(section))
          result = {
            comics: await api().library(
              section === "favorites" ? "shelf" : "downloads",
            ),
            maxPage: 1,
          };
        else if (section === "readLater" || section === "following") {
          result = {
            comics: section === "readLater"
              ? laterItems.filter(isOnlineComic)
              : followItems,
            maxPage: 1,
          };
        }
        else {
          if (!sourceId) {
            setCards([]);
            return;
          }
          const fetchSourcePage = (pageNumber: number, next?: string | null) => {
            if (section === "search" && scope.search)
              return api().search(sourceId, scope.search, options, pageNumber, next);
            if (
              section === "categoryResults" &&
              scope.comicCategory === "__ranking"
            )
              return api().ranking(
                sourceId,
                String(scope.comicCategoryParam || ""),
                pageNumber,
                next,
              );
            if (section === "categoryResults" && scope.comicCategory)
              return api().category(
                sourceId,
                scope.comicCategory,
                scope.comicCategoryParam,
                options,
                pageNumber,
                next,
              );
            if (rankingOption !== undefined)
              return api().ranking(sourceId, rankingOption, pageNumber, next);
            if (section === "discover" && current?.explore.length)
              return api().explore(sourceId, exploreIndex, pageNumber, next);
            return Promise.resolve({ comics: [], maxPage: 1 } as ComicSearchPage);
          };
          if (
            number > 1 &&
            cursors.current[number - 1] === undefined &&
            maxPage.current == null
          ) {
            for (
              let previousPage = Math.max(1, cursors.current.length);
              previousPage < number;
              previousPage++
            ) {
              const nextToken = cursors.current[previousPage - 1];
              if (previousPage > 1 && nextToken == null)
                throw new Error(`该漫画源最多只能访问第 ${previousPage - 1} 页`);
              const intermediate = await fetchSourcePage(previousPage, nextToken);
              if (intermediate.maxPage != null)
                maxPage.current = intermediate.maxPage;
              if (
                intermediate.maxPage != null &&
                number > intermediate.maxPage
              )
                throw new Error(`该漫画源最多只能访问第 ${intermediate.maxPage} 页`);
              cursors.current[previousPage] = intermediate.next ?? null;
              if (
                previousPage < number - 1 &&
                intermediate.next == null &&
                intermediate.maxPage == null
              )
                throw new Error(`该漫画源最多只能访问第 ${previousPage} 页`);
            }
          }
          if (
            number > 1 &&
            cursors.current[number - 1] == null &&
            maxPage.current == null
          )
            throw new Error(`该漫画源最多只能访问第 ${number - 1} 页`);
          result = await fetchSourcePage(number, cursors.current[number - 1]);
        }
        if (token !== generation.current || !mounted.current) return;
        page.current = number;
        cursors.current[number] = result.next;
        maxPage.current = result.maxPage;
        setPageInfo(result);
        setJumpPage(String(number));
        setCards((old) => {
          if (!append) return result.comics;
          const seen = new Set(old.map((comic) => `${comic.sourceId}:${comic.comicId}`));
          return [...old, ...result.comics.filter((comic) => !seen.has(`${comic.sourceId}:${comic.comicId}`))];
        });
      } catch (e) {
        if (aggregateRequest && token === aggregateGeneration.current && mounted.current) {
          setAggregateError(formatComicError(e));
        } else if (!aggregateRequest && token === generation.current && mounted.current) {
          setError(formatComicError(e));
          if (!append) setCards([]);
        }
      } finally {
        if (aggregateRequest && token === aggregateGeneration.current && mounted.current)
          setAggregateBusy(false);
        else if (!aggregateRequest && token === generation.current && mounted.current)
          setBusy(false);
      }
    },
    [
      section,
      sourceId,
      scope.search,
      scope.comicCategory,
      scope.comicCategoryParam,
      JSON.stringify(options),
      rankingOption,
      exploreIndex,
      current?.id,
      localRevision,
      laterItems,
      followItems,
      searchMode,
      aggregateIds.join(","),
      homeSources.map((source) => `${source.id}:${source.enabled}:${source.capabilities.search}`).join(","),
    ],
  );
  async function loadSingleSearchPage(
    pageId: string,
    searchSourceId: string,
    keyword: string,
    searchOptions: unknown[],
    number: number,
    append = false,
    defaults = singleSearchPageDefaults(searchSourceId, keyword, searchOptions),
  ) {
    const key = pageId;
    const requestId = (singleSearchRequestIds.current.get(key) || 0) + 1;
    singleSearchRequestIds.current.set(key, requestId);
    const isCurrentRequest = () => mounted.current && singleSearchRequestIds.current.get(key) === requestId;
    await loadReadingSearchPage<OnlineComic, ComicSearchPage>({
      previous: singleSearchPages[key] || defaults, number, append,
      fetchPage: (page, cursor) => api().search(searchSourceId, keyword, searchOptions, page, cursor),
      unpack: result => ({ items:result.comics, next:result.next, maxPage:result.maxPage }),
      identity: comic => `${comic.sourceId}:${comic.comicId}`, current:isCurrentRequest,
      update: patch => setSingleSearchPages(pages => !isCurrentRequest() ? pages : ({ ...pages, [key]: { ...(pages[key] || defaults), ...patch } })),
      formatError: formatComicError,
    });
  }

  const singleSearchPageLoaderRef = useRef(loadSingleSearchPage);
  singleSearchPageLoaderRef.current = loadSingleSearchPage;
  const loadVisiblePage = useCallback(
    (number: number, append = false) => {
      if (isSingleSearchPage && sourceId && scope.search)
        return singleSearchPageLoaderRef.current(
          singleSearchPageKey,
          sourceId,
          scope.search,
          singleSearchPage.submittedOptions,
          number,
          append,
          singleSearchPage,
        );
      return loadPage(number, append);
    },
    [isSingleSearchPage, singleSearchPageKey, sourceId, scope.search, singleSearchPage, loadPage],
  );
  const retryAggregateSource = async (source: ComicSourceInfo) => {
    if (!scope.search || aggregateRetrying.has(source.id)) return;
    setAggregateRetrying((current) => new Set(current).add(source.id));
    try {
      const sourceOptions = source.searchOptions.map(
        sourceOptionDefault,
      );
      const result = await api().search(source.id, scope.search, sourceOptions, 1, null);
      setAggregateFailures((current) => current.filter((failure) => failure.source.id !== source.id));
      setAggregateGroups((current) => {
        const next = current.filter((group) => group.source.id !== source.id);
        if (result.comics.length) next.push({ source, comics: result.comics.slice(0, 8) });
        return next;
      });
    } catch (reason) {
      setAggregateFailures((current) => current.map((failure) =>
        failure.source.id === source.id ? { ...failure, error: formatComicError(reason) } : failure,
      ));
    } finally {
      setAggregateRetrying((current) => {
        const next = new Set(current);
        next.delete(source.id);
        return next;
      });
    }
  };
  const loadNextWaterfallPage = useCallback(() => {
    if (!singleResultPage || displayResultMode !== "waterfall" || displayBusy || loadingMore.current || !displayPageInfo?.comics.length)
      return;
    const hasMore = displayPageInfo.maxPage != null
      ? displayPage < displayPageInfo.maxPage
      : displayPageInfo.next !== null;
    if (!hasMore) return;
    loadingMore.current = true;
    void loadVisiblePage(displayPage + 1, true).finally(() => {
      loadingMore.current = false;
    });
  }, [singleResultPage, displayResultMode, displayBusy, displayPageInfo, displayPage, loadVisiblePage]);
  const loadPageRef = useRef(loadPage);
  loadPageRef.current = loadPage;
  useEffect(() => {
    if (section === "search") return;
    cursors.current = [null];
    page.current = 1;
    maxPage.current = undefined;
    loadingMore.current = false;
    setPageInfo(undefined);
    setJumpPage("1");
  }, [section, sourceId, scope.search, scope.comicCategory, scope.comicCategoryParam, JSON.stringify(options), rankingOption, exploreIndex]);
  useEffect(() => {
    if (section !== "search" || scope.remoteId) return;
    // Aggregate search starts on form submit. Entering a source search page
    // from a result row or a detail tag is itself the explicit search action;
    // returning to a page uses its cached state and never repeats the request.
    const autoStartedPage =
      searchMode === "single" &&
      autoStartSearchPageIds.current.has(singleSearchPageKey);
    if (searchSubmitRevision === 0 && !autoStartedPage) return;
    if (!sourcesLoaded || (searchMode === "aggregate" && !aggregateSelectionInitialized.current)) return;
    if (!scope.search) {
      generation.current++;
      aggregateGeneration.current++;
      setAggregateBusy(false);
      setAggregateGroups([]);
      setAggregateFailures([]);
      setAggregateTotal(0);
      setAggregateError("");
      setCards([]);
      setError("");
      return;
    }
    if (searchMode === "single" && (!sourceId || optionsSourceId !== sourceId)) return;
    // Source selection is only a draft until the user submits the search.
    // Keep each submitted query's work keyed to its page. Navigation back from
    // a single-source page must not restart the aggregate request, even if a
    // different page was submitted in between.
    const key = searchMode === "single"
      ? singleSearchRequestKey
      : `aggregate:${scope.comicSearchId || "legacy"}:${scope.search}`;
    if (loadedSearchKeys.current.has(key)) return;
    loadedSearchKeys.current.add(key);
    if (searchMode === "single" && sourceId) {
      void singleSearchPageLoaderRef.current(
        singleSearchPageKey,
        sourceId,
        scope.search,
        singleSearchPage.submittedOptions,
        1,
        false,
        singleSearchPage,
      );
    } else {
      void loadPageRef.current(1);
    }
  }, [section, scope.remoteId, scope.search, scope.comicSearchId, searchMode, sourceId, singleSearchPageKey, singleSearchRequestKey, JSON.stringify(singleSearchPage.submittedOptions), optionsSourceId, searchSubmitRevision, sourcesLoaded, aggregateIds.join(",")]);
  useEffect(() => {
    if (section === "categories") {
      generation.current++;
      setCards([]);
      setError("");
      setBusy(false);
      return;
    }
    if (section === "search" || scope.remoteId || ["home", "categories", "sourceManager"].includes(section)) return;
    void loadPage(page.current);
    return () => {
      generation.current++;
    };
  }, [section, scope.remoteId, loadPage]);
  useEffect(() => {
    if (!scope.remoteId || !scope.providerId) {
      setDetails(undefined);
      setReader(undefined);
      return;
    }
    let live = true;
    const requestKey = `${scope.providerId}\u0000${scope.remoteId}`;
    setDetailRecord({ key: requestKey, status: "loading" });
    setReader(undefined);
    setChapterOrderReversed(false);
    setBusy(true);
    setError("");
    setSelected([]);
    void api()
      .details({ sourceId: scope.providerId, comicId: scope.remoteId })
      .then(async (d) => {
        if (!live) return;
        setDetails(d);
        if (scope.remoteKind !== "chapter") finishDetailSkeleton(requestKey);
        if (scope.remoteKind === "chapter") {
          const item = await api().readerItem({
            sourceId: scope.providerId!,
            comicId: scope.remoteId!,
            chapterId: scope.comicChapterId ?? null,
          });
          if (live) setReader(item);
        } else setReader(undefined);
      })
      .catch((e) => {
        if (live) {
          const message = formatComicError(e);
          setDetailRecord({ key: requestKey, status: "error", error: message });
          setError(message);
        }
      })
      .finally(() => {
        if (live) setBusy(false);
      });
    return () => {
      live = false;
    };
  }, [
    scope.remoteId,
    scope.providerId,
    scope.remoteKind,
    scope.comicChapterId,
  ]);
  async function run(operation: () => Promise<unknown>, reload = false) {
    const ownerPageKey = pageStateKey;
    setError("");
    try {
      await operation();
      await refresh();
      if (reload && scope.remoteId && scope.providerId)
        setDetails(
          await api().details({
            sourceId: scope.providerId,
            comicId: scope.remoteId,
          }),
        );
    } catch (e) {
      if (pageStateKeyRef.current === ownerPageKey)
        setError(formatComicError(e));
    }
  }
  async function retryDetail() {
    if (!scope.providerId || !scope.remoteId) return;
    const key = detailKey;
    setDetailRecord({ key, status: "loading" });
    setSkeletonExitIdentity(null);
    setBusy(true);
    setError("");
    try {
      const value = await api().details({ sourceId: scope.providerId, comicId: scope.remoteId }, true);
      if (detailKeyRef.current === key) {
        setDetails(value);
        finishDetailSkeleton(key);
      }
    } catch (e) {
      if (detailKeyRef.current === key) {
        const message = formatComicError(e);
        setDetailRecord({ key, status: "error", error: message });
        setError(message);
      }
    } finally {
      if (detailKeyRef.current === key) setBusy(false);
    }
  }
  async function setQuickSourceEnabled(source: ComicSourceInfo, enabled: boolean) {
    setSourceQuickBusy(true);
    setError("");
    try {
      await api().enable(source.id, enabled);
      await refresh();
    } catch (e) {
      setError(formatComicError(e));
    } finally {
      setSourceQuickBusy(false);
    }
  }
  async function setAllQuickSourcesEnabled(enabled: boolean) {
    const changed = sources.filter((source) => source.enabled !== enabled);
    if (!changed.length) return;
    setSourceQuickBusy(true);
    setError("");
    try {
      for (const source of changed) await api().enable(source.id, enabled);
      await refresh();
    } catch (e) {
      setError(formatComicError(e));
      await refresh();
    } finally {
      setSourceQuickBusy(false);
    }
  }
  function reorderHomeSources(draggedId: string, targetId: string) {
    if (!draggedId || draggedId === targetId) return;
    const reordered = [...homeSources];
    const from = reordered.findIndex((source) => source.id === draggedId);
    const to = reordered.findIndex((source) => source.id === targetId);
    if (from < 0 || to < 0) return;
    const [dragged] = reordered.splice(from, 1);
    reordered.splice(to, 0, dragged);
    const order = reordered.map((source) => source.id);
    setSourceOrder(order);
    localStorage.setItem("comic:home-source-order", JSON.stringify(order));
    setSourceSort("custom");
    localStorage.setItem("comic:home-source-sort", "custom");
    setDraggingSourceId(undefined);
    setDragOverSourceId(undefined);
  }
  function open(card: OnlineComic) {
    const identity = `comic-online-card:${card.sourceId}:${card.comicId}`;
    const origin = cardOrigin.current;
    cardOrigin.current = null;
    detailPreview.current = {
      identity,
      sourceId: card.sourceId,
      comicId: card.comicId,
      title: card.title,
      cover: card.cover || "",
      sourceName: sources.find((source) => source.id === card.sourceId)?.name || "漫画源",
      origin: origin?.identity === identity ? origin.rect : undefined,
    };
    enteringDetailIdentity.current = null;
    go({
      providerId: card.sourceId,
      remoteId: card.comicId,
      remoteKind: "comic",
    }, "push");
  }
  const detailPage = !!scope.remoteId && scope.remoteKind !== "chapter";
  const detailIdentity = scope.providerId && scope.remoteId
    ? `comic-online-card:${scope.providerId}:${scope.remoteId}`
    : "";
  const sourceName = sources.find((source) => source.id === (details?.sourceId || scope.providerId))?.name || detailPreview.current?.sourceName || "漫画源";
  function rememberDetailCover(image: HTMLImageElement) {
    if (!image.complete || image.naturalWidth <= 0) return;
    const rect = image.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    lastDetailCover.current = {
      identity: detailIdentity,
      cover: image.currentSrc || image.src,
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
    };
  }
  function captureComicCardOrigin(target: Element) {
    const hubCover = target.closest<HTMLElement>(".comic-hub-cover");
    const hubCard = hubCover?.closest<HTMLElement>(".comic-hub-card");
    const poster = target.closest<HTMLElement>(".poster");
    const node = hubCover || poster;
    const identity = hubCard?.dataset.comicTransitionId || poster?.dataset.mediaId || "";
    const rect = node?.getBoundingClientRect();
    const image = node?.querySelector<HTMLImageElement>("img");
    const cover = image?.complete && image.naturalWidth > 0
      ? image.currentSrc || image.src
      : "";
    cardOrigin.current = node && rect && rect.width > 0 && rect.height > 0
      ? { identity, cover, rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height } }
      : null;
  }
  function clearComicFlight() {
    comicFlightToken.current++;
    const flight = activeComicFlight.current;
    activeComicFlight.current = null;
    if (!flight) return;
    flight.animation?.cancel();
    if (flight.target.isConnected) flight.target.style.visibility = flight.originalVisibility;
    flight.node.remove();
  }
  function flyComicCover(src: string, from: ComicTransitionRect, target: HTMLElement) {
    if (reducedMotion) return;
    if (!src || !target.isConnected || from.width <= 0 || from.height <= 0) {
      showDetailFallbackFade();
      return;
    }
    clearComicFlight();
    const token = comicFlightToken.current;
    const image = document.createElement("img");
    image.className = "comic-detail-cover-flight";
    Object.assign(image.style, {
      left: `${from.left}px`,
      top: `${from.top}px`,
      width: `${from.width}px`,
      height: `${from.height}px`,
      borderRadius: "10px",
    });
    const flight = {
      node: image,
      target,
      originalVisibility: target.style.visibility,
      animation: undefined as Animation | undefined,
    };
    let imageHandled = false;
    activeComicFlight.current = flight;
    const finishWithoutFlight = (fade: boolean) => {
      if (comicFlightToken.current !== token || activeComicFlight.current !== flight) return;
      activeComicFlight.current = null;
      image.remove();
      if (fade) showDetailFallbackFade();
    };
    image.onload = () => {
      if (imageHandled) return;
      imageHandled = true;
      if (comicFlightToken.current !== token || activeComicFlight.current !== flight) return;
      if (image.naturalWidth <= 0) {
        finishWithoutFlight(true);
        return;
      }
      void image.decode().catch(() => {}).then(() => {
        if (comicFlightToken.current !== token || activeComicFlight.current !== flight) return;
        const liveTarget = target.isConnected
          ? target
          : comicRoot.current?.querySelector<HTMLElement>(".comic-detail-cover, .comic-detail-cover-empty");
        if (!liveTarget) {
          finishWithoutFlight(false);
          return;
        }
        const to = liveTarget.getBoundingClientRect();
        if (to.width <= 0 || to.height <= 0) {
          finishWithoutFlight(true);
          return;
        }
        flight.target = liveTarget;
        flight.originalVisibility = liveTarget.style.visibility;
        liveTarget.style.visibility = "hidden";
        document.body.append(image);
        const animation = image.animate(
          [
            { left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px`, borderRadius: "10px" },
            { left: `${to.left}px`, top: `${to.top}px`, width: `${to.width}px`, height: `${to.height}px`, borderRadius: getComputedStyle(liveTarget).borderRadius || "10px" },
          ],
          { duration: 420, easing: "cubic-bezier(.2,.75,.25,1)", fill: "both" },
        );
        flight.animation = animation;
        void animation.finished.catch(() => {}).then(() => {
          if (comicFlightToken.current !== token || activeComicFlight.current !== flight) return;
          if (liveTarget.isConnected) liveTarget.style.visibility = flight.originalVisibility;
          image.remove();
          activeComicFlight.current = null;
        });
      });
    };
    image.onerror = () => {
      if (imageHandled) return;
      imageHandled = true;
      finishWithoutFlight(true);
    };
    image.src = src;
    if (image.complete) queueMicrotask(() => {
      if (image.naturalWidth > 0) image.onload?.(new Event("load"));
      else image.onerror?.(new Event("error"));
    });
  }
  function findComicCardTarget(identity: string) {
    const candidates = comicRoot.current?.querySelectorAll<HTMLElement>(
      ".poster[data-media-id],[data-comic-transition-id]",
    );
    const card = Array.from(candidates || []).find(
      (node) => (node.dataset.comicTransitionId || node.dataset.mediaId) === identity,
    );
    return card?.querySelector<HTMLElement>("img") || card;
  }
  function showDetailFallbackFade() {
    if (reducedMotion) return;
    if (detailFallbackFadeTimer.current != null)
      window.clearTimeout(detailFallbackFadeTimer.current);
    setDetailFallbackFade(true);
    detailFallbackFadeTimer.current = window.setTimeout(() => {
      setDetailFallbackFade(false);
      detailFallbackFadeTimer.current = undefined;
    }, 280);
  }
  useLayoutEffect(() => {
    if (detailPage) {
      const root = comicRoot.current;
      const cover = root?.querySelector<HTMLElement>(
        ".comic-detail-cover, .comic-detail-cover-empty",
      );
      const preview = detailPreview.current;
      if (lastDetailCover.current?.identity !== detailIdentity)
        lastDetailCover.current = null;
      if (cover) {
        const image = cover instanceof HTMLImageElement ? cover : cover.querySelector("img");
        if (image) rememberDetailCover(image);
      }
      previousDetailPage.current = true;
      if (enteringDetailIdentity.current !== detailIdentity) {
        enteringDetailIdentity.current = detailIdentity;
        const fromChapter = previousRemoteKind.current === "chapter";
        const target = root?.querySelector<HTMLElement>(
          ".comic-detail-cover, .comic-detail-cover-empty",
        );
        if (!fromChapter && !reducedMotion) {
          if (preview?.identity === detailIdentity && preview.origin && preview.cover && target)
            flyComicCover(preview.cover, preview.origin, target);
          else
            showDetailFallbackFade();
        }
      }
    } else {
      const leavingDetail = previousDetailPage.current;
      previousDetailPage.current = false;
      if (leavingDetail && !scope.remoteId) {
        const source = lastDetailCover.current;
        let attempts = 0;
        const findTarget = () => {
          if (!source) {
            showDetailFallbackFade();
            return;
          }
          const target = findComicCardTarget(source.identity);
          if (target) {
            if (!reducedMotion) flyComicCover(source.cover, source.rect, target);
            return;
          }
          if (attempts++ < 8) {
            comicFlightFrame.current = requestAnimationFrame(findTarget);
          } else {
            showDetailFallbackFade();
          }
        };
        findTarget();
      }
    }
    previousRemoteKind.current = scope.remoteKind;
  }, [detailPage, detailIdentity, details?.cover, scope.remoteKind, scope.remoteId, reducedMotion]);
  useEffect(() => () => {
    clearComicFlight();
    if (comicFlightFrame.current != null) cancelAnimationFrame(comicFlightFrame.current);
    if (detailSkeletonExitTimer.current != null) window.clearTimeout(detailSkeletonExitTimer.current);
    if (detailFallbackFadeTimer.current != null) window.clearTimeout(detailFallbackFadeTimer.current);
  }, []);
  const items = useMemo<MediaItem[]>(
    () =>
      displayCards.map((c) => ({
        id: `comic-online-card:${c.sourceId}:${c.comicId}`,
        type: "comic",
        title: c.title,
        artist: [c.subtitle, sources.find((source) => source.id === c.sourceId)?.name]
          .filter(Boolean)
          .join(" · "),
        path: "",
        folder: "",
        ext: "online",
        size: 0,
        modifiedAt: 0,
        addedAt: 0,
        favorite: false,
        missing: false,
        cover: c.cover,
        remoteCover: c.cover,
        libraryIds: [],
        remoteData: { comicRef: refOf(c), comic: c },
      })),
    [displayCards, sources],
  );
  const source = useMemo(
    () =>
      new PagedMediaSource(
        { type: "comic", sort: "name" },
        async (q) => ({
          items: items.slice(q.offset || 0, (q.offset || 0) + (q.limit || 100)),
          total: items.length,
        }),
        true,
      ),
    [items],
  );
  useEffect(() => {
    void source.initialize();
    return () => source.dispose();
  }, [source]);
  const props = {
    source,
    scope,
    memory,
    remember,
    interactive:
      (!scope.remoteId || (!details && !busy && !!error)) &&
      section !== "sourceManager",
    reducedMotion,
    open: (item: MediaItem) => open(item.remoteData!.comic),
    favorite: (item: MediaItem) => {
      void run(() => api().favorite(item.remoteData!.comicRef, true));
    },
    onReachEnd: loadNextWaterfallPage,
    minimumCellWidth: singleResultPage ? 280 : 230,
  };
  const parts =
    (categoryData?.sourceId === current?.id
      ? categoryData?.value?.parts
      : undefined) || current?.categories?.parts || [];
  const title = {
    home: "漫画",
    favorites: "本地收藏",
    discover: "发现",
    categories: "分类",
    categoryResults: scope.comicCategory || "分类结果",
    sourceManager: "漫画源",
    search: searchMode === "single" && current ? `${current.name} · 搜索结果` : "搜索漫画",
    readLater: "稍后阅读",
    following: "追更",
    downloads: "已下载",
  }[section] || "漫画";
  const openHubItem = (item: HubCardItem) =>
    isOnlineComic(item) ? open(item) : openLocal(item);
  const openSingleSearchPage = (searchSourceId: string, keyword: string) => {
    const id = newComicSearchId();
    const searchSource = sources.find((source) => source.id === searchSourceId);
    const initial = singleSearchPageDefaults(
      searchSourceId,
      keyword,
      (searchSource?.searchOptions || []).map(sourceOptionDefault),
    );
    autoStartSearchPageIds.current.add(id);
    setSingleSearchPages((pages) => ({ ...pages, [id]: initial }));
    go({
      section: "search",
      providerId: searchSourceId,
      search: keyword,
      searchMode: "single",
      comicSearchId: id,
    }, "push");
  };
  const setLater = async (item: HubCardItem, value: boolean) => {
    const ref: ComicHubRef = isOnlineComic(item)
      ? { kind: "online", sourceId: item.sourceId, comicId: item.comicId }
      : { kind: "local", mediaId: item.id };
    await hub().set("readLater", ref, value);
    await refresh();
  };
  const laterIds = new Set(
    laterRefs.map((ref) =>
      ref.kind === "local"
        ? `local:${ref.mediaId}`
        : `online:${ref.sourceId}:${ref.comicId}`,
    ),
  );
  const homeItems = (items: OnlineComic[], locals: MediaItem[]) =>
    [...items, ...locals].slice(0, 10);
  const needsSource = ["discover", "categories", "categoryResults"].includes(
    section,
  ) || (section === "search" && searchMode === "single");
  const wallNavigation = {
    title,
    identity: `online-comics:${sourceId || ""}:${section}:${scope.search || ""}`,
    sourceKind: "online" as const,
    content: (
      <div className="comic-wall-navigation">
        <strong>{title}</strong>
        <nav aria-label="漫画页面">
          {["home", "favorites", "discover", "categories", "search"].map((key) => (
            <button key={key} onClick={() => go({ section: key, search: undefined, ...(key === "search" ? { comicSearchId: newComicSearchId() } : {}) }, "root")}>
              {{ home: "首页", favorites: "本地收藏", discover: "发现", categories: "分类", search: "搜索" }[key]}
            </button>
          ))}
        </nav>
      </div>
    ),
    empty: {
      message: displayError || (displayBusy ? "正在加载漫画…" : "暂无漫画"),
      loading: displayBusy,
      action: () => void loadVisiblePage(displayPage),
      actionLabel: "重试",
    },
  };
  return (
    <ReadingPageShell
      ref={comicRoot}
      className={`${detailPage ? " is-detail-page" : ""}${detailFallbackFade ? " is-detail-fallback-fade" : ""}`}
      aria-label="在线漫画"
      onMouseMove={(event) => {
        const onBackButton =
          event.target instanceof Element &&
          Boolean(event.target.closest(".comic-single-search-back"));
        if (!onBackButton && event.clientX <= 44) setComicMenuOpen(true);
        if (!onBackButton) onSearchPointerMove(event);
      }}
      onClickCapture={(event) => captureComicCardOrigin(event.target as Element)}
      onPointerDownCapture={onSearchPointerDown}
    >
      {section === "sourceManager" ? (
        <SourceManager
          sources={homeSources}
          refresh={refresh}
          close={() => {
            if (!onBack()) go({ section: "home" }, "replace");
          }}
        />
      ) : (
      <>
        <ReadingHubMenu title="漫画" open={comicMenuOpen} close={() => setComicMenuOpen(false)} section={section} items={COMIC_MENU_ITEMS} navigate={key => go({ section: key, search: undefined, searchMode: "aggregate", ...(key === "search" ? { comicSearchId: newComicSearchId() } : {}) }, "root")} />
      {!scope.remoteId && ["discover", "categories", "categoryResults"].includes(section) && <header className="online-toolbar">
        {(section === "discover" || (singleResultPage && section === "categoryResults")) && <div className="online-row">
          <span className="spacer" />
          {section === "discover" && activeExploreTab && (
            <IconButton
              label="刷新发现"
              disabled={busy}
              onClick={() => {
                page.current = 1;
                cursors.current = [null];
                void loadPage(1);
              }}
            >
              <RefreshCw size={16} />
            </IconButton>
          )}
          {singleResultPage && section === "categoryResults" ? (
            <div className="comic-result-controls">
              <label>布局<select aria-label="单源结果布局" value={resultLayout} onChange={(event) => saveResultPreference("layout", event.target.value as "grid" | "archiveShelf" | "carousel")}>
                <option value="grid">标准网格</option><option value="archiveShelf">立体书架</option><option value="carousel">封面流</option>
              </select></label>
              <label>结果<select aria-label="结果加载方式" value={resultMode} onChange={(event) => { saveResultPreference("mode", event.target.value as "pagination" | "waterfall"); page.current = 1; cursors.current = [null]; void loadPage(1); }}>
                <option value="pagination">分页</option><option value="waterfall">瀑布流</option>
              </select></label>
            </div>
          ) : null}
        </div>}
        {section === "discover" && (
          <div className="online-tabs comic-discovery-tabs" role="tablist" aria-label="发现栏目">
            {exploreTabs.map((tab) => (
              <button
                type="button"
                role="tab"
                key={tab.key}
                aria-selected={tab.key === activeExploreTab?.key}
                className={tab.key === activeExploreTab?.key ? "active" : ""}
                title={`${tab.title} · ${tab.sourceName}`}
                onClick={() => {
                  setExploreIndex(tab.index);
                  localStorage.setItem("comic:active-source", tab.sourceId);
                  localStorage.setItem(
                    "comic:active-explore",
                    JSON.stringify({ sourceId: tab.sourceId, index: tab.index }),
                  );
                  go({
                    section: "discover",
                    providerId: tab.sourceId,
                    search: undefined,
                  }, "replace");
                }}
              >
                {tab.title}
              </button>
            ))}
            {!exploreTabs.length && <span className="muted">当前没有可用的发现栏目</span>}
          </div>
        )}
        {needsSource && section !== "categoryResults" && section !== "search" && section !== "discover" && (
          <div
            className="comic-source-pills online-source-selector"
            aria-label="选择漫画源"
          >
            {homeSources
                  .filter((source) => source.enabled && (section !== "categories" || source.capabilities.categories))
                  .map((source) => (
                    <button
                      type="button"
                      key={source.id}
                      className={source.id === sourceId ? "active" : ""}
                      aria-pressed={source.id === sourceId}
                      onClick={() => {
                        localStorage.setItem("comic:active-source", source.id);
                        go({
                          providerId: source.id,
                          section: section === "categories" ? "categories" : "search",
                          search: undefined,
                          searchMode: section === "categories" ? undefined : "single",
                        }, "push");
                      }}
                    >
                      {source.name}
                    </button>
                  ))}
            {!homeSources.some((source) => source.enabled) && (
              <span className="muted">还没有启用的漫画源</span>
            )}
          </div>
        )}
        {!scope.remoteId && section === "categories" && current && (
          <div className="online-category-browser">
            {parts.map((part: any, i: number) => {
              const entries = part.items || (part.categories || []).map(
                (label: string, index: number) => ({
                  label,
                  target: {
                    action: part.itemType === "search" ? "search" : "category",
                    keyword: label,
                    param: part.categoryParams?.[index] ?? part.groupParam ?? null,
                  },
                }),
              );
              return (
                <section className="online-category-part" key={`${part.name || "part"}:${i}`}>
                  <h2>{part.name}</h2>
                  <div className="online-category-options">
                    {entries.map((item: any, index: number) => {
                      const target = item.target || {},
                        attributes = target.attributes || target;
                      return (
                        <button
                          className="button secondary"
                          key={`${item.label || "category"}:${index}`}
                          onClick={() => {
                            if (target.page === "search" || target.action === "search") {
                              openSingleSearchPage(current.id, String(attributes.keyword || item.label));
                            } else {
                              go({
                                section: "categoryResults",
                                providerId: current.id,
                                searchMode: "single",
                                comicCategory: attributes.category || attributes.keyword || item.label,
                                comicCategoryParam: attributes.param ?? null,
                              }, "push");
                            }
                          }}
                        >
                          {item.label}
                        </button>
                      );
                    })}
                  </div>
                </section>
              );
            })}
            {current.categories?.enableRankingPage && (current.rankingOptions || []).length > 0 && (
              <section className="online-category-part">
                <h2>排行</h2>
                <div className="online-category-options">
                  {current.rankingOptions.map((option, index) => (
                    <button
                      className="button secondary"
                      key={`${optionValue(option)}:${index}`}
                      onClick={() => go({
                        section: "categoryResults",
                        providerId: current.id,
                        comicCategory: "__ranking",
                        comicCategoryParam: optionValue(option),
                      }, "push")}
                    >
                      {optionText(option)}
                    </button>
                  ))}
                </div>
              </section>
            )}
            {!parts.length && !current.categories?.enableRankingPage && (
              <p className="muted">此漫画源没有提供分类页。</p>
            )}
          </div>
        )}
        {!scope.remoteId && section === "categoryResults" && current && (
          <div className="online-filters">
            <SourceOptions specs={current.categoryOptions} values={options} change={setOptions} />
          </div>
        )}
      </header>}
      {singleResultPage && (
        <button
          type="button"
          className="icon-button comic-single-search-back"
          aria-label="返回上一页"
          title="返回上一页"
          onClick={() => {
            clearSearchPanelHideTimer();
            setSearchPanelVisible(false);
            setComicMenuOpen(false);
            if (!onBack()) go({ section: "home" }, "replace");
          }}
        >
          <ArrowLeft size={17} />
        </button>
      )}
      {detailPage && (
        <header className="comic-detail-toolbar">
          <button className="button secondary comic-detail-back" onClick={() => {
            if (!onBack())
              go({ remoteId: undefined, remoteKind: undefined, comicChapterId: undefined }, "replace");
          }}>
            <ArrowLeft size={17} /> 返回
          </button>
          <span>{sourceName}</span>
          <span className="spacer" />
          {detailStatus === "ready" && (
            <IconButton
              label="刷新漫画详情"
              disabled={busy}
              onClick={() => void run(async () => {
                setDetails(await api().details({ sourceId: scope.providerId!, comicId: scope.remoteId! }, true));
              })}
            ><RefreshCw size={16} /></IconButton>
          )}
        </header>
      )}
      {!scope.remoteId && section === "search" && (
        <ReadingSearchPanel kind="漫画" mode={searchMode} sourceName={current?.name} query={displaySearchQuery} change={setSearchQueryDraft} submit={() => submitSearch(displaySearchQuery)} clear={() => { setSearchQueryDraft(""); go({ search: undefined }); }} hasQuery={!!scope.search} canSearch={canSearch} visible={searchPanelVisible} inputRef={searchInput} panelRef={searchPanel} sources={searchableSources} selected={aggregateIds} select={setAggregateIds}
          extra={current && <div className="comic-search-extra-controls"><div className="online-filters"><SourceOptions specs={current.searchOptions} values={displaySearchOptions} change={setSearchOptionsDraft}/></div>{singleResultPage && <ReadingResultControls layout={displayResultLayout} mode={displayResultMode} changeLayout={value => saveResultPreference("layout", value)} changeMode={value => saveResultPreference("mode", value)}/>}</div>}>
          {!scope.search && <ReadingSearchHistory terms={searchHistory} collapsed={searchHistoryCollapsed} toggle={() => setSearchHistoryCollapsedPersisted(!searchHistoryCollapsed)} clear={clearSearchHistory} remove={removeSearchHistoryItem} submit={submitSearch} disabled={!canSearch}/>}
        </ReadingSearchPanel>
      )}
      {displayError && !scope.remoteId && (
        <div className="online-error" role="alert">
          {displayError}
          <button
            className="text-button"
            onClick={() => void loadVisiblePage(displayPage)}
          >
            重试
          </button>
        </div>
      )}
      {displayBusy && !scope.remoteId && (
        <div className={`online-loading${section === "search" ? " is-search-loading" : ""}`} role="status">
          <LoaderCircle className="spin" size={20} /> 正在加载…
        </div>
      )}
      {detailPage && !details ? detailStatus === "loading" ? (
        <ComicDetailSkeleton
          sourceName={detailPreview.current?.identity === detailIdentity ? detailPreview.current.sourceName : sourceName}
          title={detailPreview.current?.identity === detailIdentity ? detailPreview.current.title : undefined}
          cover={detailPreview.current?.identity === detailIdentity ? detailPreview.current.cover : undefined}
        />
      ) : (
        <div className="online-detail-error" role="alert">
          <h2>暂时无法加载漫画详情</h2>
          <p>{detailError || "请检查网络后重试。"}</p>
          <button className="button primary" disabled={busy} onClick={() => void retryDetail()}>
            {busy ? "重试中…" : "重试"}
          </button>
        </div>
      ) : detailPage && details ? (
        <div className="comic-detail-transition-scene">
        <main className="online-detail comic-detail-loaded">
          <ReadingDetailHero source={sourceName} title={details.title} cover={details.cover} subtitle={details.subtitle} onCoverLoad={event=>rememberDetailCover(event.currentTarget)} metadata={<>
              {details.updateTime && <p className="comic-detail-updated">更新于 {details.updateTime}</p>}
              {details.offline && (
                <p className="comic-detail-offline muted">
                  {details.refreshError
                    ? `刷新失败：${formatComicError(details.refreshError)}，当前显示已保存的信息。`
                    : "当前显示已保存的信息。"}
                </p>
              )}
          </>} actions={<>
                <button
                  className="button primary"
                  onClick={() => {
                    const c = details.chapters.find((chapter) => chapter.id === details.lastChapterId) || details.chapters[0];
                    if (c) go({ remoteId: details.comicId, providerId: details.sourceId, remoteKind: "chapter", comicChapterId: c.id }, "push");
                  }}
                  disabled={!details.chapters.length}
                ><BookOpen size={16} />{details.lastChapterId ? "继续阅读" : "开始阅读"}</button>
                <button className="button secondary" onClick={() => void run(() => api().favorite(refOf(details), !details.favorite), true)}>
                  <Heart size={16} />{details.favorite ? "移出本地收藏" : "加入本地收藏"}
                </button>
                <button className="button secondary" onClick={() => void setLater(details, !laterIds.has(comicId(details)))}>
                  <BookmarkPlus size={16} />{laterIds.has(comicId(details)) ? "已加入稍后阅读" : "稍后阅读"}
                </button>
                <button className="button secondary" onClick={() => void run(async () => {
                  await hub().set("following", { kind: "online", sourceId: details.sourceId, comicId: details.comicId }, !follows.some((state) => state.ref.sourceId === details.sourceId && state.ref.comicId === details.comicId));
                  setFollows(await hub().following());
                })}>
                  {follows.some((state) => state.ref.sourceId === details.sourceId && state.ref.comicId === details.comicId) ? "取消追更" : "追更"}
                </button>
          </>}/>
          {details.description?.trim() && (
            <section className="comic-detail-section comic-detail-description-section">
              <h2>简介</h2>
              <p className="online-description">{details.description}</p>
            </section>
          )}
          {details.tags && typeof details.tags === "object" && Object.entries(details.tags as Record<string, unknown>).some(([, values]) => Array.isArray(values) ? values.length > 0 : !!values) && (
            <section className="comic-detail-section comic-detail-information">
              <h2>信息</h2>
              {Object.entries(details.tags as Record<string, unknown>).map(([group, rawValues]) => {
                const values = Array.isArray(rawValues) ? rawValues : rawValues == null || rawValues === "" ? [] : [rawValues];
                if (!values.length) return null;
                return <div className="comic-detail-tag-group" key={group}>
                  <strong>{group}</strong>
                  <div>{values.map((value, index) => <button className="comic-detail-tag" key={`${String(value)}-${index}`} onClick={() => openSingleSearchPage(details.sourceId, String(value))}>{String(value)}</button>)}</div>
                </div>;
              })}
            </section>
          )}
          <section className="comic-detail-section comic-detail-chapter-section">
            <div className="comic-detail-section-heading">
              <div><h2>章节</h2><span>{details.chapters.length} 话</span></div>
              <div className="comic-detail-chapter-tools">
                <button className="text-button" onClick={() => setChapterOrderReversed((value) => !value)}>{chapterOrderReversed ? "正序" : "倒序"}</button>
                <button className="text-button" onClick={() => void run(() => api().enqueue(refOf(details), details.chapters.map((chapter) => chapter.id)))}><Download size={14} />下载全部</button>
                <button className="text-button" disabled={!details.chapters.length} onClick={() => setSelected(selected.length === details.chapters.length && details.chapters.length > 0 ? [] : details.chapters.map((chapter) => chapter.id))}>{selected.length === details.chapters.length && details.chapters.length > 0 ? "取消全选" : "全选"}</button>
                <button className="text-button" disabled={!details.chapters.some((chapter) => !chapter.progress?.completed)} onClick={() => void run(() => api().enqueue(refOf(details), details.chapters.filter((chapter) => !chapter.progress?.completed).map((chapter) => chapter.id)))}><Download size={14} />下载未读</button>
              </div>
            </div>
            {!!selected.length && <div className="online-row online-download-actions">
              <button className="button" onClick={() => void run(() => api().enqueue(refOf(details), selected))}><Download size={15} />下载所选 {selected.length}</button>
            </div>}
            {details.chapters.length ? <div className="online-chapters">
              {(chapterOrderReversed ? [...details.chapters].reverse() : details.chapters).map((chapter, index) => (
                <div key={chapter.id ?? "body"}>
                  <input type="checkbox" aria-label={`选择 ${chapter.title}`} checked={selected.includes(chapter.id)} onChange={(e) => setSelected((old) => e.target.checked ? [...old, chapter.id] : old.filter((c) => c !== chapter.id))} />
                  <button onClick={() => go({ providerId: details.sourceId, remoteId: details.comicId, remoteKind: "chapter", comicChapterId: chapter.id }, "push")}>
                    <span>{chapter.group ? `${chapter.group} · ` : ""}{chapter.title}</span>
                    <small>{chapter.downloaded ? "已下载" : chapter.progress?.completed ? "已读" : chapter.progress?.page != null ? `阅读中 · 第 ${chapter.progress.page} 页` : `第 ${details.chapters.length - (chapterOrderReversed ? index + 1 : index)} 话`}</small>
                  </button>
                  <IconButton label={`下载 ${chapter.title}`} onClick={() => void run(() => api().enqueue(refOf(details), [chapter.id]))}><Download size={14} /></IconButton>
                </div>
              ))}
            </div> : <p className="muted">这个漫画源暂未提供章节列表。</p>}
          </section>
        </main>
        {skeletonExitIdentity === detailKey && (
          <ComicDetailSkeleton
            sourceName={sourceName}
            title={details.title}
            cover={detailPreview.current?.identity === detailIdentity ? detailPreview.current.cover || details.cover : details.cover}
            exiting
          />
        )}
        </div>
      ) : section === "home" ? (
        <main className="comic-home">
          <section className="comic-home-row comic-home-sources">
            <div className="comic-home-heading">
              <button className="text-button comic-source-management-entry" onClick={() => go({ section: "sourceManager" }, "push")}>
                漫画源 <span>{sources.filter((source) => source.enabled).length}</span>
                <ArrowRight size={14} />
              </button>
              <span className="spacer" />
              <div className="comic-source-tools" ref={sourceQuickMenu}>
                <button
                  type="button"
                  className="icon-button comic-source-tools-trigger"
                  aria-label="漫画源排序与激活"
                  title="漫画源排序与激活"
                  aria-haspopup="dialog"
                  aria-expanded={sourceQuickMenuOpen}
                  onClick={() => setSourceQuickMenuOpen((open) => !open)}
                >
                  <ArrowDownUp size={16} />
                </button>
                {sourceQuickMenuOpen && (
                  <div className="comic-source-tools-menu" role="dialog" aria-label="漫画源排序与激活">
                    <label className="comic-source-sort-control">
                      <span>排序方式</span>
                      <select
                        value={sourceSort}
                        onChange={(event) => {
                          const value = event.target.value as typeof sourceSort;
                          if (value === "custom" && !sourceOrder.length) {
                            const order = homeSources.map((source) => source.id);
                            setSourceOrder(order);
                            localStorage.setItem("comic:home-source-order", JSON.stringify(order));
                          }
                          setSourceSort(value);
                          localStorage.setItem("comic:home-source-sort", value);
                        }}
                      >
                        <option value="default">默认顺序</option>
                        <option value="name-asc">名称升序</option>
                        <option value="name-desc">名称降序</option>
                        <option value="custom">自定义</option>
                      </select>
                    </label>
                    <div className="comic-source-bulk-actions">
                      <button type="button" disabled={sourceQuickBusy || sources.every((source) => source.enabled)} onClick={() => void setAllQuickSourcesEnabled(true)}>全部激活</button>
                      <button type="button" disabled={sourceQuickBusy || sources.every((source) => !source.enabled)} onClick={() => void setAllQuickSourcesEnabled(false)}>全部停用</button>
                    </div>
                    <div className="comic-source-quick-list">
                      {homeSources.map((source) => (
                        <div
                          className={`comic-source-quick-row${dragOverSourceId === source.id ? " is-drop-target" : ""}${draggingSourceId === source.id ? " is-dragging" : ""}`}
                          key={source.id}
                          onDragOver={(event) => {
                            event.preventDefault();
                            if (draggingSourceId && draggingSourceId !== source.id) setDragOverSourceId(source.id);
                          }}
                          onDrop={(event) => {
                            event.preventDefault();
                            reorderHomeSources(event.dataTransfer.getData("text/plain") || draggingSourceId || "", source.id);
                          }}
                          onDragEnd={() => {
                            setDraggingSourceId(undefined);
                            setDragOverSourceId(undefined);
                          }}
                        >
                          <input
                            id={`comic-source-enabled-${source.id}`}
                            type="checkbox"
                            checked={source.enabled}
                            disabled={sourceQuickBusy}
                            onChange={(event) => void setQuickSourceEnabled(source, event.target.checked)}
                          />
                          <label htmlFor={`comic-source-enabled-${source.id}`}>
                            <span>{source.name}</span>
                            <small>{source.enabled ? "已激活" : "未激活"}</small>
                          </label>
                          <button
                            type="button"
                            className="comic-source-drag-handle"
                            draggable={!sourceQuickBusy}
                            aria-label={`拖动以调整 ${source.name} 的排序`}
                            title="拖动排序"
                            onDragStart={(event) => {
                              event.dataTransfer.effectAllowed = "move";
                              event.dataTransfer.setData("text/plain", source.id);
                              setDraggingSourceId(source.id);
                            }}
                          ><GripVertical size={17} /></button>
                        </div>
                      ))}
                      {!homeSources.length && <p className="muted">还没有安装漫画源。</p>}
                    </div>
                  </div>
                )}
              </div>
            </div>
            <div className="comic-source-pills">
              {homeSources.filter((source) => source.enabled).map((source) => (
                <button key={source.id} onClick={() => {
                  localStorage.setItem("comic:active-source", source.id);
                  go({ section: "discover", providerId: source.id }, "push");
                }}>{source.name}</button>
              ))}
              {!sources.some((source) => source.enabled) && <span className="muted">还没有启用的源，请进入管理页安装。</span>}
            </div>
          </section>
          <section className={`comic-home-row ${collapsedHome.history ? "is-collapsed" : ""}`}>
            <div className="comic-home-heading">
              <HomeSectionToggle
                title="最近阅读"
                count={onlineHistory.length + localRecent.length}
                collapsed={!!collapsedHome.history}
                onClick={() => toggleHomeSection("history")}
              />
            </div>
            {!collapsedHome.history && (
              <ComicCards items={homeItems(onlineHistory, localRecent)} open={openHubItem} toggleLater={setLater} laterIds={laterIds} />
            )}
          </section>
          <section className={`comic-home-row ${laterItems.length ? "" : "is-empty"} ${collapsedHome.readLater ? "is-collapsed" : ""}`}>
            <div className="comic-home-heading">
              <HomeSectionToggle
                title="稍后阅读"
                count={laterItems.length}
                collapsed={!!collapsedHome.readLater}
                onClick={() => toggleHomeSection("readLater")}
              />
              <button className="text-button" onClick={() => go({ section: "readLater" }, "push")}>查看全部 <ArrowRight size={14} /></button>
            </div>
            {!collapsedHome.readLater && <ComicCards items={laterItems.slice(0, 10)} open={openHubItem} toggleLater={setLater} laterIds={laterIds} />}
          </section>
          <section className={`comic-home-row ${localLibrary.length ? "" : "is-empty"} ${collapsedHome.local ? "is-collapsed" : ""}`}>
            <div className="comic-home-heading">
              <HomeSectionToggle
                title="本地漫画"
                count={localLibrary.length}
                collapsed={!!collapsedHome.local}
                onClick={() => toggleHomeSection("local")}
              />
              <button className="text-button" onClick={local}>浏览本地漫画 <ArrowRight size={14} /></button>
            </div>
            {!collapsedHome.local && <ComicCards items={localLibrary.slice(0, 10)} open={openHubItem} toggleLater={setLater} laterIds={laterIds} />}
          </section>
          <section className={`comic-home-row ${follows.length ? "" : "is-empty"} ${collapsedHome.following ? "is-collapsed" : ""}`}>
            <div className="comic-home-heading">
              <HomeSectionToggle
                title="追更"
                count={follows.length}
                collapsed={!!collapsedHome.following}
                onClick={() => toggleHomeSection("following")}
              />
              <button className="text-button" onClick={() => go({ section: "following" }, "push")}>查看全部 <ArrowRight size={14} /></button>
              <button className="text-button" disabled={busy || !follows.length} onClick={() => void run(async () => setFollows(await hub().checkFollowing()))}>
                <RefreshCw size={14} /> 检查更新
              </button>
            </div>
            {!collapsedHome.following && follows.some((state) => state.error) && <p className="muted">部分漫画源暂时无法检查；上次检查结果仍保留。</p>}
            {!collapsedHome.following && <ComicCards items={followItems.slice(0, 10)} open={openHubItem} toggleLater={setLater} laterIds={laterIds} />}
          </section>
          {downloaded.length > 0 && <section className="comic-home-row">
            <div className="comic-home-heading">
              <h2>已下载 <span>{downloaded.length}</span></h2>
              <button className="text-button" onClick={() => go({ section: "downloads" }, "push")}>管理下载 <ArrowRight size={14} /></button>
            </div>
            <ComicCards items={downloaded.slice(0, 10)} open={openHubItem} toggleLater={setLater} laterIds={laterIds} />
          </section>}
        </main>
      ) : (
        <>
          {section === "favorites" && (
            <div className="comic-collection-switch">
              <strong>本地收藏</strong>
              <ComicCards items={[...onlineFavorites, ...localFavorites]} open={openHubItem} toggleLater={setLater} laterIds={laterIds} />
            </div>
          )}
          {section === "readLater" && (
            <div className="comic-collection-switch">
              <ComicCards
                items={laterItems.filter((item) => !isOnlineComic(item))}
                open={openHubItem}
                toggleLater={setLater}
                laterIds={laterIds}
              />
            </div>
          )}
          {section === "following" && follows.some((state) => state.error) && (
            <p className="muted">部分源未能检查更新；保留了上次检查结果。可在漫画主页手动重试。</p>
          )}
          {section === "downloads" && tasks.length > 0 && (
            <div className="online-tasks">
              {tasks.map((task) => (
                <div key={task.id}>
                  <button
                    className="text-button"
                    onClick={() =>
                      open({
                        ...task,
                        cover: "",
                        comicId: task.comicId,
                        title: task.comicTitle,
                      })
                    }
                  >
                    {task.comicTitle} · {task.title}
                  </button>
                  <small>
                    {
                      {
                        queued: "等待",
                        downloading: "下载中",
                        paused: "已暂停",
                        completed: "已完成",
                        failed: "失败",
                      }[task.state]
                    }{" "}
                    · {task.done}/{task.total || "?"}
                  </small>
                  <progress
                    value={task.done}
                    max={task.total || 1}
                    aria-label={`${task.title} 下载进度`}
                  />
                  {task.error && (
                    <span className="online-error">{task.error}</span>
                  )}
                  <button
                    className="text-button"
                    onClick={() =>
                      void run(() =>
                        api().downloadAction(
                          task.id,
                          task.state === "downloading" ||
                            task.state === "queued"
                            ? "pause"
                            : "resume",
                        ),
                      )
                    }
                    disabled={task.state === "completed"}
                  >
                    {["downloading", "queued"].includes(task.state)
                      ? "暂停"
                      : "继续／重试"}
                  </button>
                  <button
                    className="text-button"
                    onClick={() =>
                      void run(() =>
                        api().downloadAction(
                          task.id,
                          task.state === "completed" ||
                            task.error?.startsWith("删除失败")
                            ? "delete"
                            : "cancel",
                        ),
                      )
                    }
                  >
                    {task.error?.startsWith("删除失败")
                      ? "重试删除"
                      : task.state === "completed"
                        ? "删除下载"
                        : "取消"}
                  </button>
                </div>
              ))}
            </div>
          )}
          {!displayBusy && !displayError && !displayCards.length && section !== "categories" && !isAggregateSearchPage && !(section === "search" && !scope.search) && !(
            (section === "favorites" && localFavorites.length) ||
            (section === "favorites" && onlineFavorites.length) ||
            (section === "readLater" && laterItems.length)
          ) && (
            <div className="online-empty">
              <p>{!sources.length ? "还没有漫画源。请从漫画首页的漫画源入口安装。" : "暂无漫画"}</p>
            </div>
          )}
          {section === "search" && scope.search && searchMode !== "single" && (
            <div className="comic-aggregate-results">
              {aggregateFailures.length > 0 && (
                <details className="comic-aggregate-failures" role="status">
                  <summary>
                    <strong>
                      {aggregateFailures.length === aggregateTotal
                        ? "所选漫画源暂时无法完成搜索"
                        : `${aggregateFailures.length} 个漫画源暂不可用`}
                    </strong>
                    <span>展开查看并重试</span>
                  </summary>
                  <div className="comic-aggregate-failure-list">
                    {aggregateFailures.map((failure) => (
                      <div className="comic-aggregate-failure" key={failure.source.id}>
                        <span><strong>{failure.source.name}</strong>：{failure.error}</span>
                        <button className="text-button" disabled={aggregateRetrying.has(failure.source.id)} onClick={() => void retryAggregateSource(failure.source)}>
                          {aggregateRetrying.has(failure.source.id) ? "重试中…" : "重试"}
                        </button>
                      </div>
                    ))}
                  </div>
                </details>
              )}
              {aggregateGroups.map((group) => (
                <section className="comic-aggregate-group" key={group.source.id}>
                  <div className="comic-aggregate-heading">
                    <button
                      className="comic-aggregate-source-link"
                      onClick={() => openSingleSearchPage(group.source.id, scope.search || "")}
                    >
                      <strong>{group.source.name}</strong>
                      <span>{`${group.comics.length} 条预览`}</span>
                      <ArrowRight size={15} />
                    </button>
                    <button
                      className="text-button"
                      onClick={() => openSingleSearchPage(group.source.id, scope.search || "")}
                    >
                      查看此源全部结果
                    </button>
                  </div>
                  <ComicCards items={group.comics} open={openHubItem} large />
                </section>
              ))}
              {!aggregateBusy && aggregateTotal > 0 && !aggregateGroups.length && !aggregateFailures.length && (
                <div className="online-empty">未找到漫画。</div>
              )}
              {!aggregateBusy && aggregateTotal > aggregateFailures.length && !aggregateGroups.length && aggregateFailures.length > 0 && (
                <div className="online-empty">已成功搜索的漫画源均未找到结果。</div>
              )}
            </div>
          )}
          {section === "discover" && displayCards.length > 0 && displayPageInfo?.sections?.some((part) => part.title) ? (
            <div className="comic-explore-sections">
              {displayPageInfo.sections.map((part, index) => (
                <section className="comic-explore-section" key={`${part.title}:${index}`}>
                  {part.title && <h2>{part.title}</h2>}
                  <ComicCards items={part.comics} open={openHubItem} large />
                </section>
              ))}
            </div>
          ) : displayCards.length > 0 && section !== "favorites" && !isAggregateSearchPage && (
            <div
              className={`online-layout ${singleResultPage ? "is-single-result" : ""}`}
              key={`${section}:${scope.comicSearchId || ""}:${singleResultPage && displayResultMode === "waterfall" ? "waterfall" : displayPage}:${scope.search || ""}:${displayResultLayout}`}
            >
              <ReadingResults props={props} layout={singleResultPage ? displayResultLayout : memory.layout} single={singleResultPage} alternate={!singleResultPage && memory.layout === "bravais" ? <ContentNavigationContext.Provider value={wallNavigation}><BravaisWall {...props}/></ContentNavigationContext.Provider> : undefined}/>

            </div>
          )}
          {displayCards.length > 0 && !isAggregateSearchPage &&
            !["favorites", "readLater", "following", "downloads"].includes(section) &&
            !(section === "discover" && activeExploreTab?.type === "singlePageWithMultiPart") &&
            !(singleResultPage && displayResultMode === "waterfall") && (
              <ReadingPagination page={displayPage} maxPage={displayPageInfo?.maxPage} busy={displayBusy} hasMore={displayPageInfo?.maxPage != null ? displayPage < displayPageInfo.maxPage : displayPageInfo?.next !== null} jump={displayJumpPage} changeJump={singleResultPage ? value => isSingleSearchPage ? updateSingleSearchPage({jumpPage:value}) : setJumpPage(value) : undefined} go={number=>void loadVisiblePage(number)}/>

            )}
          {displayCards.length > 0 && singleResultPage && displayResultMode === "waterfall" && (
            <div className="comic-waterfall-status" role="status">
              {displayBusy ? "正在加载下一页…" : `已加载第 ${displayPage} 页，继续滚动以加载更多`}
            </div>
          )}
        </>
      )}
      {scope.remoteKind === "chapter" && reader && (
        <ComicViewer
          key={reader.id}
          item={reader}
          close={() => {
            if (!onBack())
              go({
                providerId: scope.providerId,
                remoteId: scope.remoteId,
                remoteKind: "comic",
              }, "replace");
          }}
          switchItem={(item) => {
            const ref = item.remoteData!.comicRef;
            go({
              providerId: ref.sourceId,
              remoteId: ref.comicId,
              remoteKind: "chapter",
              comicChapterId: ref.chapterId,
            }, "replace");
          }}
        />
      )}
      </>
      )}
      <ComicSourceDialogs
        pageKey={`${section}:${scope.providerId || ""}:${scope.remoteId || ""}:${scope.remoteKind || ""}:${scope.comicChapterId || ""}:${scope.search || ""}`}
      />
    </ReadingPageShell>
  );
}
