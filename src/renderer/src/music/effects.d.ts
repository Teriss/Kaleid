interface EffectState {
  enabled: boolean;
  effects: Record<string, number>;
  set(patch: Partial<Pick<EffectState, "enabled" | "effects">>): void;
}
export const useMusicEffects: import("zustand").UseBoundStore<
  import("zustand").StoreApi<EffectState>
>;
export const effectControls: {
  id: string;
  min: number;
  max: number;
  step: number;
}[];
export const effectDefaults: Record<string, number>;
export function createEffects(
  context: AudioContext,
  input: AudioNode,
  output: AudioNode,
): {
  apply(effects: Record<string, number>, enabled: boolean): void;
  dispose(): void;
};
