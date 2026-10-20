/** The settings page and the quick editor share the same gain curves. */
export const EQUALIZER_PRESETS: Record<string, number[]> = {
  flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  bass: [6, 5, 4, 2, 0, 0, 0, 0, 1, 1],
  vocal: [-2, -1, 0, 2, 4, 4, 2, 0, -1, -2],
  classical: [3, 2, 1, 0, -1, 1, 2, 3, 3, 2],
  pop: [-1, 0, 2, 3, 1, -1, 0, 1, 2, 2],
};
