import fs from "node:fs/promises";
import path from "node:path";
import { zipSync } from "fflate";
const files = {};
async function collect(target) {
  const stat = await fs.stat(target);
  if (stat.isDirectory()) {
    for (const entry of await fs.readdir(target))
      await collect(path.join(target, entry));
  } else
    files[target.replaceAll("\\", "/")] = new Uint8Array(
      await fs.readFile(target),
    );
}
for (const name of [
  ".gitattributes",
  "src",
  "native/video-host/Program.cs",
  "native/video-host/VideoHost.csproj",
  "scripts/prepare-video.mjs",
  "scripts/prepare-comic.mjs",
  "scripts/audit-comic-sources.mjs",
  "scripts/audit-comic-sources-app.mjs",
  "scripts/audit-novel-sources-app.mjs",
  "scripts/check-online-novels-app.mjs",
  "scripts/check-reading-search-app.mjs",
  "scripts/check-novel-covers-app.mjs",
  "tests/unit/onlineNovels.test.ts",
  "tests/unit/readingSearch.test.ts",
  "scripts/merge-comic-source-report.mjs",
  "scripts/comic-sources-baseline.json",
  "scripts/comic-runtime.json",
  "scripts/video-runtime.json",
  "scripts/video-licenses",
  "scripts/video-shaders",
  "scripts/test-video.mjs",
  "scripts/test-video-tools.mjs",
  "scripts/test-video-playback.mjs",
  "scripts/test-navigation.mjs",
  "scripts/test-navigation-playback.mjs",
  "scripts/benchmark-video.mjs",
  "scripts/generate-icon.mjs",
  "scripts/package-source.mjs",
  "build/kaleid-icon.png",
  "vendor",
  "docs/music-port-status.md",
  "docs/ui-refinements.md",
  "docs/wall-engine.md",
  "docs/video-playback.md",
  "docs/comic-reader.md",
  "docs/online-comics.md",
  "docs/online-novels.md",
  "docs/novel-source-verification.json",
  "docs/navigation-and-music-wall.md",
  "package.json",
  "package-lock.json",
  "electron.vite.config.ts",
  "tsconfig.json",
  "README.md",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
])
  await collect(name);
await fs.mkdir("artifacts", { recursive: true });
await fs.writeFile("artifacts/Kaleid-Source.zip", zipSync(files, { level: 6 }));
console.log(`Source archive created: ${Object.keys(files).length} files`);
