import musicRoutes from "../shared/musicRoutes.json";
import {
  app,
  BrowserWindow,
  ipcMain,
  protocol,
  safeStorage,
  session,
  shell,
} from "electron";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { randomUUID, createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { MediaItem } from "../shared/types";
import type { MusicWindowState } from "../shared/music";

// electron-vite may inject its own ESM `require` shim into this bundle.
// Keep our loader distinct so packaging cannot introduce a duplicate declaration.
const loadCommonJS = createRequire(import.meta.url);
const PROVIDERS = new Set([
  "netease",
  "qq",
  "kugou",
  "bodian",
  "ytm",
  "spotify",
]);
/** Upstream factories are loaded individually. Its application main process is never started. */
export function installMusic(
  getMain: () => BrowserWindow | null,
  localCall: (method: string, ...args: any[]) => Promise<any>,
) {
  const projectRoot = fs.existsSync(path.join(app.getAppPath(), "vendor"))
    ? app.getAppPath()
    : path.resolve(import.meta.dirname, "../..");
  const root = path.join(projectRoot, "vendor/folia/electron");
  const directory = path.join(app.getPath("userData"), "music");
  fs.mkdirSync(directory, { recursive: true });
  const statePath = path.join(directory, "state.json");
  let disk: Record<string, any> = {};
  try {
    disk = JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    /* First run. */
  }
  const write = () => {
    fs.writeFileSync(statePath + ".tmp", JSON.stringify(disk));
    fs.renameSync(statePath + ".tmp", statePath);
  };
  const store = {
    get: (key: string) => disk[key],
    set: (key: string, value: unknown) => {
      disk[key] = value;
      write();
    },
    delete: (key: string) => {
      delete disk[key];
      write();
    },
  };
  if (disk.session && disk.session.position !== 0)
    store.set("session", { ...disk.session, position: 0 });
  const catalog = new DatabaseSync(path.join(directory, "music.sqlite"));
  catalog.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS remote_media(id TEXT PRIMARY KEY,data TEXT NOT NULL,favorite INTEGER NOT NULL DEFAULT 0,opened INTEGER); CREATE INDEX IF NOT EXISTS remote_favorites ON remote_media(favorite); CREATE INDEX IF NOT EXISTS remote_recent ON remote_media(opened DESC);",
  );
  const readRemote = catalog.prepare(
    "SELECT data,favorite,opened FROM remote_media WHERE id=?",
  );
  function remoteItem(id: string): MediaItem | undefined {
    const row = readRemote.get(id) as any;
    return row
      ? {
          ...JSON.parse(row.data),
          favorite: Boolean(row.favorite),
          lastOpened: row.opened ?? undefined,
        }
      : undefined;
  }
  const saveRemote = catalog.prepare(
    "INSERT INTO remote_media(id,data,favorite,opened) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
  );
  if (disk.catalog) {
    for (const item of Object.values(disk.catalog) as MediaItem[])
      saveRemote.run(
        item.id,
        JSON.stringify(item),
        Number(item.favorite),
        item.lastOpened ?? null,
      );
    delete disk.catalog;
    write();
  }
  function secret(key: string, value?: string) {
    if (!safeStorage.isEncryptionAvailable())
      throw new Error("系统凭据加密服务不可用");
    if (value !== undefined) {
      store.set(key, safeStorage.encryptString(value).toString("base64"));
      return value;
    }
    return disk[key]
      ? safeStorage.decryptString(Buffer.from(disk[key], "base64"))
      : "";
  }
  const load = (name: string) => loadCommonJS(path.join(root, name));
  let upgradeJob: Promise<void> | undefined;
  const upgrade = () =>
    (upgradeJob ??= (async () => {
      if (disk.migrationVersion === 1) return;
      const backup = await localCall("backupMusicDatabase");
      const [session, playlists] = await Promise.all([
        localCall("musicSession"),
        localCall("musicPlaylists"),
      ]);
      if (!disk.session && session) disk.session = session;
      disk.playlists ??= playlists;
      if (disk.playlists.length !== playlists.length)
        throw new Error("歌单迁移核对失败");
      disk.migrationBackup = backup;
      disk.migrationVersion = 1;
      write();
    })().catch((error) => {
      upgradeJob = undefined;
      throw error;
    }));
  const modelDirectory = path.join(directory, "models");
  const manifest = loadCommonJS(
    path.join(projectRoot, "vendor/folia/shared/modelManifest.json"),
  );
  const modelJobs = new Map<string, Promise<void>>();
  const verifiedModels = new Map<string, string>();
  async function modelInstalled(model: any) {
    const file = path.join(modelDirectory, model.file);
    if (!fs.existsSync(file)) return false;
    const stat = await fs.promises.stat(file);
    if (stat.size !== model.bytes) return false;
    const signature = `${stat.size}:${stat.mtimeMs}`;
    if (verifiedModels.get(file) === signature) return true;
    const hash = createHash("sha256");
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    if (hash.digest("hex") !== model.sha256) return false;
    verifiedModels.set(file, signature);
    return true;
  }
  async function downloadModel(name: string) {
    const model = manifest.models.find((m: any) => m.name === name);
    if (!model) throw new Error("无效的分析模型");
    if (modelJobs.has(name)) return modelJobs.get(name);
    const job = (async () => {
      fs.mkdirSync(modelDirectory, { recursive: true });
      const file = path.join(modelDirectory, model.file);
      const temp = file + ".download";
      let lastError: unknown;
      for (const mirror of manifest.mirrors) {
        try {
          const response = await fetch(mirror.replace("{file}", model.file), {
            signal: AbortSignal.timeout(600000),
          });
          if (!response.ok || !response.body)
            throw new Error(`模型下载 HTTP ${response.status}`);
          const handle = await fs.promises.open(temp, "w");
          let size = 0;
          const hash = createHash("sha256");
          try {
            for await (const chunk of response.body as any) {
              size += chunk.length;
              if (size > model.bytes) throw new Error("模型大小不符");
              hash.update(chunk);
              await handle.write(chunk);
            }
          } finally {
            await handle.close();
          }
          if (size !== model.bytes || hash.digest("hex") !== model.sha256)
            throw new Error("模型完整性校验失败");
          await fs.promises.rename(temp, file);
          return;
        } catch (error) {
          lastError = error;
          await fs.promises.unlink(temp).catch(() => {});
        }
      }
      throw lastError;
    })().finally(() => modelJobs.delete(name));
    modelJobs.set(name, job);
    return job;
  }
  const bridges = new Map<string, any>();
  let qqJob: Promise<any> | undefined;
  async function qq() {
    if (!qqJob)
      qqJob = (async () => {
        const repo = load(
          "qq/qqAuthSessionRepository.cjs",
        ).createQqAuthSessionRepository({ store, safeStorage });
        const backend = load("qq/qqBackend.cjs").createQqBackend({
          broadcast: () => {},
          authSessionRepository: repo,
          getStateFilePath: () => path.join(directory, "qq-device.json"),
        });
        await backend.start();
        if (!backend.getPort()) throw new Error("QQ 音乐服务未启动");
        bridges.set("qq-backend", backend);
        return backend;
      })().catch((error) => {
        qqJob = undefined;
        throw error;
      });
    return qqJob;
  }
  const networking = (name: string) => {
    const network = session.fromPartition(`yingjian-music-${name}`);
    return (input: any, init?: any) =>
      network.fetch(input instanceof URL ? input.href : input, {
        ...init,
        credentials: "omit",
      });
  };
  function bridge(provider: string) {
    if (bridges.has(provider)) return bridges.get(provider);
    let value: any;
    if (provider === "kugou")
      value = load("kugou/kugouApiBridge.cjs").createKugouApiBridge({
        store,
        safeStorage,
      });
    if (provider === "bodian")
      value = load("bodian/bodianApiBridge.cjs").createBodianApiBridge({
        store,
        safeStorage,
      });
    if (provider === "ytm") {
      const sandbox = load("ytm/sandbox.cjs").createYtmSandbox({
        BrowserWindow,
        session,
        isAllowed: () => Boolean(getMain()),
      });
      value = load("ytm/ytmApiBridge.cjs").createYtmApiBridge({
        store,
        safeStorage,
        fetch: networking(provider),
        evaluate: (code: string) => sandbox.evaluate(code),
        language: () => "zh-CN",
        signInFolder: () => path.join(directory, "ytm-sign-in"),
      });
    }
    if (provider === "spotify")
      value = load("spotify/spotifyApiBridge.cjs").createSpotifyApiBridge({
        store,
        safeStorage,
        fetch: networking(provider),
        openExternal: (url: string) => shell.openExternal(url),
        language: () => "zh-CN",
        audioDirectory: path.join(directory, "folia-spotify"),
      });
    if (!value) throw new Error("不支持的音乐平台");
    bridges.set(provider, value);
    return value;
  }
  const knownUrls = new Set<string>();
  const assets = new Map<string, string>();
  const assetUrls = new Map<string, string>();
  function remember(value: any, depth = 0) {
    if (depth > 20 || value == null) return;
    if (typeof value === "string" && /^https?:\/\//i.test(value)) {
      knownUrls.add(value);
      knownUrls.add(value.replace(/^http:/, "https:"));
    } else if (typeof value === "object")
      Object.values(value).forEach((v) => remember(v, depth + 1));
  }
  function resource(url: string) {
    if (url.startsWith("data:image/")) return url;
    if (/^folia-(ytm|spotify):/.test(url)) return url;
    const parsed = new URL(url);
    const coverHosts =
      /(^|\.)(music\.126\.net|y\.gtimg\.cn|qpic\.cn|kgimg\.com|ytimg\.com|googleusercontent\.com|scdn\.co)$/;
    if (!knownUrls.has(url) && !coverHosts.test(parsed.hostname))
      throw new Error("音乐资源未由平台提供");
    if (
      !/^https?:$/.test(parsed.protocol) ||
      /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|\[)/.test(
        parsed.hostname,
      ) ||
      parsed.username ||
      parsed.password
    )
      throw new Error("无效的音乐资源");
    if (assetUrls.has(url)) return assetUrls.get(url)!;
    const token = randomUUID();
    assets.set(token, url);
    const result = `music://asset/${token}`;
    assetUrls.set(url, result);
    return result;
  }
  function navUrl(operation: string, params: Record<string, any> = {}) {
    const config = disk.navidrome;
    if (!config) throw new Error("请先配置 Navidrome 服务器");
    const salt = randomBytes(12).toString("hex");
    const token = createHash("md5")
      .update(secret("navidrome-password") + salt)
      .digest("hex");
    const target = new URL(`${config.url}/rest/${operation}.view`);
    for (const [key, value] of Object.entries({
      ...params,
      u: config.username,
      t: token,
      s: salt,
      v: "1.16.1",
      c: "Kaleid",
      f: "json",
    }))
      target.searchParams.set(key, String(value));
    return target.href;
  }
  function navAsset(operation: string, params: Record<string, any>) {
    const token = randomUUID();
    assets.set(token, navUrl(operation, params));
    return `music://asset/${token}`;
  }
  protocol.handle("music", async (request) => {
    const url = assets.get(new URL(request.url).pathname.slice(1));
    if (!url) return new Response(null, { status: 404 });
    try {
      const headers: Record<string, string> = {};
      if (request.headers.has("range"))
        headers.Range = request.headers.get("range")!;
      const response = await networking("assets")(url, {
        headers,
        signal: AbortSignal.timeout(60000),
      });
      const responseHeaders = new Headers(response.headers);
      responseHeaders.set("Access-Control-Allow-Origin", "*");
      return new Response(response.body, {
        status: response.status,
        headers: responseHeaders,
      });
    } catch {
      return new Response(null, { status: 502 });
    }
  });
  for (const provider of ["ytm", "spotify"])
    protocol.handle(`folia-${provider}`, (request) =>
      bridge(provider).handleAudioRequest(request),
    );
  let current: MusicWindowState = {
    title: "",
    artist: "",
    lyric: "",
    playing: false,
    position: 0,
    duration: 0,
  };
  const windows = new Map<string, BrowserWindow>();
  const trusted = (
    event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent,
    auxiliary = false,
  ) => {
    if (
      event.senderFrame !== event.sender.mainFrame ||
      (event.sender !== getMain()?.webContents &&
        !(
          auxiliary &&
          [...windows.values()].some((w) => event.sender === w.webContents)
        ))
    )
      throw new Error("音乐接口访问被拒绝");
  };
  ipcMain.handle("music:call", async (event, method: string, args: any[]) => {
    trusted(event);
    if (!Array.isArray(args) || JSON.stringify(args).length > 5_000_000)
      throw new Error("音乐请求过大");
    if (method === "upgrade") return upgrade();
    if (method === "playlists") {
      await upgrade();
      return disk.playlists ?? [];
    }
    if (method === "savePlaylist") {
      await upgrade();
      const input = args[0];
      if (
        !input ||
        typeof input.name !== "string" ||
        !input.name.trim() ||
        !Array.isArray(input.songIds) ||
        input.songIds.length > 100000 ||
        input.songIds.some((id: any) => typeof id !== "string")
      )
        throw new Error("无效的歌单");
      const existing = disk.playlists.find((row: any) => row.id === input.id);
      const saved = {
        id: existing?.id ?? randomUUID(),
        name: input.name.trim().slice(0, 100),
        songIds: [...new Set(input.songIds)],
        createdAt: existing?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
      };
      store.set("playlists", [
        ...disk.playlists.filter((row: any) => row.id !== saved.id),
        saved,
      ]);
      return saved;
    }
    if (method === "deletePlaylist") {
      await upgrade();
      store.set(
        "playlists",
        disk.playlists.filter((row: any) => row.id !== args[0]),
      );
      return;
    }
    if (method === "favorite" || method === "opened") {
      const item = remoteItem(args[0]);
      if (!item || item.kind) throw new Error("该歌曲不可用");
      if (method === "favorite")
        catalog
          .prepare("UPDATE remote_media SET favorite=? WHERE id=?")
          .run(Number(Boolean(args[1])), item.id);
      else
        catalog
          .prepare("UPDATE remote_media SET opened=? WHERE id=?")
          .run(Date.now(), item.id);
      return;
    }
    if (method === "special") {
      const where =
        args[0] === "favorites" ? "favorite=1" : "opened IS NOT NULL";
      const offset = Math.max(0, Number(args[1]) || 0),
        limit = Math.max(0, Math.min(100, Number(args[2]) || 0));
      const rows = catalog
        .prepare(
          `SELECT id FROM remote_media WHERE ${where} ORDER BY opened DESC,id LIMIT ? OFFSET ?`,
        )
        .all(limit, offset) as any[];
      const items = rows.map((row) => remoteItem(row.id));
      remember(items);
      return {
        items,
        total: (
          catalog
            .prepare(
              `SELECT COUNT(*) AS count FROM remote_media WHERE ${where}`,
            )
            .get() as any
        ).count,
      };
    }
    if (method === "models")
      return Promise.all(
        manifest.models.map(async (m: any) => ({
          name: m.name,
          bytes: m.bytes,
          installed: await modelInstalled(m),
          downloading: modelJobs.has(m.name),
        })),
      );
    if (method === "downloadModel") return downloadModel(args[0]);
    if (method === "aiConfig")
      return {
        provider: disk.ai?.provider ?? "openai",
        url: disk.ai?.url ?? "https://api.openai.com/v1/chat/completions",
        model: disk.ai?.model ?? "",
        configured: Boolean(disk["ai-key"]),
      };
    if (method === "saveAI") {
      const config = args[0];
      if (
        !["openai", "gemini"].includes(config.provider) ||
        typeof config.key !== "string"
      )
        throw new Error("无效的 AI 配置");
      const url =
        config.provider === "openai"
          ? new URL(config.url)
          : new URL("https://generativelanguage.googleapis.com");
      if (
        !/^https?:$/.test(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error("无效的 AI 服务地址");
      if (
        disk.ai &&
        (disk.ai.provider !== config.provider ||
          new URL(disk.ai.url).origin !== url.origin) &&
        !config.key
      )
        throw new Error("更换服务后需要重新输入 API Key");
      if (config.key) secret("ai-key", config.key);
      store.set("ai", {
        provider: config.provider,
        url: url.href,
        model: String(config.model ?? "").slice(0, 256),
      });
      return;
    }
    if (method === "generateTheme") {
      const config = disk.ai;
      if (!config || !disk["ai-key"]) throw new Error("请先配置 AI 服务");
      const client = load("aiTextClient.cjs");
      const prompts = load("yingjianThemePrompt.cjs");
      const view = {
        get: (key: string) =>
          (
            ({
              AI_PROVIDER: config.provider,
              OPENAI_API_URL: config.url,
              OPENAI_API_MODEL: config.model,
              OPENAI_API_KEY: secret("ai-key"),
              GEMINI_API_KEY: secret("ai-key"),
            }) as Record<string, string>
          )[key],
      };
      const content = await client.runAiJsonCompletion({
        store: view,
        systemPrompt: prompts.buildThemeSystemPrompt(true),
        sourcePrompt: prompts.buildThemeSourcePrompt(
          String(args[0]).slice(0, 2000),
          !args[0],
          String(args[1]).slice(0, 300),
        ),
        schema: prompts.THEME_JSON_SCHEMA,
        schemaName: prompts.THEME_JSON_SCHEMA_NAME,
        geminiResponseSchema: prompts.getGeminiResponseSchema(),
        customFetch: networking("ai"),
        maxTokens: 4096,
      });
      const dual = loadCommonJS(
        path.join(projectRoot, "vendor/folia/shared/themeSanitizer.cjs"),
      ).sanitizeDualTheme(
        JSON.parse(
          content
            .trim()
            .replace(/^```(?:json)?\s*/, "")
            .replace(/\s*```$/, ""),
        ),
      );
      return dual;
    }
    if (method === "navidromeConfig") return disk.navidrome ?? null;
    if (method === "saveNavidrome") {
      const config = args[0];
      const url = new URL(config.url);
      if (
        !/^https?:$/.test(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        typeof config.username !== "string" ||
        !config.username ||
        typeof config.password !== "string"
      )
        throw new Error("无效的 Navidrome 配置");
      const serverId = createHash("sha256")
        .update(url.href + config.username)
        .digest("hex")
        .slice(0, 20);
      if (config.password) secret("navidrome-password", config.password);
      store.set("navidrome", {
        url: url.href.replace(/\/$/, ""),
        username: config.username,
        serverId,
      });
      return;
    }
    if (method === "navidrome") {
      const [operation, params = {}] = args;
      if (
        ![
          "getSong",
          "ping",
          "search3",
          "getAlbumList2",
          "getAlbum",
          "getArtist",
          "getArtists",
          "getPlaylists",
          "getPlaylist",
          "getLyricsBySongId",
          "star",
          "unstar",
          "createPlaylist",
          "updatePlaylist",
          "deletePlaylist",
          "getStarred2",
          "getRandomSongs",
          "stream",
        ].includes(operation)
      )
        throw new Error("不支持的 Navidrome 操作");
      if (operation === "stream") return navAsset("stream", { id: params.id });
      const response = await networking("navidrome")(
        navUrl(operation, params),
        { signal: AbortSignal.timeout(30000) },
      );
      if (!response.ok) throw new Error(`Navidrome HTTP ${response.status}`);
      const body = (await response.json())["subsonic-response"];
      if (body?.status !== "ok")
        throw new Error(body?.error?.message ?? "Navidrome 请求失败");
      const decorate = (value: any, depth = 0) => {
        if (!value || depth > 12 || typeof value !== "object") return;
        if (value.coverArt)
          value.yingjianCover = navAsset("getCoverArt", {
            id: value.coverArt,
            size: 700,
          });
        Object.values(value).forEach((v) => decorate(v, depth + 1));
      };
      decorate(body);
      return body;
    }
    if (method === "proxy") {
      const [input, init = {}] = args;
      const url = new URL(input);
      if (
        !/^https?:$/.test(url.protocol) ||
        url.username ||
        url.password ||
        !/(^|\.)(qq\.com|kugou\.com|kgimg\.com|y\.gtimg\.cn|api\.amll\.dev)$/.test(
          url.hostname,
        )
      )
        throw new Error("不支持的歌词服务");
      const headers = new Headers(init.headers);
      for (const key of [
        "host",
        "connection",
        "content-length",
        "origin",
        "referer",
      ])
        headers.delete(key);
      const response = await networking("lyrics")(url.href, {
        method: init.method === "POST" ? "POST" : "GET",
        headers,
        body: init.body,
        redirect: "error",
        signal: AbortSignal.timeout(20000),
      });
      const bodyText = await response.text();
      try {
        remember(JSON.parse(bodyText));
      } catch {
        /* Text lyrics. */
      }
      return {
        status: response.status,
        bodyText,
        headers: Object.fromEntries(response.headers),
      };
    }
    if (method === "http") {
      const [provider, endpoint, init = {}] = args;
      if (
        !["netease", "qq"].includes(provider) ||
        typeof endpoint !== "string" ||
        !/^\/[a-zA-Z0-9/_-]+(?:\?|$)/.test(endpoint) ||
        endpoint.includes("..")
      )
        throw new Error("无效的平台请求");
      const target = new URL(endpoint, "http://127.0.0.1");
      for (const key of [
        "cookie",
        "proxy",
        "url",
        "file",
        "filePath",
        "avatarFile",
        "baseURL",
      ])
        target.searchParams.delete(key);
      const routes = musicRoutes[provider as "netease" | "qq"];
      if (
        !routes.includes(target.pathname) &&
        !(
          provider === "qq" &&
          /^\/(getMusicPlay|getSongListDetail|getSongInfo)\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)?$/.test(
            target.pathname,
          )
        )
      )
        throw new Error("未授权的平台接口");
      let status = 200,
        body: any;
      if (provider === "netease") {
        const api = loadCommonJS("@neteasecloudmusicapienhanced/api");
        const fn = api[target.pathname.slice(1).replaceAll("/", "_")];
        if (typeof fn !== "function") throw new Error("不支持的网易云接口");
        const params = {
          ...Object.fromEntries(target.searchParams),
          ...(init.body ? JSON.parse(init.body) : {}),
        };
        for (const key of [
          "cookie",
          "proxy",
          "url",
          "file",
          "filePath",
          "avatarFile",
          "baseURL",
        ])
          delete params[key];
        const answer = await fn({
          ...params,
          cookie: secret("netease-cookie"),
          timeout: 25000,
        }).catch((error: any) => {
          if (error?.body) return error;
          throw new Error("网易云音乐请求失败，请检查网络");
        });
        status = answer.status || 200;
        body = answer.body;
        if (body?.cookie) {
          secret("netease-cookie", body.cookie);
          body.cookie = "main-process-session";
        }
        if (target.pathname === "/logout") store.delete("netease-cookie");
      } else {
        const backend = await qq();
        const cookie = secret("qq-cookie");
        if (cookie) target.searchParams.set("cookie", cookie);
        const response = await fetch(
          `http://127.0.0.1:${backend.getPort()}${target.pathname}${target.search}`,
          {
            method: init.method === "POST" ? "POST" : "GET",
            headers: { "Content-Type": "application/json" },
            ...(init.method === "POST" ? { body: init.body } : {}),
            signal: AbortSignal.timeout(75000),
          },
        );
        status = response.status;
        body = await response.json();
        if (body?.cookie) {
          secret("qq-cookie", body.cookie);
          body.cookie = "main-process-session";
        }
        if (target.pathname === "/logout") store.delete("qq-cookie");
      }
      remember(body);
      return { status, body };
    }
    if (method === "request") {
      const [provider, operation, params = {}] = args;
      if (!PROVIDERS.has(provider)) throw new Error("无效的音乐平台");
      const result = await bridge(provider).request(operation, params);
      remember(result);
      return result;
    }
    if (method === "resource") return resource(args[1]);
    if (method === "saveCatalog") {
      const items = args[0] as MediaItem[];
      catalog.exec("BEGIN");
      try {
        for (const item of items)
          if (item.sourceRef && item.sourceRef.kind !== "local")
            saveRemote.run(
              item.id,
              JSON.stringify({
                ...item,
                remoteAudio: undefined,
                remoteCover: undefined,
              }),
              Number(item.favorite),
              item.lastOpened ?? null,
            );
        catalog.exec("COMMIT");
      } catch (error) {
        catalog.exec("ROLLBACK");
        throw error;
      }
      return;
    }
    if (method === "items") {
      const rows = args[0]
        .slice(0, 1000)
        .map((id: string) => remoteItem(id))
        .filter(Boolean);
      remember(rows);
      return rows;
    }
    if (method === "session")
      return disk.session
        ? { session: { ...disk.session, position: 0 }, items: [] }
        : null;
    if (method === "saveSession") {
      store.set("session", { ...args[0], position: 0 });
      return;
    }
    if (method === "window") {
      const action = args[0];
      const name = action.replace("close-", "");
      if (!["mini", "lyrics"].includes(name)) throw new Error("无效的音乐窗口");
      if (action.startsWith("close-")) {
        windows.get(name)?.close();
        return;
      }
      if (windows.has(name)) {
        windows.get(name)!.show();
        return;
      }
      const main = getMain()!;
      const win = new BrowserWindow({
        width: name === "mini" ? 380 : 900,
        height: name === "mini" ? 180 : 150,
        icon: app.isPackaged
          ? path.join(process.resourcesPath, "kaleid-icon.png")
          : path.resolve(projectRoot, "build/kaleid-icon.png"),
        frame: false,
        transparent: name === "lyrics",
        alwaysOnTop: true,
        resizable: true,
        webPreferences: {
          preload: path.join(projectRoot, "out/preload/index.cjs"),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      windows.set(name, win);
      win.on("closed", () => windows.delete(name));
      win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      const base = process.env.ELECTRON_RENDERER_URL || "app://local/";
      await win.loadURL(`${base}#music-${name}`);
      win.webContents.send("music:state", current);
      return;
    }
    throw new Error("未知的音乐接口");
  });
  ipcMain.on("music:publish", (event, state: MusicWindowState) => {
    trusted(event);
    current = state;
    for (const win of windows.values())
      win.webContents.send("music:state", current);
  });
  ipcMain.on("music:command", (event, command: string, value?: number) => {
    trusted(event, true);
    if (
      [
        "play",
        "pause",
        "toggle",
        "next",
        "previous",
        "seek",
        "expand",
        "close",
      ].includes(command)
    ) {
      if (command === "close") {
        [...windows.values()]
          .find((w) => event.sender === w.webContents)
          ?.close();
        return;
      }
      if (command === "expand") {
        const main = getMain();
        if (main?.isMinimized()) main.restore();
        main?.show();
        main?.focus();
      }
      getMain()?.webContents.send("music:command", command, value);
    }
  });
  let quitting = false;
  app.on("before-quit", () => {
    if (quitting) return;
    quitting = true;
    for (const win of windows.values()) win.destroy();
    void bridges.get("qq-backend")?.stop();
    void bridges.get("ytm")?.shutdown();
    catalog.close();
  });
  return {
    closeWindows() {
      for (const win of windows.values()) win.close();
    },
    clearRecent(id?: string) {
      if (id !== undefined && !remoteItem(id))
        throw new Error("该历史条目不可用");
      return Number(
        catalog
          .prepare(
            `UPDATE remote_media SET opened=NULL WHERE opened IS NOT NULL${id ? " AND id=?" : ""}`,
          )
          .run(...(id ? [id] : [])).changes,
      );
    },
  };
}
