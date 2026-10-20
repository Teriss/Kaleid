// Sustained real-time 1080p SR benchmark. Uses generated media and isolated app data.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import ffmpeg from "ffmpeg-static";
const { _electron: electron } = await import(
  process.env.KALEID_PLAYWRIGHT_MODULE || "playwright"
);
const output = path.resolve(
  process.env.KALEID_VIDEO_BENCH_OUTPUT || "artifacts/video-sr-benchmark",
);
await fs.mkdir(output, { recursive: true });
const temporary = await fs.mkdtemp(
  path.join(os.tmpdir(), "kaleid-sr-benchmark-"),
);
const media = path.join(temporary, "media");
await fs.mkdir(media);
const fps = Number(process.env.KALEID_VIDEO_BENCH_FPS || 30);
const seconds = Number(process.env.KALEID_VIDEO_BENCH_SECONDS || 600);
assert.ok([24, 30].includes(fps));
assert.ok(seconds >= 10 && seconds <= 3600);
execFileSync(
  ffmpeg,
  [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=1920x1080:rate=${fps}`,
    "-t",
    "12",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-crf",
    "28",
    path.join(media, "1080p 超分验收.mp4"),
  ],
  { windowsHide: true, timeout: 60000 },
);
const env = {
  ...process.env,
  MEDIA_BROWSER_TEST_DATA: path.join(temporary, "data"),
};
delete env.ELECTRON_RUN_AS_NODE;
const application = await electron.launch({
  executablePath:
    process.env.KALEID_VIDEO_EXE ||
    path.resolve("node_modules/electron/dist/electron.exe"),
  args: [
    ...(process.env.KALEID_VIDEO_EXE
      ? []
      : [path.resolve("out/main/index.js")]),
    "--force-device-scale-factor=1.5",
  ],
  env,
  timeout: 60000,
});
const page = await application.firstWindow();
let socket,
  sequence = 0,
  buffer = "",
  sessionId;
const pending = new Map();
function raw(command) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("mpv benchmark timeout"));
    }, 7000);
    pending.set(id, { resolve, reject, timer });
    socket.write(JSON.stringify({ command, request_id: id }) + "\n");
  });
}
const report = {
  fps,
  requestedSeconds: seconds,
  samples: [],
  source: "generated 12-second H.264 fixture looped during sustained playback",
  gpu: null,
  result: "running",
};
try {
  await page.waitForFunction(() => Boolean(window.video && window.media));
  await application.evaluate(({ dialog }, root) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [root],
    });
  }, media);
  await page.evaluate(() =>
    window.video.onState((state) => {
      window.__videoState = state;
    }),
  );
  const library = await page.evaluate(async () =>
    window.media.createLibrary({
      name: "超分性能验收",
      type: "video",
      roots: await window.media.chooseFolders(),
    }),
  );
  await page.evaluate((id) => window.media.scan(id), library.id);
  let item;
  for (let n = 0; n < 120; n++) {
    const result = await page.evaluate(
      (id) => window.media.query({ libraryId: id, type: "video", limit: 10 }),
      library.id,
    );
    item = result.items.find((item) => !item.kind);
    if (item) break;
    await page.waitForTimeout(250);
  }
  assert.ok(item);
  sessionId = crypto.randomUUID();
  await page.evaluate(
    ({ mediaId, sessionId }) =>
      window.video.open({
        mediaId,
        sessionId,
        autoPlay: false,
        fromStart: true,
      }),
    { mediaId: item.id, sessionId },
  );
  await page.waitForFunction(
    () => window.__videoState?.status === "ready",
    undefined,
    { timeout: 35000 },
  );
  const pid = await application.evaluate(() => process.pid);
  const processes = JSON.parse(
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name = 'mpv.exe'\" | Select-Object ParentProcessId,CommandLine | ConvertTo-Json -Compress",
      ],
      { encoding: "utf8", windowsHide: true },
    ),
  );
  const commandLine = (Array.isArray(processes) ? processes : [processes]).find(
    (p) => p.ParentProcessId === pid,
  ).CommandLine;
  const pipe = commandLine.match(/--input-ipc-server=([^"\s]+)/)[1];
  socket = net.createConnection(pipe);
  socket.on("data", (part) => {
    buffer += part.toString();
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      const job = pending.get(message.request_id);
      if (job) {
        pending.delete(message.request_id);
        clearTimeout(job.timer);
        message.error === "success"
          ? job.resolve(message.data)
          : job.reject(new Error(message.error));
      }
    }
  });
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  await raw(["set_property", "loop-file", "inf"]);
  await page.evaluate(
    (id) => window.video.command(id, { type: "fullscreen", value: true }),
    sessionId,
  );
  await page.waitForTimeout(500);
  const bounds = await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setTitle("Kaleid · 1080p 实时超分性能验收");
    return window.getContentBounds();
  });
  await page.evaluate(
    ({ id, width, height }) =>
      window.video.bounds(id, { x: 0, y: 0, width, height, visible: true }),
    { id: sessionId, ...bounds },
  );
  await page.evaluate(
    (id) =>
      window.video.command(id, {
        type: "preferences",
        value: { superResolution: "generic", autoNext: false, speed: 1 },
      }),
    sessionId,
  );
  await page.waitForFunction(
    () => window.__videoState?.enhancement?.active === "generic",
    undefined,
    { timeout: 15000 },
  );
  assert.match(
    JSON.stringify(await raw(["get_property", "vo-passes"])),
    /feature map 1/,
  );
  report.gpu = await application.evaluate(({ app }) =>
    app.getGPUInfo("complete"),
  );
  report.video = await raw(["get_property", "video-params"]);
  report.osd = await raw(["get_property", "osd-dimensions"]);
  await page.evaluate(
    (id) => window.video.command(id, { type: "pause", value: false }),
    sessionId,
  );
  const started = Date.now();
  let previousDrops = 0,
    drops = 0;
  console.log(
    `BENCHMARK READY ${fps}fps / ${seconds}s`,
    application.process().pid,
  );
  while (Date.now() - started < seconds * 1000) {
    await page.waitForTimeout(
      Math.min(5000, seconds * 1000 - (Date.now() - started)),
    );
    const state = await page.evaluate(() => window.__videoState);
    assert.equal(state.status, "ready", JSON.stringify(state));
    assert.equal(state.paused, false);
    assert.equal(state.enhancement.active, "generic");
    const current = Number(await raw(["get_property", "frame-drop-count"]));
    drops += Math.max(0, current - previousDrops);
    previousDrops = current;
    const sample = {
      elapsed: (Date.now() - started) / 1000,
      drops,
      position: state.position,
      enhancement: state.enhancement,
    };
    report.samples.push(sample);
    if (report.samples.length % 6 === 0) {
      console.log(`BENCH ${Math.round(sample.elapsed)}s dropped=${drops}`);
      await fs.writeFile(
        path.join(output, "progress.json"),
        JSON.stringify(report, null, 2),
      );
    }
  }
  report.elapsedSeconds = (Date.now() - started) / 1000;
  report.droppedFrames = drops;
  report.dropRate = drops / (report.elapsedSeconds * fps);
  report.result =
    report.dropRate <= 0.05 ? "passed" : "performance target missed";
  await fs.writeFile(
    path.join(output, "results.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify({
      fps,
      elapsedSeconds: report.elapsedSeconds,
      drops,
      dropRate: report.dropRate,
      result: report.result,
    }),
  );
  assert.equal(report.result, "passed");
} finally {
  socket?.destroy();
  for (const job of pending.values()) {
    clearTimeout(job.timer);
    job.reject(new Error("benchmark closed"));
  }
  if (sessionId)
    await page
      .evaluate((id) => window.video.close(id), sessionId)
      .catch(() => {});
  await application.close();
}
