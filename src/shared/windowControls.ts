export interface MainWindowState {
  maximized: boolean;
  fullscreen: boolean;
}
export type MainWindowCommand = "minimize" | "toggle-maximize" | "close";
export interface MainWindowDrag {
  phase: "begin" | "update" | "end";
  x: number;
  y: number;
}
export interface MainWindowChromePointer {
  reveal: boolean;
  inside: boolean;
}
