import type { BrowseMemory } from "../../../shared/types";
import {
  planFlip,
  planWallWave,
  type Bounds,
  type FlipOrigin,
} from "./foliaWall";
import { WALL_METRICS, type Camera, type WallTile } from "./geometry";

export const WALL_LAYOUT_VERSION = 2;
export const defaultWallScale = (width: number) =>
  width < 640 ? 0.52 : width < 1100 ? 0.64 : 0.76;
export type SeamLevel = "full" | "spine" | "hidden";
export const defaultSeamLevel = (width: number): SeamLevel => "spine";
export const seamWidthFor = (level: SeamLevel, home: boolean) =>
  level === "hidden" ? 0 : level === "spine" ? 120 : 300;
export function migrateWallMemory(memory: BrowseMemory): BrowseMemory {
  if (memory.wallLayoutVersion === WALL_LAYOUT_VERSION) return memory;
  return {
    ...memory,
    wallLayoutVersion: WALL_LAYOUT_VERSION,
    wallManualScale: false,
    camera: undefined,
    wallCameras: undefined,
    seam: undefined,
    wallStartSlotKey: undefined,
    wallFocusedSlotKey: undefined,
    wallFocusId: undefined,
  };
}
export function parseSlot(key?: string) {
  if (!key) return null;
  const parts = key.split(",").map(Number);
  return parts.length === 3 &&
    parts.every(Number.isSafeInteger) &&
    parts[2] >= 0 &&
    parts[2] < 12
    ? { column: parts[0], row: parts[1], slotIndex: parts[2] }
    : null;
}
export function worldBounds(
  camera: Camera,
  width: number,
  height: number,
  seamWidth = 0,
): Bounds {
  return {
    left: camera.x - (width / 2 + seamWidth) / camera.scale,
    right: camera.x + (width / 2 + seamWidth) / camera.scale,
    top: camera.y - height / (2 * camera.scale),
    bottom: camera.y + height / (2 * camera.scale),
  };
}
export function needsWallCull(visible: Bounds, culled: Bounds | null) {
  const padding = 420 - 160;
  return (
    !culled ||
    visible.left < culled.left - padding ||
    visible.right > culled.right + padding ||
    visible.top < culled.top - padding ||
    visible.bottom > culled.bottom + padding
  );
}
export type WallFlipStep = {
  token: number;
  to: string | null;
  delay: number;
  direction: number;
  wave?: { inDelay: number };
  reduced: boolean;
};
export function planWallChange(input: {
  token: number;
  tiles: WallTile[];
  before: ReadonlyMap<string, string | null>;
  after: ReadonlyMap<string, string | null>;
  origin: FlipOrigin;
  visible: Bounds;
  kind: "flip" | "wave";
  reduced: boolean;
}) {
  const changes = input.tiles.map((tile) => ({
    slot: {
      ...tile,
      slotIndex: tile.slot,
      centerX: tile.x + tile.width / 2,
      centerY: tile.y + tile.height / 2,
      area: 0,
    },
    from: input.before.get(tile.key) ?? null,
    to: input.after.get(tile.key) ?? null,
  }));
  const steps = new Map<string, WallFlipStep>();
  if (input.kind === "wave" && !input.reduced) {
    const plan = planWallWave({
      changes,
      viewport: input.visible,
      visible: input.visible,
      metrics: WALL_METRICS,
    });
    for (const step of plan.steps)
      steps.set(step.key, {
        token: input.token,
        to: step.to,
        delay: step.outDelay,
        direction: 1,
        wave: { inDelay: step.inDelay },
        reduced: false,
      });
    return { steps, durationMs: plan.durationMs };
  }
  const plan = planFlip({
    changes,
    origin: input.origin,
    visible: input.visible,
    metrics: WALL_METRICS,
  });
  for (const step of plan.flips)
    steps.set(step.key, {
      ...step,
      token: input.token,
      delay: input.reduced ? 0 : step.delay,
      reduced: input.reduced,
    });
  return {
    steps,
    durationMs: steps.size && input.reduced ? 180 : plan.durationMs,
  };
}
