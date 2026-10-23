import fs from "node:fs/promises";

const artifact = "artifacts/comic-source-audit/electron-live-report.json";
const documentation = "docs/comic-source-verification.json";
const report = JSON.parse(await fs.readFile(artifact, "utf8"));
const classify = (error = "") => {
  if (/\b401\b|登录|log(?:ged)? ?in|auth|cookie|需要登录/i.test(error))
    return "account-required";
  if (/\b403\b|Cloudflare|challenge|captcha|访问验证/i.test(error))
    return "site-denied-or-challenge";
  if (/unexpected token:\s*['"]</i.test(error)) return "site-html-or-challenge";
  if (/\b5\d\d\b/.test(error)) return "upstream-error";
  if (/\b400\b|cannot read property|no pages/i.test(error))
    return "source-or-contract-failure";
  if (/fetch|TIMEOUT|network|ERR_|timeout/i.test(error))
    return "network-or-timeout";
  return "unclassified-failure";
};

for (const source of report.sources) {
  if (source.status !== "public-first-chapter-passed")
    source.status = classify(source.error);
}
await fs.writeFile(artifact, JSON.stringify(report, null, 2) + "\n");

const details = JSON.parse(await fs.readFile(documentation, "utf8"));
const byFile = new Map(report.sources.map((source) => [source.file, source]));
for (const source of details.sources) {
  const electron = byFile.get(source.file);
  if (electron) source.electron = electron;
}
const statusCounts = {};
for (const source of report.sources)
  statusCounts[source.status] = (statusCounts[source.status] || 0) + 1;
details.electronAudit = {
  checkedAt: report.checkedAt,
  transport: report.transport,
  total: report.sources.length,
  installed: report.sources.filter((source) => source.install === "passed").length,
  statusCounts,
  publicFirstChapterImages: report.sources.filter(
    (source) => source.image === "passed",
  ).length,
};

const mirrorPath =
  "artifacts/comic-source-audit/baozi.js.domains-webmota.com.electron-live-report.json";
const mirrorReport = JSON.parse(await fs.readFile(mirrorPath, "utf8"));
const baozi = details.sources.find((source) => source.file === "baozi.js");
if (baozi) {
  const probe = mirrorReport.sources[0];
  baozi.electronMirrorProbes = [
    {
      domain: "webmota.com",
      browse: probe.browse,
      comicCount: probe.comicCount,
      details: probe.details,
      failedStage: probe.failedStage,
      status: probe.status,
      error: probe.error,
    },
  ];
}
await fs.writeFile(documentation, JSON.stringify(details, null, 2) + "\n");
console.log(JSON.stringify(details.electronAudit));
