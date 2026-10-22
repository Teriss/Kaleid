export interface VideoTrack {
  id: number;
  type: "audio" | "sub";
  title?: string;
  lang?: string;
  codec?: string;
  selected?: boolean;
  external?: boolean;
  "ff-index"?: number;
}
export interface VideoMetadata {
  videoInfoVersion: number;
  videoCodec?: string;
  audioCodec?: string;
  duration?: number;
  width?: number;
  height?: number;
  videoProbeError?: string;
  videoStreams?: {
    type: string;
    codec?: string;
    language?: string;
    title?: string;
  }[];
}
export interface VideoPreferences {
  superResolution: "off" | "auto" | "generic" | "rtx";
  volume: number;
  muted: boolean;
  speed: number;
  autoNext: boolean;
  hardwareDecoding: boolean;
  subtitles: boolean;
  subtitleSize: number;
  subtitlePosition: number;
  subtitleDelay: number;
  audioDelay: number;
  fit: "contain" | "cover" | "original";
  aspect: "auto" | "16:9" | "4:3";
  rotation: number;
}
export const DEFAULT_VIDEO_PREFERENCES: VideoPreferences = {
  superResolution: "off",
  volume: 70,
  muted: false,
  speed: 1,
  autoNext: false,
  hardwareDecoding: true,
  subtitles: true,
  subtitleSize: 40,
  subtitlePosition: 95,
  subtitleDelay: 0,
  audioDelay: 0,
  fit: "contain",
  aspect: "auto",
  rotation: 0,
};
export interface VideoState {
  presentationReason?: "manual" | "automatic";
  surface?: {
    startedAt: number;
    hostReadyAt?: number;
    sizedAt?: number;
    shownAt?: number;
    playbackAt?: number;
  };
  enhancement?: VideoEnhancement;
  sessionId: string;
  mediaId: string;
  status: "loading" | "ready" | "ended" | "error";
  paused: boolean;
  position: number;
  duration: number;
  tracks: VideoTrack[];
  preferences: VideoPreferences;
  fullscreen: boolean;
  resumed: boolean;
  presentation?: "card" | "embedded" | "floating";
  alwaysOnTop?: boolean;
  error?: {
    kind: "offline" | "damaged" | "decode" | "engine";
    message: string;
  };
}
export interface VideoBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
}
export type VideoCommand =
  | { type: "preview"; value: { start: number; end: number } | null }
  | { type: "pause"; value: boolean }
  | { type: "seek"; value: number; relative?: boolean }
  | { type: "preferences"; value: Partial<VideoPreferences> }
  | { type: "track"; kind: "audio" | "sub"; id: number | "no" }
  | { type: "fullscreen"; value: boolean };
export interface VideoAPI {
  windowGesture(
    sessionId: string,
    value: {
      type: "begin" | "update" | "end";
      x: number;
      y: number;
      edge?: string;
    },
  ): Promise<{ moved: boolean }>;
  present(
    sessionId: string,
    mode: "card" | "embedded" | "floating",
    reason?: "manual" | "automatic",
  ): Promise<void>;
  pin(sessionId: string, value: boolean): Promise<void>;
  musicFocus(): Promise<boolean>;
  audioFocusAck(serial: number): Promise<void>;
  onAudioFocus(callback: (serial: number) => void): () => void;
  overlay(state: VideoOverlayState): Promise<void>;
  open(input: {
    mediaId: string;
    sessionId: string;
    autoPlay: boolean;
    fromStart?: boolean;
    presentation?: "card" | "embedded";
  }): Promise<VideoState>;
  close(sessionId: string): Promise<void>;
  command(sessionId: string, command: VideoCommand): Promise<void>;
  bounds(sessionId: string, bounds: VideoBounds): Promise<void>;
  subtitle(sessionId: string): Promise<void>;
  queue(
    mediaId: string,
    sort: "name" | "added" | "recent",
  ): Promise<import("./types").MediaItem[]>;
  onState(callback: (state: VideoState) => void): () => void;
  onInput(callback: (input: VideoInput) => void): () => void;
  export(input: VideoExportRequest): Promise<VideoExportJob | null>;
  exports(): Promise<VideoExportJob[]>;
  cancelExport(id: string): Promise<void>;
  revealExport(id: string): Promise<void>;
  onExports(callback: (jobs: VideoExportJob[]) => void): () => void;
}
export interface VideoInput {
  sessionId: string;
  action:
    | "fullscreen"
    | "escape"
    | "activity"
    | "edge-enter"
    | "edge-leave"
    | "back"
    | "forward"
    | "close"
    | "restore"
    | "surface-update";
}
export interface VideoOverlayState {
  visible: boolean;
  regions: { x: number; y: number; width: number; height: number }[];
}
export interface VideoEnhancement {
  generic: boolean;
  rtx: boolean;
  active: "off" | "generic" | "rtx";
  message: string;
}
export interface VideoExportRequest {
  sessionId: string;
  mediaId: string;
  start: number;
  end: number;
  format: "mp4" | "gif";
  audio: boolean;
  gifWidth: 320 | 480 | 640;
  gifFps: 10 | 15 | 24;
}
export interface VideoExportJob {
  id: string;
  title: string;
  format: "mp4" | "gif";
  status: "queued" | "running" | "completed" | "failed" | "canceled";
  progress: number;
  output: string;
  error?: string;
}
const numberIn = (
  value: unknown,
  fallback: number,
  min: number,
  max: number,
) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
export function videoPreferences(
  input: Partial<VideoPreferences> = {},
): VideoPreferences {
  if (!input || typeof input !== "object") input = {};
  const d = DEFAULT_VIDEO_PREFERENCES;
  return {
    superResolution: ["off", "auto", "generic", "rtx"].includes(
      input.superResolution ?? "",
    )
      ? input.superResolution!
      : d.superResolution,
    volume: numberIn(input.volume, d.volume, 0, 100),
    muted: typeof input.muted === "boolean" ? input.muted : d.muted,
    speed: numberIn(input.speed, d.speed, 0.25, 4),
    autoNext: typeof input.autoNext === "boolean" ? input.autoNext : d.autoNext,
    hardwareDecoding:
      typeof input.hardwareDecoding === "boolean"
        ? input.hardwareDecoding
        : d.hardwareDecoding,
    subtitles:
      typeof input.subtitles === "boolean" ? input.subtitles : d.subtitles,
    subtitleSize: numberIn(input.subtitleSize, d.subtitleSize, 12, 100),
    subtitlePosition: numberIn(
      input.subtitlePosition,
      d.subtitlePosition,
      0,
      100,
    ),
    subtitleDelay: numberIn(input.subtitleDelay, d.subtitleDelay, -600, 600),
    audioDelay: numberIn(input.audioDelay, d.audioDelay, -60, 60),
    fit: ["contain", "cover", "original"].includes(input.fit ?? "")
      ? input.fit!
      : d.fit,
    aspect: ["auto", "16:9", "4:3"].includes(input.aspect ?? "")
      ? input.aspect!
      : d.aspect,
    rotation: [0, 90, 180, 270].includes(input.rotation ?? -1)
      ? input.rotation!
      : 0,
  };
}
export function resumeVideo(position = 0, duration = 0, completed = false) {
  return !completed && Number.isFinite(position) && position > 0
    ? Math.max(
        0,
        duration > 0 ? Math.min(position, Math.max(0, duration - 1)) : position,
      )
    : 0;
}
