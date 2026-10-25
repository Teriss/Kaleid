// Electron regression for the compact, resizable music companion windows.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron } from "@playwright/test";

const temporary = await fs.mkdtemp(
  path.join(os.tmpdir(), "kaleid-music-windows-"),
);
const env = { ...process.env, MEDIA_BROWSER_TEST_DATA: temporary };
delete env.ELECTRON_RUN_AS_NODE;
let application;
try {
  application = await _electron.launch({ args: ["out/main/index.js"], env });
  const main = await application.firstWindow();
  await main.waitForFunction(() => Boolean(window.music?.window));

  const open = async (kind) => {
    await main.evaluate((windowKind) => window.music.window(windowKind), kind);
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const page = application
        .windows()
        .find((candidate) => candidate.url().includes(`#music-${kind}`));
      if (page) return page;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`音乐窗口未打开：${kind}`);
  };
  const bounds = (kind) =>
    application.evaluate(({ BrowserWindow }, windowKind) => {
      const win = BrowserWindow.getAllWindows().find((candidate) =>
        candidate.webContents.getURL().includes(`#music-${windowKind}`),
      );
      if (!win) throw new Error(`missing ${windowKind} BrowserWindow`);
      return { resizable: win.isResizable(), bounds: win.getBounds() };
    }, kind);

  let mini = await open("mini");
  await mini.locator(".companion-mini-row").waitFor();
  await mini.getByRole("button", { name: "上一首" }).waitFor();
  await mini.getByRole("button", { name: "下一首" }).waitFor();
  await mini.getByLabel("迷你播放器进度").waitFor();
  const before = await bounds("mini");
  assert.equal(before.resizable, true);
  await application.evaluate(({ BrowserWindow }, kind) => {
    const win = BrowserWindow.getAllWindows().find((candidate) =>
      candidate.webContents.getURL().includes(`#music-${kind}`),
    );
    if (!win) throw new Error("mini window missing");
    const current = win.getBounds();
    win.setBounds({
      ...current,
      width: current.width + 32,
      height: current.height + 8,
    });
  }, "mini");
  await mini.waitForTimeout(350);
  const resized = (await bounds("mini")).bounds;
  const miniClosed = mini.waitForEvent("close");
  await mini.evaluate(() => window.music.command("close"));
  await miniClosed;
  mini = await open("mini");
  const restored = await bounds("mini");
  assert.equal(restored.resizable, true);
  assert.ok(
    Math.abs(restored.bounds.width - resized.width) <= 4,
    `mini width restored near ${resized.width}, got ${restored.bounds.width}`,
  );
  assert.ok(
    Math.abs(restored.bounds.height - resized.height) <= 4,
    `mini height restored near ${resized.height}, got ${restored.bounds.height}`,
  );

  const lyrics = await open("lyrics");
  await lyrics.locator(".desktop-lyrics").waitFor();
  const backgrounds = await lyrics.evaluate(() =>
    ["html", "body", "#root", ".desktop-lyrics"].map((selector) => {
      const node = document.querySelector(selector);
      return node ? getComputedStyle(node).backgroundColor : null;
    }),
  );
  assert.deepEqual(backgrounds, Array(4).fill("rgba(0, 0, 0, 0)"));
  assert.equal((await bounds("lyrics")).resizable, true);

  console.log(
    JSON.stringify({
      result: "passed",
      scenarios: [
        "compact mini-player controls and progress bar",
        "native resizing and saved mini-player bounds",
        "transparent desktop lyrics background and native resizing",
      ],
    }),
  );
} finally {
  await application?.close().catch(() => {});
  await fs.rm(temporary, { recursive: true, force: true });
}
