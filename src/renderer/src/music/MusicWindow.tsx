import { useEffect, useState, type CSSProperties } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Pause,
  Play,
  X,
  Maximize2,
  Disc3,
} from "lucide-react";
import type { MusicWindowState } from "../../../shared/music";
import { isPlaybackSpaceShortcut } from "../playbackSpace";
export default function MusicWindow() {
  const [state, setState] = useState<MusicWindowState>({
    title: "",
    artist: "",
    lyric: "",
    playing: false,
    position: 0,
    duration: 0,
  });
  const [scrubbingPosition, setScrubbingPosition] = useState<number>();
  useEffect(() => window.music.onState(setState), []);
  const lyrics = location.hash === "#music-lyrics";
  useEffect(() => {
    if (lyrics) return;
    const key = (event: KeyboardEvent) => {
      if (!isPlaybackSpaceShortcut(event)) return;
      event.preventDefault();
      event.stopPropagation();
      void window.music.command("toggle");
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [lyrics]);
  return (
    <div
      className={`companion-window ${lyrics ? "desktop-lyrics" : "companion-mini"}`}
    >
      <div className="companion-drag" />
      {lyrics && (
        <button
          className="companion-close"
          aria-label="关闭窗口"
          onClick={() => window.music.command("close")}
        >
          <X size={16} />
        </button>
      )}
      {lyrics ? (
        <p>{state.lyric || state.title || "等待播放音乐"}</p>
      ) : (
        <div className="companion-mini-row">
          {state.cover ? (
            <img className="companion-cover" src={state.cover} alt="" />
          ) : (
            <div className="companion-cover companion-cover-empty">
              <Disc3 size={22} />
            </div>
          )}
          <strong
            className="companion-track-title"
            title={[state.title, state.artist].filter(Boolean).join(" · ")}
          >
            {state.title
              ? `${state.title}${state.artist ? ` · ${state.artist}` : ""}`
              : "暂无播放"}
          </strong>
          <div className="companion-controls">
            <button
              aria-label="上一首"
              title="上一首"
              onClick={() => window.music.command("previous")}
            >
              <ChevronLeft size={17} />
            </button>
            <button
              aria-label="播放暂停"
              title={state.playing ? "暂停" : "播放"}
              onClick={() => window.music.command("toggle")}
            >
              {state.playing ? <Pause size={18} /> : <Play size={18} />}
            </button>
            <button
              aria-label="下一首"
              title="下一首"
              onClick={() => window.music.command("next")}
            >
              <ChevronRight size={17} />
            </button>
            <button
              aria-label="展开播放器"
              title="展开播放器"
              onClick={() => window.music.command("expand")}
            >
              <Maximize2 size={15} />
            </button>
            <button
              aria-label="关闭窗口"
              title="关闭窗口"
              onClick={() => window.music.command("close")}
            >
              <X size={15} />
            </button>
          </div>
          <input
            className="companion-progress"
            type="range"
            aria-label="迷你播放器进度"
            min="0"
            max={state.duration || 1}
            step="0.1"
            value={Math.min(
              scrubbingPosition ?? state.position,
              state.duration || 1,
            )}
            style={
              {
                "--companion-progress": `${state.duration ? (state.position / state.duration) * 100 : 0}%`,
              } as CSSProperties
            }
            onChange={(event) => {
              const position = Number(event.target.value);
              setScrubbingPosition(position);
              window.music.command("seek", position);
            }}
            onPointerUp={() => setScrubbingPosition(undefined)}
            onBlur={() => setScrubbingPosition(undefined)}
          />
        </div>
      )}
    </div>
  );
}
