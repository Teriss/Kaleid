export type NetworkProxyRoute =
  | { mode: "system" }
  | { mode: "direct" }
  | { mode: "profile"; profileId: string };

export interface NetworkProxyProfile {
  id: string;
  name: string;
  protocol: "http" | "socks5";
  host: string;
  port: number;
}

export interface NetworkProxySettings {
  profiles: NetworkProxyProfile[];
  defaultRoute: NetworkProxyRoute;
  rules: Record<string, NetworkProxyRoute>;
}

export const DEFAULT_NETWORK_PROXY: NetworkProxySettings = {
  profiles: [],
  defaultRoute: { mode: "system" },
  rules: {},
};

export const NETWORK_PROXY_KEYS = {
  music: {
    netease: "music.netease",
    qq: "music.qq",
    ytm: "music.ytm",
    navidrome: "music.navidrome",
    matching: "music.matching",
  },
  comic: {
    default: "comic.default",
    repositories: "comic.repositories",
    source: (id: string) => `comic.source:${id}`,
  },
  novel: {
    default: "novel.default",
    repositories: "novel.repositories",
    source: (id: string) => `novel.source:${id}`,
  },
  models: "downloads.models",
} as const;

function validRoute(value: unknown): value is NetworkProxyRoute {
  if (!value || typeof value !== "object") return false;
  const route = value as Record<string, unknown>;
  if (route.mode === "system" || route.mode === "direct") return true;
  return (
    route.mode === "profile" &&
    typeof route.profileId === "string" &&
    /^[\w-]{1,80}$/.test(route.profileId)
  );
}

function validRuleKey(key: string) {
  return (
    /^[\w:.-]{1,240}$/.test(key) &&
    key !== "__proto__" &&
    key !== "constructor" &&
    key !== "prototype"
  );
}

function normalizeProfile(value: unknown): NetworkProxyProfile | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === "string" ? raw.id : "";
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const protocol = raw.protocol;
  const host = typeof raw.host === "string" ? raw.host.trim() : "";
  const port = Number(raw.port);
  if (
    !/^[\w-]{1,80}$/.test(id) ||
    !name ||
    name.length > 80 ||
    (protocol !== "http" && protocol !== "socks5") ||
    !validProxyHost(host) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    return null;
  return { id, name, protocol, host, port };
}

export function validProxyHost(host: string): boolean {
  if (!host || /[\s/@?#\\]/.test(host)) return false;
  const authority =
    host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  try {
    const url = new URL(`http://${authority}/`);
    return (
      Boolean(url.hostname) &&
      !url.username &&
      !url.password &&
      url.pathname === "/"
    );
  } catch {
    return false;
  }
}

export function normalizeNetworkProxy(value: unknown): NetworkProxySettings {
  if (!value || typeof value !== "object")
    return {
      profiles: [],
      defaultRoute: { mode: "system" },
      rules: {},
    };
  const raw = value as Record<string, unknown>;
  const profiles: NetworkProxyProfile[] = [];
  const seenProfileIds = new Set<string>();
  if (Array.isArray(raw.profiles)) {
    for (const value of raw.profiles) {
      const profile = normalizeProfile(value);
      if (!profile || seenProfileIds.has(profile.id)) continue;
      profiles.push(profile);
      seenProfileIds.add(profile.id);
      if (profiles.length === 100) break;
    }
  }
  const ids = new Set(profiles.map((profile) => profile.id));
  const normalizeRoute = (
    route: unknown,
    fallback: NetworkProxyRoute,
  ): NetworkProxyRoute => {
    if (!validRoute(route)) return fallback;
    if (route.mode === "profile" && !ids.has(route.profileId)) return fallback;
    return route;
  };
  const rules: Record<string, NetworkProxyRoute> = {};
  if (raw.rules && typeof raw.rules === "object" && !Array.isArray(raw.rules)) {
    for (const [key, route] of Object.entries(
      raw.rules as Record<string, unknown>,
    ).slice(0, 500)) {
      if (
        validRuleKey(key) &&
        validRoute(route) &&
        (route.mode !== "profile" || ids.has(route.profileId))
      )
        rules[key] = route;
    }
  }
  return {
    profiles,
    defaultRoute: normalizeRoute(
      raw.defaultRoute,
      DEFAULT_NETWORK_PROXY.defaultRoute,
    ),
    rules,
  };
}

export function validateNetworkProxy(value: unknown): NetworkProxySettings {
  if (!value || typeof value !== "object") throw new Error("网络代理设置无效");
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.profiles) || raw.profiles.length > 100)
    throw new Error("代理方案数量无效");
  const profiles = raw.profiles.map((profile) => {
    const normalized = normalizeProfile(profile);
    if (!normalized)
      throw new Error("代理方案信息无效，请检查名称、地址和端口");
    return normalized;
  });
  if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length)
    throw new Error("代理方案 ID 重复");
  const ids = new Set(profiles.map((profile) => profile.id));
  const checkRoute = (route: unknown): NetworkProxyRoute => {
    if (!validRoute(route)) throw new Error("代理路由无效");
    if (route.mode === "profile" && !ids.has(route.profileId))
      throw new Error("路由引用了不存在的代理方案");
    return route;
  };
  const defaultRoute = checkRoute(raw.defaultRoute);
  const rawRules = raw.rules;
  if (!rawRules || typeof rawRules !== "object" || Array.isArray(rawRules))
    throw new Error("代理分类规则无效");
  const entries = Object.entries(rawRules as Record<string, unknown>);
  if (entries.length > 500) throw new Error("代理分类规则过多");
  const rules: Record<string, NetworkProxyRoute> = {};
  for (const [key, route] of entries) {
    if (!validRuleKey(key)) throw new Error("代理分类 ID 无效");
    rules[key] = checkRoute(route);
  }
  return { profiles, defaultRoute, rules };
}

export function resolveNetworkProxyRoute(
  config: NetworkProxySettings,
  key: string,
  parentKey?: string,
): NetworkProxyRoute {
  return (
    config.rules[key] ??
    (parentKey ? config.rules[parentKey] : undefined) ??
    config.defaultRoute
  );
}
