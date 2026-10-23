// Packaged-app regression for restoring a nested library folder after restart.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import ffmpeg from "ffmpeg-static";

const { _electron: electron } = await import(
  process.env.KALEID_PLAYWRIGHT_MODULE || "playwright"
);
const temporary = await fs.mkdtemp(
  path.join(os.tmpdir(), "kaleid-navigation-"),
);
const root = path.join(temporary, "中文媒体库");
const nested = path.join(root, "季节", "第一季");
const profile = path.join(temporary, "profile");
await fs.mkdir(nested, { recursive: true });
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
    "color=c=blue:s=320x180:d=1",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    path.join(nested, "测试.mp4"),
  ],
  { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 },
);

const env = {
  ...process.env,
  MEDIA_BROWSER_TEST_DATA: path.join(temporary, "data"),
};
delete env.ELECTRON_RUN_AS_NODE;
const executable =
  process.env.KALEID_VIDEO_EXE ||
  path.resolve("release/win-unpacked/Kaleid.exe");
const launch = () =>
  electron.launch({
    executablePath: executable,
    args: [`--user-data-dir=${profile}`],
    env,
    timeout: 60000,
  });

let application;
try {
  application = await launch();
  let page = await application.firstWindow();
  await page.waitForFunction(() => Boolean(window.media && window.video));
  await application.evaluate(({ dialog }, selectedRoot) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [selectedRoot],
    });
  }, root);
  const library = await page.evaluate(async () => {
    const existing = (await window.media.libraries()).find(
      (item) => item.type === "video",
    );
    return (
      existing ??
      (await window.media.createLibrary({
        name: "导航验收",
        type: "video",
        roots: await window.media.chooseFolders(),
      }))
    );
  });
  await page.evaluate((id) => window.media.scan(id), library.id);
  const scanDeadline = Date.now() + 30000;
  let total = 0;
  do {
    total = await page.evaluate(
      async (id) =>
        (await window.media.query({ libraryId: id, type: "video" })).total,
      library.id,
    );
    if (total === 1) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < scanDeadline);
  assert.equal(total, 1, "nested video was indexed");
  const restoredFolder = path.join(library.roots[0], "季节", "第一季");
  await page.evaluate(
    ({ libraryId, folder }) =>
      localStorage.setItem(
        "last-browse",
        JSON.stringify({ view: "library", libraryId, type: "video", folder }),
      ),
    { libraryId: library.id, folder: restoredFolder },
  );
  await application.close();
  application = await launch();
  page = await application.firstWindow();
  page.on("pageerror", (error) =>
    console.log("SECOND INSTANCE ERROR", error.message),
  );
  page.on("console", (message) => {
    if (message.type() === "error")
      console.log("SECOND INSTANCE CONSOLE", message.text());
  });
  await page.waitForFunction(() => Boolean(window.media && window.video));
  await page.locator(".chrome-edge-top").hover();
  await page.locator(".auto-chrome.chrome-shown").first().waitFor();
  await page
    .locator('.folder-breadcrumbs[aria-label="文件夹路径"]')
    .waitFor({ timeout: 30000 });

  const crumbs = async () =>
    (await page.locator(".folder-breadcrumbs button").allTextContents())
      .map((value) => value.trim())
      .filter(Boolean);
  assert.deepEqual(await crumbs(), ["中文媒体库", "季节", "第一季"]);
  assert.equal(
    await page.getByRole("button", { name: "前进", exact: true }).count(),
    0,
    "the forward action is removed",
  );
  const back = page.getByRole("button", {
    name: "返回上级文件夹",
    exact: true,
  });

  await page.dispatchEvent("body", "mouseup", { button: 3 });
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll(".folder-breadcrumbs button")].at(-1)
        ?.textContent === "季节",
  );
  await page.keyboard.press("Escape");
  await page.waitForFunction(
    () => !document.querySelector(".folder-breadcrumbs"),
  );
  const atLibraryRoot = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("last-browse") || "null"),
  );
  await page.keyboard.press("Alt+ArrowLeft");
  await page.keyboard.press("Alt+ArrowRight");
  await page.dispatchEvent("body", "mouseup", { button: 4 });
  await page.waitForTimeout(80);
  assert.deepEqual(
    await page.evaluate(() => JSON.parse(localStorage.getItem("last-browse") || "null")),
    atLibraryRoot,
    "root back and all forward inputs leave the route unchanged",
  );
  assert.equal(await back.count(), 0, "the library root has no parent arrow");
  assert.equal(
    await page.getByRole("button", { name: "后退", exact: true }).count(),
    0,
    "the chronological toolbar action is removed",
  );
  console.log("PASS mouse, Escape and Alt-left hierarchical back; forward inputs are inert");
} finally {
  if (application) await application.close().catch(() => {});
  await fs.rm(temporary, { recursive: true, force: true });
}
