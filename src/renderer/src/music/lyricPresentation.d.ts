import type { LyricLine } from "../Player";
import type { MotionValue } from "framer-motion";
interface Presentation {
  trackId: string;
  lines: any[];
  currentTime: MotionValue<number>;
  currentLineIndex: number;
  paused: boolean;
  theme: any;
}
export const useLyricPresentation: import("zustand").UseBoundStore<
  import("zustand").StoreApi<Presentation>
>;
export function lyricLines(lines: LyricLine[], duration: number): any[];
export function publishLyrics(
  trackId: string | undefined,
  lines: LyricLine[],
  duration: number,
): void;
export function startLyricClock(
  read: () => HTMLAudioElement | null,
): () => void;
export function setLyricTheme(theme: any): void;
