import { useEffect, useState } from "react";
import type {
  VideoCommand,
  VideoExportRequest,
  VideoState,
} from "../../shared/video";
import { clipTime, parseClipTime } from "../../shared/videoClip";
import { report } from "./store";

export default function VideoClipPanel({
  state,
  command,
}: {
  state: VideoState;
  command(command: VideoCommand): Promise<unknown>;
}) {
  const [start, setStart] = useState(() =>
    clipTime(Math.min(state.position, Math.max(0, state.duration - 0.001))),
  );
  const [end, setEnd] = useState(() =>
    clipTime(Math.min(state.position + 10, state.duration)),
  );
  const [format, setFormat] = useState<"mp4" | "gif">("mp4");
  const [audio, setAudio] = useState(true);
  const [width, setWidth] = useState<VideoExportRequest["gifWidth"]>(480);
  const [fps, setFps] = useState<VideoExportRequest["gifFps"]>(15);
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const a = parseClipTime(start),
    b = parseClipTime(end);
  const valid =
    Number.isFinite(a) &&
    Number.isFinite(b) &&
    a >= 0 &&
    b > a &&
    b <= state.duration + 0.0005;
  useEffect(() => {
    const id = state.sessionId;
    return () => {
      void window.video
        .command(id, { type: "preview", value: null })
        .catch(() => {});
    };
  }, [state.sessionId]);
  const stop = () => {
    setPreview(false);
    void command({ type: "preview", value: null });
  };
  const change = (setter: (value: string) => void, value: string) => {
    if (preview) stop();
    setter(value);
  };
  async function submit() {
    if (!valid || saving) return;
    stop();
    setSaving(true);
    try {
      const job = await window.video.export({
        sessionId: state.sessionId,
        mediaId: state.mediaId,
        start: a,
        end: Math.min(b, state.duration),
        format,
        audio,
        gifWidth: width,
        gifFps: fps,
      });
      if (job) window.dispatchEvent(new Event("video:exports-open"));
    } catch (error) {
      report(error);
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="video-clip">
      <div className="video-clip-fields">
        <p className="video-help">
          选择一段时间导出为新文件。时间格式：时:分:秒.毫秒。
        </p>
        <label>
          开始时间
          <input
            aria-label="片段开始时间"
            value={start}
            onChange={(e) => change(setStart, e.target.value)}
            spellCheck={false}
          />
        </label>
        <button
          className="button secondary"
          onClick={() => change(setStart, clipTime(state.position))}
        >
          将当前位置设为起点
        </button>
        <label>
          结束时间
          <input
            aria-label="片段结束时间"
            value={end}
            onChange={(e) => change(setEnd, e.target.value)}
            spellCheck={false}
          />
        </label>
        <button
          className="button secondary"
          onClick={() => change(setEnd, clipTime(state.position))}
        >
          将当前位置设为终点
        </button>
        <label>
          拖动起点
          <input
            aria-label="拖动片段起点"
            type="range"
            min={0}
            max={state.duration}
            step={0.001}
            value={Number.isFinite(a) ? a : 0}
            onChange={(e) =>
              change(
                setStart,
                clipTime(
                  Math.min(
                    Number(e.target.value),
                    Number.isFinite(b)
                      ? Math.max(0, b - 0.001)
                      : state.duration,
                  ),
                ),
              )
            }
          />
        </label>
        <label>
          拖动终点
          <input
            aria-label="拖动片段终点"
            type="range"
            min={0}
            max={state.duration}
            step={0.001}
            value={Number.isFinite(b) ? b : state.duration}
            onChange={(e) =>
              change(
                setEnd,
                clipTime(
                  Math.max(
                    Number(e.target.value),
                    Number.isFinite(a)
                      ? Math.min(state.duration, a + 0.001)
                      : 0,
                  ),
                ),
              )
            }
          />
        </label>
        <small className="video-help" role="status">
          {valid
            ? `片段时长：${(b - a).toFixed(3)} 秒`
            : "请输入有效范围，结束时间需大于开始时间且不超出视频时长。"}
        </small>
        <button
          className="button secondary"
          disabled={!valid}
          onClick={() => {
            if (preview) stop();
            else {
              setPreview(true);
              void command({
                type: "preview",
                value: { start: a, end: Math.min(b, state.duration) },
              });
            }
          }}
        >
          {preview ? "停止片段预览" : "循环预览片段"}
        </button>
        <label>
          导出格式
          <select
            aria-label="导出格式"
            value={format}
            onChange={(e) => setFormat(e.target.value as typeof format)}
          >
            <option value="mp4">MP4 视频 · H.264 / AAC · SDR</option>
            <option value="gif">GIF 动图 · 无声音</option>
          </select>
        </label>
        {format === "mp4" ? (
          <label className="video-check">
            <input
              type="checkbox"
              checked={audio}
              onChange={(e) => setAudio(e.target.checked)}
            />
            包含当前选中音轨
          </label>
        ) : (
          <>
            <label>
              GIF 宽度
              <select
                aria-label="GIF 宽度"
                value={width}
                onChange={(e) =>
                  setWidth(Number(e.target.value) as typeof width)
                }
              >
                {[320, 480, 640].map((n) => (
                  <option key={n} value={n}>
                    {n} 像素
                  </option>
                ))}
              </select>
            </label>
            <label>
              GIF 帧率
              <select
                aria-label="GIF 帧率"
                value={fps}
                onChange={(e) => setFps(Number(e.target.value) as typeof fps)}
              >
                {[10, 15, 24].map((n) => (
                  <option key={n} value={n}>
                    {n} fps
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        <p className="video-help">
          按原始速度导出；字幕、超分、播放比例和旋转设置不写入文件。HDR
          视频转换为 SDR。GIF 保持比例，不放大源视频。
        </p>
      </div>
      <button
        className="button"
        disabled={!valid || saving}
        onClick={() => void submit()}
      >
        {saving ? "正在准备…" : "选择保存位置并导出…"}
      </button>
    </div>
  );
}
