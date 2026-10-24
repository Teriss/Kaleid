import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import ffmpeg from "ffmpeg-static";
import { _electron } from "playwright";
const directory = await fs.mkdtemp(
  path.join(os.tmpdir(), "kaleid-window-chrome-"),
);
const env = {
  ...process.env,
  MEDIA_BROWSER_TEST_DATA: path.join(directory, "data"),
};
delete env.ELECTRON_RUN_AS_NODE;
const app = await _electron.launch({
  args: [path.resolve("out/main/index.js")],
  env,
});
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.locator(".window-titlebar").waitFor({ state: "attached" });
  await page.mouse.move(400, 400);
  assert.equal(
    await page.locator(".window-titlebar").getAttribute("inert"),
    "",
  );
  await page.mouse.move(400, 4);
  await page.locator(".window-titlebar.is-visible").waitFor();
  const close = page.getByRole("button", { name: "关闭应用窗口", exact: true });
  await close.hover();
  await page.waitForTimeout(180);
  assert.equal(
    await close.evaluate((el) => getComputedStyle(el).backgroundColor),
    "rgb(196, 43, 28)",
  );
  await page.screenshot({ path: "artifacts/window-chrome-hover.png" });
  await page.mouse.move(400, 400);
  await page
    .locator(".window-titlebar.is-visible")
    .waitFor({ state: "hidden" });
  await page.keyboard.press("Tab");
  await page.locator(".window-titlebar.is-visible").waitFor();
  await page
    .getByRole("button", { name: "最大化应用窗口", exact: true })
    .click();
  await page
    .getByRole("button", { name: "还原应用窗口", exact: true })
    .waitFor();
  assert.equal(
    await page.evaluate(
      async () => (await window.media.windowState()).maximized,
    ),
    true,
  );
  await page.getByRole("button", { name: "还原应用窗口", exact: true }).click();
  await page
    .getByRole("button", { name: "最大化应用窗口", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "最小化应用窗口", exact: true })
    .click();
  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].isMinimized(),
    ),
    true,
  );
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.restore();
    win.focus();
  });
  const rejects = await page.evaluate(async () => {
    try {
      await window.media.windowCommand("invalid-command");
      return false;
    } catch {
      return true;
    }
  });
  assert.equal(rejects, true);
  await page.evaluate(async () =>
    window.media.saveSettings({
      ...(await window.media.settings()),
      theme: "light",
      readerTheme: "warm",
    }),
  );
  await page.reload();
  await page.mouse.move(400, 4);
  await page.locator(".window-titlebar.is-visible").waitFor();
  const light = await page.locator(".window-titlebar").evaluate((el) => ({
    bg: getComputedStyle(el).backgroundColor,
    fg: getComputedStyle(el).color,
  }));
  assert.notEqual(light.bg, "rgb(20, 20, 20)");
  await page.screenshot({ path: "artifacts/window-chrome-light.png" });
  const root = path.join(directory, "books");
  await fs.mkdir(root);
  await fs.writeFile(
    path.join(root, "标题栏测试.txt"),
    "第一章\n" + "这是一段标题栏配色与隐藏验证文本。\n".repeat(100),
  );
  await app.evaluate(({ dialog }, root) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [root],
    });
  }, root);
  const id = await page.evaluate(async () => {
    const library = await window.media.createLibrary({
      name: "标题栏验证",
      type: "novel",
      roots: await window.media.chooseFolders(),
    });
    await window.media.scan(library.id);
    return library.id;
  });
  await page.waitForFunction(
    async (id) =>
      (await window.media.libraries()).find((l) => l.id === id)?.count === 1,
    id,
  );
  await page.evaluate(
    (id) =>
      localStorage.setItem(
        "last-browse",
        JSON.stringify({ view: "library", libraryId: id, type: "novel" }),
      ),
    id,
  );
  await page.reload();
  const book = page
    .getByRole("button", { name: /^(打开|聚焦) 标题栏测试$/ })
    .first();
  await book.waitFor();
  await book.click();
  if (!(await page.locator(".reader").count()))
    await page.keyboard.press("Enter");
  await page.locator(".reader").waitFor();
  await page.mouse.move(400, 4);
  await page.waitForFunction(
    () =>
      getComputedStyle(document.querySelector(".window-titlebar"))
        .backgroundColor === "rgb(233, 221, 200)",
  );
  await page.screenshot({ path: "artifacts/window-chrome-reader.png" });
  await page.mouse.move(400, 400);
  await page
    .locator(".window-titlebar.is-visible")
    .waitFor({ state: "hidden" });
  await page.locator(".reader-exit-button").click();
  const videos = path.join(directory, "videos");
  await fs.mkdir(videos);
  execFileSync(
    ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=320x180:d=20",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      path.join(videos, "标题栏视频.mp4"),
    ],
    { windowsHide: true },
  );
  await app.evaluate(({ dialog }, root) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [root],
    });
  }, videos);
  const videoLibrary = await page.evaluate(async () => {
    const library = await window.media.createLibrary({
      name: "视频标题栏验证",
      type: "video",
      roots: await window.media.chooseFolders(),
    });
    await window.media.scan(library.id);
    return library.id;
  });
  await page.waitForFunction(
    async (id) =>
      (await window.media.libraries()).find((l) => l.id === id)?.count === 1,
    videoLibrary,
  );
  await page.evaluate((id) => {
    localStorage.setItem("layout:type:video", "grid");
    localStorage.setItem(
      "last-browse",
      JSON.stringify({ view: "library", libraryId: id, type: "video" }),
    );
  }, videoLibrary);
  await page.reload();
  const popupPromise = app.context().waitForEvent("page");
  await page
    .getByRole("button", { name: "打开 标题栏视频", exact: true })
    .dblclick();
  const popup = await popupPromise;
  popup.on("pageerror", (error) => errors.push(error.message));
  await popup.locator(".window-titlebar").waitFor({ state: "attached" });
  await popup
    .locator('.video-player[data-status="ready"]')
    .waitFor({ timeout: 30000 });
  await popup.mouse.move(400, 4);
  await popup.locator(".window-titlebar.is-visible").waitFor();
  await popup
    .getByRole("button", { name: "最大化应用窗口", exact: true })
    .click();
  await popup
    .getByRole("button", { name: "还原应用窗口", exact: true })
    .waitFor();
  assert.equal(
    await page.evaluate(
      async () => (await window.media.windowState()).maximized,
    ),
    true,
  );
  await popup
    .getByRole("button", { name: "还原应用窗口", exact: true })
    .click();
  const before = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getBounds(),
  );
  await popup.mouse.move(300, 18);
  await popup.mouse.down();
  await popup.mouse.move(350, 68, { steps: 5 });
  await popup.mouse.up();
  const after = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getBounds(),
  );
  assert.ok(
    after.x !== before.x || after.y !== before.y,
    "video titlebar moves the main window",
  );
  await popup.screenshot({ path: "artifacts/window-chrome-video-overlay.png" });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: [
        "default hidden, top-edge reveal and auto-hide",
        "hover/focus, maximize/restore, minimize and invalid commands",
        "light theme and active reader palette",
        "native video overlay titlebar, maximize/restore and main window drag",
      ],
    }),
  );
} finally {
  await app.close();
}
