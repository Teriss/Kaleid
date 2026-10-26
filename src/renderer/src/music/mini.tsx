import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import MusicWindow from "./MusicWindow";
import { applyTheme, initializeTheme } from "../theme";
import { installDesktopInteractionPolicy } from "../desktopInteraction";
import "./mini.css";

document.documentElement.dataset.musicWindow = "mini";
initializeTheme();
const initial = window.music.windowInitial();
if (initial) applyTheme(initial.theme);
installDesktopInteractionPolicy();
class MiniBoundary extends React.Component<
  React.PropsWithChildren,
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    window.music.windowReady();
  }
  render() {
    return this.state.failed ? (
      <div className="mini-error">
        遥控窗口加载失败{" "}
        <button onClick={() => location.reload()}>重新加载</button>
      </div>
    ) : (
      this.props.children
    );
  }
}
const root = createRoot(document.getElementById("root")!);
flushSync(() =>
  root.render(
    <MiniBoundary>
      <MusicWindow />
    </MiniBoundary>,
  ),
);
