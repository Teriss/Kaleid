import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft,
  Play,
  Pause,
  Volume2,
  VolumeX,
  SkipBack,
  SkipForward,
  Maximize,
  Minimize,
  ListVideo,
  Settings2,
  Captions,
  FolderOpen,
  X,
  RotateCw,
  Scissors,
  Download,
} from "lucide-react";
import type { MediaItem } from "../../shared/types";
import type {
  VideoCommand,
  VideoPreferences,
  VideoState,
  VideoTrack,
} from "../../shared/video";
import { report, useApp, usePlayback } from "./store";
import { useVideoChrome } from "./useVideoChrome";
import { useVideoOverlay } from "./useVideoOverlay";
import "./video.css";
import VideoClipPanel from "./VideoClipPanel";

function clock(seconds: number) {
  const n = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return n >= 3600
    ? `${Math.floor(n / 3600)}:${String(Math.floor(n / 60) % 60).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`
    : `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
}
function trackName(track: VideoTrack) {
  return [
    track.title || `轨道 ${track.id}`,
    track.lang,
    track.codec,
    track.external ? "外挂" : "",
  ]
    .filter(Boolean)
    .join(" · ");
}
export default function VideoPlayer({
  item,
  autoPlay,
  close,
  switchItem,
  sort,
}: {
  item: MediaItem;
  autoPlay: boolean;
  close(): void;
  switchItem(item: MediaItem): void;
  sort: "name" | "added" | "recent";
}) {
  const [entry, setEntry] = useState({ item, fromStart: false });
  const [state, setState] = useState<VideoState>();
  const [queue, setQueue] = useState<MediaItem[]>([]);
  const [panel, setPanel] = useState<
    "queue" | "subtitles" | "settings" | "clip" | null
  >(null);
  const [retry, setRetry] = useState(0);
  const [resumeNotice, setResumeNotice] = useState(false);
  const [dragPosition, setDragPosition] = useState<number>();
  const [edgeActive, setEdgeActive] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const surface = useVideoOverlay(root, close);
  const viewport = useRef<HTMLDivElement>(null);
  const session = useRef("");
  const reducedMotion = useApp((s) => s.settings.reducedMotion);
  const { chrome, activity } = useVideoChrome(
    root,
    state?.status !== "ready" ||
      state.paused ||
      !!panel ||
      resumeNotice ||
      edgeActive,
    `${entry.item.id}:${retry}:${autoPlay}`,
    reducedMotion,
    surface?.ownerDocument,
  );
  const latest = useRef({ state, queue, panel, entry, close, switchItem });
  latest.current = { state, queue, panel, entry, close, switchItem };
  const handledEnd = useRef("");
  useEffect(() => {
    if (entry.item.id !== item.id) setEntry({ item, fromStart: false });
  }, [item.id]);
  const command = useCallback((command: VideoCommand) => {
    if (!session.current) return Promise.resolve();
    return window.video.command(session.current, command).catch(report);
  }, []);
  const preferences = (value: Partial<VideoPreferences>) =>
    void command({ type: "preferences", value });
  function choose(target: MediaItem, fromStart = false) {
    setEntry({ item: target, fromStart });
    setPanel(null);
    setResumeNotice(false);
    setDragPosition(undefined);
    switchItem(target);
  }
  const chooseRef = useRef(choose);
  chooseRef.current = choose;
  const step = (direction: number, fromStart = false) => {
    const index = latest.current.queue.findIndex(
      (candidate) => candidate.id === latest.current.entry.item.id,
    );
    const target = latest.current.queue[index + direction];
    if (target) chooseRef.current(target, fromStart);
  };
  const stepRef = useRef(step);
  stepRef.current = step;
  useEffect(() => {
    let disposed = false;
    void window.video
      .queue(entry.item.id, sort)
      .then((items) => {
        if (!disposed) setQueue(items);
      })
      .catch(report);
    return () => {
      disposed = true;
    };
  }, [entry.item.folder, sort]);
  useEffect(() => {
    const id = crypto.randomUUID();
    session.current = id;
    handledEnd.current = "";
    setEdgeActive(false);
    setState(undefined);
    setResumeNotice(false);
    let noticeTimer: ReturnType<typeof setTimeout> | undefined;
    let wasResumed = false;
    const unsubscribe = window.video.onState((next) => {
      if (next.sessionId !== id || session.current !== id) return;
      setState(next);
      if (next.status === "ready" && !next.paused)
        usePlayback.setState({ playing: false });
      if (next.resumed && next.status === "ready" && !wasResumed) {
        wasResumed = true;
        setResumeNotice(true);
        noticeTimer = setTimeout(() => setResumeNotice(false), 8000);
      }
      if (next.status === "ended" && handledEnd.current !== id) {
        handledEnd.current = id;
        if (next.preferences.autoNext) stepRef.current(1, true);
      }
      if (next.status === "ready") handledEnd.current = "";
    });
    void window.video
      .open({
        mediaId: entry.item.id,
        sessionId: id,
        autoPlay,
        fromStart: entry.fromStart,
      })
      .then((initial) => {
        if (session.current === id)
          setState((previous) =>
            previous?.sessionId === id ? previous : initial,
          );
      })
      .catch((error) => {
        if (session.current === id) report(error);
      });
    return () => {
      unsubscribe();
      clearTimeout(noticeTimer);
      if (session.current === id) session.current = "";
      void window.video.close(id).catch(report);
    };
  }, [entry.item.id, retry, autoPlay]);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!session.current) return;
        const rect = element.getBoundingClientRect();
        const modal = document.querySelector(
          "dialog[open],.modal-backdrop,.context-menu",
        );
        void window.video
          .bounds(session.current, {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            visible:
              !modal &&
              !document.hidden &&
              latest.current.state?.status !== "error",
          })
          .catch(() => {});
      });
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    const mutations = new MutationObserver(update);
    mutations.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["open"],
    });
    const interval = setInterval(update, 500); // Display/DPI changes can occur without a DOM resize.
    window.addEventListener("resize", update);
    document.addEventListener("visibilitychange", update);
    update();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      mutations.disconnect();
      clearInterval(interval);
      window.removeEventListener("resize", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, [state?.status, retry, entry.item.id, surface]);
  useEffect(() => {
    const escape = () => {
      if (latest.current.panel) setPanel(null);
      else if (latest.current.state?.fullscreen)
        void command({ type: "fullscreen", value: false });
      else latest.current.close();
    };
    const fullscreen = () =>
      void command({
        type: "fullscreen",
        value: !latest.current.state?.fullscreen,
      });
    const unsubscribe = window.video.onInput(({ sessionId, action }) => {
      if (sessionId !== session.current) return;
      activity();
      if (action === "edge-enter") {
        setEdgeActive(true);
        return;
      }
      if (action === "edge-leave") {
        setEdgeActive(false);
        return;
      }
      if (action === "escape") escape();
      if (action === "fullscreen") fullscreen();
      if (action === "back" || action === "forward")
        window.dispatchEvent(
          new CustomEvent("video:navigate", { detail: action }),
        );
    });
    const key = (event: KeyboardEvent) => {
      if (document.querySelector("dialog[open],.modal-backdrop")) return;
      if (
        event.key !== "Escape" &&
        (event.target as HTMLElement)?.closest(
          "input,textarea,select,[contenteditable=true]",
        )
      )
        return;
      const current = latest.current.state;
      if (!current) return;
      let action: (() => void) | undefined;
      switch (event.key.toLowerCase()) {
        case " ":
          action = () =>
            void command({ type: "pause", value: !current.paused });
          break;
        case "arrowleft":
          action = () =>
            void command({
              type: "seek",
              value: event.shiftKey ? -30 : -5,
              relative: true,
            });
          break;
        case "arrowright":
          action = () =>
            void command({
              type: "seek",
              value: event.shiftKey ? 30 : 5,
              relative: true,
            });
          break;
        case "arrowup":
          action = () =>
            void command({
              type: "preferences",
              value: { volume: current.preferences.volume + 5 },
            });
          break;
        case "arrowdown":
          action = () =>
            void command({
              type: "preferences",
              value: { volume: current.preferences.volume - 5 },
            });
          break;
        case "m":
          action = () =>
            void command({
              type: "preferences",
              value: { muted: !current.preferences.muted },
            });
          break;
        case "f":
          action = fullscreen;
          break;
        case "escape":
          action = escape;
          break;
      }
      if (action) {
        event.preventDefault();
        event.stopImmediatePropagation();
        action();
      }
    };
    window.addEventListener("keydown", key, true);
    const controlsWindow = surface?.ownerDocument.defaultView;
    controlsWindow?.addEventListener("keydown", key, true);
    return () => {
      unsubscribe();
      window.removeEventListener("keydown", key, true);
      controlsWindow?.removeEventListener("keydown", key, true);
    };
  }, [command, activity, surface]);
  const index = queue.findIndex((target) => target.id === entry.item.id);
  const prefs = state?.preferences;
  const ready = state?.status === "ready" || state?.status === "ended";
  const togglePanel = (target: typeof panel) =>
    setPanel((current) => (current === target ? null : target));
  const selectedTrack = (kind: "audio" | "sub") =>
    state?.tracks.find((track) => track.type === kind && track.selected)?.id ??
    "no";
  const trackSelect = (kind: "audio" | "sub") => (
    <label>
      {kind === "audio" ? "音轨" : "字幕轨道"}
      <select
        aria-label={kind === "audio" ? "音轨" : "字幕轨道"}
        value={selectedTrack(kind)}
        onChange={(event) =>
          void command({
            type: "track",
            kind,
            id: event.target.value === "no" ? "no" : Number(event.target.value),
          })
        }
      >
        <option value="no">关闭</option>
        {state?.tracks
          .filter((track) => track.type === kind)
          .map((track) => (
            <option key={track.id} value={track.id}>
              {trackName(track)}
            </option>
          ))}
      </select>
    </label>
  );
  const player = (
    <div
      ref={root}
      className="viewer viewer-video video-player video-overlay-player"
      data-status={state?.status ?? "loading"}
      data-chrome={chrome}
      data-fullscreen={state?.fullscreen ?? false}
      data-reduced-motion={reducedMotion}
    >
      <header className="video-header" inert={chrome !== "visible"}>
        <button className="back-button" onClick={close}>
          <ArrowLeft size={18} />
          返回媒体库
        </button>
        <div className="video-heading">
          <strong title={entry.item.title}>{entry.item.title}</strong>
          <small>
            {[
              entry.item.ext.toUpperCase(),
              entry.item.videoCodec,
              entry.item.width && `${entry.item.width} × ${entry.item.height}`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </small>
        </div>
        <button
          title="导出任务"
          aria-label="导出任务"
          onClick={() => window.dispatchEvent(new Event("video:exports-open"))}
        >
          <Download size={18} />
        </button>
        <button
          title="在文件夹中显示"
          aria-label="在文件夹中显示"
          onClick={() => void window.media.reveal(entry.item.id).catch(report)}
        >
          <FolderOpen size={18} />
        </button>
      </header>
      <div className="video-body">
        <div className="video-viewport" ref={viewport}>
          {!ready && state?.status !== "error" && (
            <div className="video-message" role="status">
              <span className="video-loading" />
              正在读取视频…
            </div>
          )}
          {state?.error && (
            <div className="video-message" role="alert">
              <h2>
                {
                  {
                    offline: "视频文件不可用",
                    damaged: "无法读取视频文件",
                    decode: "视频解码失败",
                    engine: "播放器启动失败",
                  }[state.error.kind]
                }
              </h2>
              <p>{state.error.message}</p>
              <div>
                <button
                  className="button primary"
                  onClick={() => setRetry((n) => n + 1)}
                >
                  重新尝试
                </button>
                <button
                  className="button secondary"
                  onClick={async () => {
                    await command({
                      type: "preferences",
                      value: { hardwareDecoding: false },
                    });
                    setRetry((n) => n + 1);
                  }}
                >
                  使用软件解码重试
                </button>
                <button
                  className="button secondary"
                  onClick={() =>
                    void window.media.reveal(entry.item.id).catch(report)
                  }
                >
                  显示文件位置
                </button>
              </div>
            </div>
          )}
        </div>
        {panel && (
          <aside className="video-panel">
            <div className="video-panel-title">
              <strong>
                {panel === "queue"
                  ? `选集 · ${queue.length}`
                  : panel === "subtitles"
                    ? "字幕与音轨"
                    : panel === "clip"
                      ? "截取片段"
                      : "播放设置"}
              </strong>
              <button aria-label="关闭面板" onClick={() => setPanel(null)}>
                <X size={17} />
              </button>
            </div>
            {panel === "clip" && state && (
              <VideoClipPanel
                key={state.sessionId}
                state={state}
                command={command}
              />
            )}
            {panel === "queue" && (
              <>
                <label className="video-check">
                  <input
                    type="checkbox"
                    checked={prefs?.autoNext ?? false}
                    onChange={(e) =>
                      preferences({ autoNext: e.target.checked })
                    }
                  />
                  自动播放下一集
                </label>
                <small className="video-help">
                  当前目录 ·{" "}
                  {sort === "name"
                    ? "名称排序"
                    : sort === "added"
                      ? "添加时间排序"
                      : "最近打开排序"}
                </small>
                <div className="video-episodes">
                  {queue.map((target, index) => (
                    <button
                      key={target.id}
                      className={target.id === entry.item.id ? "active" : ""}
                      aria-current={
                        target.id === entry.item.id ? "true" : undefined
                      }
                      onClick={() => choose(target)}
                    >
                      <span>{String(index + 1).padStart(2, "0")}</span>
                      <strong>{target.title}</strong>
                      <small>{clock(target.duration ?? 0)}</small>
                    </button>
                  ))}
                </div>
              </>
            )}
            {panel === "subtitles" && prefs && (
              <>
                {trackSelect("audio")}
                {trackSelect("sub")}
                <button
                  className="button secondary"
                  disabled={!ready}
                  onClick={() =>
                    void window.video.subtitle(session.current).catch(report)
                  }
                >
                  加载外挂字幕…
                </button>
                <label className="video-check">
                  <input
                    type="checkbox"
                    checked={prefs.subtitles}
                    onChange={(e) =>
                      preferences({ subtitles: e.target.checked })
                    }
                  />
                  显示字幕
                </label>
                <label className="video-panel-section">
                  字幕字号
                  <input
                    aria-label="字幕字号"
                    type="range"
                    min="12"
                    max="100"
                    value={prefs.subtitleSize}
                    onChange={(e) =>
                      preferences({ subtitleSize: Number(e.target.value) })
                    }
                  />
                </label>
                <label>
                  字幕位置
                  <input
                    aria-label="字幕位置"
                    type="range"
                    min="0"
                    max="100"
                    value={prefs.subtitlePosition}
                    onChange={(e) =>
                      preferences({ subtitlePosition: Number(e.target.value) })
                    }
                  />
                </label>
                <label className="video-panel-section">
                  字幕延迟（秒）
                  <input
                    aria-label="字幕延迟"
                    type="number"
                    step="0.1"
                    min="-600"
                    max="600"
                    value={prefs.subtitleDelay}
                    onChange={(e) =>
                      preferences({ subtitleDelay: Number(e.target.value) })
                    }
                  />
                </label>
                <label>
                  声音延迟（秒）
                  <input
                    aria-label="声音延迟"
                    type="number"
                    step="0.1"
                    min="-60"
                    max="60"
                    value={prefs.audioDelay}
                    onChange={(e) =>
                      preferences({ audioDelay: Number(e.target.value) })
                    }
                  />
                </label>
                <small className="video-help">
                  保留 ASS 字幕原有排版与样式，字号和位置可能由字幕自身指定。
                </small>
              </>
            )}
            {panel === "settings" && prefs && (
              <>
                <label>
                  实时超分
                  <select
                    aria-label="实时超分"
                    value={prefs.superResolution}
                    onChange={(e) =>
                      preferences({
                        superResolution: e.target
                          .value as VideoPreferences["superResolution"],
                      })
                    }
                  >
                    <option value="off">关闭</option>
                    <option value="auto">自动</option>
                    <option value="generic">通用超分 · FSRCNNX</option>
                    <option value="rtx">NVIDIA RTX</option>
                  </select>
                </label>
                <small className="video-help" role="status">
                  {state?.enhancement?.message ?? "正在检测超分能力…"}
                  。仅影响观看，导出使用源画面。
                </small>
                <label className="video-panel-section">
                  画面适配
                  <select
                    aria-label="画面适配"
                    value={prefs.fit}
                    onChange={(e) =>
                      preferences({
                        fit: e.target.value as VideoPreferences["fit"],
                      })
                    }
                  >
                    <option value="contain">适应窗口</option>
                    <option value="cover">填充裁切</option>
                    <option value="original">原始大小</option>
                  </select>
                </label>
                <label>
                  画面比例
                  <select
                    aria-label="画面比例"
                    value={prefs.aspect}
                    onChange={(e) =>
                      preferences({
                        aspect: e.target.value as VideoPreferences["aspect"],
                      })
                    }
                  >
                    <option value="auto">原始比例</option>
                    <option value="16:9">16:9</option>
                    <option value="4:3">4:3</option>
                  </select>
                </label>
                <button
                  className="button secondary"
                  onClick={() =>
                    preferences({ rotation: (prefs.rotation + 90) % 360 })
                  }
                >
                  <RotateCw size={15} />
                  旋转 · {prefs.rotation}°
                </button>
                <label className="video-check video-panel-section">
                  <input
                    type="checkbox"
                    checked={prefs.hardwareDecoding}
                    onChange={(e) =>
                      preferences({ hardwareDecoding: e.target.checked })
                    }
                  />
                  自动硬件解码
                </label>
                <small className="video-help">
                  出现花屏或黑屏时，可关闭硬件解码后重试。
                </small>
                <div className="video-shortcuts">
                  空格 · 播放／暂停
                  <br />← → · 跳转 5 秒<br />
                  Shift + ← → · 跳转 30 秒<br />↑ ↓ · 音量　M · 静音
                  <br />F / 双击画面 · 全屏
                  <br />
                  Esc · 关闭面板／退出全屏／返回
                </div>
              </>
            )}
          </aside>
        )}
      </div>
      <footer className="video-controls" inert={chrome !== "visible"}>
        <div className="video-control-surface">
          {resumeNotice && (
            <div className="video-resume">
              已继续上次播放
              <button
                onClick={() => {
                  void command({ type: "seek", value: 0 });
                  setResumeNotice(false);
                }}
              >
                从头播放
              </button>
              <button
                aria-label="关闭续播提示"
                onClick={() => setResumeNotice(false)}
              >
                <X size={13} />
              </button>
            </div>
          )}
          <div className="video-timeline">
            <span>{clock(dragPosition ?? state?.position ?? 0)}</span>
            <input
              aria-label="播放进度"
              style={
                {
                  "--range-progress": `${Math.min(100, Math.max(0, ((dragPosition ?? state?.position ?? 0) / (state?.duration || 1)) * 100))}%`,
                } as CSSProperties
              }
              type="range"
              min="0"
              max={state?.duration || 1}
              step="0.1"
              value={
                dragPosition ??
                Math.min(state?.position ?? 0, state?.duration || 1)
              }
              disabled={!ready}
              onChange={(e) => setDragPosition(Number(e.target.value))}
              onPointerCancel={() => setDragPosition(undefined)}
              onPointerUp={(e) => {
                void command({
                  type: "seek",
                  value: Number(e.currentTarget.value),
                }).finally(() => setDragPosition(undefined));
              }}
              onKeyUp={(e) => {
                if (
                  [
                    "ArrowLeft",
                    "ArrowRight",
                    "Home",
                    "End",
                    "PageUp",
                    "PageDown",
                  ].includes(e.key)
                )
                  void command({
                    type: "seek",
                    value: Number(e.currentTarget.value),
                  }).finally(() => setDragPosition(undefined));
              }}
            />
            <span>{clock(state?.duration ?? 0)}</span>
          </div>
          <div className="video-toolbar">
            <button
              title="上一集"
              aria-label="上一集"
              disabled={index <= 0}
              onClick={() => step(-1)}
            >
              <SkipBack size={19} />
            </button>
            <button
              className="video-play"
              title={state?.paused ? "播放" : "暂停"}
              aria-label={state?.paused ? "播放" : "暂停"}
              disabled={!ready}
              onClick={() =>
                void command({ type: "pause", value: !state?.paused })
              }
            >
              {state?.paused ? <Play size={23} /> : <Pause size={23} />}
            </button>
            <button
              title="下一集"
              aria-label="下一集"
              disabled={index < 0 || index >= queue.length - 1}
              onClick={() => step(1)}
            >
              <SkipForward size={19} />
            </button>
            <div className="video-volume">
              <button
                aria-label={prefs?.muted ? "取消静音" : "静音"}
                onClick={() => preferences({ muted: !prefs?.muted })}
              >
                {prefs?.muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
              </button>
              <input
                aria-label="音量"
                style={
                  {
                    "--range-progress": `${prefs?.muted ? 0 : (prefs?.volume ?? 70)}%`,
                  } as CSSProperties
                }
                type="range"
                min="0"
                max="100"
                value={prefs?.volume ?? 70}
                onChange={(e) =>
                  preferences({ volume: Number(e.target.value), muted: false })
                }
              />
            </div>
            <div className="video-toolbar-space" />
            <select
              aria-label="播放速度"
              value={prefs?.speed ?? 1}
              onChange={(e) => preferences({ speed: Number(e.target.value) })}
            >
              {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4].map(
                (speed) => (
                  <option key={speed} value={speed}>
                    {speed}×
                  </option>
                ),
              )}
            </select>
            <button
              title="截取片段"
              aria-expanded={panel === "clip"}
              aria-label="截取片段"
              disabled={!ready || !state?.duration}
              className={panel === "clip" ? "active" : ""}
              onClick={() => {
                void command({ type: "pause", value: true });
                togglePanel("clip");
              }}
            >
              <Scissors size={19} />
            </button>
            <button
              className={panel === "queue" ? "active" : ""}
              aria-expanded={panel === "queue"}
              title="选集"
              aria-label="选集"
              onClick={() => togglePanel("queue")}
            >
              <ListVideo size={19} />
            </button>
            <button
              className={panel === "subtitles" ? "active" : ""}
              aria-expanded={panel === "subtitles"}
              title="字幕与音轨"
              aria-label="字幕与音轨"
              onClick={() => togglePanel("subtitles")}
            >
              <Captions size={20} />
            </button>
            <button
              className={panel === "settings" ? "active" : ""}
              aria-expanded={panel === "settings"}
              title="播放设置"
              aria-label="播放设置"
              onClick={() => togglePanel("settings")}
            >
              <Settings2 size={19} />
            </button>
            <button
              title={state?.fullscreen ? "退出全屏" : "全屏"}
              aria-label={state?.fullscreen ? "退出全屏" : "全屏"}
              onClick={() =>
                void command({ type: "fullscreen", value: !state?.fullscreen })
              }
            >
              {state?.fullscreen ? (
                <Minimize size={19} />
              ) : (
                <Maximize size={19} />
              )}
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
  return (
    <>
      <div className="viewer viewer-video video-player video-underlay" />
      {surface && createPortal(player, surface)}
    </>
  );
}
