import { BrowserWindow, ipcMain, screen } from "electron";
import type { VideoOverlayState } from "../shared/video";

/** A layered window can blend over mpv's child HWND; DOM z-index cannot. */
export function installVideoOverlay(getWindow: () => BrowserWindow | null) {
  const getMainWindow = getWindow;
  let hostWindow: BrowserWindow | undefined;
  getWindow = () =>
    hostWindow && !hostWindow.isDestroyed() ? hostWindow : getMainWindow();
  let overlay: BrowserWindow | undefined;
  let state: VideoOverlayState = { visible: false, regions: [] };
  let suspended = false;
  let ignoring = true;
  let edgeActive = false;
  let onEdgeActivity: ((active: boolean) => void) | undefined;
  let pointerTimer: ReturnType<typeof setInterval> | undefined;
  const publishEdgeActivity = (active: boolean) => {
    if (active === edgeActive) return;
    edgeActive = active;
    onEdgeActivity?.(active);
  };
  const sync = () => {
    const parent = getWindow();
    if (!parent || !overlay || overlay.isDestroyed()) return;
    const bounds = parent.getContentBounds();
    const previous = overlay.getBounds();
    if (
      bounds.x !== previous.x ||
      bounds.y !== previous.y ||
      bounds.width !== previous.width ||
      bounds.height !== previous.height
    )
      overlay.setBounds(bounds);
    if (
      state.visible &&
      !suspended &&
      parent.isVisible() &&
      !parent.isMinimized()
    ) {
      if (!overlay.isVisible()) overlay.showInactive();
    } else if (overlay.isVisible()) overlay.hide();
  };
  const pointer = () => {
    if (!overlay || overlay.isDestroyed()) return;
    const parent = getWindow();
    if (!parent || parent.isDestroyed()) return;
    const bounds = overlay.getBounds();
    const cursor = screen.getCursorScreenPoint();
    const x = cursor.x - bounds.x;
    const y = cursor.y - bounds.y;
    const windowBounds = parent.getBounds();
    const edgeSize = 24;
    const inWindow =
      cursor.x >= windowBounds.x &&
      cursor.x < windowBounds.x + windowBounds.width &&
      cursor.y >= windowBounds.y &&
      cursor.y < windowBounds.y + windowBounds.height;
    const nearEdge =
      cursor.y < windowBounds.y + edgeSize ||
      cursor.y >= windowBounds.y + windowBounds.height - edgeSize;
    publishEdgeActivity(
      state.visible &&
        !suspended &&
        parent.isVisible() &&
        !parent.isMinimized() &&
        inWindow &&
        nearEdge,
    );
    const ignore =
      !state.visible ||
      suspended ||
      !state.regions.some(
        (region) =>
          x >= region.x &&
          y >= region.y &&
          x < region.x + region.width &&
          y < region.y + region.height,
      );
    if (ignore !== ignoring) {
      ignoring = ignore;
      overlay.setIgnoreMouseEvents(ignore, { forward: true });
    }
  };
  ipcMain.handle("video:overlay", (event, value: VideoOverlayState) => {
    const parent = getMainWindow();
    if (
      !parent ||
      event.sender !== parent.webContents ||
      event.senderFrame !== parent.webContents.mainFrame
    )
      throw new Error("无权访问视频控制层");
    if (
      !value ||
      typeof value.visible !== "boolean" ||
      !Array.isArray(value.regions) ||
      value.regions.length > 8 ||
      !value.regions.every(
        (region) =>
          region &&
          [region.x, region.y, region.width, region.height].every(
            (n) =>
              typeof n === "number" &&
              Number.isFinite(n) &&
              Math.abs(n) < 50000,
          ) &&
          region.width >= 0 &&
          region.height >= 0,
      )
    )
      throw new Error("无效控制层区域");
    state = value;
    sync();
    pointer();
  });
  function bindWindow(parent: BrowserWindow) {
    parent.webContents.setWindowOpenHandler(({ url, frameName }) => {
      if (
        url !== "about:blank" ||
        frameName !== "kaleid-video-controls" ||
        (overlay && !overlay.isDestroyed())
      )
        return { action: "deny" };
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          ...parent.getContentBounds(),
          parent,
          frame: false,
          transparent: true,
          backgroundColor: "#00000000",
          hasShadow: false,
          resizable: false,
          minimizable: false,
          maximizable: false,
          fullscreenable: false,
          skipTaskbar: true,
          show: false,
          autoHideMenuBar: true,
        },
      };
    });
    parent.webContents.on("did-create-window", (child, details) => {
      if (details.frameName !== "kaleid-video-controls") return;
      overlay = child;
      state = { visible: false, regions: [] };
      suspended = false;
      ignoring = true;
      child.setIgnoreMouseEvents(true, { forward: true });
      child.setMenu(null);
      child.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      child.webContents.on("will-navigate", (event) => event.preventDefault());
      pointerTimer = setInterval(pointer, 16);
      child.on("closed", () => {
        clearInterval(pointerTimer);
        pointerTimer = undefined;
        if (overlay === child) overlay = undefined;
      });
      sync();
    });
    parent.on("move", sync);
    parent.on("resize", sync);
    parent.on("restore", sync);
    parent.on("show", sync);
    parent.on("hide", sync);
    parent.on("minimize", sync);
    parent.on("enter-full-screen", sync);
    parent.on("leave-full-screen", sync);
  }
  return {
    setHostWindow(window: BrowserWindow) {
      hostWindow = window;
      overlay?.setParentWindow(window);
      overlay?.setAlwaysOnTop(window.isAlwaysOnTop());
      sync();
      pointer();
    },
    refresh() {
      sync();
      pointer();
    },
    bindWindow,
    onEdgeActivity(callback: (active: boolean) => void) {
      onEdgeActivity = callback;
      callback(edgeActive);
    },
    suspend(value: boolean) {
      suspended = value;
      sync();
      pointer();
    },
    focusControls(reverse: boolean) {
      if (!overlay || overlay.isDestroyed() || !state.visible || suspended)
        return false;
      sync();
      overlay.focus();
      overlay.webContents.focus();
      const modifiers: "shift"[] = reverse ? ["shift"] : [];
      overlay.webContents.sendInputEvent({
        type: "keyDown",
        keyCode: "Tab",
        modifiers,
      });
      overlay.webContents.sendInputEvent({
        type: "keyUp",
        keyCode: "Tab",
        modifiers,
      });
      return true;
    },
  };
}
