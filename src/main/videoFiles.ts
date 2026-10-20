import path from "node:path";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import ffmpegStatic from "ffmpeg-static";
import type { VideoMetadata } from "../shared/video";

export const VIDEO_INFO_VERSION = 1;
export function videoRuntimeDirectory() {
  return (
    process.env.MEDIA_BROWSER_VIDEO_RUNTIME ||
    path.join(process.resourcesPath, "video-runtime")
  );
}
export function videoBinary(name: "mpv" | "ffprobe" | "host") {
  return path.join(
    videoRuntimeDirectory(),
    name === "host" ? "host" : name === "mpv" ? "mpv" : "ffprobe",
    name === "host" ? "VideoHost.exe" : `${name}.exe`,
  );
}
export function runVideoTool(
  binary: string,
  args: string[],
  timeout: number,
  limit = 4 * 1024 * 1024,
) {
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(binary, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let errorText = "";
    let failure: Error | undefined;
    const timer = setTimeout(() => {
      failure = new Error("视频处理超时");
      child.kill();
    }, timeout);
    child.stdout.on("data", (part: Buffer) => {
      size += part.length;
      if (size > limit) {
        failure = new Error("视频处理结果超过限制");
        child.kill();
      } else chunks.push(part);
    });
    child.stderr.on("data", (part: Buffer) => {
      errorText = (errorText + part.toString()).slice(-2048);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (failure || code !== 0)
        reject(failure ?? new Error(errorText || "无法读取视频"));
      else resolve(Buffer.concat(chunks));
    });
  });
}
export async function probeVideo(file: string): Promise<VideoMetadata> {
  const result = JSON.parse(
    (
      await runVideoTool(
        videoBinary("ffprobe"),
        [
          "-v",
          "error",
          "-protocol_whitelist",
          "file,pipe",
          "-show_entries",
          "format=duration:stream=codec_type,codec_name,width,height,duration:stream_tags=language,title",
          "-of",
          "json",
          file,
        ],
        15000,
      )
    ).toString("utf8"),
  );
  const streams = result.streams ?? [];
  const video = streams.find((s: any) => s.codec_type === "video");
  if (!video) throw new Error("文件中没有可识别的视频轨道");
  const duration = Number(result.format?.duration ?? video.duration);
  return {
    videoInfoVersion: VIDEO_INFO_VERSION,
    duration: Number.isFinite(duration) ? duration : undefined,
    width: video.width,
    height: video.height,
    videoCodec: video.codec_name,
    audioCodec: streams.find((s: any) => s.codec_type === "audio")?.codec_name,
    videoStreams: streams.map((s: any) => ({
      type: s.codec_type,
      codec: s.codec_name,
      language: s.tags?.language,
      title: s.tags?.title,
    })),
  };
}
export async function videoPoster(file: string, duration = 0) {
  if (!ffmpegStatic) throw new Error("随包 FFmpeg 不支持当前系统架构");
  const binary = ffmpegStatic.replace(
    /app\.asar([\\/])/i,
    "app.asar.unpacked$1",
  );
  return runVideoTool(
    binary,
    [
      "-hide_banner",
      "-nostdin",
      "-loglevel",
      "error",
      "-ss",
      String(Math.min(1, duration > 0 ? duration / 4 : 0)),
      "-protocol_whitelist",
      "file,pipe",
      "-i",
      file,
      "-map",
      "0:v:0",
      "-frames:v",
      "1",
      "-an",
      "-sn",
      "-vf",
      "scale=640:-2",
      "-f",
      "image2pipe",
      "-vcodec",
      "mjpeg",
      "pipe:1",
    ],
    20000,
  );
}
export async function matchingSubtitles(
  file: string,
  allowed: (file: string) => Promise<boolean>,
) {
  const base = path.basename(file, path.extname(file)).toLowerCase();
  const directory = path.dirname(file);
  const names = await fs.readdir(directory);
  const result: string[] = [];
  for (const name of names.sort()) {
    const ext = path.extname(name).toLowerCase();
    if (![".srt", ".ass", ".ssa", ".vtt"].includes(ext)) continue;
    const stem = name.slice(0, -ext.length).toLowerCase();
    if (
      stem !== base &&
      !stem.startsWith(`${base}.`) &&
      !stem.startsWith(`${base}_`)
    )
      continue;
    const candidate = path.join(directory, name);
    if (await allowed(candidate)) result.push(candidate);
  }
  return result;
}
