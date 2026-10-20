import React from "react";
// Pixi's interpreter polyfills support the renderer CSP without allowing eval.
import "pixi.js/unsafe-eval";
import LatticeLyrics from "../../../../vendor/folia/src/components/app/lattice/lyrics/LatticeLyrics";
import LatticeLyricsProvider from "../../../../vendor/folia/src/components/app/lattice/lyrics/LatticeLyricsProvider";
import { useLyricPresentation } from "./lyricPresentation";

class CanvasBoundary extends React.Component {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}
export default function CardLyrics({ item, reducedMotion }) {
  const source = useLyricPresentation();
  if (source.trackId !== item.id || !source.lines.length) return null;
  return (
    <CanvasBoundary key={item.id}>
      <div className="card-lyrics-host" aria-label="卡片同步歌词">
        <LatticeLyricsProvider
          source={{
            ...source,
            staticMode: reducedMotion,
            showSubtitleTranslation: true,
            subtitleContentMode: "translation",
          }}
          songKey={item.id}
          keywordColoringEnabled
        >
          <LatticeLyrics
            tile={{ id: item.id, title: item.title, artist: item.artist || "" }}
            reducedMotion={reducedMotion}
          />
        </LatticeLyricsProvider>
      </div>
    </CanvasBoundary>
  );
}
