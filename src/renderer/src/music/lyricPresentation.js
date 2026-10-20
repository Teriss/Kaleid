import { create } from "zustand";
import { motionValue } from "framer-motion";
import { DEFAULT_THEME } from "../../../../vendor/folia/src/services/baseThemes";

let theme = DEFAULT_THEME;
try {
  theme = JSON.parse(localStorage.getItem("yingjian:music-theme")) || theme;
} catch {}
const currentTime = motionValue(0);
export const useLyricPresentation = create(() => ({
  trackId: "",
  lines: [],
  currentTime,
  currentLineIndex: -1,
  paused: true,
  theme,
}));
export function lyricLines(lyrics, duration) {
  return lyrics.map((line, index) => ({
    fullText: line.text,
    startTime: line.time,
    endTime:
      lyrics[index + 1]?.time ??
      (duration > line.time ? duration : line.time + 5),
    translation: line.translation,
    romanization: line.romanization,
    // A zero-length display marker highlights the entire line at once; no character times are inferred.
    words: line.words?.length
      ? line.words.map((w) => ({
          text: w.text,
          startTime: w.time,
          endTime: w.time + w.duration,
        }))
      : [
          {
            text: line.text,
            startTime: line.time,
            endTime: line.time,
          },
        ],
  }));
}
export function publishLyrics(trackId, lyrics, duration) {
  useLyricPresentation.setState({
    trackId: trackId || "",
    lines: lyricLines(lyrics, duration),
  });
}
export function setLyricTheme(theme) {
  useLyricPresentation.setState({ theme });
  localStorage.setItem("yingjian:music-theme", JSON.stringify(theme));
}
/** The audio element is the sole clock; visualizers only read this motion value. */
export function startLyricClock(readAudio) {
  let frame;
  function tick() {
    const audio = readAudio();
    const time = Number.isFinite(audio?.currentTime) ? audio.currentTime : 0;
    currentTime.set(time);
    const state = useLyricPresentation.getState();
    const index = state.lines.findLastIndex((line) => line.startTime <= time);
    const paused = !audio || audio.paused;
    if (index !== state.currentLineIndex || paused !== state.paused)
      useLyricPresentation.setState({ currentLineIndex: index, paused });
    frame = requestAnimationFrame(tick);
  }
  frame = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(frame);
}
