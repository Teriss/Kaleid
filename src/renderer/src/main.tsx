import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import MusicWindow from "./music/MusicWindow";
import "./music/folia.css";
import "./styles.css";
import "./reader.css";

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error?: string }
> {
  state: { error?: string } = {};
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  render() {
    return this.state.error ? (
      <div className="fatal">
        <h1>界面暂时遇到了问题</h1>
        <p>{this.state.error}</p>
        <button onClick={() => location.reload()}>重新加载</button>
      </div>
    ) : (
      this.props.children
    );
  }
}
createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    {location.hash.startsWith("#music-") ? <MusicWindow /> : <App />}
  </ErrorBoundary>,
);
