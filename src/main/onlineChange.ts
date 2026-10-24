import type { OnlineChangeEvent } from "../shared/types";

export interface ChangeSender {
  /** `{ download: true }` merges into a single trailing event; a bare call is immediate. */
  send(event?: OnlineChangeEvent): void;
  /** Drops any pending trailing event when the service shuts down. */
  dispose(): void;
}

/**
 * Download progress is reported once per page, which is far more often than the
 * UI needs it. Progress events therefore collapse into one trailing tick, while
 * state transitions (chapter finished, favourite toggled, source installed) are
 * sent straight away and make any queued progress tick redundant.
 */
export function createChangeSender(
  send: (event?: OnlineChangeEvent) => void,
  interval = 300,
): ChangeSender {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    send(event) {
      if (event?.download) {
        if (timer) return;
        timer = setTimeout(() => {
          timer = undefined;
          send({ download: true });
        }, interval);
        return;
      }
      if (timer) clearTimeout(timer);
      timer = undefined;
      send(undefined);
    },
    dispose() {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
