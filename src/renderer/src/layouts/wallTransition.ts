let resolveCompletion: (() => void) | undefined;
export const wallTransition = {
  token: 0,
  origin: { x: 0, y: 0 },
  active: false,
  kind: "flip" as "flip" | "wave",
  startSlotKey: undefined as string | undefined,
  direction: "replace" as "push" | "back" | "replace",
  completion: Promise.resolve(),
  begin() {
    resolveCompletion?.();
    this.completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
  },
  settle(token: number) {
    if (token !== this.token) return;
    resolveCompletion?.();
    resolveCompletion = undefined;
  },
};
