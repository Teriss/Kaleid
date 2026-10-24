import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron } from "playwright";
const directory = await fs.mkdtemp(
  path.join(os.tmpdir(), "kaleid-novel-audit-"),
);
const env = { ...process.env, MEDIA_BROWSER_TEST_DATA: directory };
delete env.ELECTRON_RUN_AS_NODE;
const application = await _electron.launch({
  executablePath:
    process.env.KALEID_TEST_EXECUTABLE ||
    path.resolve("node_modules/electron/dist/electron.exe"),
  args: process.env.KALEID_TEST_EXECUTABLE ? [] : ["."],
  env,
  timeout: 30000,
});
const report = {
  checkedAt: new Date().toISOString(),
  environment: "isolated Electron persistent sessions, guest",
  sources: [],
};
try {
  const page = await application.firstWindow();
  await page.waitForFunction(() => !!window.media?.onlineNovels);
  for (const id of ["lightnovelshelf", "bilinovel"]) {
    const result = await page.evaluate(async (id) => {
      const api = window.media.onlineNovels,
        result = { sourceId: id, stages: [] };
      let sample;
      for (const [stage, run] of [
        ["discover", () => api.discover(id, "latest", 1)],
        ["search", () => api.search(id, "败北", 1)],
      ]) {
        try {
          const list = await run();
          result.stages.push({
            stage,
            status: list.novels.length ? "passed" : "empty",
            count: list.novels.length,
          });
          sample ||= list.novels[0];
        } catch (error) {
          result.stages.push({
            stage,
            status: "blocked",
            error: String(error),
          });
        }
      }
      if (sample) {
        try {
          const details = await api.details(sample, true);
          result.stages.push({
            stage: "details/catalog",
            status: details.chapters.length ? "passed" : "empty",
            chapterCount: details.chapters.length,
          });
          if (details.chapters.length) {
            const reader = await api.reader({
              ...sample,
              chapterId: details.chapters[0].id,
            });
            const response = await fetch(
              `media://novel/chapter/${reader.item.id.replace("novel-online:", "")}`,
            );
            result.stages.push({
              stage: "chapter/assets",
              status: response.ok ? "passed" : "failed",
              epubBytes: (await response.arrayBuffer()).byteLength,
              requiredFont: reader.item.novelRequiredFont,
            });
          }
        } catch (error) {
          result.stages.push({
            stage: "details/catalog/chapter",
            status: "blocked",
            error: String(error),
          });
        }
      }
      result.stages.push({
        stage: "account/paid-export",
        status: "not_tested",
        reason: "No account supplied; no billable requests made",
      });
      return result;
    }, id);
    report.sources.push(result);
    console.log(JSON.stringify(result));
  }
  const file = path.resolve("artifacts/novel-source-audit/report.json");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(report, null, 2) + "\n");
  console.log(file);
} finally {
  await application.close();
}
