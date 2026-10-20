export async function visualizerChoices() {
  const { VISUALIZER_REGISTRY } =
    await import("../../../../vendor/folia/src/components/visualizer/registry");
  return VISUALIZER_REGISTRY.map((entry) => ({
    mode: entry.mode,
    label: entry.labelFallback,
  }));
}
