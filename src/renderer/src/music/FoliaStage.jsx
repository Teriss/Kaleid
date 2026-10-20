import React, { useEffect, useMemo, useState } from "react";
import { motionValue } from "framer-motion";
import VisualizerRenderer from "../../../../vendor/folia/src/components/visualizer/VisualizerRenderer";
import { VISUALIZER_REGISTRY } from "../../../../vendor/folia/src/components/visualizer/registry";
import { useLyricPresentation, setLyricTheme } from "./lyricPresentation";
import { useMotionSettingsStore } from "../../../../vendor/folia/src/stores/useMotionSettingsStore";

export default function FoliaStage({
  track,
  lyrics,
  position,
  playing,
  reducedMotion,
  duration,
  seek,
  analyser,
}) {
  const [generating, setGenerating] = useState(false);
  const [mode, setMode] = useState(
    () => localStorage.getItem("yingjian:lyric-style") || "classic",
  );
  const [background, setBackground] = useState(
    () => localStorage.getItem("yingjian:music-background") || "latent",
  );
  useEffect(() => {
    const update = () => {
      setMode(localStorage.getItem("yingjian:lyric-style") || "classic");
      setBackground(
        localStorage.getItem("yingjian:music-background") || "latent",
      );
    };
    window.addEventListener("music-appearance-change", update);
    return () => window.removeEventListener("music-appearance-change", update);
  }, []);
  const presentation = useLyricPresentation();
  const theme = presentation.theme;
  const setTheme = setLyricTheme;
  const currentTime = presentation.currentTime;
  const audioPower = useMemo(() => motionValue(0), []);
  const audioBands = useMemo(
    () =>
      Object.fromEntries(
        ["bass", "lowMid", "mid", "vocal", "treble"].map((name) => [
          name,
          motionValue(0),
        ]),
      ),
    [],
  );
  const lines = presentation.trackId === track.id ? presentation.lines : [];
  useEffect(() => {
    let handle;
    const bins = new Uint8Array(analyser?.frequencyBinCount ?? 1024);
    const tick = () => {
      if (analyser && playing && !reducedMotion) {
        analyser.getByteFrequencyData(bins);
        const parts = [0, 4, 10, 30, 90, Math.min(350, bins.length)];
        ["bass", "lowMid", "mid", "vocal", "treble"].forEach((name, index) => {
          const slice = bins.subarray(parts[index], parts[index + 1]);
          audioBands[name].set(
            slice.reduce((a, b) => a + b, 0) / Math.max(1, slice.length) / 255,
          );
        });
        audioPower.set(bins.reduce((a, b) => a + b, 0) / bins.length / 255);
      } else {
        audioPower.set(0);
        Object.values(audioBands).forEach((v) => v.set(0));
      }
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [analyser, reducedMotion, playing]);
  useEffect(() => {
    const state = useMotionSettingsStore.getState();
    useMotionSettingsStore.setState({
      reducedMotionSurfaces: Object.fromEntries(
        Object.keys(state.reducedMotionSurfaces).map((key) => [
          key,
          reducedMotion,
        ]),
      ),
    });
  }, [reducedMotion]);
  function color(key, value) {
    const next = { ...theme, [key]: value };
    setTheme(next);
    localStorage.setItem("yingjian:music-theme", JSON.stringify(next));
  }
  return (
    <div className="folia-lyrics-stage">
      <VisualizerRenderer
        mode={mode}
        lines={lines}
        currentTime={currentTime}
        currentLineIndex={presentation.currentLineIndex}
        duration={duration}
        audioPower={audioPower}
        audioBands={audioBands}
        theme={theme}
        songTitle={track.title}
        songArtist={track.artist}
        songAlbum={track.album}
        coverUrl={track.coverUrl}
        seed={track.id}
        paused={!playing}
        staticMode={reducedMotion}
        backgroundStaticMode={reducedMotion}
        background={{ mode: background }}
        showText
        showSubtitleTranslation
        subtitleContentMode="both"
        onLyricLineSeek={seek}
        animateStyleSwitch={!reducedMotion}
      />
      <div className="folia-stage-options">
        <button
          disabled={generating}
          onClick={async () => {
            setGenerating(true);
            try {
              const dual = await window.music.generateTheme(
                lyrics.map((l) => l.text).join("\n"),
                track.title,
              );
              setTheme(dual.dark);
              localStorage.setItem(
                "yingjian:music-theme",
                JSON.stringify(dual.dark),
              );
            } catch (error) {
              window.dispatchEvent(
                new CustomEvent("music:notice", { detail: String(error) }),
              );
            } finally {
              setGenerating(false);
            }
          }}
        >
          {generating ? "生成中…" : "AI 主题"}
        </button>
        <select
          aria-label="Folia 歌词动画"
          value={mode}
          onChange={(e) => {
            setMode(e.target.value);
            localStorage.setItem("yingjian:lyric-style", e.target.value);
          }}
        >
          {VISUALIZER_REGISTRY.map((entry) => (
            <option key={entry.mode} value={entry.mode}>
              {entry.labelFallback}
            </option>
          ))}
        </select>
        <select
          aria-label="音乐动态背景"
          value={background}
          onChange={(e) => {
            setBackground(e.target.value);
            localStorage.setItem("yingjian:music-background", e.target.value);
          }}
        >
          {["common", "latent", "monet", "nomand", "sora"].map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
        <label title="主题文字">
          <input
            aria-label="歌词文字颜色"
            type="color"
            value={theme.primaryColor}
            onChange={(e) => color("primaryColor", e.target.value)}
          />
        </label>
        <label title="主题背景">
          <input
            aria-label="音乐背景颜色"
            type="color"
            value={theme.backgroundColor}
            onChange={(e) => color("backgroundColor", e.target.value)}
          />
        </label>
      </div>
    </div>
  );
}
