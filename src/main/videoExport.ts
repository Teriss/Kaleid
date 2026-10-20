import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import ffmpegStatic from "ffmpeg-static";
import { runVideoTool, videoBinary } from "./videoFiles";
import type { VideoExportJob, VideoExportRequest } from "../shared/video";

export const ffmpegBinary = () => {
  if (!ffmpegStatic) throw new Error("当前系统缺少随包 FFmpeg");
  return ffmpegStatic.replace(/app\.asar([\\/])/i, "app.asar.unpacked$1");
};
export interface ExportSource {
  file: string;
  title: string;
  duration: number;
  video: number;
  audio?: number;
  hdr: boolean;
  size: number;
  modified: number;
}
export async function inspectExportSource(
  file: string,
  title: string,
  audioIndex?: number,
): Promise<ExportSource> {
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error("源视频不可用");
  const data = JSON.parse(
    (
      await runVideoTool(
        videoBinary("ffprobe"),
        [
          "-v",
          "error",
          "-protocol_whitelist",
          "file,pipe",
          "-show_streams",
          "-show_format",
          "-of",
          "json",
          file,
        ],
        15000,
      )
    ).toString("utf8"),
  );
  const streams: any[] = data.streams ?? [];
  const video = streams.find(
    (s) => s.codec_type === "video" && !s.disposition?.attached_pic,
  );
  const duration = Number(data.format?.duration ?? video?.duration);
  if (!video || !Number.isFinite(duration) || duration <= 0)
    throw new Error("无法确定视频时长，不能截取");
  const audio = streams.find(
    (s) => s.codec_type === "audio" && s.index === audioIndex,
  );
  if (audioIndex !== undefined && !audio)
    throw new Error("选中的音轨已失效，请重新选择");
  return {
    file,
    title,
    duration,
    video: video.index,
    audio: audio?.index,
    hdr: ["smpte2084", "arib-std-b67"].includes(video.color_transfer),
    size: stat.size,
    modified: stat.mtimeMs,
  };
}
export function validateExport(input: VideoExportRequest, duration: number) {
  if (
    !input ||
    ![input.start, input.end].every(
      (n) => typeof n === "number" && Number.isFinite(n),
    ) ||
    input.start < 0 ||
    input.end <= input.start ||
    input.end > duration + 0.001 ||
    !["mp4", "gif"].includes(input.format) ||
    typeof input.audio !== "boolean" ||
    ![320, 480, 640].includes(input.gifWidth) ||
    ![10, 15, 24].includes(input.gifFps)
  )
    throw new Error("截取范围或导出设置无效");
}
function toneMapFilters(source: ExportSource) {
  return source.hdr
    ? [
        "zscale=t=linear:npl=100",
        "format=gbrpf32le",
        "zscale=p=bt709",
        "tonemap=tonemap=mobius:desat=0",
        "zscale=t=bt709:m=bt709:r=tv",
        "format=yuv420p",
      ]
    : [];
}
function gifFilters(source: ExportSource, input: VideoExportRequest) {
  return [
    ...toneMapFilters(source),
    `fps=${input.gifFps}`,
    `scale=w='min(${input.gifWidth},iw)':h='max(1,round(ow/dar))':flags=lanczos`,
    "setsar=1",
  ];
}
function paletteArguments(
  source: ExportSource,
  input: VideoExportRequest,
  palette: string,
) {
  return [
    "-hide_banner",
    "-nostdin",
    "-loglevel",
    "error",
    "-y",
    "-ss",
    String(input.start),
    "-t",
    String(input.end - input.start),
    "-protocol_whitelist",
    "file,pipe",
    "-i",
    source.file,
    "-map",
    `0:${source.video}`,
    "-an",
    "-sn",
    "-dn",
    "-vf",
    [...gifFilters(source, input), "palettegen=stats_mode=diff"].join(","),
    "-frames:v",
    "1",
    "-update",
    "1",
    "-f",
    "image2",
    "-progress",
    "pipe:1",
    "-stats_period",
    "0.25",
    palette,
  ];
}
export function exportArguments(
  source: ExportSource,
  input: VideoExportRequest,
  temporary: string,
  palette?: string,
) {
  validateExport(input, source.duration);
  const filters = toneMapFilters(source);
  const args = [
    "-hide_banner",
    "-nostdin",
    "-loglevel",
    "error",
    "-y",
    "-ss",
    String(input.start),
    "-t",
    String(input.end - input.start),
    "-protocol_whitelist",
    "file,pipe",
    "-i",
    source.file,
    "-t",
    String(Math.min(input.end, source.duration) - input.start),
    "-map",
    `0:${source.video}`,
    "-sn",
    "-dn",
    "-map_metadata",
    "-1",
  ];
  if (input.format === "mp4") {
    if (input.audio && source.audio !== undefined)
      args.push("-map", `0:${source.audio}`, "-c:a", "aac", "-b:a", "192k");
    else args.push("-an");
    filters.push("pad=ceil(iw/2)*2:ceil(ih/2)*2");
    args.push(
      "-vf",
      filters.join(","),
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "23",
      "-pix_fmt",
      "yuv420p",
      "-fps_mode",
      "passthrough",
      "-movflags",
      "+faststart",
      "-f",
      "mp4",
    );
    if (source.hdr)
      args.push(
        "-color_primaries",
        "bt709",
        "-color_trc",
        "bt709",
        "-colorspace",
        "bt709",
      );
  } else {
    if (!palette) throw new Error("GIF 缺少调色板");
    args.splice(args.indexOf("-i") + 2, 0, "-i", palette);
    args.push(
      "-an",
      "-filter_complex_threads",
      "1",
      "-filter_complex",
      `[0:${source.video}]${gifFilters(source, input).join(",")}[x];[x][1:v:0]paletteuse=dither=sierra2_4a[v]`,
      "-map",
      "[v]",
      "-loop",
      "0",
      "-f",
      "gif",
    );
    // Only map the filtered video, not the unfiltered input as well.
    const map = args.indexOf("-map");
    args.splice(map, 2);
  }
  args.push("-progress", "pipe:1", "-stats_period", "0.25", temporary);
  return args;
}
interface Task {
  job: VideoExportJob;
  source: ExportSource;
  input: VideoExportRequest;
  temporary: string;
  palette?: string;
  destinationVersion: string;
  process?: ChildProcess;
  committing?: boolean;
}
const version = async (file: string) => {
  const stat = await fs.stat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  return stat
    ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`
    : "absent";
};
export class VideoExports {
  private tasks: Task[] = [];
  private running = false;
  private stopping = false;
  private saving: Promise<unknown> = Promise.resolve();
  private drain?: Promise<void>;
  private lastPublish = 0;
  private ready: Promise<void>;
  constructor(
    private manifest: string,
    private changed: (jobs: VideoExportJob[]) => void,
  ) {
    this.ready = this.recover();
    void this.ready.catch(console.warn);
  }
  list() {
    return this.tasks.map((t) => ({ ...t.job }));
  }
  hasActive() {
    return this.tasks.some((t) => ["queued", "running"].includes(t.job.status));
  }
  private publish(force = true) {
    if (force || Date.now() - this.lastPublish > 250) {
      this.lastPublish = Date.now();
      this.changed(this.list());
    }
  }
  private async recover() {
    let files: unknown = [];
    try {
      files = JSON.parse(await fs.readFile(this.manifest, "utf8"));
    } catch {
      /* Missing or interrupted manifest. */
    }
    if (Array.isArray(files))
      for (const file of files) {
        if (
          typeof file === "string" &&
          /^\.kaleid-export-[\da-f-]{36}\.part\.(mp4|gif|png)$/.test(
            path.basename(file),
          )
        )
          await fs.rm(file, { force: true }).catch(console.warn);
      }
    await fs.mkdir(path.dirname(this.manifest), { recursive: true });
    await fs.writeFile(this.manifest, "[]");
  }
  private persist() {
    this.saving = this.saving
      .catch(() => {})
      .then(async () => {
        const files = this.tasks
          .filter(
            (t) => ["queued", "running"].includes(t.job.status) || t.process,
          )
          .flatMap((t) =>
            t.palette ? [t.temporary, t.palette] : [t.temporary],
          );
        const staged = this.manifest + ".tmp";
        await fs.writeFile(staged, JSON.stringify(files));
        await fs.rename(staged, this.manifest);
      });
    return this.saving;
  }
  async add(source: ExportSource, input: VideoExportRequest, output: string) {
    await this.ready;
    if (this.stopping) throw new Error("应用正在退出");
    validateExport(input, source.duration);
    const canonicalSource = await fs.realpath(source.file);
    const canonicalParent = await fs.realpath(path.dirname(output));
    output = path.join(canonicalParent, path.basename(output));
    if (
      this.tasks.some(
        (t) =>
          ["queued", "running"].includes(t.job.status) &&
          t.job.output.toLowerCase() === output.toLowerCase(),
      )
    )
      throw new Error("已有任务正在写入此文件，请选择其他文件名");
    const target = await fs.realpath(output).catch(() => output);
    if (canonicalSource.toLowerCase() === target.toLowerCase())
      throw new Error("不能覆盖源视频");
    const sourceStat = await fs.stat(canonicalSource);
    const targetStat = await fs.stat(output).catch(() => null);
    if (
      targetStat &&
      targetStat.ino === sourceStat.ino &&
      targetStat.dev === sourceStat.dev
    )
      throw new Error("不能覆盖源视频");
    if (targetStat && !targetStat.isFile()) throw new Error("目标不是普通文件");
    const id = randomUUID();
    const task: Task = {
      source,
      input: { ...input },
      temporary: path.join(
        canonicalParent,
        `.kaleid-export-${id}.part.${input.format}`,
      ),
      palette:
        input.format === "gif"
          ? path.join(canonicalParent, `.kaleid-export-${id}.part.png`)
          : undefined,
      destinationVersion: await version(output),
      job: {
        id,
        title: source.title,
        format: input.format,
        status: "queued",
        progress: 0,
        output,
      },
    };
    this.tasks.push(task);
    try {
      await this.persist();
    } catch (error) {
      task.job.status = "failed";
      task.job.error = "无法保存导出任务清单，请检查磁盘空间和目录权限";
      this.publish();
      throw error;
    }
    this.publish();
    if (!this.running) {
      this.drain = this.pump();
      void this.drain.catch(console.warn);
    }
    return { ...task.job };
  }
  async cancel(id: string) {
    const task = this.tasks.find((t) => t.job.id === id);
    if (
      !task ||
      task.committing ||
      !["queued", "running"].includes(task.job.status)
    )
      return;
    task.job.status = "canceled";
    task.process?.kill();
    this.publish();
    if (!task.process) {
      await fs.rm(task.temporary, { force: true });
      if (task.palette) await fs.rm(task.palette, { force: true });
      await this.persist();
    }
  }
  async stop() {
    this.stopping = true;
    await this.ready.catch(console.warn);
    await Promise.allSettled(this.tasks.map((t) => this.cancel(t.job.id)));
    await this.drain?.catch(console.warn);
    await this.saving.catch(console.warn);
  }
  private async pump() {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const task = this.tasks.find((t) => t.job.status === "queued");
        if (!task || this.stopping) break;
        try {
          const stat = await fs.stat(task.source.file);
          if (
            stat.size !== task.source.size ||
            stat.mtimeMs !== task.source.modified
          )
            throw new Error("源文件已被替换，请重新截取");
          if (
            (task.job.status as VideoExportJob["status"]) === "canceled" ||
            this.stopping
          )
            continue;
          task.job.status = "running";
          this.publish();
          const encode = (args: string[], base: number, fraction: number) =>
            new Promise<void>((resolve, reject) => {
              const child = spawn(ffmpegBinary(), args, {
                windowsHide: true,
                stdio: ["ignore", "pipe", "pipe"],
              });
              task.process = child;
              let buffer = "",
                errors = "";
              child.stdout!.setEncoding("utf8");
              child.stdout!.on("data", (part) => {
                buffer += part;
                let end: number;
                while ((end = buffer.indexOf("\n")) >= 0) {
                  const line = buffer.slice(0, end).trim();
                  buffer = buffer.slice(end + 1);
                  if (line.startsWith("out_time_us=")) {
                    task.job.progress = Math.max(
                      task.job.progress,
                      Math.min(
                        0.99,
                        base +
                          (fraction * Number(line.slice(12))) /
                            1e6 /
                            (task.input.end - task.input.start),
                      ) || 0,
                    );
                    this.publish(false);
                  }
                }
                buffer = buffer.slice(-8192);
              });
              child.stderr!.on("data", (part) => {
                errors = (errors + part.toString()).slice(-4096);
              });
              child.once("error", reject);
              child.once("close", (code) =>
                code === 0
                  ? resolve()
                  : reject(new Error(errors || `编码器退出（${code}）`)),
              );
            });
          // Two streaming passes avoid buffering the full clip while palettegen waits for EOF.
          if (task.palette) {
            await encode(
              paletteArguments(task.source, task.input, task.palette),
              0,
              0.15,
            );
            if (
              (task.job.status as VideoExportJob["status"]) === "canceled" ||
              this.stopping
            )
              continue;
            task.job.progress = 0.15;
            this.publish();
          }
          await encode(
            exportArguments(
              task.source,
              task.input,
              task.temporary,
              task.palette,
            ),
            task.palette ? 0.15 : 0,
            task.palette ? 0.85 : 1,
          );
          if (
            (task.job.status as VideoExportJob["status"]) === "canceled" ||
            this.stopping
          )
            continue;
          if ((await version(task.job.output)) !== task.destinationVersion)
            throw new Error("目标文件在导出期间发生变化，请选择新的保存位置");
          if (!(await fs.stat(task.temporary)).size)
            throw new Error("导出文件为空");
          if (
            (task.job.status as VideoExportJob["status"]) === "canceled" ||
            this.stopping
          )
            continue;
          task.committing = true;
          await fs.rename(task.temporary, task.job.output);
          task.job.status = "completed";
          task.job.progress = 1;
        } catch (error) {
          if (task.job.status !== "canceled") {
            task.job.status = "failed";
            task.job.error = String(error).slice(0, 1200);
          }
        } finally {
          task.process = undefined;
          await fs.rm(task.temporary, { force: true }).catch(console.warn);
          if (task.palette)
            await fs.rm(task.palette, { force: true }).catch(console.warn);
          await this.persist().catch(console.warn);
          this.publish();
        }
      }
    } finally {
      this.running = false;
    }
  }
}
