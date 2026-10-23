// Guest-only live source verification. No account or credential is read.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron } from "playwright";
const temporary = await fs.mkdtemp(
  path.join(os.tmpdir(), "kaleid-novel-cover-"),
);
const env = { ...process.env, MEDIA_BROWSER_TEST_DATA: temporary };
delete env.ELECTRON_RUN_AS_NODE;
let application;
try {
  application = await _electron.launch({
    executablePath: path.resolve("node_modules/electron/dist/electron.exe"),
    args: ["."],
    env,
    timeout: 30000,
  });
  const page = await application.firstWindow();
  await page.waitForFunction(() => !!window.media?.onlineNovels);
  const result = await page.evaluate(async () => {
    const list = await window.media.onlineNovels.discover(
      "lightnovelshelf",
      "latest",
      1,
    );
    const sample = list.novels.find((novel) => novel.cover);
    if (!sample) throw new Error("公开列表未提供封面");
    const response = await fetch(sample.cover);
    if (!response.ok) throw new Error(await response.text());
    const img = new Image();
    img.src = sample.cover;
    await img.decode();
    if (!img.naturalWidth) throw new Error("封面未解码");
    return {
      status: response.status,
      type: response.headers.get("content-type"),
      width: img.naturalWidth,
      height: img.naturalHeight,
    };
  });
  await page.locator(".chrome-edge-right").hover();
  await page
    .getByRole("button", { name: "浏览小说", exact: true })
    .first()
    .click({ force: true });
  await page
    .locator(".novel-source-pills")
    .getByRole("button", { name: "轻书架", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll(".novel-results-layout .cover img").length >
        0 &&
      [...document.querySelectorAll(".novel-results-layout .cover img")].every(
        (img) => img.complete && img.naturalWidth > 0,
      ),
  );
  await fs.mkdir("artifacts/novel-verification", { recursive: true });
  await page.screenshot({
    animations: "disabled",
    path: "artifacts/novel-verification/live-covers.png",
  });
  const report = {
    checkedAt: new Date().toISOString(),
    environment: "isolated Electron guest session",
    source: "lightnovelshelf",
    ...result,
    decoded: true,
  };
  await fs.writeFile(
    "artifacts/novel-verification/live-covers.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
} finally {
  if (application) await application.close();
}
