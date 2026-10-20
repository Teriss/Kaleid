// Node 24 strips the TypeScript annotations; no additional test runner required.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EXTENSIONS } from "../src/main/core.ts";
import { videoPreferences, resumeVideo } from "../src/shared/video.ts";
import { matchingSubtitles } from "../src/main/videoFiles.ts";

test("video extensions include movies, legacy media and camera recordings", () => {
  for (const ext of [
    "mkv",
    "mp4",
    "webm",
    "mov",
    "avi",
    "rmvb",
    "ts",
    "m2ts",
    "3gp",
    "ogv",
  ])
    assert.equal(
      EXTENSIONS.video.has(
        path.extname(`电影.${ext.toUpperCase()}`).toLowerCase(),
      ),
      true,
    );
  for (const ext of [".mp3", ".srt", ".jpg", ".exe"])
    assert.equal(EXTENSIONS.video.has(ext), false);
});
test("video preferences default safely and clamp finite numeric values", () => {
  assert.deepEqual(videoPreferences(), videoPreferences(null));
  const result = videoPreferences({
    volume: 400,
    speed: -1,
    subtitleSize: NaN,
    subtitleDelay: Infinity,
    rotation: 45,
    fit: "invalid",
    autoNext: "true",
  });
  assert.equal(result.volume, 100);
  assert.equal(result.speed, 0.25);
  assert.equal(result.subtitleSize, 40);
  assert.equal(result.subtitleDelay, 0);
  assert.equal(result.rotation, 0);
  assert.equal(result.fit, "contain");
  assert.equal(result.autoNext, false);
});
test("resume preserves unfinished progress and restarts completed videos", () => {
  assert.equal(resumeVideo(30, 120), 30);
  assert.equal(resumeVideo(999, 120), 119);
  assert.equal(resumeVideo(30, 120, true), 0);
  assert.equal(resumeVideo(NaN, 120), 0);
  assert.equal(resumeVideo(-4, 120), 0);
  assert.equal(resumeVideo(30, 0), 30);
});
test("subtitle discovery matches Unicode names and language suffixes within authorization", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "kaleid-video-subs-"),
  );
  try {
    const names = [
      "第 01 集.mkv",
      "第 01 集.srt",
      "第 01 集.zh-CN.ASS",
      "第 01 集_en.vtt",
      "第 01 集.bad.ssa",
      "第 01 集2.srt",
      "第 02 集.srt",
      "第 01 集.exe",
    ];
    await Promise.all(
      names.map((name) => fs.writeFile(path.join(directory, name), "")),
    );
    const matches = await matchingSubtitles(
      path.join(directory, names[0]),
      async (file) => !file.endsWith("bad.ssa"),
    );
    assert.deepEqual(
      matches.map((file) => path.basename(file)).sort(),
      ["第 01 集.srt", "第 01 集.zh-CN.ASS", "第 01 集_en.vtt"].sort(),
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
