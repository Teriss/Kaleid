import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { BrowseLocation } from "../../../shared/navigation";
import type { MusicProviderSummary } from "../../../shared/music";
import NavidromeSettings from "./NavidromeSettings";
import { Modal } from "../components";
import { report } from "../store";
import { provider, providers, invalidateMusicPages } from "./catalog";
import { useApp } from "../store";

export default function MusicSources({
  scope,
  navigate,
  local,
  accountOpen,
  account,
  closeAccount,
}: {
  scope: BrowseLocation;
  navigate(scope: BrowseLocation): void;
  local(): void;
  accountOpen: boolean;
  account(): void;
  closeAccount(): void;
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
  const [serverLabel, setServerLabel] = useState("服务器");
  const id = scope.providerId ?? "netease";
  const remote = scope.view === "music";
  const platform = platforms.find((p) => p.id === id);
  useEffect(() => {
    if (scope.musicSource !== "navidrome") return;
    let live = true;
    void window.music
      .navidromeConfig()
      .then((config) => {
        if (live)
          setServerLabel(config ? new URL(config.url).host : "配置服务器");
      })
      .catch(report);
    return () => {
      live = false;
    };
  }, [scope.musicSource, accountOpen]);
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
        menu.querySelector<HTMLElement>("summary")?.focus();
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
    if (!remote || !accountOpen) return;
    let live = true;
    void provider(id)
      .then(async (p) => {
        const [u, m] = await Promise.all([
          p.auth?.getLoginStatus(),
          p.auth?.resolveLoginMethods?.() ?? p.auth?.getLoginMethods?.() ?? [],
        ]);
        if (live) {
          setUser(u);
          setMethods(m);
        }
      })
      .catch((error) => {
        if (live) setStatus(String(error));
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
          setUser(await p.auth.getLoginStatus());
          setLogin(null);
          invalidateMusicPages(id);
          window.dispatchEvent(
            new CustomEvent("music-auth-changed", { detail: id }),
          );
          closeAccount();
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
    setBusy(true);
    setStatus("");
    try {
      const p = await provider(id);
      const key = await p.auth.startLogin(method);
      const image = p.auth.createQr ? await p.auth.createQr(key) : undefined;
      setLogin({ key, image, browser: !image });
      if (!image && p.auth.openLoginPage && !p.auth.opensLoginPageItself?.(key))
        await p.auth.openLoginPage(key);
    } catch (error) {
      setStatus(String(error));
    } finally {
      setBusy(false);
    }
  }
  const go = (section: string, providerId = id) =>
    navigate({
      view: "music",
      type: "music",
      musicSource: "online",
      providerId,
      section,
    });
  return (
    <>
      <div className="music-sources" aria-label="音乐来源">
        <div className="music-source-tabs">
          <button className={!remote ? "active" : ""} onClick={local}>
            本地
          </button>
          <button
            className={remote && scope.musicSource === "online" ? "active" : ""}
            onClick={() => go("discover")}
          >
            在线
          </button>
          <button
            className={scope.musicSource === "navidrome" ? "active" : ""}
            onClick={() =>
              navigate({
                view: "music",
                type: "music",
                musicSource: "navidrome",
                section: "albums",
              })
            }
          >
            Navidrome
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
                  ? serverLabel
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
                    e.currentTarget.closest("details")?.removeAttribute("open");
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
      {accountOpen && scope.musicSource === "navidrome" && (
        <NavidromeSettings close={closeAccount} />
      )}
      {accountOpen && scope.musicSource !== "navidrome" && (
        <Modal
          title={`${platform?.name ?? "音乐平台"}账号`}
          close={closeAccount}
          className="music-account-modal"
        >
          {user ? (
            <>
              <p>{user.nickname}</p>
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
                        new CustomEvent("music-auth-changed", { detail: id }),
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
                <img className="login-qr" src={login.image} alt="登录二维码" />
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
        </Modal>
      )}
    </>
  );
}
