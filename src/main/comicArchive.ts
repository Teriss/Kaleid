import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import yauzl from "yauzl";
import sharp from "sharp";
import { EXTENSIONS, isWithin, naturalSort } from "./core";
import { parseComicInfo, type ComicInfo } from "../shared/comic";

const MAX_ENTRY = 128 * 1024 * 1024;
const MAX_TOTAL = 4 * 1024 * 1024 * 1024;
const DISK_LIMIT = 2 * 1024 * 1024 * 1024;
interface Entry {
  name: string;
  size: number;
  zip?: yauzl.Entry;
}
interface Manifest {
  key: string;
  directory: boolean;
  entries: Entry[];
  pages: Entry[];
  info: ComicInfo;
  zip?: yauzl.ZipFile;
  solid: boolean;
  metrics: Map<string, { width?: number; height?: number }>;
  controller: AbortController;
}
export function comicEntryName(name: string) {
  const normalized = name.replaceAll("\\", "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.includes(":") ||
    /[\x00-\x1f]/.test(normalized) ||
    normalized
      .split("/")
      .some(
        (part) =>
          part === ".." ||
          part === "." ||
          /[. ]$/.test(part) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  )
    throw new Error("漫画压缩包包含不安全路径");
  return normalized;
}
export function isComicImage(name: string) {
  return (
    !name
      .replaceAll("\\", "/")
      .split("/")
      .some((p) => p.startsWith(".") || p === "__MACOSX") &&
    EXTENSIONS.image.has(path.extname(name).toLowerCase())
  );
}
function run7z(
  executable: string,
  args: string[],
  signal: AbortSignal,
  max = 8 * 1024 * 1024,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      windowsHide: true,
      signal,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let size = 0,
      errorText = "",
      timedOut = false;
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) child.kill();
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (errorText.length < 2000) errorText += String(chunk);
    });
    child.on("error", reject);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 55000);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (signal.aborted) reject(new Error("已取消漫画加载"));
      else if (timedOut)
        reject(new Error("漫画解压超时，请尝试拆分较大的压缩包"));
      else if (size > max) reject(new Error("漫画内容超过大小限制"));
      else if (code !== 0)
        reject(
          new Error(
            /password|encrypted/i.test(
              errorText + Buffer.concat(chunks).toString("utf8").slice(-2000),
            )
              ? "暂不支持加密漫画压缩包"
              : "漫画压缩包损坏或格式不受支持",
          ),
        );
      else resolve(Buffer.concat(chunks));
    });
  });
}
export class ComicArchives {
  private manifests = new Map<string, Promise<Manifest>>();
  private pending = new Map<string, Promise<string>>();
  private solidJobs = new Map<string, Promise<void>>();
  private touched = new Map<string, number>();
  private lastTrim = 0;
  constructor(
    private cacheRoot: string,
    private sevenZip: string,
  ) {}
  invalidate(file: string) {
    const old = this.manifests.get(file);
    this.manifests.delete(file);
    if (old)
      void old
        .then((m) => {
          m.controller.abort();
          m.zip?.close();
        })
        .catch(() => {});
  }
  release(file: string) {
    this.invalidate(file);
  }
  async clear() {
    for (const file of [...this.manifests.keys()]) this.invalidate(file);
    await Promise.allSettled([
      ...this.pending.values(),
      ...this.solidJobs.values(),
    ]);
    const root = path.resolve(this.cacheRoot);
    await fs.rm(root, { recursive: true, force: true });
    this.touched.clear();
  }
  async manifest(file: string): Promise<Manifest> {
    const stat = await fs.stat(file);
    const key = createHash("sha256")
      .update(`${file}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`)
      .digest("hex")
      .slice(0, 32);
    const old = this.manifests.get(file);
    if (old) {
      const manifest = await old;
      if (manifest.key === key && !manifest.controller.signal.aborted) {
        this.touched.set(key, Date.now());
        return manifest;
      }
      this.invalidate(file);
    }
    if (this.manifests.size >= 8)
      this.invalidate(this.manifests.keys().next().value!);
    const promise = this.open(file, key, stat.isDirectory());
    this.manifests.set(file, promise);
    this.touched.set(key, Date.now());
    try {
      return await promise;
    } catch (e) {
      if (this.manifests.get(file) === promise) this.manifests.delete(file);
      throw e;
    }
  }
  private async open(
    file: string,
    key: string,
    directory: boolean,
  ): Promise<Manifest> {
    const manifest: Manifest = {
      key,
      directory,
      entries: [],
      pages: [],
      info: {},
      solid: false,
      metrics: new Map(),
      controller: new AbortController(),
    };
    try {
      if (directory) {
        manifest.entries = (await fs.readdir(file, { withFileTypes: true }))
          .filter((e) => e.isFile())
          .map((e) => ({ name: e.name, size: 0 }));
      } else if ([".zip", ".cbz"].includes(path.extname(file).toLowerCase())) {
        await new Promise<void>((resolve, reject) => {
          yauzl.open(
            file,
            { lazyEntries: true, autoClose: false },
            (error, zip) => {
              if (error || !zip)
                return reject(new Error("漫画压缩包损坏，无法读取 ZIP 目录"));
              manifest.zip = zip;
              let total = 0;
              const names = new Set<string>();
              zip.on("error", reject);
              zip.on("entry", (entry: yauzl.Entry) => {
                try {
                  comicEntryName(entry.fileName);
                  if (entry.isEncrypted())
                    throw new Error("暂不支持加密漫画压缩包");
                  if (
                    ((entry.externalFileAttributes >>> 16) & 0xf000) ===
                    0xa000
                  )
                    throw new Error("漫画压缩包包含链接");
                  total += entry.uncompressedSize;
                  const name = comicEntryName(entry.fileName).toLowerCase();
                  if (names.has(name)) throw new Error("漫画压缩包含重名条目");
                  names.add(name);
                  if (
                    entry.uncompressedSize > MAX_ENTRY ||
                    total > MAX_TOTAL ||
                    manifest.entries.length >= 20000
                  )
                    throw new Error("漫画压缩包内容超过限制");
                  manifest.entries.push({
                    name: entry.fileName,
                    size: entry.uncompressedSize,
                    zip: entry,
                  });
                  zip.readEntry();
                } catch (e) {
                  zip.close();
                  reject(e);
                }
              });
              zip.on("end", resolve);
              zip.readEntry();
            },
          );
        });
      } else {
        await fs.access(this.sevenZip).catch(() => {
          throw new Error(
            "漫画解压组件缺失，请重新安装应用或运行 npm run comic:prepare",
          );
        });
        const listing = (
          await run7z(
            this.sevenZip,
            ["l", "-slt", "-sccUTF-8", "-p-", "--", file],
            manifest.controller.signal,
          )
        ).toString("utf8");
        if (/^Encrypted = \+/m.test(listing))
          throw new Error("暂不支持加密漫画压缩包");
        if (
          /^Volumes = ([2-9]|\d{2,})/m.test(listing) ||
          /^Multivolume = \+/m.test(listing)
        )
          throw new Error("暂不支持分卷漫画压缩包");
        manifest.solid = /^Solid = \+/m.test(listing);
        const body = listing.split(/\r?\n----------\r?\n/)[1];
        if (body === undefined) throw new Error("无法读取漫画压缩包目录");
        for (const block of body.split(/\r?\n\r?\n/)) {
          const name = block.match(/^Path = (.*)$/m)?.[1]?.trimEnd();
          if (!name) continue;
          comicEntryName(name);
          if (
            /^(Symbolic Link|Hard Link) = \S/m.test(block) ||
            /^Attributes = .*l[rwx-]{9}/m.test(block)
          )
            throw new Error("漫画压缩包包含链接");
          if (/^Folder = \+/m.test(block) || /^Attributes = D/m.test(block))
            continue;
          manifest.entries.push({
            name,
            size: Number(block.match(/^Size = (\d+)/m)?.[1] ?? 0),
          });
        }
        this.validate(manifest.entries);
      }
      manifest.pages = manifest.entries
        .filter((e) => isComicImage(e.name))
        .sort((a, b) => naturalSort(a.name, b.name));
      const info = manifest.entries.find((e) =>
        /(^|[\\/])ComicInfo\.xml$/i.test(e.name),
      );
      if (info && info.size <= 1024 * 1024) {
        try {
          manifest.info = parseComicInfo(
            (await this.bytes(file, manifest, info)).toString("utf8"),
          );
        } catch {
          /* Invalid metadata must not prevent reading. */
        }
      }
      return manifest;
    } catch (e) {
      manifest.zip?.close();
      manifest.controller.abort();
      throw e;
    }
  }
  private validate(entries: Entry[]) {
    if (
      new Set(entries.map((e) => comicEntryName(e.name).toLowerCase())).size !==
      entries.length
    )
      throw new Error("漫画压缩包含重名条目");
    if (
      entries.length > 20000 ||
      entries.some(
        (e) =>
          !Number.isSafeInteger(e.size) || e.size < 0 || e.size > MAX_ENTRY,
      ) ||
      entries.reduce((sum, e) => sum + e.size, 0) > MAX_TOTAL
    )
      throw new Error("漫画压缩包内容超过限制（单页 128 MB，总计 4 GB）");
  }
  private async bytes(
    file: string,
    manifest: Manifest,
    entry: Entry,
  ): Promise<Buffer> {
    if (manifest.directory) {
      const resolved = await fs.realpath(path.join(file, entry.name));
      if (!isWithin(await fs.realpath(file), resolved))
        throw new Error("漫画页面越界");
      const stat = await fs.stat(resolved);
      if (stat.size > MAX_ENTRY) throw new Error("漫画页面过大");
      return fs.readFile(resolved);
    }
    if (manifest.zip && entry.zip)
      return new Promise((resolve, reject) => {
        manifest.zip!.openReadStream(entry.zip!, (err, stream) => {
          if (err || !stream)
            return reject(err ?? new Error("无法读取漫画页面"));
          const chunks: Buffer[] = [];
          let size = 0;
          stream.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_ENTRY) stream.destroy(new Error("漫画页面过大"));
            else chunks.push(chunk);
          });
          stream.on("error", reject);
          stream.on("end", () => resolve(Buffer.concat(chunks)));
        });
      });
    return run7z(
      this.sevenZip,
      ["x", "-so", "-spd", "-y", "-p-", "--", file, entry.name],
      manifest.controller.signal,
      MAX_ENTRY,
    );
  }
  private async solid(file: string, manifest: Manifest, root: string) {
    let job = this.solidJobs.get(manifest.key);
    if (!job) {
      job = (async () => {
        if (
          await fs.access(path.join(root, ".complete")).then(
            () => true,
            () => false,
          )
        )
          return;
        // Only validated, link-free paths are extracted into an application-owned directory.
        const target = path.resolve(root, "solid");
        if (!isWithin(path.resolve(this.cacheRoot), target))
          throw new Error("无效缓存路径");
        await fs.rm(target, { recursive: true, force: true });
        await fs.mkdir(target, { recursive: true });
        await run7z(
          this.sevenZip,
          ["x", "-y", "-p-", `-o${target}`, "--", file],
          manifest.controller.signal,
        );
        await fs.writeFile(path.join(root, ".complete"), "ok");
      })();
      this.solidJobs.set(manifest.key, job);
      void job
        .finally(() => this.solidJobs.delete(manifest.key))
        .catch(() => {});
    }
    await job;
  }
  async page(file: string, index: number): Promise<string> {
    const manifest = await this.manifest(file),
      entry = manifest.pages[index];
    if (!entry) throw new Error("漫画页码不存在");
    if (manifest.directory) {
      const target = await fs.realpath(path.join(file, entry.name));
      if (!isWithin(await fs.realpath(file), target))
        throw new Error("漫画页面越界");
      return target;
    }
    const root = path.resolve(this.cacheRoot, manifest.key);
    const target = manifest.solid
      ? path.join(root, "solid", comicEntryName(entry.name))
      : path.join(root, `${index}${path.extname(entry.name)}`);
    let job = this.pending.get(target);
    if (!job) {
      job = (async () => {
        await fs.mkdir(root, { recursive: true });
        if (manifest.solid) await this.solid(file, manifest, root);
        else if (
          !(await fs.access(target).then(
            () => true,
            () => false,
          ))
        ) {
          const bytes = await this.bytes(file, manifest, entry);
          if (manifest.controller.signal.aborted)
            throw new Error("已取消漫画加载");
          await fs.writeFile(target + ".tmp", bytes);
          await fs.rename(target + ".tmp", target);
        }
        const real = await fs.realpath(target);
        if (!isWithin(await fs.realpath(root), real))
          throw new Error("漫画缓存页面越界");
        void this.trim(manifest.key).catch(() => {});
        return real;
      })();
      this.pending.set(target, job);
      void job.finally(() => this.pending.delete(target)).catch(() => {});
    }
    return job;
  }
  async dimensions(file: string, index: number) {
    const manifest = await this.manifest(file),
      entry = manifest.pages[index];
    if (!entry) return {};
    const old = manifest.metrics.get(entry.name);
    if (old) return old;
    try {
      const info = await sharp(await this.page(file, index), {
        limitInputPixels: 100_000_000,
      }).metadata();
      const metric = { width: info.width, height: info.height };
      manifest.metrics.set(entry.name, metric);
      return metric;
    } catch {
      return {};
    }
  }
  private async trim(current: string) {
    if (Date.now() - this.lastTrim < 30000) return;
    this.lastTrim = Date.now();
    const roots = await fs
      .readdir(this.cacheRoot, { withFileTypes: true })
      .catch(() => []);
    const records: { name: string; size: number; time: number }[] = [];
    const sizeOf = async (dir: string): Promise<number> => {
      let size = 0;
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const f = path.join(dir, entry.name);
        if (entry.isDirectory()) size += await sizeOf(f);
        else if (entry.isFile()) size += (await fs.stat(f)).size;
      }
      return size;
    };
    for (const dir of roots)
      if (dir.isDirectory() && /^[a-f0-9]{32}$/.test(dir.name)) {
        const f = path.join(this.cacheRoot, dir.name);
        records.push({
          name: dir.name,
          size: await sizeOf(f),
          time: this.touched.get(dir.name) ?? (await fs.stat(f)).mtimeMs,
        });
      }
    let total = records.reduce((s, r) => s + r.size, 0);
    for (const r of records.sort((a, b) => a.time - b.time)) {
      if (total <= DISK_LIMIT) break;
      const dir = path.resolve(this.cacheRoot, r.name);
      if (
        r.name === current ||
        this.solidJobs.has(r.name) ||
        [...this.pending.keys()].some((f) => isWithin(dir, f))
      )
        continue;
      if (!isWithin(path.resolve(this.cacheRoot), dir)) continue;
      await fs.rm(dir, { recursive: true, force: true });
      total -= r.size;
    }
  }
}
