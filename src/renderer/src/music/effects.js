import { create } from "zustand";
import { createAudioEffectChain } from "../../../../vendor/folia/src/services/audioEffects/effectChain";
import {
  AUDIO_EFFECT_CONTROLS,
  DEFAULT_AUDIO_EFFECT_SETTINGS,
  normalizeAudioEffects,
} from "../../../../vendor/folia/src/utils/audioEffects";
let saved = {};
try {
  saved = JSON.parse(localStorage.getItem("yingjian:audio-effects") || "{}");
} catch {
  /* Defaults. */
}
export const useMusicEffects = create((set) => ({
  enabled: Boolean(saved.enabled),
  effects: normalizeAudioEffects(saved.effects),
  set: (patch) => set(patch),
}));
useMusicEffects.subscribe((state) =>
  localStorage.setItem(
    "yingjian:audio-effects",
    JSON.stringify({ enabled: state.enabled, effects: state.effects }),
  ),
);
export const effectControls = AUDIO_EFFECT_CONTROLS;
export const effectDefaults = DEFAULT_AUDIO_EFFECT_SETTINGS;
export function createEffects(context, input, output) {
  const state = useMusicEffects.getState();
  return createAudioEffectChain({
    context,
    input,
    output,
    enabled: state.enabled,
    effects: state.effects,
  });
}
