import {
  BrowserWindow,
  ipcMain,
  screen,
  type IpcMainInvokeEvent,
} from "electron";
import type {
  MainWindowCommand,
  MainWindowDrag,
  MainWindowState,
} from "../shared/windowControls";

export function installWindowControls(getWindow: () => BrowserWindow | null) {
  const checked = (event: IpcMainInvokeEvent) => {
    const win = getWindow();
    if (
      !win ||
      win.isDestroyed() ||
      event.sender !== win.webContents ||
      event.senderFrame !== win.webContents.mainFrame
    )
      throw new Error("无权操作主窗口");
    return win;
  };
  const state = (win: BrowserWindow): MainWindowState => ({
    maximized: win.isMaximized(),
    fullscreen: win.isFullScreen(),
  });
  const pointerState = (win: BrowserWindow) => {
    const bounds = win.getBounds(),
      point = screen.getCursorScreenPoint();
    const inside =
      win.isVisible() &&
      !win.isMinimized() &&
      point.x >= bounds.x &&
      point.x < bounds.x + bounds.width &&
      point.y >= bounds.y &&
      point.y < bounds.y + 36;
    return { inside, reveal: inside && point.y < bounds.y + 8 };
  };
  ipcMain.handle("app:window-state", (event) => state(checked(event)));
  ipcMain.handle("app:window-chrome-pointer", (event) =>
    pointerState(checked(event)),
  );
  ipcMain.handle("app:window-command", (event, command: MainWindowCommand) => {
    const win = checked(event);
    switch (command) {
      case "minimize":
        win.minimize();
        break;
      case "toggle-maximize":
        if (win.isFullScreen()) win.setFullScreen(false);
        else if (win.isMaximized()) win.unmaximize();
        else win.maximize();
        break;
      case "close":
        win.close();
        break;
      default:
        throw new Error("无效窗口操作");
    }
  });
  let drag: { x: number; y: number; bounds: Electron.Rectangle } | undefined;
  ipcMain.handle("app:window-drag", (event, value: MainWindowDrag) => {
    const win = checked(event);
    if (
      !value ||
      !["begin", "update", "end"].includes(value.phase) ||
      ![value.x, value.y].every(
        (n) =>
          typeof n === "number" && Number.isFinite(n) && Math.abs(n) < 1000000,
      )
    )
      throw new Error("无效窗口拖动");
    if (win.isFullScreen()) {
      drag = undefined;
      return;
    }
    if (value.phase === "end") {
      drag = undefined;
      return;
    }
    if (value.phase === "begin") {
      drag = { x: value.x, y: value.y, bounds: win.getBounds() };
      return;
    }
    if (!drag) return;
    const dx = Math.round(value.x - drag.x),
      dy = Math.round(value.y - drag.y);
    if (Math.abs(dx) + Math.abs(dy) > 4) {
      if (win.isMaximized()) {
        const fraction = Math.max(
          0,
          Math.min(1, (drag.x - drag.bounds.x) / drag.bounds.width),
        );
        win.unmaximize();
        const normal = win.getBounds();
        drag.bounds = {
          ...normal,
          x: Math.round(drag.x - fraction * normal.width),
          y: drag.y - 18,
        };
      }
      win.setPosition(drag.bounds.x + dx, drag.bounds.y + dy);
    }
  });
  return (win: BrowserWindow) => {
    // Native resize/drag regions do not deliver DOM pointer events on Windows.
    let previous = "";
    const pointer = setInterval(() => {
      if (win.isDestroyed() || win.webContents.isDestroyed()) return;
      const value = pointerState(win);
      const key = JSON.stringify(value);
      if (key !== previous) {
        previous = key;
        win.webContents.send("app:window-chrome-pointer", value);
      }
    }, 50);
    const publish = () => {
      if (!win.isDestroyed())
        win.webContents.send("app:window-state", state(win));
    };
    win.on("maximize", publish);
    win.on("unmaximize", publish);
    win.on("enter-full-screen", publish);
    win.on("leave-full-screen", publish);
    win.on("move", publish);
    win.on("blur", () => {
      drag = undefined;
    });
    win.on("closed", () => {
      drag = undefined;
      clearInterval(pointer);
    });
  };
}
