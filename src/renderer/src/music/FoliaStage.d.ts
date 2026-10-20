import type { ComponentType } from "react";
import type { LyricLine } from "../Player";
declare const FoliaStage: ComponentType<{
  track: {
    id: string;
    title: string;
    artist?: string;
    album?: string;
    coverUrl?: string;
  };
  lyrics: LyricLine[];
  position: number;
  duration: number;
  playing: boolean;
  reducedMotion: boolean;
  seek(time: number): void;
  analyser?: AnalyserNode;
}>;
export default FoliaStage;
