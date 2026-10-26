import { app, BrowserWindow, ipcMain, nativeImage, screen } from "electron";
import path from "node:path";
import type { MusicWindowState } from "../shared/music";

interface MiniWindowHost {
  getMain(): BrowserWindow | null;
  projectRoot: string;
  read(key: string): any;
  write(key: string, value: unknown): void;
  snapshot(): MusicWindowState;
  theme(): "dark" | "light";
}

/** One lightweight remote for the main window's player. Closing always destroys it. */
export function installMusicMiniWindow(host: MiniWindowHost) {
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, "kaleid-icon.png")
    : path.join(host.projectRoot, "build/kaleid-icon.png");
  const sourceIcon = nativeImage.createFromPath(iconPath);
  // Decode the large application artwork during service setup, not each cold open.
  const icon = sourceIcon.isEmpty()
    ? iconPath
    : sourceIcon.resize({ width: 64, height: 64 });
  let window: BrowserWindow | null = null;
  let opening: Promise<void> | undefined;
  let ready: (() => void) | undefined;
  let interacting = false;
  const isSender = (contents: Electron.WebContents) =>
    !!window && !window.isDestroyed() && window.webContents === contents;
  const trusted = (
    event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent,
  ) => {
    if (event.senderFrame !== event.sender.mainFrame || !isSender(event.sender))
      throw new Error("遥控窗口访问被拒绝");
  };
  ipcMain.handle("music:window-snapshot", (event) => {
    trusted(event);
    return host.snapshot();
  });
  ipcMain.handle("music:window-bootstrap", (event) => {
    trusted(event);
    return {
      state: host.snapshot(),
      pinned: host.read("mini:alwaysOnTop") !== false,
      theme: host.theme(),
    };
  });
  ipcMain.handle("music:window-pin", (event, value?: boolean) => {
    trusted(event);
    if (value !== undefined) {
      if (typeof value !== "boolean") throw new Error("无效的置顶状态");
      window!.setAlwaysOnTop(value);
      host.write("mini:alwaysOnTop", value);
    }
    // Before the transparent native window is shown Windows can report false
    // even though the requested topmost flag is already configured.
    return host.read("mini:alwaysOnTop") !== false;
  });
  ipcMain.on("music:window-ready", (event) => {
    trusted(event);
    ready?.();
  });
  ipcMain.on("music:window-interaction", (event, active: boolean) => {
    trusted(event);
    interacting = active === true;
  });

  function close() {
    window?.close();
  }
  function destroy() {
    window?.destroy();
  }
  async function open() {
    if (window && !window.isDestroyed()) {
      await opening;
      if (window && !window.isDestroyed()) {
        if (window.isMinimized()) window.restore();
        window.webContents.send("music:state", host.snapshot());
        window.show();
        window.setAlwaysOnTop(host.read("mini:alwaysOnTop") !== false);
        window.focus();
      }
      return;
    }
    const saved = host.read("window:mini");
    let bounds: { x?: number; y?: number; width: number; height: number } = {
      width: 602,
      height: 184,
    };
    if (
      saved &&
      [saved.x, saved.y, saved.width, saved.height].every(Number.isFinite)
    ) {
      // Upgrade the former 72px single-row window once; keep the user's placement.
      const legacy = saved.height < 160;
      const area = screen.getDisplayMatching(saved).workArea;
      const width = Math.min(
        area.width,
        Math.max(480, legacy ? 602 : saved.width),
      );
      const height = Math.min(
        area.height,
        Math.max(160, legacy ? 184 : saved.height),
      );
      bounds = {
        width,
        height,
        x: Math.max(area.x, Math.min(saved.x, area.x + area.width - width)),
        y: Math.max(area.y, Math.min(saved.y, area.y + area.height - height)),
      };
    }
    const win = new BrowserWindow({
      ...bounds,
      minWidth: 480,
      minHeight: 160,
      show: true,
      title: "Kaleid 遥控播放器",
      frame: false,
      transparent: true,
      hasShadow: false,
      backgroundColor: "#00000000",
      resizable: true,
      maximizable: false,
      alwaysOnTop: host.read("mini:alwaysOnTop") !== false,
      icon,
      webPreferences: {
        preload: path.join(host.projectRoot, "out/preload/musicMini.cjs"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    window = win;
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    let pointerTimer: ReturnType<typeof setInterval> | undefined;
    let pointerInside: boolean | undefined;
    let ignored = false;
    const persist = () => {
      if (!win.isDestroyed()) host.write("window:mini", win.getBounds());
    };
    const scheduleSave = () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(persist, 250);
    };
    const pollPointer = () => {
      if (win.isDestroyed()) return;
      const bounds = win.getBounds();
      const point = screen.getCursorScreenPoint();
      const x = point.x - bounds.x,
        y = point.y - bounds.y;
      const inside =
        win.isVisible() &&
        !win.isMinimized() &&
        x >= 0 &&
        y >= 0 &&
        x < bounds.width &&
        y < bounds.height;
      if (inside !== pointerInside) {
        pointerInside = inside;
        win.webContents.send("music:window-pointer", inside);
      }
      const scale = Math.min(bounds.width / 602, bounds.height / 184);
      const left = (bounds.width - 602 * scale) / 2;
      const top = (bounds.height - 184 * scale) / 2;
      // Folia leaves the sleeve's area transparent while in use. The 8px native
      // resize border remains interactive, even over this otherwise empty strip.
      const edge =
        x < 8 || y < 8 || x >= bounds.width - 8 || y >= bounds.height - 8;
      const empty =
        x < left + 178 * scale ||
        x > left + 598 * scale ||
        y < top + 4 * scale ||
        y > top + 180 * scale;
      const ignore = inside && !edge && !interacting && empty;
      if (ignore !== ignored) {
        ignored = ignore;
        win.setIgnoreMouseEvents(ignore, { forward: true });
      }
    };
    win.on("resize", scheduleSave);
    win.on("move", scheduleSave);
    win.on("close", persist);
    win.on("restore", () => {
      win.webContents.send("music:state", host.snapshot());
      pollPointer();
    });
    win.on("blur", () => {
      interacting = false;
    });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    let rejectReady!: (error: Error) => void;
    const rendered = new Promise<void>((resolve, reject) => {
      ready = resolve;
      rejectReady = reject;
    });
    const timeout = setTimeout(
      () => rejectReady(new Error("遥控窗口加载超时")),
      10000,
    );
    win.webContents.once("render-process-gone", () => {
      rejectReady(new Error("遥控窗口进程已退出"));
      if (!win.isDestroyed()) win.destroy();
    });
    win.on("closed", () => {
      clearTimeout(timeout);
      clearTimeout(saveTimer);
      clearInterval(pointerTimer);
      rejectReady(new Error("遥控窗口已关闭"));
      if (window === win) {
        window = null;
        ready = undefined;
        interacting = false;
      }
    });
    const base = process.env.ELECTRON_RENDERER_URL || "app://local/";
    const url = new URL("music-mini.html", base);
    url.hash = "music-mini";
    // Match Folia's immediate native presentation. Only the open() promise waits
    // for the first card commit; state hydration and page load don't gate visibility.
    void win.loadURL(url.href).catch((error) => {
      rejectReady(error);
      if (!win.isDestroyed()) win.destroy();
    });
    const pending = rendered
      .then(() => {
        if (win.isDestroyed() || !host.getMain())
          throw new Error("主窗口已关闭");
        win.webContents.send("music:state", host.snapshot());
        win.show();
        win.setAlwaysOnTop(host.read("mini:alwaysOnTop") !== false);
        win.focus();
        pollPointer();
        pointerTimer = setInterval(pollPointer, 80);
      })
      .catch((error) => {
        if (!win.isDestroyed()) win.destroy();
        throw error;
      })
      .finally(() => {
        clearTimeout(timeout);
        if (opening === pending) opening = undefined;
        if (window === win) ready = undefined;
      });
    opening = pending;
    await pending;
  }
  return {
    open,
    close,
    destroy,
    isSender,
    publish(patch: Partial<MusicWindowState>) {
      if (window && !window.isDestroyed())
        window.webContents.send("music:state", patch);
    },
  };
}
