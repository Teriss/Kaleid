import { useEffect, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Pause,
  Play,
  X,
  Maximize2,
} from "lucide-react";
import type { MusicWindowState } from "../../../shared/music";
export default function MusicWindow() {
  const [state, setState] = useState<MusicWindowState>({
    title: "",
    artist: "",
    lyric: "",
    playing: false,
    position: 0,
    duration: 0,
  });
  useEffect(() => window.music.onState(setState), []);
  const lyrics = location.hash === "#music-lyrics";
  return (
    <div
      className={`companion-window ${lyrics ? "desktop-lyrics" : "companion-mini"}`}
    >
      <div className="companion-drag" />
      <button
        className="companion-close"
        aria-label="关闭窗口"
        onClick={() => window.music.command("close")}
      >
        <X size={16} />
      </button>
      {lyrics ? (
        <p>{state.lyric || state.title || "等待播放音乐"}</p>
      ) : (
        <>
          <strong>{state.title || "暂无播放"}</strong>
          <small>{state.artist}</small>
          <p>{state.lyric}</p>
        </>
      )}
      <div className="companion-controls">
        <button
          aria-label="上一首"
          onClick={() => window.music.command("previous")}
        >
          <ChevronLeft />
        </button>
        <button
          aria-label="播放暂停"
          onClick={() => window.music.command("toggle")}
        >
          {state.playing ? <Pause /> : <Play />}
        </button>
        <button
          aria-label="下一首"
          onClick={() => window.music.command("next")}
        >
          <ChevronRight />
        </button>
        <button
          aria-label="展开播放器"
          onClick={() => window.music.command("expand")}
        >
          <Maximize2 size={17} />
        </button>
      </div>
    </div>
  );
}
