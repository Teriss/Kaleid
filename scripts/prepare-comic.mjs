import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lock = JSON.parse(
  await fs.readFile(path.join(root, "scripts/comic-runtime.json"), "utf8"),
);
const target = path.join(root, "artifacts/comic-runtime");
const hash = (data) => createHash("sha256").update(data).digest("hex");
const valid = await Promise.all(
  Object.entries(lock.files).map(
    async ([name, digest]) =>
      hash(
        await fs.readFile(path.join(target, name)).catch(() => Buffer.alloc(0)),
      ) === digest,
  ),
);
if (valid.every(Boolean)) {
  await fs.writeFile(
    path.join(target, "runtime-lock.json"),
    JSON.stringify(lock, null, 2),
  );
  console.log("Comic runtime verified: 7-Zip " + lock.version);
  process.exit(0);
}
if (process.platform !== "win32" || process.arch !== "x64")
  throw new Error("Comic runtime currently requires Windows x64");
const downloads = path.join(root, "artifacts/comic-downloads");
await fs.mkdir(downloads, { recursive: true });
await fs.mkdir(target, { recursive: true });
const archive = path.join(downloads, lock.archive);
if (
  hash(await fs.readFile(archive).catch(() => Buffer.alloc(0))) !== lock.sha256
) {
  const result = spawnSync(
    "curl.exe",
    [
      "-fLsS",
      "--retry",
      "3",
      "--connect-timeout",
      "20",
      "--max-time",
      "180",
      "-o",
      archive,
      lock.url,
    ],
    { windowsHide: true, stdio: "inherit" },
  );
  if (result.error || result.status !== 0)
    throw result.error ?? new Error("Unable to download comic runtime");
}
if (hash(await fs.readFile(archive)) !== lock.sha256)
  throw new Error("Comic runtime archive checksum mismatch");
const result = spawnSync(
  path.join(root, "node_modules/7zip-bin/win/x64/7za.exe"),
  ["x", "-y", `-o${target}`, archive, ...Object.keys(lock.files)],
  { windowsHide: true, stdio: "inherit" },
);
if (result.error || result.status !== 0)
  throw result.error ?? new Error("Unable to prepare comic runtime");
for (const [name, digest] of Object.entries(lock.files))
  if (hash(await fs.readFile(path.join(target, name))) !== digest)
    throw new Error("Comic runtime checksum mismatch: " + name);
await fs.writeFile(
  path.join(target, "runtime-lock.json"),
  JSON.stringify(lock, null, 2),
);
console.log("Comic runtime verified: 7-Zip " + lock.version);
