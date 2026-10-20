import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "win32" || process.arch !== "x64")
  throw new Error("Video runtime currently requires Windows x64");
const lock = JSON.parse(
  await fs.readFile(path.join(root, "scripts/video-runtime.json"), "utf8"),
);
const runtime = path.join(root, "artifacts/video-runtime");
const downloads = path.join(root, "artifacts/video-downloads");
await fs.mkdir(runtime, { recursive: true });
await fs.mkdir(downloads, { recursive: true });
const shader = await fs.readFile(
  path.join(root, "scripts/video-shaders", lock.shader.file),
);
if (createHash("sha256").update(shader).digest("hex") !== lock.shader.sha256)
  throw new Error("Checksum mismatch: " + lock.shader.file);
await fs.mkdir(path.join(runtime, "shaders"), { recursive: true });
await fs.writeFile(path.join(runtime, "shaders", lock.shader.file), shader);
const sevenZip = path.join(root, "node_modules/7zip-bin/win/x64/7za.exe");
function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} exited with ${result.status}`);
}
async function download(spec, archive) {
  // Resolve the release redirect once. Reusing it avoids GitHub API rate limits
  // for range requests and keeps every byte on the upstream release CDN.
  let url = spec.url;
  if (!url) {
    const releaseUrl = `https://github.com/shinchiro/mpv-winbuild-cmake/releases/download/${lock.release}/${spec.file}`;
    const redirect = spawnSync(
      "curl.exe",
      [
        "--head",
        "--silent",
        "--show-error",
        "--retry",
        "3",
        "--max-time",
        "30",
        releaseUrl,
      ],
      { encoding: "utf8", windowsHide: true },
    );
    const location = redirect.stdout
      ?.match(/^location:\s*(.+)$/im)?.[1]
      ?.trim();
    if (
      redirect.status !== 0 ||
      !location?.startsWith("https://release-assets.githubusercontent.com/")
    )
      throw new Error(`Unable to resolve upstream download: ${spec.file}`);
    url = location;
  }
  const chunkDirectory = path.join(downloads, spec.file + ".parts");
  await fs.mkdir(chunkDirectory, { recursive: true });
  const chunkSize = 1024 * 1024;
  const count = Math.ceil(spec.size / chunkSize);
  let next = 0;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (next < count) {
        const index = next++;
        const start = index * chunkSize;
        const end = Math.min(spec.size - 1, start + chunkSize - 1);
        const file = path.join(chunkDirectory, String(index));
        if ((await fs.stat(file).catch(() => null))?.size === end - start + 1)
          continue;
        await new Promise((resolve, reject) => {
          const child = spawn(
            "curl.exe",
            [
              "--fail",
              "--silent",
              "--show-error",
              "--location",
              "--retry",
              "3",
              "--retry-all-errors",
              "--connect-timeout",
              "20",
              "--max-time",
              "180",
              "--range",
              `${start}-${end}`,
              "--output",
              file,
              url + `${url.includes("?") ? "&" : "?"}kaleid-part=${index}`,
            ],
            { windowsHide: true, stdio: "inherit" },
          );
          child.once("error", reject);
          child.once("exit", (code) =>
            code === 0
              ? resolve()
              : reject(new Error(`Download chunk ${index} failed (${code})`)),
          );
        });
        if ((await fs.stat(file)).size !== end - start + 1)
          throw new Error(`Invalid download chunk ${index}`);
      }
    }),
  );
  const chunks = await Promise.all(
    Array.from({ length: count }, (_, index) =>
      fs.readFile(path.join(chunkDirectory, String(index))),
    ),
  );
  await fs.writeFile(archive, Buffer.concat(chunks));
}
for (const name of ["mpv", "ffprobe"]) {
  const spec = lock[name];
  const destination = path.join(runtime, name);
  const marker = path.join(destination, ".archive-sha256");
  const expectedBinary = path.join(
    destination,
    name === "mpv" ? "mpv.exe" : "ffprobe.exe",
  );
  if (
    (await fs.readFile(marker, "utf8").catch(() => "")) === spec.sha256 &&
    (await fs.access(expectedBinary).then(
      () => true,
      () => false,
    ))
  )
    continue;
  const archive = path.join(downloads, spec.file);
  let bytes = await fs.readFile(archive).catch(() => null);
  if (
    !bytes ||
    createHash("sha256").update(bytes).digest("hex") !== spec.sha256
  ) {
    console.log(`Downloading ${spec.file}`);
    await download(spec, archive);
    bytes = await fs.readFile(archive);
    if (createHash("sha256").update(bytes).digest("hex") !== spec.sha256)
      throw new Error(`Checksum mismatch: ${spec.file}`);
    await fs.writeFile(archive, bytes);
  }
  // Keep distribution licenses and build information alongside the executables.
  await fs.mkdir(destination, { recursive: true });
  if (name === "ffprobe") {
    run("tar.exe", [
      "-xzf",
      archive,
      "-C",
      destination,
      "--strip-components=1",
    ]);
  } else run(sevenZip, ["x", "-y", `-o${destination}`, archive]);
  await fs.writeFile(marker, spec.sha256);
}
run("dotnet", [
  "publish",
  "native/video-host/VideoHost.csproj",
  "-c",
  "Release",
  "-o",
  path.join(runtime, "host"),
  "--nologo",
]);
const hostDeps = JSON.parse(
  await fs.readFile(
    path.join(
      root,
      "native/video-host/bin/Release/net10.0-windows/win-x64/VideoHost.deps.json",
    ),
    "utf8",
  ),
);
for (const name of [
  "Microsoft.NETCore.App.Runtime.win-x64",
  "Microsoft.WindowsDesktop.App.Runtime.win-x64",
]) {
  const dependency = Object.keys(hostDeps.libraries).find((key) =>
    key.startsWith(`runtimepack.${name}/`),
  );
  if (!dependency) throw new Error(`Missing runtime version: ${name}`);
  const version = dependency.split("/")[1];
  const nuget =
    process.env.NUGET_PACKAGES || path.join(os.homedir(), ".nuget/packages");
  const directory = path.join(nuget, name.toLowerCase(), version);
  // The desktop pack shares the .NET license; retain every notice it includes.
  for (const file of await fs.readdir(directory)) {
    if (/^(LICENSE|THIRD-PARTY-NOTICES).*\.txt$/i.test(file))
      await fs.copyFile(
        path.join(directory, file),
        path.join(runtime, "host", `${name}-${file}`),
      );
  }
}
await fs.copyFile(
  path.join(root, "scripts/video-runtime.json"),
  path.join(runtime, "runtime-lock.json"),
);
await fs.cp(
  path.join(root, "scripts/video-licenses"),
  path.join(runtime, "licenses"),
  { recursive: true },
);
console.log("Video runtime ready:", runtime);
