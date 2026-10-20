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
  "src",
  "scripts/generate-icon.mjs",
  "scripts/package-source.mjs",
  "build/kaleid-icon.png",
  "vendor",
  "docs/music-port-status.md",
  "docs/ui-refinements.md",
  "docs/wall-engine.md",
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
await fs.writeFile(
  "artifacts/Kaleid-Source.zip",
  zipSync(files, { level: 6 }),
);
console.log(`Source archive created: ${Object.keys(files).length} files`);
