import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  Search,
  ListFilter,
  X,
  Settings2,
  UserRound,
} from "lucide-react";
import WallMenu, { openWallSearch } from "../layouts/WallMenu";
import AccountPicture from "./AccountPicture";
import { isActiveMusicProvider } from "../../../shared/music";
import "./music-wall.css";
import type { BrowseLocation } from "../../../shared/navigation";
import type { MusicProviderSummary } from "../../../shared/music";
import { Modal } from "../components";
import { report } from "../store";
import { provider, providers, invalidateMusicPages } from "./catalog";

export default function MusicSources({
  scope,
  navigate,
  local,
  accountOpen,
  account,
  closeAccount,
  wall = false,
  filter,
  settings,
  submitSearch,
}: {
  scope: BrowseLocation;
  navigate(scope: BrowseLocation): void;
  local(): void;
  accountOpen: boolean;
  account(): void;
  closeAccount(): void;
  wall?: boolean;
  filter?: {
    query: string;
    update(value: string): void;
    total: number;
    loaded: number;
    originalTotal: number;
  };
  settings?(): void;
  submitSearch(value: string): void;
}) {
  const [platforms, setPlatforms] = useState<MusicProviderSummary[]>([]);
  const [user, setUser] = useState<any>(null);
  const [login, setLogin] = useState<{
    key: string;
    image?: string;
    browser?: boolean;
  } | null>(null);
  const [methods, setMethods] = useState<any[]>([]);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [playlistName, setPlaylistName] = useState("");
  const preferredId =
    scope.providerId ??
    localStorage.getItem("music:active-provider") ??
    "netease";
  const activeId = isActiveMusicProvider(preferredId) ? preferredId : "netease";
  const [accountId, setAccountId] = useState(activeId);
  const [accounts, setAccounts] = useState<Record<string, any>>({});
  const loginGeneration = useRef(0);
  const id = accountOpen ? accountId : activeId;
  const remote = scope.view === "music";
  const platform = platforms.find((p) => p.id === id);
  const activePlatform = platforms.find((p) => p.id === activeId);
  useEffect(() => {
    if (accountOpen) setAccountId(activeId);
  }, [accountOpen]);
  useEffect(() => {
    let live = true;
    let generation = 0;
    const read = () => {
      const ticket = ++generation;
      void Promise.all(
        platforms.map(async (p) => {
          const value = await provider(p.id)
            .then((p) => p.auth?.getLoginStatus())
            .catch(() => null);
          if (live && ticket === generation)
            setAccounts((current) => ({ ...current, [p.id]: value }));
        }),
      );
    };
    read();
    window.addEventListener("music-auth-changed", read);
    return () => {
      live = false;
      window.removeEventListener("music-auth-changed", read);
    };
  }, [platforms]);
  useEffect(() => {
    const outside = (event: PointerEvent) =>
      document
        .querySelectorAll<HTMLDetailsElement>(".music-platform-menu[open]")
        .forEach((menu) => {
          if (!menu.contains(event.target as Node)) menu.open = false;
        });
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const menu = document.querySelector<HTMLDetailsElement>(
        ".music-platform-menu[open]",
      );
      if (menu) {
        event.preventDefault();
        event.stopPropagation();
        menu.open = false;
      }
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape, true);
    };
  }, []);
  useEffect(() => {
    void providers().then(setPlatforms).catch(report);
  }, []);
  useEffect(() => {
    setUser(null);
    setLogin(null);
    setStatus("");
    setMethods([]);
    setBusy(false);
    ++loginGeneration.current;
    if (!accountOpen) return;
    let live = true;
    void provider(id)
      .then(async (p) => {
        const [u, m] = await Promise.allSettled([
          p.auth?.getLoginStatus(),
          p.auth?.resolveLoginMethods?.() ?? p.auth?.getLoginMethods?.() ?? [],
        ]);
        if (live) {
          setUser(u.status === "fulfilled" ? u.value : null);
          setMethods(m.status === "fulfilled" ? m.value : []);
          if (u.status === "rejected" || m.status === "rejected") {
            setStatus("暂时无法读取完整账号信息，可尝试登录或稍后重试。");
            console.warn(
              "Music account information unavailable",
              id,
              u.status === "rejected" ? u.reason : undefined,
              m.status === "rejected" ? m.reason : undefined,
            );
          }
        }
      })
      .catch((error) => {
        if (live) setStatus("暂时无法读取平台信息，请稍后重试。");
      });
    return () => {
      live = false;
    };
  }, [id, accountOpen, remote]);
  useEffect(() => {
    if (!login || !accountOpen) return;
    let live = true,
      timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const p = await provider(id);
        const result = await p.auth.checkLogin(login.key);
        if (!live) return;
        setStatus(
          result.state === "scanned"
            ? "已扫码，请在手机确认"
            : result.state === "waiting"
              ? "等待授权"
              : (result.message ?? result.state),
        );
        if (result.state === "confirmed") {
          const confirmed = await p.auth.getLoginStatus();
          if (!live) return;
          setUser(confirmed);
          setLogin(null);
          invalidateMusicPages(id);
          window.dispatchEvent(
            new CustomEvent("music-auth-changed", { detail: id }),
          );
          return;
        }
        if (["expired", "error"].includes(result.state) && !result.transient)
          return;
      } catch (error) {
        if (live) setStatus(String(error));
      }
      if (live) timer = setTimeout(poll, 2500);
    };
    timer = setTimeout(poll, 2500);
    return () => {
      live = false;
      clearTimeout(timer);
      void provider(id).then((p) => p.auth?.cancelLogin?.(login.key));
    };
  }, [id, login, accountOpen]);
  async function start(method?: string) {
    const generation = ++loginGeneration.current;
    setBusy(true);
    setStatus("");
    try {
      const p = await provider(id);
      const key = await p.auth.startLogin(method);
      const image = p.auth.createQr ? await p.auth.createQr(key) : undefined;
      if (generation !== loginGeneration.current) {
        void p.auth?.cancelLogin?.(key);
        return;
      }
      setLogin({ key, image, browser: !image });
      if (!image && p.auth.openLoginPage && !p.auth.opensLoginPageItself?.(key))
        await p.auth.openLoginPage(key);
    } catch (error) {
      if (generation === loginGeneration.current) setStatus(String(error));
    } finally {
      if (generation === loginGeneration.current) setBusy(false);
    }
  }
  const go = (section: string, providerId = activeId) => {
    localStorage.setItem("music:active-provider", providerId);
    navigate({
      view: "music",
      type: "music",
      musicSource: "online",
      providerId,
      section,
    });
  };
  const menu = (
    <WallMenu
      identity={JSON.stringify(scope)}
      title="书库"
      music
      online={remote}
      filter={filter!}
      submit={submitSearch}
    >
      <strong className="music-wall-heading">书库</strong>
      <div className="music-source-tabs" role="group" aria-label="音乐来源">
        <button onClick={local} aria-pressed="false">
          本地
        </button>
        <button className="active" aria-pressed="true">
          在线
        </button>
      </div>
      <nav className="music-wall-sections" aria-label="音乐墙面栏目">
        {[
          ["mine", "歌单", activePlatform?.capabilities.userLibrary],
          ["radio", "电台", activePlatform?.capabilities.personalFm],
          ["discover", "探索", true],
          ["albums", "专辑", activePlatform?.capabilities.userAlbums],
          [
            "daily",
            "每日歌曲",
            activePlatform?.capabilities.dailyRecommendations,
          ],
        ]
          .filter((row) => row[2])
          .map(([section, label]) => (
            <button
              key={String(section)}
              className={remote && scope.section === section ? "active" : ""}
              onClick={() => go(String(section))}
            >
              {label}
            </button>
          ))}
      </nav>
      <div className="music-wall-bottom">
        <button
          className="music-liked-link"
          aria-current={
            remote && scope.section === "liked" ? "page" : undefined
          }
          onClick={() =>
            remote
              ? go("liked")
              : navigate({ view: "favorites", type: "music", localOnly: true })
          }
        >
          我喜欢的音乐
        </button>
        {filter?.query && (
          <button
            className="music-filter-badge"
            aria-label="清除当前视图过滤"
            onClick={() => filter.update("")}
          >
            <ListFilter size={14} />
            {filter.query}
            <X size={13} />
          </button>
        )}
        <button
          className="music-wall-avatar"
          aria-label="音乐平台账号与登录"
          onClick={account}
        >
          <AccountPicture user={accounts[activeId]} providerId={activeId} />
          <strong>{accounts[activeId]?.nickname ?? "账号与登录"}</strong>
        </button>
        <div className="music-wall-tools">
          <button aria-label="音乐墙面搜索" onClick={() => openWallSearch()}>
            <Search size={20} />
          </button>
          <button aria-label="音乐墙面设置" onClick={settings}>
            <Settings2 size={20} />
          </button>
        </div>
      </div>
    </WallMenu>
  );
  return (
    <>
      {wall && remote ? (
        menu
      ) : (
        <div className="music-sources" aria-label="音乐来源">
          <div className="music-source-tabs">
            <button className={!remote ? "active" : ""} onClick={local}>
              本地
            </button>
            <button
              className={
                remote && scope.musicSource === "online" ? "active" : ""
              }
              onClick={() => go("discover")}
            >
              在线
            </button>
          </div>
          {remote && (
            <div className="music-source-details">
              <details
                className="music-platform-menu"
                key={scope.musicSource + id}
              >
                <summary>
                  {scope.musicSource === "navidrome"
                    ? "服务器"
                    : (platform?.name ?? "选择平台")}
                  <ChevronDown size={12} />
                </summary>
                <div className="music-platform-popover">
                  {scope.musicSource !== "navidrome" && (
                    <select
                      aria-label="在线音乐平台"
                      value={id}
                      onChange={(e) => go("discover", e.target.value)}
                    >
                      {platforms.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  )}
                  <button
                    onClick={(e) => {
                      e.currentTarget
                        .closest("details")
                        ?.removeAttribute("open");
                      account();
                    }}
                  >
                    {scope.musicSource === "navidrome"
                      ? "配置服务器"
                      : "平台账号"}
                  </button>
                </div>
              </details>
              <div className="music-sections" aria-label="音乐栏目">
                {(scope.musicSource === "navidrome"
                  ? [
                      ["albums", "专辑", true],
                      ["artists", "歌手", true],
                      ["playlists", "歌单", true],
                      ["favorites", "服务器收藏", true],
                    ]
                  : [
                      ["discover", "探索", true],
                      ["mine", "我的音乐", platform?.capabilities.userLibrary],
                      ["radio", "电台", platform?.capabilities.personalFm],
                      [
                        "daily",
                        "每日歌曲",
                        platform?.capabilities.dailyRecommendations,
                      ],
                      ["albums", "收藏专辑", platform?.capabilities.userAlbums],
                    ]
                )
                  .filter((row) => row[2])
                  .map(([section, text]) => (
                    <button
                      key={String(section)}
                      className={scope.section === section ? "active" : ""}
                      onClick={() =>
                        scope.musicSource === "navidrome"
                          ? navigate({
                              view: "music",
                              type: "music",
                              musicSource: "navidrome",
                              section: String(section),
                            })
                          : go(String(section))
                      }
                    >
                      {text}
                    </button>
                  ))}
              </div>
            </div>
          )}
        </div>
      )}
      {remote && scope.musicSource !== "navidrome" && (
        <div className="music-page-actions">
          {" "}
          {scope.section === "mine" &&
            platform?.capabilities.createPlaylist && (
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (!playlistName.trim()) return;
                  try {
                    const p = await provider(id);
                    const collection = await p.mutations.createPlaylist(
                      playlistName.trim(),
                    );
                    setPlaylistName("");
                    invalidateMusicPages();
                    navigate({
                      view: "music",
                      type: "music",
                      musicSource: "online",
                      providerId: id,
                      section: "collection",
                      remoteId: String(collection.id),
                      remoteKind: "playlist",
                    });
                  } catch (error) {
                    report(error);
                  }
                }}
              >
                <input
                  aria-label="平台新歌单名称"
                  value={playlistName}
                  onChange={(e) => setPlaylistName(e.target.value)}
                  placeholder="平台新歌单名称"
                />
                <button type="submit">创建平台歌单</button>
              </form>
            )}
        </div>
      )}
      {accountOpen && scope.musicSource !== "navidrome" && (
        <Modal
          title={`${platform?.name ?? "音乐平台"}账号`}
          close={closeAccount}
          className="music-account-modal"
        >
          <div className="music-account-layout">
            <nav className="music-account-platforms" aria-label="音乐账号平台">
              {platforms.map((p) => (
                <button
                  key={p.id}
                  className={p.id === accountId ? "active" : ""}
                  onClick={() => setAccountId(p.id)}
                >
                  <span className={`platform-mark platform-${p.id}`}>
                    {p.name.slice(0, 1)}
                  </span>
                  <span>
                    <strong>{p.name}</strong>
                    <small>{accounts[p.id]?.nickname ?? "未登录"}</small>
                  </span>
                  <AccountPicture
                    user={accounts[p.id]}
                    providerId={p.id}
                    size={25}
                  />
                </button>
              ))}
            </nav>
            <section className="music-account-detail" aria-label="所选平台账号">
              <h3>{platform?.name ?? "音乐平台"}</h3>
              {user ? (
                <>
                  <AccountPicture user={user} providerId={id} size={112} />
                  <h2>{user.nickname}</h2>
                  <button
                    className="button secondary"
                    onClick={() =>
                      void provider(id)
                        .then((p) => p.auth.logout())
                        .then(() => {
                          setUser(null);
                          setStatus("已退出登录");
                          invalidateMusicPages(id);
                          window.dispatchEvent(
                            new CustomEvent("music-auth-changed", {
                              detail: id,
                            }),
                          );
                        })
                        .catch(report)
                    }
                  >
                    退出该平台账号
                  </button>
                </>
              ) : (
                <>
                  {login?.image && (
                    <img
                      className="login-qr"
                      src={login.image}
                      alt="登录二维码"
                    />
                  )}
                  {login?.browser && <p>请在授权窗口完成登录。</p>}
                  <div className="inline-actions">
                    {methods.length ? (
                      methods.map((m) => (
                        <button
                          key={m.id}
                          className="button secondary"
                          disabled={busy}
                          onClick={() => void start(m.id)}
                        >
                          {m.label || m.name || m.id}
                        </button>
                      ))
                    ) : (
                      <button
                        className="button primary"
                        disabled={busy}
                        onClick={() => void start()}
                      >
                        登录
                      </button>
                    )}
                  </div>
                </>
              )}
              {status && <p role="status">{status}</p>}
              <button
                className="button primary"
                onClick={() => {
                  closeAccount();
                  go("discover", accountId);
                }}
              >
                使用此平台
              </button>
            </section>
          </div>
        </Modal>
      )}
    </>
  );
}
