// Production Electron regression for the Folia remote and its single real player.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron } from "@playwright/test";

const tempRoot = path.resolve(os.tmpdir());
const temporary = await fs.mkdtemp(
  path.join(tempRoot, "kaleid-music-windows-"),
);
const fixtures = path.join(temporary, "音乐");
const screenshots = path.resolve("artifacts/music-mini");
await fs.mkdir(fixtures);
await fs.mkdir(screenshots, { recursive: true });
// Two minutes of silent PCM: playback/seek can be checked without making sound.
const pcm = Buffer.alloc(44 + 8000 * 2 * 120);
pcm.write("RIFF");
pcm.writeUInt32LE(pcm.length - 8, 4);
pcm.write("WAVEfmt ", 8);
pcm.writeUInt32LE(16, 16);
pcm.writeUInt16LE(1, 20);
pcm.writeUInt16LE(1, 22);
pcm.writeUInt32LE(8000, 24);
pcm.writeUInt32LE(16000, 28);
pcm.writeUInt16LE(2, 32);
pcm.writeUInt16LE(16, 34);
pcm.write("data", 36);
pcm.writeUInt32LE(pcm.length - 44, 40);
for (const name of ["遥控验收一", "遥控验收二"]) {
  await fs.writeFile(path.join(fixtures, name + ".wav"), pcm);
  await fs.writeFile(
    path.join(fixtures, name + ".lrc"),
    "[00:00.00]第一行歌词\n[00:05.00]第二行歌词\n[00:30.00]第三行歌词\n[01:30.00]最后一行",
  );
}
const env = {
  ...process.env,
  MEDIA_BROWSER_TEST_DATA: path.join(temporary, "data"),
};
delete env.ELECTRON_RUN_AS_NODE;
let application;
const errors = [];
const until = async (predicate, message, timeout = 10000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(message);
};
try {
  application = await _electron.launch({ args: ["out/main/index.js"], env });
  const main = await application.firstWindow();
  main.on("pageerror", (error) => errors.push(error.message));
  await main.waitForFunction(() => Boolean(window.music?.window));
  const native = () =>
    application.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find(
        (item) =>
          !item.isDestroyed() &&
          !item.webContents.isDestroyed() &&
          item.webContents.getURL().endsWith("#music-mini"),
      );
      return win
        ? {
            id: win.id,
            visible: win.isVisible(),
            pinned: win.isAlwaysOnTop(),
            resizable: win.isResizable(),
            bounds: win.getBounds(),
          }
        : null;
    });
  const open = async () => {
    const start = performance.now();
    await main.evaluate(() => window.music.window("mini"));
    const ms = performance.now() - start;
    const page = application
      .windows()
      .find((item) => item.url().endsWith("#music-mini"));
    assert.ok(page, "remote exists after open resolves");
    page.on("pageerror", (error) => errors.push(error.message));
    assert.ok(
      (await native()).visible,
      "open resolves after the first card is visible",
    );
    assert.ok(
      await page.evaluate(
        () => performance.getEntriesByName("mini-ready").length > 0,
      ),
    );
    return { page, ms: Math.round(ms) };
  };
  const close = async (page) => {
    const closing = page.waitForEvent("close");
    await page.evaluate(() => window.music.command("close"));
    await closing;
    assert.equal(await native(), null, "closing destroys the native window");
  };
  const active = async (page) => {
    await page.dispatchEvent(".mini-viewport", "pointerover", {
      pointerType: "mouse",
    });
    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find(
          (win) =>
            !win.isDestroyed() &&
            win.webContents.getURL().endsWith("#music-mini"),
        )
        ?.webContents.send("music:window-pointer", true);
    });
    await page.waitForFunction(
      () =>
        document.querySelector(".remote-window")?.getAttribute("data-lit") ===
        "true",
    );
  };
  const snapshot = (page) => page.evaluate(() => window.music.windowSnapshot());
  let { page: mini, ms: firstOpenMs } = await open();
  await active(mini);
  assert.equal(
    await mini.getByRole("button", { name: "播放暂停" }).isDisabled(),
    true,
  );
  await assert.rejects(
    () => main.evaluate(() => window.music.windowSnapshot()),
    /访问被拒绝/,
  );
  const initial = await native();
  assert.equal(initial.resizable, true);
  assert.ok(Math.abs(initial.bounds.width - 602) <= 4);
  assert.ok(Math.abs(initial.bounds.height - 184) <= 4);
  const dependencies = await mini.evaluate(() =>
    [...document.querySelectorAll("script[src],link[rel=modulepreload]")].map(
      (node) => new URL(node.src || node.href).pathname,
    ),
  );
  const cachePolicy = await mini.evaluate(async () => {
    const script = document.querySelector("script[src]").src;
    const asset = await fetch(script);
    const html = await fetch(location.href.split("#")[0]);
    return {
      asset: asset.headers.get("cache-control"),
      html: html.headers.get("cache-control"),
    };
  });
  assert.match(cachePolicy.asset, /immutable/);
  assert.equal(cachePolicy.html, "no-cache");
  let initialJsBytes = 0;
  for (const dependency of dependencies)
    initialJsBytes += (await fs.stat(path.join("out/renderer", dependency)))
      .size;
  assert.ok(
    initialJsBytes < 500000,
    "remote must not load the main application bundle",
  );
  await main.evaluate(() =>
    Promise.all(Array.from({ length: 8 }, () => window.music.window("mini"))),
  );
  assert.equal(
    (await native()).id,
    initial.id,
    "repeated opens reuse the current window",
  );
  await close(mini);
  // Also deduplicate calls while the new renderer is still starting.
  await main.evaluate(() =>
    Promise.all(Array.from({ length: 8 }, () => window.music.window("mini"))),
  );
  mini = application
    .windows()
    .find((item) => item.url().endsWith("#music-mini"));
  assert.equal(
    application.windows().filter((item) => item.url().endsWith("#music-mini"))
      .length,
    1,
  );
  await close(mini);
  const opens = [];
  for (let index = 0; index < 5; index++) {
    const sample = await open();
    mini = sample.page;
    opens.push(sample.ms);
    await close(mini);
  }
  const medianOpenMs = [...opens].sort((a, b) => a - b)[2];
  assert.ok(
    medianOpenMs <= Number(process.env.KALEID_MINI_OPEN_BUDGET_MS || 250),
    "reopen median should meet the 250ms same-machine target: " +
      JSON.stringify(opens),
  );

  await application.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [folder],
    });
  }, fixtures);
  const library = await main.evaluate(async () =>
    window.media.createLibrary({
      name: "音乐遥控验收",
      type: "music",
      roots: await window.media.chooseFolders(),
    }),
  );
  await main.evaluate((id) => window.media.scan(id), library.id);
  let songs;
  await until(async () => {
    const result = await main.evaluate(
      (id) => window.media.query({ libraryId: id, type: "music" }),
      library.id,
    );
    songs = result.items;
    return songs.length === 2;
  }, "music fixture indexing failed");
  await main.evaluate(
    ({ songs }) =>
      window.music.saveSession(
        {
          trackId: songs[0].id,
          queueIds: songs.map((item) => item.id),
          position: 0,
          volume: 0,
          muted: true,
          repeat: "off",
          order: "sequential",
        },
        songs,
      ),
    { songs },
  );
  await main.reload();
  await main.waitForFunction(
    () => !!document.querySelector("audio")?.getAttribute("src"),
  );
  mini = (await open()).page;
  await until(
    async () => (await snapshot(mini)).trackId === songs[0].id,
    "restored track reaches remote",
  );
  await until(
    async () => (await snapshot(mini)).lyrics.length > 0,
    "local lyrics reach remote",
  );
  await main.evaluate(() => {
    window.remoteCommands = [];
    window.music.onCommand((command, value) =>
      window.remoteCommands.push({ command, value }),
    );
  });
  await active(mini);
  await mini.getByRole("button", { name: "播放暂停" }).click();
  await main.waitForFunction(() => !document.querySelector("audio").paused);
  await until(
    async () => (await snapshot(mini)).playing,
    "remote reflects playing state",
  );
  await mini.keyboard.press("Space");
  await main.waitForFunction(() => document.querySelector("audio").paused);
  assert.equal(
    await main.evaluate(
      () =>
        window.remoteCommands.filter((item) => item.command === "toggle")
          .length,
    ),
    2,
    "click then space toggle exactly once each",
  );
  await mini.keyboard.down("Space");
  await mini.keyboard.down("Space");
  await mini.keyboard.down("Space");
  await mini.keyboard.up("Space");
  await main.waitForFunction(() => !document.querySelector("audio").paused);
  assert.equal(
    await main.evaluate(
      () =>
        window.remoteCommands.filter((item) => item.command === "toggle")
          .length,
    ),
    3,
    "holding space doesn't repeatedly toggle",
  );
  await mini.keyboard.press("Space");
  await main.waitForFunction(() => document.querySelector("audio").paused);
  await active(mini);
  await mini.getByRole("button", { name: "收藏", exact: true }).click();
  await until(
    async () => (await snapshot(mini)).favorite,
    "favorite persisted and reflected",
  );
  const favorited = await main.evaluate(
    async (id) =>
      (await window.media.query({ type: "music", favorite: true })).items.some(
        (item) => item.id === id,
      ),
    songs[0].id,
  );
  assert.equal(favorited, true);
  await mini.getByRole("button", { name: "切换循环模式" }).click();
  await until(
    async () => (await snapshot(mini)).repeat === "all",
    "repeat reaches main player",
  );
  await mini.getByRole("button", { name: "下一首" }).click();
  await until(
    async () => (await snapshot(mini)).trackId === songs[1].id,
    "next changes actual track",
  );
  await mini.getByRole("button", { name: "上一首" }).click();
  await until(
    async () => (await snapshot(mini)).trackId === songs[0].id,
    "previous changes actual track",
  );
  await mini.keyboard.press("Space");
  await main.waitForFunction(() => document.querySelector("audio").paused);
  await active(mini);
  const slider = await mini.getByLabel("迷你播放器进度").boundingBox();
  const seeksBefore = await main.evaluate(
    () =>
      window.remoteCommands.filter((item) => item.command === "seek").length,
  );
  await mini.mouse.move(slider.x + 2, slider.y + slider.height / 2);
  await mini.mouse.down();
  await mini.mouse.move(
    slider.x + slider.width * 0.25,
    slider.y + slider.height / 2,
    { steps: 8 },
  );
  await mini.mouse.up();
  await until(
    async () =>
      await main.evaluate(
        () => document.querySelector("audio").currentTime > 20,
      ),
    "progress drag seeks actual audio",
  );
  assert.equal(
    await main.evaluate(
      () =>
        window.remoteCommands.filter((item) => item.command === "seek").length,
    ),
    seeksBefore + 1,
    "one seek on drag release",
  );
  await mini.getByRole("button", { name: "更多播放选项" }).click();
  const volumeSlider = await mini.getByLabel("遥控音量").boundingBox();
  await mini.mouse.click(
    volumeSlider.x + volumeSlider.width * 0.35,
    volumeSlider.y + volumeSlider.height / 2,
  );
  await until(
    async () => Math.abs((await snapshot(mini)).volume - 0.35) < 0.04,
    "volume reaches main player",
  );
  await mini
    .getByRole("button", { name: "随机播放", exact: true })
    .count()
    .then(async (count) => {
      if (!count)
        await mini
          .getByRole("button", { name: "顺序播放", exact: true })
          .click();
    });
  await until(
    async () => (await snapshot(mini)).order === "shuffle",
    "order synchronized",
  );
  const pinBefore = (await native()).pinned;
  await mini
    .getByRole("button", { name: pinBefore ? "取消置顶" : "置顶", exact: true })
    .click();
  await until(
    async () => (await native()).pinned === !pinBefore,
    "native topmost flag updated",
  );
  await mini.keyboard.press("Escape");
  await mini.waitForFunction(
    () => document.querySelector(".remote-window").dataset.sheet === "false",
  );
  const commandsBeforeModifiers = await main.evaluate(
    () => window.remoteCommands.length,
  );
  await mini.keyboard.press("Control+Space");
  assert.equal(
    await main.evaluate(() => window.remoteCommands.length),
    commandsBeforeModifiers,
  );
  assert.equal(
    await mini.evaluate(() =>
      [...document.querySelectorAll("button,input")].some(
        (node) => node.tabIndex >= 0,
      ),
    ),
    false,
  );
  await mini.getByRole("button", { name: "更多播放选项" }).click();
  await mini.getByRole("button", { name: "播放队列", exact: true }).click();
  await main.locator(".music-stage.lyrics-only").waitFor();
  await main.locator(".queue-panel").waitFor();
  await mini.getByRole("button", { name: "返回歌词" }).click();
  // The remote's idle/hover transitions must never resize its native window.
  const beforeIdle = (await native()).bounds;
  await mini.dispatchEvent(".mini-viewport", "pointerenter");
  await active(mini);
  const art =
    "data:image/svg+xml," +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="176" height="176"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#b8c9b8"/><stop offset="1" stop-color="#d9a1a8"/></linearGradient></defs><path fill="url(#g)" d="M0 0h176v176H0z"/><circle cx="88" cy="88" r="54" fill="#ffffff36"/><text x="88" y="102" text-anchor="middle" fill="#fff" font-family="serif" font-size="44">♪</text></svg>',
    );
  const visual = {
    title: "咲き誇れ",
    artist: "YOASOBI",
    cover: art,
    playing: false,
    position: 0,
    updatedAt: Date.now(),
    lyrics: [
      {
        time: 0,
        text: "繰り返す出会いと別れに",
        translation: "面对反复上演的相遇与别离",
      },
      { time: 60, text: "次の行" },
    ],
  };
  await main.evaluate((patch) => window.music.publish(patch), visual);
  await mini.locator(".remote-lyric__hero").last().waitFor();
  await mini.waitForTimeout(400);
  await mini.screenshot({
    path: path.join(screenshots, "active-dark.png"),
    omitBackground: true,
  });
  // Send a native-equivalent pointer leave; do not depend on the tester's real cursor.
  await application.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((win) => win.webContents.getURL().endsWith("#music-mini"))
      .webContents.send("music:window-pointer", false);
  });
  await mini.waitForFunction(
    () => document.querySelector(".remote-window").dataset.idle === "true",
  );
  await mini.waitForTimeout(700);
  assert.deepEqual((await native()).bounds, beforeIdle);
  await mini.screenshot({
    path: path.join(screenshots, "idle-dark.png"),
    omitBackground: true,
  });
  await active(mini);
  await mini.getByRole("button", { name: "切换遥控背景" }).click();
  await mini.waitForTimeout(600);
  await mini.screenshot({
    path: path.join(screenshots, "cover.png"),
    omitBackground: true,
  });
  await mini.getByRole("button", { name: "切换遥控背景" }).click();
  assert.equal(
    await mini.evaluate(
      () => getComputedStyle(document.documentElement).backgroundColor,
    ),
    "rgba(0, 0, 0, 0)",
  );
  await mini.screenshot({
    path: path.join(screenshots, "transparent.png"),
    omitBackground: true,
  });
  await mini.getByRole("button", { name: "切换遥控背景" }).click();
  await mini.evaluate(() => {
    document.documentElement.dataset.theme = "light";
  });
  await mini.waitForFunction(
    () => document.querySelector(".remote-window").dataset.theme === "light",
  );
  await mini.waitForTimeout(600);
  await mini.screenshot({
    path: path.join(screenshots, "active-light.png"),
    omitBackground: true,
  });
  await main.evaluate((patch) => window.music.publish(patch), {
    ...visual,
    reducedMotion: true,
    lyrics: [
      {
        time: 0,
        text: "这是一段用于检查长歌词在较小窗口中是否能够保持两行排版并且不会遮挡进度和播放控件的歌词",
        translation: "A long translated line that must fit within the card.",
      },
    ],
  });
  await application.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((win) => win.webContents.getURL().endsWith("#music-mini"))
      .setBounds({ width: 480, height: 160 });
  });
  await mini.waitForFunction(() => Math.abs(innerWidth - 480) <= 4);
  await mini.waitForTimeout(300);
  await mini.screenshot({
    path: path.join(screenshots, "small-long-lyric.png"),
    omitBackground: true,
  });
  await mini.getByRole("button", { name: "更多播放选项" }).click();
  await mini.screenshot({
    path: path.join(screenshots, "small-options.png"),
    omitBackground: true,
  });
  await application.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((win) => win.webContents.getURL().endsWith("#music-mini"))
      .setBounds({ width: 760, height: 280 });
  });
  await mini.waitForTimeout(300);
  const resized = (await native()).bounds;
  await close(mini);
  mini = (await open()).page;
  const restoredBounds = (await native()).bounds;
  for (const key of ["x", "y", "width", "height"])
    assert.ok(
      Math.abs(restoredBounds[key] - resized[key]) <= 4,
      "saved " + key + " restored within native DPI rounding",
    );
  assert.equal((await native()).pinned, !pinBefore);
  const delayedState = await snapshot(mini);
  await close(mini);
  // A delayed initial snapshot must not hold the native window or its card back.
  // The regular live state stream should make the controls usable in the meantime.
  await application.evaluate(({ ipcMain }, state) => {
    globalThis.miniSlowBootstrapComplete = false;
    ipcMain.removeHandler("music:window-bootstrap");
    ipcMain.handle("music:window-bootstrap", async () => {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      globalThis.miniSlowBootstrapComplete = true;
      return { state, pinned: true, theme: "dark" };
    });
  }, delayedState);
  const delayedOpen = await open();
  mini = delayedOpen.page;
  await active(mini);
  assert.ok(
    delayedOpen.ms < 800,
    "first card must not wait for a slow initial snapshot",
  );
  await until(
    async () =>
      await mini
        .getByRole("button", { name: "播放暂停" })
        .isEnabled({ timeout: 500 }),
    "live snapshot makes remote usable before bootstrap completes",
    700,
  );
  assert.equal(
    await application.evaluate(() => globalThis.miniSlowBootstrapComplete),
    false,
  );
  await mini.evaluate(() => window.music.windowBootstrap());
  assert.equal(
    await mini.evaluate(() => window.music.windowInitial().state.trackId),
    delayedState.trackId,
  );
  await close(mini);
  await assert.rejects(() =>
    main.evaluate(() => window.music.window("lyrics")),
  );
  assert.deepEqual(errors, [], "no renderer crashes");
  console.log(
    JSON.stringify(
      {
        result: "passed",
        firstOpenMs,
        reopenMs: opens,
        medianOpenMs,
        delayedBootstrapOpenMs: delayedOpen.ms,
        initialJsBytes,
        screenshots,
        scenarios: [
          "dedicated lightweight entry and ready handshake",
          "close destroys / concurrent open deduplicates",
          "real audio commands and single space toggle",
          "lyrics, favorite, repeat, volume and order synchronization",
          "idle sleeve / themes / backgrounds / small window",
          "native sizing and persisted bounds and pin",
          "slow bootstrap cannot block first card or live controls",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  await application?.close().catch(() => {});
  const resolved = path.resolve(temporary);
  if (
    path.dirname(resolved) !== tempRoot ||
    !path.basename(resolved).startsWith("kaleid-music-windows-")
  )
    throw new Error("Unexpected regression directory");
  await fs.rm(resolved, { recursive: true, force: true });
}
