import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ChevronDown, Plus, Trash2, X } from "lucide-react";
import {
  NETWORK_PROXY_KEYS,
  resolveNetworkProxyRoute,
  type NetworkProxyProfile,
  type NetworkProxyRoute,
  type NetworkProxySettings,
  validateNetworkProxy,
  validProxyHost,
} from "../../shared/networkProxy";
import type { ComicSourceInfo } from "../../shared/onlineComics";
import type { NovelSourceInfo } from "../../shared/onlineNovels";
import { report, useApp } from "./store";

const routeValue = (route: NetworkProxyRoute) =>
  route.mode === "profile" ? `profile:${route.profileId}` : route.mode;

function routeFromValue(value: string): NetworkProxyRoute {
  if (value === "direct") return { mode: "direct" };
  if (value.startsWith("profile:"))
    return { mode: "profile", profileId: value.slice("profile:".length) };
  return { mode: "system" };
}

function routeName(route: NetworkProxyRoute, config: NetworkProxySettings) {
  if (route.mode === "direct") return "直连";
  if (route.mode === "system") return "系统代理";
  return (
    config.profiles.find((profile) => profile.id === route.profileId)?.name ??
    "代理方案"
  );
}

function ProfileSelect({
  value,
  config,
  inherited,
  onChange,
}: {
  value?: NetworkProxyRoute;
  config: NetworkProxySettings;
  inherited?: NetworkProxyRoute;
  onChange(value: NetworkProxyRoute | undefined): void;
}) {
  return (
    <select
      aria-label="连接方式"
      value={value ? routeValue(value) : "inherit"}
      onChange={(event) =>
        onChange(
          event.target.value === "inherit"
            ? undefined
            : routeFromValue(event.target.value),
        )
      }
    >
      {inherited && (
        <option value="inherit">继承（{routeName(inherited, config)}）</option>
      )}
      <option value="system">系统代理</option>
      <option value="direct">直连</option>
      {config.profiles.map((profile) => (
        <option key={profile.id} value={`profile:${profile.id}`}>
          {profile.name}
        </option>
      ))}
    </select>
  );
}

function RouteRow({
  label,
  description,
  value,
  config,
  inherited,
  onChange,
}: {
  label: string;
  description?: string;
  value?: NetworkProxyRoute;
  config: NetworkProxySettings;
  inherited?: NetworkProxyRoute;
  onChange(value: NetworkProxyRoute | undefined): void;
}) {
  return (
    <label className="setting-row network-proxy-row">
      <span>
        <strong>{label}</strong>
        {description && <small>{description}</small>}
      </span>
      <ProfileSelect
        value={value}
        config={config}
        inherited={inherited}
        onChange={onChange}
      />
    </label>
  );
}

function SettingsModule({
  title,
  children,
  defaultOpen = true,
  action,
}: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
  action?: (openModule: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details
      className="network-proxy-module"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <ChevronDown className="network-proxy-module-chevron" size={15} />
        <span className="network-proxy-module-title">{title}</span>
        {action?.(() => setOpen(true))}
      </summary>
      {children}
    </details>
  );
}

export default function NetworkProxySettingsPanel() {
  const settings = useApp((state) => state.settings);
  const setSettings = useApp((state) => state.setSettings);
  const [comicSources, setComicSources] = useState<ComicSourceInfo[]>([]);
  const [novelSources, setNovelSources] = useState<NovelSourceInfo[]>([]);
  const [draft, setDraft] = useState<NetworkProxySettings>(
    settings.networkProxy,
  );
  const [dirty, setDirty] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyFailed, setApplyFailed] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [name, setName] = useState("");
  const [protocol, setProtocol] = useState<"http" | "socks5">("http");
  const [host, setHost] = useState("127.0.0.1");
  const [port, setPort] = useState("7890");
  const revisionRef = useRef(0);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    let live = true;
    void Promise.all([
      window.media.onlineComics.sources().catch(() => [] as ComicSourceInfo[]),
      window.media.onlineNovels.sources().catch(() => [] as NovelSourceInfo[]),
    ]).then(([comics, novels]) => {
      if (!live) return;
      setComicSources(comics);
      setNovelSources(novels);
    });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!dirty) setDraft(settings.networkProxy);
  }, [dirty, settings.networkProxy]);

  const validDraft = useMemo(() => {
    try {
      validateNetworkProxy(draft);
      return true;
    } catch {
      return false;
    }
  }, [draft]);

  useEffect(() => {
    if (!dirty || !validDraft) return;
    const revision = revisionRef.current;
    const timeout = setTimeout(() => {
      const config = validateNetworkProxy(draft);
      const save = saveQueueRef.current
        .catch(() => {})
        .then(async () => {
          await setSettings({
            ...useApp.getState().settings,
            networkProxy: config,
          });
        });
      saveQueueRef.current = save;
      setApplying(true);
      setApplyFailed(false);
      void save
        .then(() => {
          if (revisionRef.current === revision) setDirty(false);
        })
        .catch((error: unknown) => {
          if (revisionRef.current !== revision) return;
          setApplyFailed(true);
          report(error);
        })
        .finally(() => {
          if (revisionRef.current === revision) setApplying(false);
        });
    }, 350);
    return () => clearTimeout(timeout);
  }, [dirty, draft, setSettings, validDraft]);

  const updateDraft = (
    update: (current: NetworkProxySettings) => NetworkProxySettings,
  ) => {
    revisionRef.current += 1;
    setDraft(update);
    setDirty(true);
    setApplyFailed(false);
  };
  const inheritedFor = (key: string, parentKey?: string) =>
    parentKey
      ? (draft.rules[parentKey] ?? draft.defaultRoute)
      : draft.defaultRoute;
  const setRule = (key: string, value: NetworkProxyRoute | undefined) => {
    updateDraft((current) => {
      const rules = { ...current.rules };
      if (value) rules[key] = value;
      else delete rules[key];
      return { ...current, rules };
    });
  };
  const profileRefs = useMemo(() => {
    const refs = new Set<string>();
    if (draft.defaultRoute.mode === "profile")
      refs.add(draft.defaultRoute.profileId);
    for (const route of Object.values(draft.rules))
      if (route.mode === "profile") refs.add(route.profileId);
    return refs;
  }, [draft]);
  const addProfile = () => {
    const parsedPort = Number(port);
    if (
      !name.trim() ||
      !validProxyHost(host.trim()) ||
      !Number.isInteger(parsedPort) ||
      parsedPort < 1 ||
      parsedPort > 65535 ||
      draft.profiles.length >= 100
    )
      return;
    const profile: NetworkProxyProfile = {
      id: crypto.randomUUID(),
      name: name.trim(),
      protocol,
      host: host.trim(),
      port: parsedPort,
    };
    updateDraft((current) => ({
      ...current,
      profiles: [...current.profiles, profile],
    }));
    setName("");
    setShowAddForm(false);
  };
  const updateProfile = (id: string, patch: Partial<NetworkProxyProfile>) => {
    updateDraft((current) => ({
      ...current,
      profiles: current.profiles.map((profile) =>
        profile.id === id ? { ...profile, ...patch } : profile,
      ),
    }));
  };
  const removeProfile = (id: string) => {
    if (profileRefs.has(id)) return;
    updateDraft((current) => ({
      ...current,
      profiles: current.profiles.filter((profile) => profile.id !== id),
    }));
  };

  const comicDefault = draft.rules[NETWORK_PROXY_KEYS.comic.default];
  const novelDefault = draft.rules[NETWORK_PROXY_KEYS.novel.default];
  const installedComicIds = new Set(comicSources.map((source) => source.id));
  const installedNovelIds = new Set(novelSources.map((source) => source.id));
  const orphanComicRules = Object.entries(draft.rules).filter(
    ([key]) =>
      key.startsWith("comic.source:") &&
      !installedComicIds.has(key.slice("comic.source:".length)),
  );
  const orphanNovelRules = Object.entries(draft.rules).filter(
    ([key]) =>
      key.startsWith("novel.source:") &&
      !installedNovelIds.has(key.slice("novel.source:".length)),
  );
  const canAddProfile =
    Boolean(name.trim()) &&
    validProxyHost(host.trim()) &&
    Number.isInteger(Number(port)) &&
    Number(port) >= 1 &&
    Number(port) <= 65535 &&
    draft.profiles.length < 100;

  return (
    <>
      <p className="settings-description">
        支持无认证的 HTTP 和 SOCKS5
        代理。为不同平台和来源选择连接方式；未单独设置的项目继承分类默认值，分类默认值继承全局默认。更改会自动保存并应用，正在进行的播放或下载可能需要重新连接。
      </p>
      <SettingsModule
        title="代理方案"
        defaultOpen
        action={(openModule) => (
          <button
            type="button"
            className="icon-button network-proxy-add-trigger"
            aria-label="添加代理方案"
            title={
              draft.profiles.length >= 100
                ? "已达到代理方案数量上限"
                : "添加代理方案"
            }
            disabled={draft.profiles.length >= 100}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              openModule();
              setShowAddForm((current) => !current);
            }}
          >
            <Plus size={15} />
          </button>
        )}
      >
        <div className="settings-group network-proxy-profiles">
          {draft.profiles.length === 0 && !showAddForm && (
            <p className="muted network-proxy-empty">还没有代理方案。</p>
          )}
          {draft.profiles.map((profile) => (
            <div className="network-proxy-profile" key={profile.id}>
              <input
                aria-label="方案名称"
                value={profile.name}
                maxLength={80}
                onChange={(event) =>
                  updateProfile(profile.id, { name: event.target.value })
                }
              />
              <select
                aria-label="代理协议"
                value={profile.protocol}
                onChange={(event) =>
                  updateProfile(profile.id, {
                    protocol: event.target.value as "http" | "socks5",
                  })
                }
              >
                <option value="http">HTTP</option>
                <option value="socks5">SOCKS5</option>
              </select>
              <input
                aria-label="代理地址"
                value={profile.host}
                onChange={(event) =>
                  updateProfile(profile.id, { host: event.target.value })
                }
              />
              <input
                aria-label="代理端口"
                type="number"
                min="1"
                max="65535"
                value={profile.port}
                onChange={(event) =>
                  updateProfile(profile.id, {
                    port: Number(event.target.value),
                  })
                }
              />
              <button
                type="button"
                className="icon-button"
                aria-label="删除代理方案"
                title={
                  profileRefs.has(profile.id)
                    ? "先更改使用此方案的路由"
                    : "删除代理方案"
                }
                disabled={profileRefs.has(profile.id)}
                onClick={() => removeProfile(profile.id)}
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
          {showAddForm && (
            <div className="network-proxy-add">
              <input
                aria-label="新方案名称"
                placeholder="方案名称"
                value={name}
                maxLength={80}
                autoFocus
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && canAddProfile) addProfile();
                  if (event.key === "Escape") setShowAddForm(false);
                }}
              />
              <select
                aria-label="新方案协议"
                value={protocol}
                onChange={(event) =>
                  setProtocol(event.target.value as "http" | "socks5")
                }
              >
                <option value="http">HTTP</option>
                <option value="socks5">SOCKS5</option>
              </select>
              <input
                aria-label="新方案地址"
                placeholder="127.0.0.1"
                value={host}
                onChange={(event) => setHost(event.target.value)}
              />
              <input
                aria-label="新方案端口"
                type="number"
                min="1"
                max="65535"
                value={port}
                onChange={(event) => setPort(event.target.value)}
              />
              <span className="network-proxy-add-actions">
                <button
                  type="button"
                  className="text-button"
                  disabled={!canAddProfile}
                  onClick={addProfile}
                >
                  添加
                </button>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="取消添加代理方案"
                  title="取消"
                  onClick={() => setShowAddForm(false)}
                >
                  <X size={14} />
                </button>
              </span>
            </div>
          )}
        </div>
      </SettingsModule>

      <SettingsModule title="默认连接" defaultOpen>
        <div className="settings-group">
          <RouteRow
            label="全局默认"
            description="新平台和未单独配置的分类使用此连接。"
            value={draft.defaultRoute}
            config={draft}
            onChange={(route) => {
              if (route)
                updateDraft((current) => ({ ...current, defaultRoute: route }));
            }}
          />
        </div>
      </SettingsModule>

      <SettingsModule title="音乐">
        <div className="settings-group">
          {[
            [NETWORK_PROXY_KEYS.music.netease, "网易云音乐"],
            [NETWORK_PROXY_KEYS.music.qq, "QQ 音乐"],
            [NETWORK_PROXY_KEYS.music.ytm, "YouTube Music"],
            [NETWORK_PROXY_KEYS.music.navidrome, "Navidrome"],
            [NETWORK_PROXY_KEYS.music.matching, "歌词与在线信息匹配"],
          ].map(([key, label]) => (
            <RouteRow
              key={key}
              label={label}
              value={draft.rules[key]}
              config={draft}
              inherited={draft.defaultRoute}
              onChange={(route) => setRule(key, route)}
            />
          ))}
        </div>
      </SettingsModule>

      <SettingsModule title="漫画">
        <div className="settings-group">
          <RouteRow
            label="漫画分类默认"
            value={comicDefault}
            config={draft}
            inherited={draft.defaultRoute}
            onChange={(route) =>
              setRule(NETWORK_PROXY_KEYS.comic.default, route)
            }
          />
          <RouteRow
            label="源仓库与更新"
            value={draft.rules[NETWORK_PROXY_KEYS.comic.repositories]}
            config={draft}
            inherited={draft.defaultRoute}
            onChange={(route) =>
              setRule(NETWORK_PROXY_KEYS.comic.repositories, route)
            }
          />
          {comicSources.map((source) => {
            const key = NETWORK_PROXY_KEYS.comic.source(source.id);
            const effective = resolveNetworkProxyRoute(
              draft,
              key,
              NETWORK_PROXY_KEYS.comic.default,
            );
            return (
              <RouteRow
                key={source.id}
                label={source.name}
                description={`当前：${routeName(effective, draft)}`}
                value={draft.rules[key]}
                config={draft}
                inherited={inheritedFor(key, NETWORK_PROXY_KEYS.comic.default)}
                onChange={(route) => setRule(key, route)}
              />
            );
          })}
          {orphanComicRules.length > 0 && (
            <>
              <h4>已卸载来源规则</h4>
              {orphanComicRules.map(([key, route]) => (
                <RouteRow
                  key={key}
                  label={`已卸载来源 · ${key.slice("comic.source:".length)}`}
                  value={route}
                  config={draft}
                  inherited={inheritedFor(
                    key,
                    NETWORK_PROXY_KEYS.comic.default,
                  )}
                  onChange={(next) => setRule(key, next)}
                />
              ))}
            </>
          )}
        </div>
      </SettingsModule>

      <SettingsModule title="小说">
        <div className="settings-group">
          <RouteRow
            label="小说分类默认"
            value={novelDefault}
            config={draft}
            inherited={draft.defaultRoute}
            onChange={(route) =>
              setRule(NETWORK_PROXY_KEYS.novel.default, route)
            }
          />
          <RouteRow
            label="源仓库与更新"
            value={draft.rules[NETWORK_PROXY_KEYS.novel.repositories]}
            config={draft}
            inherited={draft.defaultRoute}
            onChange={(route) =>
              setRule(NETWORK_PROXY_KEYS.novel.repositories, route)
            }
          />
          {novelSources.map((source) => {
            const key = NETWORK_PROXY_KEYS.novel.source(source.id);
            const effective = resolveNetworkProxyRoute(
              draft,
              key,
              NETWORK_PROXY_KEYS.novel.default,
            );
            return (
              <RouteRow
                key={source.id}
                label={source.name}
                description={`当前：${routeName(effective, draft)}`}
                value={draft.rules[key]}
                config={draft}
                inherited={inheritedFor(key, NETWORK_PROXY_KEYS.novel.default)}
                onChange={(route) => setRule(key, route)}
              />
            );
          })}
          {orphanNovelRules.length > 0 && (
            <>
              <h4>已卸载来源规则</h4>
              {orphanNovelRules.map(([key, route]) => (
                <RouteRow
                  key={key}
                  label={`已卸载来源 · ${key.slice("novel.source:".length)}`}
                  value={route}
                  config={draft}
                  inherited={inheritedFor(
                    key,
                    NETWORK_PROXY_KEYS.novel.default,
                  )}
                  onChange={(next) => setRule(key, next)}
                />
              ))}
            </>
          )}
        </div>
      </SettingsModule>

      <SettingsModule title="下载">
        <div className="settings-group">
          <RouteRow
            label="音乐分析模型"
            value={draft.rules[NETWORK_PROXY_KEYS.models]}
            config={draft}
            inherited={draft.defaultRoute}
            onChange={(route) => setRule(NETWORK_PROXY_KEYS.models, route)}
          />
        </div>
      </SettingsModule>
      <p className="network-proxy-status" role="status" aria-live="polite">
        {!validDraft
          ? "代理信息暂不完整，补全名称、地址和有效端口后会自动应用。"
          : applying
            ? "正在自动保存并应用…"
            : applyFailed
              ? "自动应用失败，请检查代理设置和连接状态。"
              : dirty
                ? "更改会自动保存并应用。"
                : "代理设置已自动应用。"}
      </p>
    </>
  );
}
