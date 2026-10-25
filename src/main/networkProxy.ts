import { session, type Session, type ProxyConfig } from "electron";
import { HttpProxyAgent } from "http-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import type {
  NetworkProxyRoute,
  NetworkProxySettings,
} from "../shared/networkProxy";
import { resolveNetworkProxyRoute } from "../shared/networkProxy";

interface SessionBinding {
  session: Session;
  key: string;
  parentKey?: string;
  route: string;
  queuedRoute: string;
  job: Promise<void>;
}

function routeKey(route: NetworkProxyRoute, settings: NetworkProxySettings) {
  if (route.mode !== "profile") return JSON.stringify(route);
  const profile = settings.profiles.find(
    (entry) => entry.id === route.profileId,
  );
  return JSON.stringify({
    route,
    profile: profile && {
      protocol: profile.protocol,
      host: profile.host,
      port: profile.port,
    },
  });
}

function proxyConfig(
  route: NetworkProxyRoute,
  settings: NetworkProxySettings,
): ProxyConfig {
  if (route.mode === "system") return { mode: "system" };
  if (route.mode === "direct") return { mode: "direct" };
  const profile = settings.profiles.find(
    (entry) => entry.id === route.profileId,
  );
  if (!profile) throw new Error("路由引用了不存在的代理方案");
  const host =
    profile.host.includes(":") && !profile.host.startsWith("[")
      ? `[${profile.host}]`
      : profile.host;
  return {
    mode: "fixed_servers",
    proxyRules: `${profile.protocol}://${host}:${profile.port}`,
  };
}

export class NetworkProxyManager {
  private settings: NetworkProxySettings;
  private bindings = new Map<Session, SessionBinding>();

  constructor(settings: NetworkProxySettings) {
    this.settings = settings;
  }

  route(key: string, parentKey?: string) {
    return resolveNetworkProxyRoute(this.settings, key, parentKey);
  }

  browserProxyArgs(key: string) {
    const route = this.route(key);
    if (route.mode === "system") return [];
    if (route.mode === "direct") return ["--no-proxy-server"];
    const profile = this.settings.profiles.find(
      (entry) => entry.id === route.profileId,
    );
    if (!profile) throw new Error("路由引用了不存在的代理方案");
    const host =
      profile.host.includes(":") && !profile.host.startsWith("[")
        ? `[${profile.host}]`
        : profile.host;
    return [`--proxy-server=${profile.protocol}://${host}:${profile.port}`];
  }

  getSession(partition: string, key: string, parentKey?: string) {
    const ses = session.fromPartition(partition);
    let binding = this.bindings.get(ses);
    if (!binding) {
      binding = {
        session: ses,
        key,
        parentKey,
        route: "",
        queuedRoute: "",
        job: Promise.resolve(),
      };
      this.bindings.set(ses, binding);
    }
    if (!binding.route) this.queueApply(binding, false);
    return ses;
  }

  async ready(ses: Session) {
    await this.bindings.get(ses)?.job;
  }

  async fetch(
    key: string,
    input: string | URL,
    init?: RequestInit,
    parentKey?: string,
  ) {
    const partition = `kaleid-network-${key.replace(/[^\w.-]/g, "-")}`;
    const ses = this.getSession(partition, key, parentKey);
    await this.ready(ses);
    return ses.fetch(input instanceof URL ? input.href : input, {
      ...init,
      credentials: "omit",
    });
  }

  async nodeAgents(key: string, targetUrl: string) {
    const route = this.route(key);
    let proxyUrl: string | undefined;
    let proxyProtocol: "http" | "socks5" | undefined;
    if (route.mode === "profile") {
      const profile = this.settings.profiles.find(
        (entry) => entry.id === route.profileId,
      );
      if (!profile) throw new Error("路由引用了不存在的代理方案");
      proxyProtocol = profile.protocol;
      const host =
        profile.host.includes(":") && !profile.host.startsWith("[")
          ? `[${profile.host}]`
          : profile.host;
      proxyUrl = `${profile.protocol}://${host}:${profile.port}`;
    } else if (route.mode === "system") {
      const resolved = (await session.defaultSession.resolveProxy(targetUrl))
        .split(";")[0]
        .trim();
      if (!resolved || /^DIRECT$/i.test(resolved)) return {};
      const match = /^(PROXY|HTTP|HTTPS|SOCKS5)\s+(.+)$/i.exec(resolved);
      if (!match) throw new Error("系统代理返回了不支持的代理类型");
      proxyProtocol = /^SOCKS5$/i.test(match[1]) ? "socks5" : "http";
      proxyUrl = `${/^HTTPS$/i.test(match[1]) ? "https" : proxyProtocol === "socks5" ? "socks5" : "http"}://${match[2]}`;
    } else {
      return {};
    }
    if (proxyProtocol === "socks5") {
      const agent = new SocksProxyAgent(proxyUrl!);
      return {
        httpAgent: agent,
        httpsAgent: agent,
        proxy: false,
        dispose: () => agent.destroy(),
      };
    }
    const httpAgent = new HttpProxyAgent(proxyUrl!);
    const httpsAgent = new HttpsProxyAgent(proxyUrl!);
    return {
      httpAgent,
      httpsAgent,
      proxy: false,
      dispose() {
        httpAgent.destroy();
        httpsAgent.destroy();
      },
    };
  }

  async setSettings(settings: NetworkProxySettings) {
    const previous = this.settings;
    this.settings = settings;
    try {
      await Promise.all(
        [...this.bindings.values()].map((binding) =>
          this.queueApply(binding, true),
        ),
      );
    } catch (error) {
      this.settings = previous;
      await Promise.allSettled(
        [...this.bindings.values()].map((binding) =>
          this.queueApply(binding, true),
        ),
      );
      throw error;
    }
  }

  private queueApply(binding: SessionBinding, closeConnections: boolean) {
    const route = this.route(binding.key, binding.parentKey);
    const key = routeKey(route, this.settings);
    if (binding.queuedRoute === key) return binding.job;
    binding.queuedRoute = key;
    const settings = this.settings;
    binding.job = binding.job
      .catch(() => {})
      .then(async () => {
        try {
          await binding.session.setProxy(proxyConfig(route, settings));
          binding.route = key;
          if (closeConnections) await binding.session.closeAllConnections();
        } catch (error) {
          binding.queuedRoute = binding.route;
          throw error;
        }
      });
    return binding.job;
  }
}
