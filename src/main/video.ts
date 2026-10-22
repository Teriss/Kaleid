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
  logicalBounds?: VideoBounds;
  log: string;
  completed: boolean;
  saveJob: Promise<unknown>;
  cleanupJob?: Promise<void>;
  dialogOpen?: boolean;
  preferencesLoaded?: boolean;
  enhancer?: VideoEnhancer;
  audioTicket?: number;
  hostMoves?: Map<
    string,
    {
      resolve(): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >;
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
  overlay?: {
    setHostWindow(window: BrowserWindow): void;
    refresh(): void;
    suspend(value: boolean): void;
    focusControls(reverse: boolean): boolean;
    onEdgeActivity(callback: (active: boolean) => void): void;
  },
) {
  let current: Playback | undefined;
  let opening: Promise<unknown> = Promise.resolve();
  let quitting = false;
  let floating: BrowserWindow | undefined;
  let closingFloating = false;
  let presenting: Promise<void> = Promise.resolve();
  let gesture:
    | {
        sessionId: string;
        x: number;
        y: number;
        bounds: Electron.Rectangle;
        edge: string;
        moved: boolean;
      }
    | undefined;
  let audioSerial = 0;
  const audioAcks = new Map<number, () => void>();
  const playbackWindow = () =>
    floating &&
    !floating.isDestroyed() &&
    current?.state.presentation === "floating"
      ? floating
      : getWindow();
  const windowPrefsPath = () =>
    path.join(app.getPath("userData"), "video-window.json");
  let windowSaveTimer: ReturnType<typeof setTimeout> | undefined;
  let windowSave = Promise.resolve();
  function setFloatingBounds(bounds: Electron.Rectangle) {
    if (!floating) return;
    let requested = { ...bounds };
    // DIP rectangles can round outwards at fractional Windows scaling.
    // Compensate measured size so restoring an already rounded rectangle
    // cannot accumulate another pixel on each window migration.
    for (let i = 0; i < 3; i++) {
      floating.setBounds(requested);
      const actual = floating.getBounds();
      if (actual.width === bounds.width && actual.height === bounds.height)
        break;
      requested = {
        ...requested,
        width: Math.max(320, requested.width + bounds.width - actual.width),
        height: Math.max(180, requested.height + bounds.height - actual.height),
      };
    }
  }
  const saveWindow = () => {
    if (
      !floating ||
      floating.isDestroyed() ||
      floating.isFullScreen() ||
      floating.isMinimized()
    )
      return;
    const value = {
      ...floating.getBounds(),
      alwaysOnTop: floating.isAlwaysOnTop(),
    };
    windowSave = windowSave
      .then(() => fs.writeFile(windowPrefsPath(), JSON.stringify(value)))
      .catch(console.error);
  };
  const closeFloating = () => {
    gesture = undefined;
    clearTimeout(windowSaveTimer);
    saveWindow();
    closingFloating = true;
    floating?.destroy();
    floating = undefined;
    closingFloating = false;
  };
  const videoInput = (action: "close" | "restore") => {
    if (current && !current.closed)
      getWindow()?.webContents.send("video:input", {
        sessionId: current.state.sessionId,
        action,
      });
  };
  async function present(p: Playback, mode: "card" | "embedded" | "floating") {
    const main = getWindow();
    if (!main || p.closed || current !== p) return;
    if (mode === "floating" && !floating) {
      const saved = await fs
        .readFile(windowPrefsPath(), "utf8")
        .then((value) => JSON.parse(value))
        .catch(() => ({}));
      if (p.closed || current !== p) return;
      const display = screen.getDisplayMatching(main.getBounds()).workArea;
      const requestedWidth = Math.max(
        320,
        Number.isFinite(saved.width) ? saved.width : 480,
      );
      const requestedHeight = Math.max(
        180,
        Number.isFinite(saved.height) ? saved.height : 310,
      );
      const area = screen.getDisplayMatching({
        x: saved.x ?? display.x,
        y: saved.y ?? display.y,
        width: requestedWidth,
        height: requestedHeight,
      }).workArea;
      const width = Math.min(area.width, requestedWidth);
      const height = Math.min(area.height, requestedHeight);
      const x = Math.max(
        area.x,
        Math.min(
          area.x + area.width - width,
          saved.x ?? area.x + area.width - width - 24,
        ),
      );
      const y = Math.max(
        area.y,
        Math.min(
          area.y + area.height - height,
          saved.y ?? area.y + area.height - height - 24,
        ),
      );
      floating = new BrowserWindow({
        x,
        y,
        width,
        height,
        minWidth: 320,
        minHeight: 180,
        frame: false,
        thickFrame: false,
        resizable: true,
        title: `Kaleid 视频 · ${p.item?.title ?? "正在播放"}`,
        backgroundColor: "#000000",
        alwaysOnTop: saved.alwaysOnTop !== false,
        show: false,
        autoHideMenuBar: true,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      floating.setMenu(null);
      // Electron's frameless constructor can add the Windows resize border to
      // the initial bounds. Apply the saved outer rectangle explicitly so it
      // does not grow on every detach/restore cycle.
      setFloatingBounds({ x, y, width, height });
      floating.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      floating.webContents.on("will-navigate", (event) =>
        event.preventDefault(),
      );
      const onWindowChange = () => {
        overlay?.refresh();
        if (current?.state.presentation === "floating") {
          current.state.fullscreen = floating?.isFullScreen() ?? false;
          refreshSurface(current);
          send(current, true);
        }
        clearTimeout(windowSaveTimer);
        windowSaveTimer = setTimeout(saveWindow, 250);
      };
      floating.on("move", onWindowChange);
      floating.on("resize", onWindowChange);
      floating.on("restore", onWindowChange);
      floating.on("show", onWindowChange);
      floating.on("hide", onWindowChange);
      floating.on("minimize", onWindowChange);
      floating.on("enter-full-screen", onWindowChange);
      floating.on("leave-full-screen", onWindowChange);
      floating.on("close", (event) => {
        if (closingFloating) return;
        event.preventDefault();
        videoInput("close");
        if (current) void cleanup(current);
      });
    }
    if (p.closed || current !== p) return;
    const target = mode === "floating" ? floating! : main;
    if (p.state.presentation !== mode) {
      const previousMode = p.state.presentation;
      if (p.state.presentation && playbackWindow()?.isFullScreen())
        playbackWindow()?.setFullScreen(false);
      p.state.presentation = mode;
      p.state.fullscreen = target.isFullScreen();
      const handle = target.getNativeWindowHandle();
      const parent =
        handle.length >= 8
          ? handle.readBigUInt64LE().toString()
          : String(handle.readUInt32LE());
      if (p.host && (previousMode === "floating" || mode === "floating"))
        await new Promise<void>((resolve, reject) => {
          const moveId = randomUUID();
          const timer = setTimeout(() => {
            p.hostMoves?.delete(moveId);
            reject(new Error("视频窗口迁移超时"));
          }, 3000);
          (p.hostMoves ??= new Map()).set(moveId, { resolve, reject, timer });
          p.host!.stdin.write(JSON.stringify({ parent, moveId }) + "\n");
        });
    }
    if (p.closed || current !== p) return;
    overlay?.setHostWindow(target);
    await synchronizeSurface(p);
    if (mode === "floating") {
      p.state.alwaysOnTop = target.isAlwaysOnTop();
      target.showInactive();
    } else {
      if (main.isMinimized()) main.restore();
      main.show();
      closeFloating();
    }
    send(p, true);
  }
  async function grantVideo(p: Playback, ticket: number) {
    if (p.closed || current !== p || ticket !== audioSerial) return false;
    const acknowledged = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        audioAcks.delete(ticket);
        resolve(false);
      }, 2000);
      audioAcks.set(ticket, () => {
        clearTimeout(timer);
        audioAcks.delete(ticket);
        resolve(true);
      });
      getWindow()?.webContents.send("video:audio-focus", ticket);
    });
    return acknowledged && !p.closed && current === p && ticket === audioSerial;
  }
  async function pauseVideo(p: Playback, paused: boolean) {
    if (!paused) {
      const ticket = ++audioSerial;
      p.audioTicket = ticket;
      if (!(await grantVideo(p, ticket))) return;
      if (p.completed) {
        p.completed = false;
        p.state.status = "ready";
        await raw(p, ["seek", 0, "absolute+exact"]);
      }
    } else {
      ++audioSerial;
      p.audioTicket = undefined;
    }
    if (p.closed || current !== p) return;
    await raw(p, ["set_property", "pause", paused]);
    p.state.paused = paused;
    power(p);
    send(p, true);
  }
  let quitPending = false;
  const publishEdgeInput = (active: boolean) => {
    const p = current;
    if (!p || p.closed || current !== p) return;
    getWindow()?.webContents.send("video:input", {
      sessionId: p.state.sessionId,
      action: active ? "edge-enter" : "edge-leave",
    });
  };
  overlay?.onEdgeActivity(publishEdgeInput);
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
  async function synchronizeSurface(p: Playback, logical?: VideoBounds) {
    if (p.closed || current !== p) return;
    const window = playbackWindow();
    if (!window) return;
    const content = window.getContentBounds();
    const scale = screen.getDisplayMatching(content).scaleFactor;
    const input = logical ??
      p.logicalBounds ?? {
        x: 0,
        y: 0,
        width: content.width,
        height: content.height,
        visible: true,
      };
    if (logical) p.logicalBounds = logical;
    const whole = p.state.fullscreen || p.state.presentation === "floating";
    const x = whole ? 0 : Math.max(0, Math.min(content.width, input.x));
    const y = whole ? 0 : Math.max(0, Math.min(content.height, input.y));
    p.bounds = {
      x: Math.round(x * scale),
      y: Math.round(y * scale),
      width: Math.round(
        Math.max(
          0,
          Math.min(whole ? content.width : input.width, content.width - x),
        ) * scale,
      ),
      height: Math.round(
        Math.max(
          0,
          Math.min(whole ? content.height : input.height, content.height - y),
        ) * scale,
      ),
      visible:
        input.visible &&
        (p.state.status === "ready" || p.state.status === "ended") &&
        !p.dialogOpen,
    };
    if (!p.host) return;
    const rectId = randomUUID();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        p.hostMoves?.delete(rectId);
        reject(new Error("画面尺寸同步超时"));
      }, 3000);
      (p.hostMoves ??= new Map()).set(rectId, { resolve, reject, timer });
      p.host!.stdin.write(JSON.stringify({ ...p.bounds, rectId }) + "\n");
    });
    if (p.state.surface) {
      p.state.surface.sizedAt ??= Date.now();
      if (p.bounds.visible) p.state.surface.shownAt ??= Date.now();
    }
  }
  function refreshSurface(p: Playback) {
    overlay?.refresh();
    void synchronizeSurface(p).catch((error) => {
      if (!p.closed) console.warn(error);
    });
    getWindow()?.webContents.send("video:input", {
      sessionId: p.state.sessionId,
      action: "surface-update",
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
      for (const move of p.hostMoves?.values() ?? []) {
        clearTimeout(move.timer);
        move.reject(new Error("播放会话已结束"));
      }
      p.hostMoves?.clear();
      p.mpv?.kill();
      p.host?.stdin.end();
      p.host?.kill();
      if (current === p) current = undefined;
      if (!current) {
        const main = getWindow();
        if (main) overlay?.setHostWindow(main);
        closeFloating();
      }
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
      if (action === "toggle-pause") {
        void pauseVideo(p, !p.state.paused).catch(console.error);
        return;
      }
      if (action === "activity" && ["tab", "backtab"].includes(event.args[2])) {
        const contents = getWindow()?.webContents;
        const modifiers: "shift"[] =
          event.args[2] === "backtab" ? ["shift"] : [];
        if (!overlay?.focusControls(event.args[2] === "backtab")) {
          contents?.focus();
          contents?.sendInputEvent({
            type: "keyDown",
            keyCode: "Tab",
            modifiers,
          });
          contents?.sendInputEvent({
            type: "keyUp",
            keyCode: "Tab",
            modifiers,
          });
        }
      }
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
        while (output.includes("\n")) {
          const end = output.indexOf("\n");
          const line = output.slice(0, end);
          output = output.slice(end + 1);
          try {
            const value = JSON.parse(line);
            if (value.hwnd) {
              clearTimeout(timer);
              resolve(value.hwnd);
            }
            if (value.moved || value.resized) {
              const id = value.moved ?? value.resized;
              const move = p.hostMoves?.get(id);
              p.hostMoves?.delete(id);
              if (move) {
                clearTimeout(move.timer);
                value.ok
                  ? move.resolve()
                  : move.reject(new Error("视频窗口迁移失败"));
              }
            }
          } catch {
            clearTimeout(timer);
            reject(new Error("无效的宿主窗口"));
          }
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
      const hwnd = await spawnHost(
        p,
        (playbackWindow() ?? window).getNativeWindowHandle(),
      );
      if (p.state.surface) p.state.surface.hostReadyAt = Date.now();
      if (p.closed || current !== p) return;
      await synchronizeSurface(p);
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
          "SPACE script-message kaleid-input toggle-pause",
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
          "MBTN_LEFT script-message kaleid-input toggle-pause",
          "MBTN_LEFT_DBL script-message kaleid-input fullscreen",
          "MOUSE_MOVE script-message kaleid-input activity",
          "WHEEL_UP add volume 5",
          "WHEEL_DOWN add volume -5",
          "TAB script-message kaleid-input activity tab",
          "Shift+TAB script-message kaleid-input activity backtab",
        ]
          .map((binding) =>
            /^(SPACE|LEFT|RIGHT|Shift\+LEFT|Shift\+RIGHT|UP|DOWN|m|MBTN_LEFT|WHEEL_UP|WHEEL_DOWN) /.test(
              binding,
            )
              ? `${binding}; script-message kaleid-input activity`
              : binding,
          )
          .join("\n"),
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
      await synchronizeSurface(p);
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
      const shouldPlay =
        input.autoPlay &&
        p.audioTicket !== undefined &&
        (await grantVideo(p, p.audioTicket));
      if (p.closed || current !== p) return;
      p.state.paused = !shouldPlay;
      send(p, true);
      await raw(p, ["set_property", "pause", !shouldPlay]);
      if (p.state.surface) p.state.surface.playbackAt = Date.now();
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
          typeof input.autoPlay !== "boolean" ||
          (input.presentation !== undefined &&
            !["card", "embedded"].includes(input.presentation))
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
            presentation: input.presentation ?? "embedded",
            surface: { startedAt: Date.now() },
            resumed: false,
          },
          pending: new Map(),
          requestId: 0,
          closed: false,
          log: "",
          completed: false,
          saveJob: Promise.resolve(),
          ...(input.presentation === "card"
            ? {
                logicalBounds: {
                  x: 0,
                  y: 0,
                  width: 1,
                  height: 1,
                  visible: false,
                },
              }
            : {}),
        };
        current = p;
        if (input.autoPlay) p.audioTicket = ++audioSerial;
        // Replay the cursor edge state after a session swap in case the pointer
        // entered the edge before this playback session took ownership.
        overlay?.onEdgeActivity(publishEdgeInput);
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
      if (method === "audioFocusAck") {
        if (typeof args[0] === "number") audioAcks.get(args[0])?.();
        return;
      }
      if (method === "musicFocus") {
        const ticket = ++audioSerial;
        const p = current;
        if (p && !p.closed) {
          p.audioTicket = undefined;
          p.state.paused = true;
          if (p.socket && p.state.status === "ready")
            await raw(p, ["set_property", "pause", true]);
          power(p);
          send(p, true);
        }
        return ticket === audioSerial;
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
        overlay?.suspend(true);
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
          overlay?.suspend(false);
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
      if (method === "windowGesture") {
        const value = args[1];
        if (
          !value ||
          !["begin", "update", "end"].includes(value.type) ||
          ![value.x, value.y].every(
            (n) => Number.isFinite(n) && Math.abs(n) < 1000000,
          ) ||
          (value.edge &&
            !["n", "s", "w", "e", "nw", "ne", "sw", "se"].includes(value.edge))
        )
          throw new Error("无效窗口操作");
        if (
          !floating ||
          p.state.presentation !== "floating" ||
          floating.isFullScreen()
        ) {
          gesture = undefined;
          return { moved: false };
        }
        if (value.type === "begin") {
          gesture = {
            sessionId: p.state.sessionId,
            x: value.x,
            y: value.y,
            bounds: floating.getBounds(),
            edge: value.edge ?? "",
            moved: false,
          };
          return { moved: false };
        }
        if (!gesture || gesture.sessionId !== p.state.sessionId)
          return { moved: false };
        const dx = Math.round(value.x - gesture.x),
          dy = Math.round(value.y - gesture.y);
        if (Math.abs(dx) + Math.abs(dy) > 4) gesture.moved = true;
        if (gesture.moved) {
          const b = gesture.bounds,
            edge = gesture.edge;
          const next = { ...b };
          if (!edge) {
            next.x += dx;
            next.y += dy;
          }
          if (edge.includes("e")) next.width = Math.max(320, b.width + dx);
          if (edge.includes("s")) next.height = Math.max(180, b.height + dy);
          if (edge.includes("w")) {
            next.width = Math.max(320, b.width - dx);
            next.x = b.x + b.width - next.width;
          }
          if (edge.includes("n")) {
            next.height = Math.max(180, b.height - dy);
            next.y = b.y + b.height - next.height;
          }
          setFloatingBounds(next);
        }
        const moved = gesture.moved;
        if (value.type === "end") {
          gesture = undefined;
          saveWindow();
        }
        return { moved };
      }
      if (method === "present") {
        if (!["card", "embedded", "floating"].includes(args[1]))
          throw new Error("无效显示方式");
        const mode = args[1];
        if (args[2] !== undefined && !["manual", "automatic"].includes(args[2]))
          throw new Error("无效画中画来源");
        p.state.presentationReason =
          mode === "floating" ? (args[2] ?? "manual") : undefined;
        presenting = presenting.catch(() => {}).then(() => present(p, mode));
        await presenting;
        return;
      }
      if (method === "pin") {
        if (typeof args[1] !== "boolean") throw new Error("无效置顶状态");
        floating?.setAlwaysOnTop(args[1]);
        p.state.alwaysOnTop = args[1];
        if (floating) overlay?.setHostWindow(floating);
        saveWindow();
        send(p, true);
        return;
      }
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
        await synchronizeSurface(p, bounds);
        return;
      }
      if (method === "subtitle") {
        p.dialogOpen = true;
        overlay?.suspend(true);
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
          overlay?.suspend(false);
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
          await pauseVideo(p, !range);
          break;
        }
        case "pause":
          if (typeof command.value !== "boolean")
            throw new Error("无效暂停状态");
          await pauseVideo(p, command.value);
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
          (playbackWindow() ?? window).setFullScreen(command.value);
          p.state.fullscreen = command.value;
          refreshSurface(p);
          break;
        default:
          throw new Error("不支持的播放操作");
      }
      send(p, true);
    },
  );
  function bindWindow(window: BrowserWindow) {
    window.on("enter-full-screen", () => {
      if (current && current.state.presentation !== "floating") {
        current.state.fullscreen = true;
        refreshSurface(current);
        send(current, true);
      }
    });
    window.on("leave-full-screen", () => {
      if (current && current.state.presentation !== "floating") {
        current.state.fullscreen = false;
        refreshSurface(current);
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
      await windowSave;
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
