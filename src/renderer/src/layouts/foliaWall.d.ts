export type Metrics = { cellSize: number; gap: number };
export type Bounds = {
  left: number;
  right: number;
  top: number;
  bottom: number;
};
export type Slot = {
  key: string;
  column: number;
  row: number;
  slotIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  area: number;
};
export type Change = { slot: Slot; from: string | null; to: string | null };
export type FlipOrigin =
  { kind: "point"; x: number; y: number } | { kind: "seam-edges"; x: number };
export const BLOCK_COLS: number, BLOCK_ROWS: number, SLOTS_PER_BLOCK: number;
export function getBlockTemplate(
  column: number,
  row: number,
): { x: number; y: number; cols: number; rows: number }[];
export function getWallSlot(
  column: number,
  row: number,
  slot: number,
  metrics: Metrics,
): Slot | null;
export function layoutFocusedBlock(
  column: number,
  row: number,
  slot: number,
  metrics: Metrics,
): Slot[] | null;
export function getWrapPeriod(count: number): {
  blocksPerRow: number;
  blockRows: number;
  perBlock: number;
};
export function getStartWrapOffset(
  start: { column: number; row: number; slotIndex: number } | null,
  count: number,
): number;
export function getInfiniteSlotItem(
  slot: { column: number; row: number; slotIndex: number },
  count: number,
  offset: number,
): number | null;
export function formatWorldTransform(
  x: number,
  y: number,
  scale: number,
  dpr?: number,
): string;
export function nearestSeamBoundaryX(x: number, metrics: Metrics): number;
type View = { width: number; height: number; scale: number };
export function blockSeamPlan(input: {
  cameraX: number;
  openWidth: number;
  view: View;
  metrics: Metrics;
  preferX?: number;
}): { x: number; cameraX: number; shift: number };
export function getSeamGeometry(input: {
  anchorX: number;
  cameraX: number;
  openWidth: number;
  view: View;
}): {
  screenX: number;
  width: number;
  collapsed: boolean;
  side: "left" | "right";
};
export function getSeamSplitOffsets(
  width: number,
  scale: number,
  metrics: Metrics,
): { left: number; right: number };
type WheelSample = Pick<
  WheelEvent,
  "deltaMode" | "deltaX" | "deltaY" | "timeStamp"
>;
export function createWallWheelClassifier(): (
  event: WheelSample,
) => "wheel" | "trackpad";
export function stepWallWheel(
  pending: { x: number; y: number },
  dt: number,
): { step: { x: number; y: number }; pending: { x: number; y: number } };
export function wallWheelDelta(
  event: Pick<WheelEvent, "deltaMode" | "deltaX" | "deltaY" | "shiftKey">,
  height: number,
): { dx: number; dy: number };
export const WALL_PAN_INERTIA: {
  minSpeed: number;
  maxSpeed: number;
  power: number;
  timeConstant: number;
  restDelta: number;
  staleReleaseMs: number;
};
export function planFlip(input: {
  changes: Change[];
  origin: FlipOrigin;
  visible: Bounds;
  metrics: Metrics;
  maxTiles?: number;
}): {
  flips: { key: string; to: string | null; delay: number; direction: -1 | 1 }[];
  durationMs: number;
};
export function planWallWave(input: {
  changes: Change[];
  viewport: Bounds;
  visible: Bounds;
  metrics: Metrics;
  maxTiles?: number;
}): {
  steps: {
    key: string;
    to: string | null;
    outDelay: number;
    inDelay: number;
  }[];
  durationMs: number;
};
