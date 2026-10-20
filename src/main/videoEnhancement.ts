import fs from "node:fs/promises";
import path from "node:path";
import { videoRuntimeDirectory } from "./videoFiles";
import type {
  VideoBounds,
  VideoEnhancement,
  VideoState,
} from "../shared/video";

type Raw = (command: unknown[]) => Promise<any>;
export class VideoEnhancer {
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private disposed = false;
  private lastKey = "";
  private selected = "off";
  private rejected = new Set<string>();
  private sampled?: { time: number; frames: number; drops: number };
  private badWindows = 0;
  private settled = Date.now();
  private reason = "";
  private shader = path.join(
    videoRuntimeDirectory(),
    "shaders",
    "FSRCNNX_x2_8-0-4-1.glsl",
  );
  constructor(
    private state: VideoState,
    private bounds: () => VideoBounds | undefined,
    private raw: Raw,
    private publish: () => void,
    private nvidia: boolean,
  ) {
    state.enhancement = {
      generic: false,
      rtx: nvidia,
      active: "off",
      message: "超分已关闭",
    };
    this.timer = setInterval(() => void this.update(), 1000);
  }
  reset() {
    this.sampled = undefined;
    this.badWindows = 0;
    this.settled = Date.now();
  }
  close() {
    this.disposed = true;
    clearInterval(this.timer);
  }
  log(text: string) {
    if (
      this.state.enhancement?.active === "generic" &&
      /(?:shader|glsl|spirv).*(?:error|fail)|(?:error|fail).*(?:shader|glsl|spirv)/i.test(
        text,
      )
    ) {
      this.rejected.add("generic");
      this.reason = "通用超分编译失败，已恢复普通播放";
      this.lastKey = "";
    }
  }
  async update() {
    if (this.busy || this.disposed || this.state.status !== "ready") return;
    this.busy = true;
    try {
      const mode = this.state.preferences.superResolution;
      if (mode !== this.selected) {
        this.selected = mode;
        this.rejected.clear();
        this.reason = "";
        this.lastKey = "";
        this.reset();
      }
      const available = await fs.access(this.shader).then(
        () => true,
        () => false,
      );
      const params = await this.raw(["get_property", "video-params"]).catch(
        () => null,
      );
      const osd = await this.raw(["get_property", "osd-dimensions"]).catch(
        () => null,
      );
      const hdr = ["pq", "hlg", "smpte2084", "arib-std-b67"].includes(
        params?.gamma ?? "",
      );
      const width = params?.dw || params?.w || 0,
        height = params?.dh || params?.h || 0;
      const b = this.bounds();
      const viewWidth = osd
        ? osd.w - (osd.ml || 0) - (osd.mr || 0)
        : b?.width || 0;
      const viewHeight = osd
        ? osd.h - (osd.mt || 0) - (osd.mb || 0)
        : b?.height || 0;
      const ratio =
        width && height ? Math.min(viewWidth / width, viewHeight / height) : 0;
      let target: VideoEnhancement["active"] = "off";
      let message = "超分已关闭";
      if (mode !== "off") {
        if (hdr) message = "HDR 视频暂不启用超分";
        else if (ratio <= 1 || this.state.preferences.fit === "original")
          message = "当前画面无需放大";
        else {
          target =
            mode === "auto"
              ? this.nvidia && !this.rejected.has("rtx")
                ? "rtx"
                : "generic"
              : mode;
          if (target === "rtx" && !this.nvidia) {
            target = "off";
            message = "当前活动 GPU 不支持 NVIDIA RTX 接口，请选择通用超分";
          } else if (target === "generic" && !available) {
            target = "off";
            message = "缺少随包超分着色器，请重新安装播放组件";
          } else if (this.rejected.has(target)) {
            target = "off";
            message = this.reason || "当前超分方案不可用，已恢复普通播放";
          } else if (target === "generic" && ratio <= 1.3) {
            target = "off";
            message = "通用超分在画面放大超过 1.3 倍时启用";
          } else
            message =
              target === "rtx"
                ? "RTX 接口已启用；实际增强取决于 NVIDIA 驱动的 RTX 视频设置"
                : "通用超分 · FSRCNNX 2×";
        }
      }
      const scale = Math.min(2, Math.max(1.01, ratio)).toFixed(2);
      const key = `${target}:${target === "rtx" ? scale : ""}`;
      if (key !== this.lastKey) {
        await this.raw(["vf", "remove", "@kaleid-sr"]).catch(() => {});
        await this.raw(["set_property", "glsl-shaders", []]);
        if (this.disposed) return;
        try {
          if (target === "rtx")
            await this.raw([
              "vf",
              "append",
              `@kaleid-sr:d3d11vpp=scale=${scale}:scaling-mode=nvidia`,
            ]);
          if (target === "generic")
            await this.raw(["set_property", "glsl-shaders", [this.shader]]);
        } catch {
          this.rejected.add(target);
          this.reason = `${target === "rtx" ? "RTX 接口初始化" : "通用超分加载"}失败，已回退`;
          target = "off";
          message = this.reason;
          this.lastKey = "";
          await this.raw(["vf", "remove", "@kaleid-sr"]).catch(() => {});
          await this.raw(["set_property", "glsl-shaders", []]).catch(() => {});
        }
        if (!this.rejected.has(target)) this.lastKey = key;
        this.reset();
      }
      if (this.disposed) return;
      let actual = target;
      if (target === "generic") {
        const passes = await this.raw(["get_property", "vo-passes"]).catch(
          () => null,
        );
        if (
          !/feature map 1|sub-pixel convolution|aggregation/.test(
            JSON.stringify(passes),
          )
        ) {
          actual = "off";
          message = "通用超分已加载，等待兼容画面进入 GPU 处理";
        }
      }
      const next = {
        generic: available,
        rtx: this.nvidia,
        active: actual,
        message:
          this.reason && mode === "auto"
            ? `${message}；${this.reason}`
            : message,
      };
      if (JSON.stringify(next) !== JSON.stringify(this.state.enhancement)) {
        this.state.enhancement = next;
        this.publish();
      }
      await this.sample(actual);
    } catch {
      /* A closed session or a transient reconfiguration is retried on the next tick. */
    } finally {
      this.busy = false;
    }
  }
  private async sample(target: string) {
    if (
      this.state.preferences.superResolution !== "auto" ||
      target === "off" ||
      this.state.paused ||
      Date.now() - this.settled < 5000
    ) {
      this.sampled = undefined;
      this.badWindows = 0;
      return;
    }
    const seeking = await this.raw(["get_property", "seeking"]).catch(
      () => true,
    );
    if (seeking) {
      this.reset();
      return;
    }
    const frames = Number(
      await this.raw(["get_property", "estimated-frame-number"]),
    );
    const drops = Number(await this.raw(["get_property", "frame-drop-count"]));
    const now = Date.now(),
      previous = this.sampled;
    if (!Number.isFinite(frames) || !Number.isFinite(drops)) return;
    if (!previous) {
      this.sampled = { time: now, frames, drops };
      return;
    }
    if (now - previous.time < 5000) return;
    const delta = frames - previous.frames;
    this.sampled = { time: now, frames, drops };
    if (delta <= 0 || drops < previous.drops) {
      this.badWindows = 0;
      return;
    }
    this.badWindows =
      (drops - previous.drops) / delta > 0.05 ? this.badWindows + 1 : 0;
    if (this.badWindows >= 3) {
      this.rejected.add(target);
      this.reason = "持续掉帧，已自动降低超分负载";
      this.lastKey = "";
      this.reset();
    }
  }
}
