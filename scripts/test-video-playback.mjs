// Windows integration test. Install playwright locally or set KALEID_PLAYWRIGHT_MODULE
// to its absolute index.mjs file URL. Build and prepare the runtime first.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import ffmpeg from "ffmpeg-static";
import net from "node:net";
const { _electron: electron } = await import(
  process.env.KALEID_PLAYWRIGHT_MODULE || "playwright"
);
const output = path.resolve(
  process.env.KALEID_VIDEO_TEST_OUTPUT || "artifacts/video-acceptance",
);
await fs.mkdir(output, { recursive: true });
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "kaleid-video-"));
const media = path.join(temporary, "中文 电影与剧集");
await fs.mkdir(media);
const encode = (...args) =>
  execFileSync(
    ffmpeg,
    ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...args],
    { windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024 },
  );
const file = (name) => path.join(media, name);
encode(
  "-f",
  "lavfi",
  "-i",
  "testsrc2=size=320x180:rate=24",
  "-f",
  "lavfi",
  "-i",
  "sine=frequency=440",
  "-f",
  "lavfi",
  "-i",
  "sine=frequency=880",
  "-t",
  "12",
  "-map",
  "0:v",
  "-map",
  "1:a",
  "-map",
  "2:a",
  "-c:v",
  "libx264",
  "-preset",
  "ultrafast",
  "-c:a",
  "aac",
  "-metadata:s:a:0",
  "language=zho",
  "-metadata:s:a:1",
  "language=eng",
  file("01 测试.MP4"),
);
await fs.writeFile(
  file("字幕.srt"),
  "1\n00:00:00,000 --> 00:00:10,000\n中文字幕测试\n",
);
encode(
  "-i",
  file("01 测试.MP4"),
  "-i",
  file("字幕.srt"),
  "-map",
  "0",
  "-map",
  "1",
  "-c:v",
  "libx265",
  "-preset",
  "ultrafast",
  "-pix_fmt",
  "yuv420p10le",
  "-x265-params",
  "pools=1:log-level=error",
  "-c:a",
  "copy",
  "-c:s",
  "ass",
  "-metadata:s:s:0",
  "language=zho",
  file("02 剧集.mkv"),
);
encode(
  "-i",
  file("01 测试.MP4"),
  "-map",
  "0:v",
  "-map",
  "0:a:0",
  "-c:v",
  "mpeg4",
  "-c:a",
  "libmp3lame",
  file("03 旧片.avi"),
);
encode(
  "-i",
  file("01 测试.MP4"),
  "-map",
  "0:v",
  "-map",
  "0:a:0",
  "-c:v",
  "libvpx-vp9",
  "-deadline",
  "realtime",
  "-cpu-used",
  "8",
  "-c:a",
  "libopus",
  file("04 网页.webm"),
);
encode(
  "-i",
  file("01 测试.MP4"),
  "-map",
  "0:v",
  "-map",
  "0:a:0",
  "-c",
  "copy",
  file("05 录像.ts"),
);
encode(
  "-i",
  file("01 测试.MP4"),
  "-map",
  "0:v",
  "-map",
  "0:a:0",
  "-c:v",
  "rv20",
  "-c:a",
  "ac3",
  "-f",
  "rm",
  file("06 老视频.rmvb"),
);
await fs.writeFile(file("损坏视频.mkv"), "This is not a movie");
await fs.copyFile(file("字幕.srt"), file("01 测试.zh.srt"));
for (let index = 7; index <= 72; index++)
  await fs.copyFile(
    file("01 测试.MP4"),
    file(`${String(index).padStart(2, "0")} 分集.mp4`),
  );

const env = {
  ...process.env,
  MEDIA_BROWSER_TEST_DATA: path.join(temporary, "data"),
};
delete env.ELECTRON_RUN_AS_NODE;
const scales = process.env.KALEID_VIDEO_SCALES?.split(",").map(Number) || [
  1, 1.5, 2,
];
const results = [];
async function nativeCommand(application, command) {
  const pid = await application.evaluate(() => process.pid);
  const rawProcesses = execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process -Filter \"Name = 'mpv.exe'\" | Select-Object ParentProcessId,CommandLine | ConvertTo-Json -Compress",
    ],
    { encoding: "utf8", windowsHide: true },
  );
  const processes = JSON.parse(rawProcesses || "[]");
  const commandLine = (Array.isArray(processes) ? processes : [processes]).find(
    (p) => p.ParentProcessId === pid,
  )?.CommandLine;
  assert.ok(
    commandLine,
    `mpv child of browser ${pid}; discovered ${rawProcesses}`,
  );
  const pipe = commandLine.match(/--input-ipc-server=([^"\s]+)/)?.[1];
  assert.ok(pipe, "native mpv IPC pipe exists");
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipe);
    let buffer = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("Native command timed out"));
    }, 7000);
    socket.once("error", reject);
    socket.on("connect", () =>
      socket.write(JSON.stringify({ command, request_id: 991 }) + "\n"),
    );
    socket.on("data", (part) => {
      buffer += part.toString();
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const message = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (message.request_id === 991) {
          clearTimeout(timeout);
          socket.destroy();
          if (message.error === "success") resolve(message.data);
          else reject(new Error(message.error));
        }
      }
    });
  });
}
for (const scale of scales) {
  const application = await electron.launch({
    executablePath:
      process.env.KALEID_VIDEO_EXE ||
      path.resolve("node_modules/electron/dist/electron.exe"),
    args: [
      ...(process.env.KALEID_VIDEO_EXE
        ? []
        : [path.resolve("out/main/index.js")]),
      `--force-device-scale-factor=${scale}`,
    ],
    env,
    timeout: 60000,
  });
  const page = await application.firstWindow();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  application
    .process()
    .stderr.on("data", (part) =>
      fs.appendFile(path.join(output, "electron.log"), part).catch(() => {}),
    );
  try {
    await page.waitForFunction(() => Boolean(window.media && window.video));
    await application.evaluate(({ dialog }, root) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [root],
      });
    }, media);
    let lib = await page.evaluate(async () => {
      const existing = (await window.media.libraries()).find(
        (library) => library.type === "video",
      );
      if (existing) return existing;
      return window.media.createLibrary({
        name: "视频验收",
        type: "video",
        roots: await window.media.chooseFolders(),
      });
    });
    await page.evaluate(async (id) => {
      await window.media.scan(id);
    }, lib.id);
    let all;
    const scanDeadline = Date.now() + 30000;
    do {
      all = await page.evaluate(
        (id) =>
          window.media.query({ libraryId: id, type: "video", limit: 500 }),
        lib.id,
      );
      if (all.total === 73) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    } while (Date.now() < scanDeadline);
    const items = all.items.filter((item) => !item.kind);
    assert.equal(
      items.length,
      73,
      JSON.stringify({
        total: all.total,
        items: all.items.map((item) => ({
          title: item.title,
          kind: item.kind,
          missing: item.missing,
        })),
      }),
    );
    const first = items.find((item) => item.title.startsWith("01"));
    const queue = await page.evaluate(
      (id) => window.video.queue(id, "name"),
      first.id,
    );
    assert.equal(queue.length, 73, "queue spans all pagination");
    await page.evaluate(() => {
      window.__videoState = undefined;
      window.video.onState((state) => (window.__videoState = state));
    });
    const open = async (item, extra = {}) => {
      const sessionId = crypto.randomUUID();
      await page.evaluate(
        async ({ item, sessionId, extra }) => {
          window.__videoState = undefined;
          await window.video.open({
            mediaId: item.id,
            sessionId,
            autoPlay: false,
            ...extra,
          });
        },
        { item, sessionId, extra },
      );
      await page.waitForFunction(
        (sessionId) =>
          window.__videoState?.sessionId === sessionId &&
          ["ready", "error"].includes(window.__videoState.status),
        sessionId,
        { timeout: 35000 },
      );
      const state = await page.evaluate(() => window.__videoState);
      assert.equal(state.status, "ready", JSON.stringify(state.error));
      return sessionId;
    };
    if (scale === scales[0]) {
      // Probe and poster work is independent from the initial scan.
      const deadline = Date.now() + 30000;
      let enriched;
      do {
        enriched = await page.evaluate((id) => window.media.item(id), first.id);
        if (enriched.cover && enriched.width && enriched.duration) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      } while (Date.now() < deadline);
      assert.ok(
        enriched.cover && enriched.width === 320 && enriched.duration > 10,
        JSON.stringify(enriched),
      );
      console.log("PASS background metadata and FFmpeg cover");
    }
    for (const prefix of process.env.KALEID_VIDEO_FORMATS?.split(",") ||
      (scale === scales[0] ? ["01", "02", "03", "04", "05", "06"] : ["02"])) {
      const candidate = items.find((item) => item.title.startsWith(prefix));
      const id = await open(candidate);
      await page.evaluate(async (id) => {
        await window.video.bounds(id, {
          x: 40,
          y: 100,
          width: 640,
          height: 360,
          visible: true,
        });
        await window.video.command(id, {
          type: "preferences",
          value: { muted: true },
        });
        await window.video.command(id, { type: "seek", value: 3 });
      }, id);
      const state = await page.evaluate(() => window.__videoState);
      assert.ok(
        state.duration > 10 && state.duration < 15,
        `duration ${state.duration}`,
      );
      if (prefix === "02") {
        assert.equal(
          state.tracks.filter((track) => track.type === "audio").length,
          2,
        );
        assert.ok(state.tracks.some((track) => track.type === "sub"));
        const audio = state.tracks.filter((track) => track.type === "audio")[1];
        await page.evaluate(
          ({ id, track }) =>
            window.video.command(id, {
              type: "track",
              kind: "audio",
              id: track,
            }),
          { id, track: audio.id },
        );
        await page.evaluate(
          (id) =>
            window.video.command(id, {
              type: "preferences",
              value: {
                hardwareDecoding: false,
                speed: 1.5,
                subtitleDelay: 0.2,
                audioDelay: 0.1,
                fit: "cover",
                rotation: 90,
              },
            }),
          id,
        );
      }
      if (prefix === "01")
        assert.ok(
          state.tracks.some(
            (track) => track.type === "sub" && track.external && track.selected,
          ),
          "same-name external subtitle selected",
        );
      await page.evaluate(
        (id) => window.video.command(id, { type: "pause", value: false }),
        id,
      );
      await page.waitForFunction(() => window.__videoState?.position > 3.2);
      await page.evaluate(
        (id) => window.video.command(id, { type: "pause", value: true }),
        id,
      );
      await page.evaluate((id) => window.video.close(id), id);
      const saved = await page.evaluate(
        (id) => window.media.item(id),
        candidate.id,
      );
      assert.ok(saved.progress.position >= 3);
      const resumed = await open(candidate);
      assert.ok((await page.evaluate(() => window.__videoState)).resumed);
      await page.evaluate((id) => window.video.close(id), resumed);
      results.push({ scale, format: candidate.ext, result: "passed" });
      console.log(
        "PASS",
        scale,
        candidate.ext,
        "decode, seek, progress, resume",
      );
    }
    if (scale === scales[0]) {
      const completed = await open(first, { fromStart: true });
      await page.evaluate(async (id) => {
        await window.video.command(id, {
          type: "preferences",
          value: { muted: true, speed: 4, fit: "contain", rotation: 0 },
        });
        await window.video.command(id, { type: "seek", value: 11.8 });
        await window.video.command(id, { type: "pause", value: false });
      }, completed);
      await page.waitForFunction(
        () => window.__videoState?.status === "ended",
        undefined,
        { timeout: 10000 },
      );
      await page.evaluate((id) => window.video.close(id), completed);
      const watched = await page.evaluate(
        (id) => window.media.item(id),
        first.id,
      );
      assert.equal(watched.progress.completed, true);
      assert.equal(watched.progress.position, 0);
      const restart = await open(first);
      assert.equal(
        (await page.evaluate(() => window.__videoState)).resumed,
        false,
      );
      await page.evaluate((id) => window.video.close(id), restart);
      const damaged = items.find((candidate) => candidate.title === "损坏视频");
      const badSession = crypto.randomUUID();
      await page.evaluate(
        ({ id, sessionId }) =>
          window.video.open({ mediaId: id, sessionId, autoPlay: false }),
        { id: damaged.id, sessionId: badSession },
      );
      await page.waitForFunction(
        (id) =>
          window.__videoState?.sessionId === id &&
          window.__videoState.status === "error",
        badSession,
      );
      await page.evaluate((id) => window.video.close(id), badSession);
      const stale = crypto.randomUUID(),
        fresh = crypto.randomUUID();
      await page.evaluate(
        async ({ id, stale, fresh }) => {
          await Promise.all([
            window.video.open({
              mediaId: id,
              sessionId: stale,
              autoPlay: false,
            }),
            window.video.open({
              mediaId: id,
              sessionId: fresh,
              autoPlay: false,
            }),
          ]);
        },
        { id: first.id, stale, fresh },
      );
      await page.waitForFunction(
        (id) =>
          window.__videoState?.sessionId === id &&
          window.__videoState.status === "ready",
        fresh,
      );
      await assert.rejects(() =>
        page.evaluate(
          (id) => window.video.command(id, { type: "pause", value: false }),
          stale,
        ),
      );
      await page.evaluate(
        (id) =>
          window.video.command(id, {
            type: "preferences",
            value: { speed: 1 },
          }),
        fresh,
      );
      await page.evaluate((id) => window.video.close(id), fresh);
      results.push({
        scale,
        boundaries: "completed progress, damaged file, stale session",
        result: "passed",
      });
      console.log("PASS completion, damaged file, rapid session switching");
    }
    // Every native session is closed before opening the actual renderer viewer.
    await page.reload();
    await page.waitForFunction(() => Boolean(window.media && window.video));
    await page.evaluate(() => {
      window.video.onState((state) => (window.__videoState = state));
      window.video.onExports((jobs) => {
        window.__exportJobs = jobs;
      });
    });
    await page.getByRole("button", { name: "浏览视频", exact: true }).click();
    await page.getByRole("button", { name: "媒体库", exact: true }).click();
    await page
      .locator(".library-picker")
      .getByRole("button", { name: "视频验收", exact: true })
      .click();
    await page.getByLabel("排序方式").selectOption("name");
    await page.getByRole("button", { name: "显示方式", exact: true }).click();
    await page
      .getByRole("button", { name: "切换到标准网格", exact: true })
      .click();
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await page
      .getByRole("textbox", { name: "搜索媒体", exact: true })
      .fill("01 测试");
    await page
      .getByRole("textbox", { name: "搜索媒体", exact: true })
      .press("Enter");
    const tile = page.getByRole("button", { name: /^(打开|聚焦) 01 测试$/ });
    await tile.first().dblclick();
    await page
      .locator('.video-player[data-status="ready"]')
      .waitFor({ timeout: 35000 });
    await page.getByRole("button", { name: "选集", exact: true }).click();
    assert.equal(await page.locator(".video-episodes button").count(), 73);
    await page.screenshot({ path: path.join(output, `controls-${scale}.png`) });
    if (scale === scales[0] && process.env.KALEID_VIDEO_HOLD !== "1") {
      await page.getByRole("button", { name: "播放设置", exact: true }).click();
      await page
        .getByLabel("实时超分", { exact: true })
        .selectOption("generic");
      await page.waitForFunction(
        () => window.__videoState?.enhancement?.active === "generic",
        undefined,
        { timeout: 15000 },
      );
      const passes = await nativeCommand(application, [
        "get_property",
        "vo-passes",
      ]);
      assert.match(
        JSON.stringify(passes),
        /feature map|sub-pixel convolution|aggregation/,
        "FSRCNNX really executes on GPU",
      );
      await fs.writeFile(
        path.join(output, "gpu-info.json"),
        JSON.stringify(
          await application.evaluate(({ app }) => app.getGPUInfo("complete")),
          null,
          2,
        ),
      );
      const generic = await page.evaluate(
        () => window.__videoState.enhancement,
      );
      await page.getByLabel("实时超分", { exact: true }).selectOption("rtx");
      await page.waitForTimeout(2500);
      const rtx = await page.evaluate(() => window.__videoState.enhancement);
      await fs.writeFile(
        path.join(output, "enhancement.json"),
        JSON.stringify({ generic, rtx, passes }, null, 2),
      );
      assert.equal(
        (await page.evaluate(() => window.__videoState)).status,
        "ready",
        "RTX attempt preserves playback",
      );
      await page.getByLabel("实时超分", { exact: true }).selectOption("off");
      await page.waitForFunction(
        () => window.__videoState?.enhancement?.active === "off",
      );
      await page.getByRole("button", { name: "截取片段", exact: true }).click();
      await page.getByLabel("片段开始时间").fill("00:00:01.123");
      await page.getByLabel("片段结束时间").fill("00:00:03.456");
      const exportButton = await page
        .getByRole("button", { name: "选择保存位置并导出…", exact: true })
        .boundingBox();
      const clipPanel = await page.locator(".video-panel").boundingBox();
      assert.ok(
        exportButton.y + exportButton.height <=
          clipPanel.y + clipPanel.height + 1,
        "export action remains visible without scrolling",
      );
      await page.screenshot({
        path: path.join(output, `clip-panel-${scale}.png`),
      });
      await page
        .getByRole("button", { name: "循环预览片段", exact: true })
        .click();
      await page.waitForTimeout(3200);
      const preview = await page.evaluate(() => window.__videoState.position);
      assert.ok(
        preview >= 1.1 && preview <= 3.6,
        `range loop position ${preview}`,
      );
      await page
        .getByRole("button", { name: "停止片段预览", exact: true })
        .click();
      for (const format of ["mp4", "gif"]) {
        const target = path.join(output, `UI 中文片段.${format}`);
        await application.evaluate(({ dialog }, filePath) => {
          dialog.showSaveDialog = async () => ({ canceled: false, filePath });
        }, target);
        await page.getByLabel("导出格式").selectOption(format);
        await page
          .getByRole("button", { name: "选择保存位置并导出…", exact: true })
          .click();
        await page.locator(".video-export-modal[open]").waitFor();
        await page.waitForFunction(
          (target) =>
            window.__exportJobs?.some(
              (j) =>
                j.output === target &&
                ["completed", "failed"].includes(j.status),
            ),
          target,
          { timeout: 30000 },
        );
        const completed = (
          await page.evaluate(() => window.video.exports())
        ).find((j) => j.output === target);
        assert.equal(completed.status, "completed", completed.error);
        assert.ok((await fs.stat(target)).size > 0);
        await page
          .locator(".video-export-modal")
          .getByRole("button", { name: "关闭", exact: true })
          .click();
        await page
          .locator(".video-export-modal")
          .waitFor({ state: "detached" });
      }
      await page.getByRole("button", { name: "关闭面板", exact: true }).click();
      assert.equal(
        await nativeCommand(application, ["get_property", "ab-loop-a"]),
        "no",
      );
      // A stale native callback must not navigate the current viewer.
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].webContents.send("video:input", {
          sessionId: "expired",
          action: "back",
        }),
      );
      await page.waitForTimeout(200);
      assert.equal(await page.locator(".video-player").count(), 1);
      await application.evaluate(({ dialog }, directory) => {
        let count = 0;
        dialog.showSaveDialog = async () => ({
          canceled: false,
          filePath: `${directory}\\background-${++count}.gif`,
        });
        global.__exportQuitPrompts = 0;
        dialog.showMessageBox = async () => {
          global.__exportQuitPrompts++;
          return { response: 0 };
        };
      }, output);
      await page.evaluate(async () => {
        const state = window.__videoState;
        for (let i = 0; i < 8; i++)
          await window.video.export({
            sessionId: state.sessionId,
            mediaId: state.mediaId,
            start: 0,
            end: 12,
            format: "gif",
            audio: false,
            gifWidth: 640,
            gifFps: 24,
          });
      });
      await application.evaluate(({ app }) => app.quit());
      assert.equal(
        await application.evaluate(() => global.__exportQuitPrompts),
        1,
        "unfinished exports block quit and allow waiting",
      );
      await page.getByRole("button", { name: "全屏", exact: true }).click();
      await nativeCommand(application, ["keypress", "MBTN_BACK"]);
      await page.locator(".video-player").waitFor({ state: "detached" });
      assert.equal(
        await application.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].isFullScreen(),
        ),
        false,
      );
      await page.waitForFunction(
        () =>
          window.__exportJobs
            ?.filter((j) => j.output.includes("background-"))
            .every((j) => ["completed", "failed"].includes(j.status)),
        undefined,
        { timeout: 30000 },
      );
      const background = (
        await page.evaluate(() => window.video.exports())
      ).filter((j) => j.output.includes("background-"));
      assert.equal(background.length, 8);
      assert.ok(
        background.every((j) => j.status === "completed"),
        JSON.stringify(background),
      );
      // DOM control area uses the same complete-viewer close operation.
      await tile.first().dblclick();
      await page
        .locator('.video-player[data-status="ready"]')
        .waitFor({ timeout: 35000 });
      await page.getByRole("button", { name: "选集", exact: true }).click();
      await page
        .getByRole("button", { name: "返回媒体库", exact: true })
        .dispatchEvent("mouseup", { button: 3 });
      await page.locator(".video-player").waitFor({ state: "detached" });
      await tile.first().dblclick();
      await page
        .locator('.video-player[data-status="ready"]')
        .waitFor({ timeout: 35000 });
      await page.getByRole("button", { name: "选集", exact: true }).click();
      results.push({
        scale,
        enhancements:
          "GPU FSRCNNX, RTX attempt, clip preview, real MP4/GIF UI exports, native/DOM back and stale input",
        result: "passed",
      });
    }
    if (process.env.KALEID_VIDEO_HOLD === "1") {
      await page.getByRole("button", { name: "暂停", exact: true }).click();
      console.log("HOLD", scale, "native surface ready for capture");
      await new Promise((resolve) => setTimeout(resolve, 60000));
    }
    if (scale === scales[0] && process.env.KALEID_VIDEO_HOLD !== "1") {
      await page
        .getByRole("checkbox", { name: "自动播放下一集", exact: true })
        .click();
      await page.waitForFunction(
        () => window.__videoState?.preferences.autoNext === true,
      );
      await page.evaluate(async () => {
        const id = window.__videoState.sessionId;
        await window.video.command(id, { type: "seek", value: 11.8 });
        await window.video.command(id, { type: "pause", value: false });
      });
      await page.waitForFunction(
        () =>
          document
            .querySelector(".video-heading strong")
            ?.textContent?.startsWith("02"),
        undefined,
        { timeout: 10000 },
      );
      await page
        .locator('.video-player[data-status="ready"]')
        .waitFor({ timeout: 35000 });
      await page.getByRole("button", { name: "选集", exact: true }).click();
      await page
        .getByRole("checkbox", { name: "自动播放下一集", exact: true })
        .click();
      await page.waitForFunction(
        () => window.__videoState?.preferences.autoNext === false,
      );
      console.log("PASS directory auto-next starts next episode");
    }
    await page.keyboard.press("Escape");
    await page.locator(".video-panel").waitFor({ state: "detached" });
    await page.getByRole("button", { name: "全屏", exact: true }).click();
    await page.waitForTimeout(500);
    assert.equal(
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].isFullScreen(),
      ),
      true,
    );
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
    assert.equal(
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].isFullScreen(),
      ),
      false,
    );
    await page.keyboard.press("Escape");
    await page.locator(".video-player").waitFor({ state: "detached" });
    assert.deepEqual(errors, []);
    results.push({
      scale,
      ui: "controls, queue, fullscreen, Escape",
      result: "passed",
    });
    if (scale === scales[0]) {
      const missing = items.find((candidate) =>
        candidate.title.startsWith("06"),
      );
      const originalPath = file("06 老视频.rmvb");
      const movedPath = file("06 老视频.offline");
      await fs.rename(originalPath, movedPath);
      try {
        const id = crypto.randomUUID();
        await page.evaluate(
          ({ mediaId, sessionId }) =>
            window.video.open({ mediaId, sessionId, autoPlay: false }),
          { mediaId: missing.id, sessionId: id },
        );
        await page.waitForFunction(
          (id) =>
            window.__videoState?.sessionId === id &&
            window.__videoState.status === "error",
          id,
        );
        assert.equal(
          (await page.evaluate(() => window.__videoState)).error.kind,
          "offline",
        );
        await page.evaluate((id) => window.video.close(id), id);
      } finally {
        await fs.rename(movedPath, originalPath);
      }
      await page.evaluate(async (id) => {
        await window.media.favorite(id, true);
        await window.media.saveProgress(id, { position: 5, duration: 12 });
      }, first.id);
      await fs.copyFile(file("04 网页.webm"), file("01 测试.MP4"));
      await page.evaluate((id) => window.media.scan(id), lib.id);
      const replacementDeadline = Date.now() + 30000;
      let replaced;
      do {
        replaced = await page.evaluate((id) => window.media.item(id), first.id);
        if (replaced.videoCodec === "vp9" && !replaced.progress) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      } while (Date.now() < replacementDeadline);
      assert.equal(replaced.videoCodec, "vp9");
      assert.equal(replaced.progress, undefined);
      assert.equal(replaced.favorite, true);
      assert.equal(replaced.id, first.id);
      await page.evaluate(async (id) => {
        await window.media.scan(id);
        await window.media.cancelScan(id);
      }, lib.id);
      results.push({
        scale,
        indexing:
          "offline file, replacement, stable identity and favorite, scan cancellation",
        result: "passed",
      });
      console.log(
        "PASS offline file, replacement, favorite preservation, scan cancellation",
      );
    }
  } catch (error) {
    console.error("Acceptance failure:", error);
    await page
      .screenshot({ path: path.join(output, `failure-${scale}.png`) })
      .catch(() => {});
    await fs
      .writeFile(
        path.join(output, `failure-${scale}.txt`),
        await page.locator("body").innerText(),
      )
      .catch(() => {});
    throw error;
  } finally {
    await page
      .evaluate(async () => {
        for (const job of await window.video.exports())
          if (["queued", "running"].includes(job.status))
            await window.video.cancelExport(job.id);
      })
      .catch(() => {});
    await application.close();
  }
}
await fs.writeFile(
  path.join(output, "results.json"),
  JSON.stringify({ results, temporary }, null, 2),
);
console.log(JSON.stringify({ results, fixtures: temporary }, null, 2));
