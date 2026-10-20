import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  powerSaveBlocker,
  screen,
  shell,
} from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { videoBinary } from "./videoFiles";
import {
  VideoExports,
  inspectExportSource,
  validateExport,
} from "./videoExport";
import { VideoEnhancer } from "./videoEnhancement";
import {
  videoPreferences,
  resumeVideo,
  type VideoBounds,
  type VideoCommand,
  type VideoPreferences,
  type VideoState,
  type VideoExportRequest,
} from "../shared/video";
import type { MediaItem } from "../shared/types";

type Call = (method: string, ...args: any[]) => Promise<any>;
interface Playback {
  state: VideoState;
  item?: MediaItem;
  host?: ChildProcessWithoutNullStreams;
  mpv?: ChildProcessWithoutNullStreams;
  socket?: net.Socket;
  pending: Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >;
  requestId: number;
  closed: boolean;
  timer?: ReturnType<typeof setInterval>;
  publishTimer?: ReturnType<typeof setTimeout>;
  blocker?: number;
  bounds?: VideoBounds;
  log: string;
  completed: boolean;
  saveJob: Promise<unknown>;
  cleanupJob?: Promise<void>;
  dialogOpen?: boolean;
  preferencesLoaded?: boolean;
  enhancer?: VideoEnhancer;
}
const observed = [
  "pause",
  "time-pos",
  "duration",
  "track-list",
  "volume",
  "mute",
  "speed",
  "eof-reached",
];
export function installVideo(
  getWindow: () => BrowserWindow | null,
  call: Call,
) {
  let current: Playback | undefined;
  let opening: Promise<unknown> = Promise.resolve();
  let quitting = false;
  let quitPending = false;
  const exports = new VideoExports(
    path.join(app.getPath("userData"), "video-export-temporaries.json"),
    (jobs) => getWindow()?.webContents.send("video:exports", jobs),
  );
  const send = (p: Playback, immediate = false) => {
    if (p.closed || current !== p) return;
    const publish = () => {
      p.publishTimer = undefined;
      getWindow()?.webContents.send("video:state", p.state);
    };
    if (immediate) {
      clearTimeout(p.publishTimer);
      publish();
    } else if (!p.publishTimer) p.publishTimer = setTimeout(publish, 100);
  };
  function power(p: Playback) {
    const active = !p.closed && p.state.status === "ready" && !p.state.paused;
    if (active && p.blocker === undefined)
      p.blocker = powerSaveBlocker.start("prevent-display-sleep");
    if (!active && p.blocker !== undefined) {
      if (powerSaveBlocker.isStarted(p.blocker))
        powerSaveBlocker.stop(p.blocker);
      p.blocker = undefined;
    }
  }
  function save(p: Playback) {
    if (
      !p.item ||
      !Number.isFinite(p.state.position) ||
      p.state.status === "loading"
    )
      return p.saveJob;
    const progress = {
      position: p.completed ? 0 : Math.max(0, p.state.position),
      duration: p.state.duration,
      completed: p.completed,
    };
    // Preserve ordering even when a periodic save races a seek or EOF.
    p.saveJob = p.saveJob
      .catch(() => {})
      .then(() => call("saveProgress", p.state.mediaId, progress));
    return p.saveJob;
  }
  function raw(p: Playback, command: unknown[]): Promise<any> {
    return new Promise((resolve, reject) => {
      if (p.closed || !p.socket || p.socket.destroyed) {
        reject(new Error("播放器连接已关闭"));
        return;
      }
      const id = ++p.requestId;
      const timer = setTimeout(() => {
        p.pending.delete(id);
        reject(new Error("播放器响应超时"));
      }, 5000);
      p.pending.set(id, { resolve, reject, timer });
      p.socket.write(
        JSON.stringify({ command, request_id: id }) + "\n",
        (error) => {
          if (error) {
            clearTimeout(timer);
            p.pending.delete(id);
            reject(error);
          }
        },
      );
    });
  }
  function cleanup(p: Playback): Promise<void> {
    if (p.cleanupJob) return p.cleanupJob;
    p.cleanupJob = (async () => {
      clearInterval(p.timer);
      clearTimeout(p.publishTimer);
      p.closed = true;
      p.enhancer?.close();
      power(p);
      await save(p).catch(console.error);
      if (p.preferencesLoaded)
        await call("saveVideoPreferences", p.state.preferences).catch(
          console.error,
        );
      p.socket?.destroy();
      for (const job of p.pending.values()) {
        clearTimeout(job.timer);
        job.reject(new Error("播放会话已结束"));
      }
      p.pending.clear();
      p.mpv?.kill();
      p.host?.stdin.end();
      p.host?.kill();
      if (current === p) current = undefined;
    })();
    return p.cleanupJob;
  }
  function fail(
    p: Playback,
    kind: NonNullable<VideoState["error"]>["kind"],
    message: string,
  ) {
    if (p.closed || current !== p || p.state.status === "error") return;
    p.state.status = "error";
    p.state.paused = true;
    p.state.error = { kind, message };
    p.enhancer?.close();
    power(p);
    if (p.bounds)
      p.host?.stdin.write(
        JSON.stringify({ ...p.bounds, visible: false }) + "\n",
      );
    send(p, true);
    void save(p).catch(console.error);
    console.warn("Video playback failed", kind, p.log.slice(-2000));
    clearInterval(p.timer);
    p.socket?.destroy();
    p.mpv?.kill();
    p.host?.kill();
  }
  async function setPreferences(p: Playback, value: Partial<VideoPreferences>) {
    const next = videoPreferences({ ...p.state.preferences, ...value });
    const previous = p.state.preferences;
    p.state.preferences = next;
    const properties: [keyof VideoPreferences, string, unknown][] = [
      ["volume", "volume", next.volume],
      ["muted", "mute", next.muted],
      ["speed", "speed", next.speed],
      ["hardwareDecoding", "hwdec", next.hardwareDecoding ? "auto" : "no"],
      ["subtitles", "sub-visibility", next.subtitles],
      ["subtitleSize", "sub-font-size", next.subtitleSize],
      ["subtitlePosition", "sub-pos", next.subtitlePosition],
      ["subtitleDelay", "sub-delay", next.subtitleDelay],
      ["audioDelay", "audio-delay", next.audioDelay],
      ["fit", "panscan", next.fit === "cover" ? 1 : 0],
      ["fit", "video-unscaled", next.fit === "original" ? "yes" : "no"],
      [
        "aspect",
        "video-aspect-override",
        next.aspect === "auto" ? "-1" : next.aspect,
      ],
      ["rotation", "video-rotate", next.rotation],
    ].filter(([field]) => Object.hasOwn(value, String(field))) as [
      keyof VideoPreferences,
      string,
      unknown,
    ][];
    if (p.socket && !p.socket.destroyed && !p.closed) {
      const commands = properties.map(([, key, value]) =>
        raw(p, ["set_property", key, value]),
      );
      const results = await Promise.allSettled(commands);
      // Unsupported GPU options must not make volume or subtitle controls unusable.
      results.forEach((result, index) => {
        if (result.status === "rejected")
          console.warn("mpv property", properties[index][1], result.reason);
      });
    }
    await call("saveVideoPreferences", next);
    void p.enhancer?.update();
    if (previous.hardwareDecoding !== next.hardwareDecoding)
      void save(p).catch(console.error);
    send(p, true);
  }
  function handleMessage(p: Playback, event: any) {
    if (p.closed || current !== p) return;
    if (typeof event.request_id === "number") {
      const job = p.pending.get(event.request_id);
      if (job) {
        clearTimeout(job.timer);
        p.pending.delete(event.request_id);
        if (event.error === "success") job.resolve(event.data);
        else job.reject(new Error(String(event.error)));
      }
    }
    if (event.event === "property-change") {
      const data = event.data;
      switch (event.name) {
        case "eof-reached":
          if (data === true && p.state.status === "ready") {
            p.completed = true;
            p.state.status = "ended";
            p.state.paused = true;
            power(p);
            void save(p).catch(console.error);
            send(p, true);
          } else if (data === false && p.state.status === "ended") {
            p.completed = false;
            p.state.status = "ready";
            power(p);
          }
          break;
        case "time-pos":
          if (Number.isFinite(data)) p.state.position = Math.max(0, data);
          break;
        case "duration":
          if (Number.isFinite(data)) p.state.duration = Math.max(0, data);
          break;
        case "pause":
          p.state.paused = Boolean(data);
          power(p);
          if (data) void save(p).catch(console.error);
          break;
        case "track-list":
          p.state.tracks = Array.isArray(data)
            ? data.filter((t: any) => t.type === "audio" || t.type === "sub")
            : [];
          break;
        case "volume":
          if (Number.isFinite(data)) p.state.preferences.volume = data;
          break;
        case "mute":
          p.state.preferences.muted = Boolean(data);
          break;
        case "speed":
          if (Number.isFinite(data)) p.state.preferences.speed = data;
          break;
      }
      send(p);
    }
    if (event.event === "seek") p.enhancer?.reset();
    if (event.event === "log-message")
      p.enhancer?.log(String(event.text ?? ""));
    if (event.event === "playback-restart") void save(p).catch(console.error);
    if (event.event === "end-file") {
      if (event.reason === "eof") {
        p.completed = true;
        p.state.status = "ended";
        p.state.paused = true;
        power(p);
        void save(p).catch(console.error);
        send(p, true);
      } else if (event.reason === "error")
        fail(
          p,
          /invalid|unrecognized|format/i.test(event.file_error ?? "")
            ? "damaged"
            : "decode",
          "视频解码失败，可尝试关闭硬件解码后重试。",
        );
    }
    if (
      event.event === "client-message" &&
      event.args?.[0] === "kaleid-input"
    ) {
      const action = event.args[1];
      if (
        ["fullscreen", "escape", "activity", "back", "forward"].includes(action)
      )
        getWindow()?.webContents.send("video:input", {
          sessionId: p.state.sessionId,
          action,
        });
    }
  }
  async function connect(p: Playback, pipe: string) {
    const deadline = Date.now() + 10000;
    while (!p.closed && current === p && Date.now() < deadline) {
      try {
        const socket = await new Promise<net.Socket>((resolve, reject) => {
          const socket = net.createConnection(pipe);
          const timer = setTimeout(() => {
            socket.destroy();
            reject(new Error("连接超时"));
          }, 500);
          socket.once("connect", () => {
            clearTimeout(timer);
            socket.removeListener("error", failed);
            resolve(socket);
          });
          const failed = (error: Error) => {
            clearTimeout(timer);
            socket.destroy();
            reject(error);
          };
          socket.once("error", failed);
        });
        if (p.closed || current !== p) {
          socket.destroy();
          throw new Error("播放已取消");
        }
        p.socket = socket;
        let buffer = "";
        socket.setEncoding("utf8");
        socket.on("data", (part: string) => {
          buffer += part;
          if (buffer.length > 4 * 1024 * 1024) {
            socket.destroy();
            return;
          }
          let end: number;
          while ((end = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, end);
            buffer = buffer.slice(end + 1);
            try {
              handleMessage(p, JSON.parse(line));
            } catch (error) {
              console.warn("mpv event", error);
            }
          }
        });
        socket.on("error", () => fail(p, "engine", "播放器连接中断，请重试。"));
        socket.on("close", () => {
          if (!p.closed) fail(p, "engine", "播放器已断开，请重试。");
        });
        return;
      } catch {
        if (p.state.status === "error") throw new Error(p.state.error?.message);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    throw new Error("播放器启动超时");
  }
  function spawnHost(p: Playback, parent: Buffer) {
    return new Promise<number>((resolve, reject) => {
      const hwnd =
        parent.length >= 8
          ? parent.readBigUInt64LE().toString()
          : String(parent.readUInt32LE());
      const child = spawn(videoBinary("host"), [hwnd, String(process.pid)], {
        windowsHide: true,
        stdio: "pipe",
      });
      p.host = child;
      const timer = setTimeout(
        () => reject(new Error("画面宿主启动超时")),
        10000,
      );
      let output = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (part) => {
        output += part;
        if (!output.includes("\n")) return;
        try {
          const value = JSON.parse(output.split("\n")[0]);
          clearTimeout(timer);
          resolve(value.hwnd);
        } catch {
          clearTimeout(timer);
          reject(new Error("无效的宿主窗口"));
        }
      });
      child.stdin.on("error", () => {});
      child.stderr.on("data", (part) => {
        p.log = (p.log + part.toString()).slice(-8192);
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("画面宿主已退出"));
        if (!p.closed) fail(p, "engine", "视频画面宿主意外退出，请重试。");
      });
    });
  }
  async function start(
    p: Playback,
    input: { autoPlay: boolean; fromStart?: boolean },
  ) {
    try {
      let source: { item: MediaItem; path: string };
      try {
        source = await call("videoFile", p.state.mediaId);
      } catch {
        fail(p, "offline", "视频文件不可用，请检查来源目录或重新扫描。");
        return;
      }
      if (p.closed || current !== p) return;
      p.item = source.item;
      p.state.preferences = videoPreferences(await call("videoPreferences"));
      p.preferencesLoaded = true;
      if (p.closed || current !== p) return;
      p.state.duration = source.item.duration ?? 0;
      const startPosition = input.fromStart
        ? 0
        : resumeVideo(
            source.item.progress?.position,
            p.state.duration,
            source.item.progress?.completed,
          );
      p.state.position = startPosition;
      p.state.resumed = startPosition > 0;
      await Promise.all([
        fs.access(videoBinary("host")),
        fs.access(videoBinary("mpv")),
      ]);
      if (p.closed || current !== p) return;
      const window = getWindow();
      if (!window) throw new Error("窗口已关闭");
      const hwnd = await spawnHost(p, window.getNativeWindowHandle());
      if (p.closed || current !== p) return;
      const pipe = [
        "",
        "",
        ".",
        "pipe",
        "kaleid-video-" + process.pid + "-" + randomUUID(),
      ].join(String.fromCharCode(92));
      const configDirectory = path.join(app.getPath("userData"), "video");
      await fs.mkdir(configDirectory, { recursive: true });
      const inputFile = path.join(configDirectory, "input.conf");
      await fs.writeFile(
        inputFile,
        [
          "SPACE cycle pause",
          "LEFT seek -5",
          "RIGHT seek 5",
          "Shift+LEFT seek -30",
          "Shift+RIGHT seek 30",
          "UP add volume 5",
          "DOWN add volume -5",
          "m cycle mute",
          "f script-message kaleid-input fullscreen",
          "ESC script-message kaleid-input escape",
          "MBTN_BACK script-message kaleid-input back",
          "MBTN_FORWARD script-message kaleid-input forward",
          "GO_BACK script-message kaleid-input back",
          "GO_FORWARD script-message kaleid-input forward",
          "MBTN_LEFT cycle pause",
          "MBTN_LEFT_DBL script-message kaleid-input fullscreen",
          "MOUSE_MOVE script-message kaleid-input activity",
          "WHEEL_UP add volume 5",
          "WHEEL_DOWN add volume -5",
        ].join("\n"),
      );
      if (p.closed || current !== p) return;
      p.mpv = spawn(
        videoBinary("mpv"),
        [
          "--no-config",
          "--idle=yes",
          "--keep-open=yes",
          "--osc=no",
          "--osd-level=1",
          "--terminal=no",
          "--input-default-bindings=no",
          `--input-conf=${inputFile}`,
          "--input-vo-keyboard=yes",
          "--input-media-keys=no",
          "--stop-screensaver=no",
          "--window-dragging=no",
          `--wid=${hwnd >>> 0}`,
          `--input-ipc-server=${pipe}`,
          "--hwdec=auto",
          "--sub-auto=no",
          "--autoload-files=no",
          "--access-references=no",
          "--load-scripts=no",
          "--vo=gpu-next",
          "--gpu-api=d3d11",
        ],
        { windowsHide: true, stdio: "pipe" },
      );
      p.mpv.stderr.on("data", (part) => {
        p.log = (p.log + part.toString()).slice(-8192);
      });
      p.mpv.stdout.resume();
      p.mpv.stdin.on("error", () => {});
      p.mpv.once("error", (error) =>
        fail(p, "engine", `无法启动播放内核：${error.message}`),
      );
      p.mpv.once("exit", () => {
        if (!p.closed) fail(p, "engine", "播放内核意外退出，请重试。");
      });
      await connect(p, pipe);
      await raw(p, ["request_log_messages", "warn"]);
      for (let index = 0; index < observed.length; index++)
        await raw(p, ["observe_property", index, observed[index]]);
      await setPreferences(p, p.state.preferences);
      await raw(p, ["set_property", "pause", true]);
      const loaded = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          clearInterval(poll);
          reject(new Error("读取视频超时"));
        }, 20000);
        const poll = setInterval(() => {
          if (p.closed || p.state.status === "error") {
            clearInterval(poll);
            clearTimeout(timer);
            reject(new Error("视频无法加载"));
            return;
          }
          void raw(p, ["get_property", "video-format"])
            .then((format) => {
              if (format) {
                clearInterval(poll);
                clearTimeout(timer);
                resolve();
              }
            })
            .catch(() => {});
        }, 100);
      });
      // Attach the rejection handler immediately, including loadfile failure paths.
      void loaded.catch(() => {});
      await raw(p, ["loadfile", source.path, "replace"]);
      await loaded;
      if (p.closed || current !== p) return;
      const duration = await raw(p, ["get_property", "duration"]).catch(
        () => p.state.duration,
      );
      if (Number.isFinite(duration)) p.state.duration = duration;
      p.state.position = resumeVideo(startPosition, p.state.duration);
      if (p.state.position > 0)
        await raw(p, ["seek", p.state.position, "absolute+exact"]);
      const subtitles = await call("videoSubtitles", p.state.mediaId).catch(
        () => [],
      );
      if (p.closed || current !== p) return;
      for (let index = 0; index < subtitles.length; index++)
        await raw(p, [
          "sub-add",
          subtitles[index],
          index === 0 ? "select" : "auto",
        ]).catch(console.warn);
      p.state.status = "ready";
      const gpu = (await app.getGPUInfo("complete").catch(() => ({}))) as any;
      if (p.closed || current !== p) return;
      const devices: any[] = gpu.gpuDevice ?? [];
      const nvidia = devices.some(
        (device) =>
          device.active &&
          device.vendorId === 0x10de &&
          /RTX/i.test(
            device.deviceString ?? device.deviceName ?? JSON.stringify(gpu),
          ),
      );
      p.enhancer = new VideoEnhancer(
        p.state,
        () => p.bounds,
        (commands) => raw(p, commands),
        () => send(p, true),
        nvidia,
      );
      void p.enhancer.update();
      p.state.paused = !input.autoPlay;
      send(p, true);
      await raw(p, ["set_property", "pause", !input.autoPlay]);
      power(p);
      p.timer = setInterval(() => {
        void save(p).catch(console.error);
        void call("saveVideoPreferences", p.state.preferences).catch(
          console.error,
        );
      }, 5000);
      send(p, true);
    } catch (error) {
      fail(
        p,
        p.socket ? "decode" : "engine",
        p.socket
          ? "无法读取视频，请检查文件是否损坏，或关闭硬件解码后重试。"
          : `无法启动视频播放器，请重新安装播放组件。${String(error).slice(0, 200)}`,
      );
    }
  }
  function active(sessionId: unknown) {
    if (!current || current.closed || current.state.sessionId !== sessionId)
      throw new Error("播放会话已失效");
    return current;
  }
  ipcMain.handle(
    "video:call",
    async (event, method: string, ...args: any[]) => {
      const window = getWindow();
      if (
        !window ||
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame
      )
        throw new Error("无权访问视频播放");
      if (method === "open") {
        const input = args[0];
        if (
          !input ||
          !/^[a-f0-9]{32}$/.test(input.mediaId) ||
          typeof input.sessionId !== "string" ||
          !/^[\w-]{1,100}$/.test(input.sessionId) ||
          typeof input.autoPlay !== "boolean"
        )
          throw new Error("无效的播放请求");
        // Assign the new session synchronously; older asynchronous startup cannot regain ownership.
        const previous = current;
        const p: Playback = {
          state: {
            sessionId: input.sessionId,
            mediaId: input.mediaId,
            status: "loading",
            paused: true,
            position: 0,
            duration: 0,
            tracks: [],
            preferences: videoPreferences(),
            fullscreen: window.isFullScreen(),
            resumed: false,
          },
          pending: new Map(),
          requestId: 0,
          closed: false,
          log: "",
          completed: false,
          saveJob: Promise.resolve(),
        };
        current = p;
        const stopping = previous ? cleanup(previous) : Promise.resolve();
        opening = opening
          .catch(() => {})
          .then(async () => {
            await stopping;
            if (current !== p || p.closed || quitting) return;
            await start(p, input);
          });
        void opening.catch((error) => fail(p, "engine", String(error)));
        return p.state;
      }
      if (method === "queue") {
        if (
          typeof args[0] !== "string" ||
          !["name", "added", "recent"].includes(args[1])
        )
          throw new Error("无效的选集请求");
        return call("videoQueue", args[0], args[1]);
      }
      if (method === "exports") return exports.list();
      if (method === "cancelExport") {
        await exports.cancel(String(args[0]));
        return;
      }
      if (method === "revealExport") {
        const job = exports
          .list()
          .find((job) => job.id === args[0] && job.status === "completed");
        if (!job) throw new Error("导出文件不可用");
        shell.showItemInFolder(job.output);
        return;
      }
      if (method === "export") {
        const input = args[0] as VideoExportRequest;
        const p = active(input?.sessionId);
        if (
          input.mediaId !== p.state.mediaId ||
          !["ready", "ended"].includes(p.state.status)
        )
          throw new Error("视频尚未准备好");
        validateExport(input, p.state.duration);
        const file = await call("videoFile", p.state.mediaId);
        const selected = p.state.tracks.find(
          (track) => track.type === "audio" && track.selected,
        );
        if (input.audio && selected && typeof selected["ff-index"] !== "number")
          throw new Error("无法确定当前音轨，请重新打开视频");
        const source = await inspectExportSource(
          file.path,
          file.item.title,
          input.audio ? selected?.["ff-index"] : undefined,
        );
        if (p.closed || current !== p) throw new Error("播放会话已失效");
        validateExport(input, source.duration);
        const mark = (n: number) => n.toFixed(3).replace(".", "-");
        p.dialogOpen = true;
        if (p.bounds)
          p.host?.stdin.write(
            JSON.stringify({ ...p.bounds, visible: false }) + "\n",
          );
        let result;
        try {
          result = await dialog.showSaveDialog(window, {
            title:
              input.format === "gif" ? "导出 GIF 动图" : "导出 MP4 片段（SDR）",
            defaultPath: path.join(
              path.dirname(source.file),
              `${source.title.replace(/[<>:"/\\|?*]/g, "_")}_${mark(input.start)}_${mark(input.end)}.${input.format}`,
            ),
            filters: [
              { name: input.format.toUpperCase(), extensions: [input.format] },
            ],
            properties: ["showOverwriteConfirmation", "createDirectory"],
          });
        } finally {
          p.dialogOpen = false;
          if (!p.closed && current === p && p.bounds)
            p.host?.stdin.write(
              JSON.stringify({ ...p.bounds, visible: true }) + "\n",
            );
        }
        if (result.canceled || !result.filePath) return null;
        if (p.closed || current !== p) throw new Error("播放会话已失效");
        if (path.extname(result.filePath).toLowerCase() !== `.${input.format}`)
          throw new Error("文件扩展名必须与导出格式一致");
        return exports.add(source, input, result.filePath);
      }
      if (method === "close") {
        if (current && current.state.sessionId === args[0]) {
          const p = current;
          await cleanup(p);
          if (window.isFullScreen()) window.setFullScreen(false);
        }
        return;
      }
      const p = active(args[0]);
      if (method === "bounds") {
        const bounds = args[1] as VideoBounds;
        if (
          !bounds ||
          ![bounds.x, bounds.y, bounds.width, bounds.height].every(
            (n) =>
              typeof n === "number" &&
              Number.isFinite(n) &&
              Math.abs(n) < 50000,
          )
        )
          throw new Error("无效画面区域");
        const content = window.getContentBounds();
        const scale = screen.getDisplayMatching(content).scaleFactor;
        const x = Math.max(0, Math.min(content.width, bounds.x));
        const y = Math.max(0, Math.min(content.height, bounds.y));
        p.bounds = {
          x: Math.round(x * scale),
          y: Math.round(y * scale),
          width: Math.round(
            Math.max(0, Math.min(bounds.width, content.width - x)) * scale,
          ),
          height: Math.round(
            Math.max(0, Math.min(bounds.height, content.height - y)) * scale,
          ),
          visible:
            bounds.visible === true &&
            (p.state.status === "ready" || p.state.status === "ended") &&
            !p.dialogOpen,
        };
        p.host?.stdin.write(JSON.stringify(p.bounds) + "\n");
        return;
      }
      if (method === "subtitle") {
        p.dialogOpen = true;
        if (p.bounds)
          p.host?.stdin.write(
            JSON.stringify({ ...p.bounds, visible: false }) + "\n",
          );
        let result;
        try {
          result = await dialog.showOpenDialog(window, {
            title: "选择外挂字幕",
            properties: ["openFile"],
            filters: [
              { name: "字幕", extensions: ["srt", "ass", "ssa", "vtt"] },
            ],
          });
        } finally {
          p.dialogOpen = false;
        }
        if (
          result.canceled ||
          !result.filePaths[0] ||
          current !== p ||
          p.closed
        )
          return;
        const file = await fs.realpath(result.filePaths[0]);
        if (
          !/\.(srt|ass|ssa|vtt)$/i.test(file) ||
          !(await fs.stat(file)).isFile()
        )
          throw new Error("请选择支持的字幕文件");
        await raw(p, ["sub-add", file, "select"]);
        return;
      }
      if (method !== "command") throw new Error("不支持的视频操作");
      const command = args[1] as VideoCommand;
      if (!command || typeof command !== "object")
        throw new Error("无效的播放操作");
      switch (command.type) {
        case "preview": {
          const range = command.value;
          if (
            range &&
            (![range.start, range.end].every(
              (n) => typeof n === "number" && Number.isFinite(n),
            ) ||
              range.start < 0 ||
              range.end <= range.start ||
              range.end > p.state.duration)
          )
            throw new Error("无效预览范围");
          await raw(p, ["set_property", "ab-loop-a", "no"]);
          await raw(p, ["set_property", "ab-loop-b", "no"]);
          if (range) {
            p.completed = false;
            p.state.status = "ready";
            await raw(p, ["set_property", "ab-loop-a", range.start]);
            await raw(p, ["set_property", "ab-loop-b", range.end]);
            await raw(p, ["seek", range.start, "absolute+exact"]);
          }
          await raw(p, ["set_property", "pause", !range]);
          break;
        }
        case "pause":
          if (typeof command.value !== "boolean")
            throw new Error("无效暂停状态");
          if (p.completed && !command.value) {
            p.completed = false;
            p.state.status = "ready";
            await raw(p, ["seek", 0, "absolute+exact"]);
          }
          await raw(p, ["set_property", "pause", command.value]);
          break;
        case "seek":
          if (
            typeof command.value !== "number" ||
            !Number.isFinite(command.value)
          )
            throw new Error("无效跳转位置");
          p.completed = false;
          p.state.status = "ready";
          await raw(p, [
            "seek",
            command.relative
              ? command.value
              : Math.max(
                  0,
                  Math.min(command.value, p.state.duration || command.value),
                ),
            command.relative ? "relative+exact" : "absolute+exact",
          ]);
          p.state.position = await raw(p, ["get_property", "time-pos"]);
          await save(p);
          break;
        case "preferences":
          if (
            !command.value ||
            typeof command.value !== "object" ||
            Array.isArray(command.value)
          )
            throw new Error("无效播放设置");
          await setPreferences(p, command.value);
          break;
        case "track":
          if (
            !["audio", "sub"].includes(command.kind) ||
            (command.id !== "no" &&
              !p.state.tracks.some(
                (track) =>
                  track.type === command.kind && track.id === command.id,
              ))
          )
            throw new Error("无效轨道");
          await raw(p, [
            "set_property",
            command.kind === "audio" ? "aid" : "sid",
            command.id,
          ]);
          break;
        case "fullscreen":
          if (typeof command.value !== "boolean")
            throw new Error("无效全屏状态");
          window.setFullScreen(command.value);
          p.state.fullscreen = command.value;
          break;
        default:
          throw new Error("不支持的播放操作");
      }
      send(p, true);
    },
  );
  function bindWindow(window: BrowserWindow) {
    window.on("enter-full-screen", () => {
      if (current) {
        current.state.fullscreen = true;
        send(current, true);
      }
    });
    window.on("leave-full-screen", () => {
      if (current) {
        current.state.fullscreen = false;
        send(current, true);
      }
    });
    window.on("close", (event) => {
      if (exports.hasActive() && !quitting) {
        event.preventDefault();
        void requestQuit();
        return;
      }
      if (!event.defaultPrevented && current) void cleanup(current);
    });
    window.webContents.on("render-process-gone", () => {
      if (current) void cleanup(current);
    });
    window.webContents.on(
      "did-start-navigation",
      (_event, _url, _inPlace, mainFrame) => {
        if (mainFrame && current) void cleanup(current);
      },
    );
  }
  async function requestQuit() {
    if (quitPending || quitting) return;
    quitPending = true;
    try {
      if (exports.hasActive()) {
        const options = {
          type: "question" as const,
          title: "视频正在导出",
          message: "还有尚未完成的导出任务",
          detail: "继续等待会保留应用和任务；退出会取消全部未完成的任务。",
          buttons: ["继续等待", "取消任务并退出"],
          defaultId: 0,
          cancelId: 0,
        };
        const window = getWindow();
        const result = window
          ? await dialog.showMessageBox(window, options)
          : await dialog.showMessageBox(options);
        if (result.response !== 1) return;
      }
      quitting = true;
      await exports.stop();
      if (current) await cleanup(current);
      app.quit();
    } finally {
      quitPending = false;
    }
  }
  app.on("before-quit", (event) => {
    if (quitting) return;
    if (!current && !exports.hasActive()) return;
    event.preventDefault();
    void requestQuit().catch(console.error);
  });
  return { bindWindow };
}
