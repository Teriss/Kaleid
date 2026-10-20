// Real FFmpeg exports plus the typed playback enhancement policy; Node 24 required.
import { registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (
        error.code === "ERR_MODULE_NOT_FOUND" &&
        specifier.startsWith(".") &&
        context.parentURL?.includes("/src/")
      )
        return next(specifier + ".ts", context);
      throw error;
    }
  },
});
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
const { VideoExports, inspectExportSource, ffmpegBinary, validateExport } =
  await import("../src/main/videoExport.ts");
const { VideoEnhancer } = await import("../src/main/videoEnhancement.ts");
const { clipTime, parseClipTime } = await import("../src/shared/videoClip.ts");
const { videoPreferences } = await import("../src/shared/video.ts");
process.env.MEDIA_BROWSER_VIDEO_RUNTIME = path.resolve(
  "artifacts/video-runtime",
);
const ffmpeg = ffmpegBinary();
const ffprobe = path.resolve("artifacts/video-runtime/ffprobe/ffprobe.exe");
const encode = (args) =>
  execFileSync(
    ffmpeg,
    ["-hide_banner", "-nostdin", "-v", "error", "-y", ...args],
    { windowsHide: true, timeout: 60000 },
  );
const probe = (file) =>
  JSON.parse(
    execFileSync(
      ffprobe,
      ["-v", "error", "-show_streams", "-show_format", "-of", "json", file],
      { windowsHide: true },
    ).toString(),
  );
const input = {
  sessionId: "test",
  mediaId: "a".repeat(32),
  start: 0.731,
  end: 2.317,
  format: "mp4",
  audio: true,
  gifWidth: 480,
  gifFps: 15,
};
async function waitFor(manager, id) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const job = manager.list().find((job) => job.id === id);
    if (!["running", "queued"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Export timed out");
}
test("clip timestamps preserve milliseconds and reject malformed ranges", () => {
  assert.equal(clipTime(3723.456), "01:02:03.456");
  assert.equal(parseClipTime("01:02:03.456"), 3723.456);
  assert.equal(parseClipTime("00:00:00.1"), 0.1);
  assert.ok(Number.isNaN(parseClipTime("00:60:01.000")));
  for (const patch of [
    { start: NaN },
    { end: 0 },
    { start: -1 },
    { end: 11 },
    { format: "exe" },
    { gifWidth: 100000 },
    { audio: "yes" },
  ])
    assert.throws(() => validateExport({ ...input, ...patch }, 10));
  assert.equal(videoPreferences().superResolution, "off");
  assert.equal(
    videoPreferences({ superResolution: "injected" }).superResolution,
    "off",
  );
});
test("bundled shader is pinned and unchanged upstream source", async () => {
  const lock = JSON.parse(
    await fs.readFile("scripts/video-runtime.json", "utf8"),
  );
  const shader = await fs.readFile(
    `artifacts/video-runtime/shaders/${lock.shader.file}`,
  );
  assert.equal(
    createHash("sha256").update(shader).digest("hex"),
    lock.shader.sha256,
  );
  assert.match(shader.toString(), /Lesser General Public/);
});
test("precise MP4, selected audio, silent GIF, HDR, cancellation and file safeguards", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kaleid-export-中文-"));
  const manifest = path.join(dir, "jobs.json");
  const manager = new VideoExports(manifest, () => {});
  try {
    const file = path.join(dir, "双音轨.MP4");
    encode([
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x180:rate=24",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=880:sample_rate=48000",
      "-t",
      "4",
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
      "-g",
      "96",
      "-c:a",
      "aac",
      file,
    ]);
    const source = await inspectExportSource(file, "双音轨", 2);
    const mp4 = await manager.add(
      source,
      input,
      path.join(dir, "精确片段.mp4"),
    );
    assert.equal((await waitFor(manager, mp4.id)).status, "completed");
    const metadata = probe(mp4.output);
    assert.equal(metadata.streams[0].codec_name, "h264");
    assert.equal(metadata.streams[1].codec_name, "aac");
    assert.ok(
      Math.abs(Number(metadata.format.duration) - (input.end - input.start)) <
        0.09,
    );
    const pcm = execFileSync(
      ffmpeg,
      [
        "-v",
        "error",
        "-i",
        mp4.output,
        "-map",
        "0:a",
        "-t",
        "1",
        "-ac",
        "1",
        "-ar",
        "48000",
        "-f",
        "s16le",
        "pipe:1",
      ],
      { windowsHide: true },
    );
    let crossings = 0;
    for (let i = 2; i < pcm.length; i += 2)
      if (pcm.readInt16LE(i - 2) <= 0 && pcm.readInt16LE(i) > 0) crossings++;
    assert.ok(
      Math.abs(crossings - 880) < 8,
      `selected second audio frequency: ${crossings}`,
    );
    const gif = await manager.add(
      source,
      { ...input, format: "gif" },
      path.join(dir, "动图.gif"),
    );
    assert.equal((await waitFor(manager, gif.id)).status, "completed");
    const g = probe(gif.output);
    assert.equal(g.streams.length, 1);
    assert.equal(g.streams[0].codec_name, "gif");
    assert.equal(g.streams[0].width, 320);
    assert.ok(Math.abs(Number(g.format.duration) - 1.6) < 0.08);
    const vfrFile = path.join(dir, "可变帧率静音.mkv");
    encode([
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=160x90:rate=30",
      "-t",
      "4",
      "-vf",
      "select='not(mod(n,2))+not(mod(n,5))'",
      "-fps_mode",
      "vfr",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      vfrFile,
    ]);
    const vfrSource = await inspectExportSource(vfrFile, "VFR silent");
    const vfrJob = await manager.add(
      vfrSource,
      input,
      path.join(dir, "VFR.mp4"),
    );
    const vfrResult = await waitFor(manager, vfrJob.id);
    assert.equal(vfrResult.status, "completed", vfrResult.error);
    const vfrOutput = probe(vfrJob.output);
    assert.equal(vfrOutput.streams.length, 1);
    assert.ok(
      Math.abs(Number(vfrOutput.format.duration) - (input.end - input.start)) <
        0.12,
    );
    await assert.rejects(manager.add(source, input, file), /源视频/);
    const target = path.join(dir, "冲突.mp4");
    const conflict = await manager.add(source, input, target);
    await fs.writeFile(target, "preserve this new file");
    assert.equal((await waitFor(manager, conflict.id)).status, "failed");
    assert.equal(await fs.readFile(target, "utf8"), "preserve this new file");
    const cancel = await manager.add(source, input, path.join(dir, "取消.mp4"));
    await manager.cancel(cancel.id);
    assert.equal((await waitFor(manager, cancel.id)).status, "canceled");
    const replacement = await manager.add(
      { ...source, modified: source.modified - 1 },
      input,
      path.join(dir, "替换.mp4"),
    );
    assert.equal((await waitFor(manager, replacement.id)).status, "failed");
    const hdrFile = path.join(dir, "HDR.mkv");
    encode([
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=160x90:rate=24",
      "-t",
      "3",
      "-c:v",
      "libx265",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p10le",
      "-x265-params",
      "pools=1:log-level=error",
      "-color_primaries",
      "bt2020",
      "-color_trc",
      "smpte2084",
      "-colorspace",
      "bt2020nc",
      hdrFile,
    ]);
    const hdr = await inspectExportSource(hdrFile, "HDR");
    assert.equal(hdr.hdr, true);
    const hdrJob = await manager.add(hdr, input, path.join(dir, "SDR.mp4"));
    const hdrResult = await waitFor(manager, hdrJob.id);
    assert.equal(hdrResult.status, "completed", hdrResult.error);
    assert.equal(probe(hdrJob.output).streams[0].color_transfer, "bt709");
    await manager.stop();
    assert.equal(
      (await fs.readdir(dir)).some((name) =>
        name.startsWith(".kaleid-export-"),
      ),
      false,
    );
    assert.deepEqual(JSON.parse(await fs.readFile(manifest, "utf8")), []);
    t.diagnostic(
      "Real encoding passed: exact non-keyframe interval, 880Hz track, GIF, HDR→SDR, cancel/replacement/conflict safety.",
    );
  } finally {
    await manager.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
test("startup cleans only recorded export scratch files", async () => {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "kaleid-export-recover-"),
  );
  const temporary = path.join(
    dir,
    ".kaleid-export-00000000-0000-0000-0000-000000000001.part.mp4",
  );
  const keep = path.join(dir, "keep.mp4"),
    manifest = path.join(dir, "manifest.json");
  await fs.writeFile(temporary, "interrupted");
  await fs.writeFile(keep, "preserve");
  await fs.writeFile(manifest, JSON.stringify([temporary, keep]));
  const manager = new VideoExports(manifest, () => {});
  try {
    await manager.stop();
    assert.equal(
      await fs.access(temporary).then(
        () => true,
        () => false,
      ),
      false,
    );
    assert.equal(await fs.readFile(keep, "utf8"), "preserve");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
test("auto SR ignores pauses and degrades RTX then generic after sustained drops", async () => {
  const now = Date.now;
  let time = 100000;
  Date.now = () => time;
  const state = {
    status: "ready",
    paused: false,
    preferences: videoPreferences({ superResolution: "auto" }),
  };
  const raw = async (command) => {
    if (command[0] === "get_property")
      return {
        "video-params": { w: 640, h: 360 },
        "osd-dimensions": { w: 1920, h: 1080 },
        "vo-passes": { fresh: [{ desc: "feature map 1" }] },
        seeking: false,
        "estimated-frame-number": time * 0.03,
        "frame-drop-count": time * 0.003,
      }[command[1]];
  };
  const enhancer = new VideoEnhancer(
    state,
    () => undefined,
    raw,
    () => {},
    true,
  );
  const tick = async () => {
    time += 5000;
    await enhancer.update();
  };
  try {
    await enhancer.update();
    await tick();
    await tick();
    await tick();
    assert.equal(state.enhancement.active, "rtx");
    state.paused = true;
    await tick();
    state.paused = false;
    await tick();
    await tick();
    await tick();
    assert.equal(state.enhancement.active, "rtx");
    await tick();
    await tick();
    assert.equal(state.enhancement.active, "generic");
    for (let i = 0; i < 5; i++) await tick();
    assert.equal(state.enhancement.active, "off");
    assert.match(state.enhancement.message, /掉帧/);
  } finally {
    enhancer.close();
    Date.now = now;
  }
});
test("super resolution enables one backend, bypasses HDR and falls back when RTX rejects", async () => {
  const state = {
    status: "ready",
    paused: true,
    preferences: videoPreferences({ superResolution: "auto" }),
  };
  let hdr = false;
  const commands = [];
  const raw = async (command) => {
    commands.push(command);
    if (command[0] === "get_property") {
      if (command[1] === "video-params")
        return { w: 640, h: 360, gamma: hdr ? "pq" : "bt.1886" };
      if (command[1] === "osd-dimensions") return { w: 1920, h: 1080 };
      if (command[1] === "vo-passes")
        return { fresh: [{ desc: "feature map 1" }] };
    }
    if (command[0] === "vf" && command[1] === "append")
      throw new Error("driver rejected");
    return null;
  };
  const enhancer = new VideoEnhancer(
    state,
    () => undefined,
    raw,
    () => {},
    true,
  );
  try {
    await enhancer.update();
    await enhancer.update();
    assert.equal(state.enhancement.active, "generic");
    assert.ok(
      commands.some(
        (c) =>
          c[0] === "set_property" &&
          c[1] === "glsl-shaders" &&
          c[2].length === 1,
      ),
    );
    hdr = true;
    await enhancer.update();
    assert.equal(state.enhancement.active, "off");
    assert.match(state.enhancement.message, /HDR/);
    state.preferences.superResolution = "off";
    await enhancer.update();
    assert.equal(state.enhancement.active, "off");
  } finally {
    enhancer.close();
  }
});
