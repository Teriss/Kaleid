import {
  BLOCK_COLS,
  BLOCK_ROWS as FOLIA_ROWS,
  getBlockTemplate,
  getWallSlot,
  layoutFocusedBlock,
  getWrapPeriod,
  getInfiniteSlotItem,
} from "./foliaWall";

export interface Camera {
  x: number;
  y: number;
  scale: number;
}
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface WallTile extends Rect {
  key: string;
  index: number;
  column: number;
  row: number;
  slot: number;
}
export type WallMode = "finite" | "infinite";
export const WALL_CELL = 128;
export const WALL_GAP = 8;
export const WALL_PITCH = WALL_CELL + WALL_GAP;
export const WALL_METRICS = { cellSize: WALL_CELL, gap: WALL_GAP };
export const BLOCK_COLUMNS = BLOCK_COLS;
export const BLOCK_ROWS = FOLIA_ROWS;
export const WALL_TEMPLATE = getBlockTemplate(0, 0).map(
  (s) => [s.x, s.y, s.cols, s.rows] as const,
);
export const modulo = (value: number, divisor: number) =>
  ((value % divisor) + divisor) % divisor;
export function wallPeriod(total: number) {
  const period = getWrapPeriod(total);
  return { columns: period.blocksPerRow, rows: period.blockRows };
}
export function tileAt(
  column: number,
  row: number,
  slot: number,
  total: number,
  mode: WallMode = "infinite",
  offset = 0,
): WallTile {
  const rect = getWallSlot(column, row, slot, WALL_METRICS)!;
  const period = wallPeriod(total);
  return {
    ...rect,
    slot,
    index:
      mode === "finite"
        ? (row * period.columns + column) * WALL_TEMPLATE.length + slot
        : (getInfiniteSlotItem(rect, total, offset) ?? 0),
  };
}
export function visibleWall(
  camera: Camera,
  width: number,
  height: number,
  total: number,
  mode: WallMode = "infinite",
  offset = 0,
  overscan = 420,
): WallTile[] {
  if (!total || width <= 0 || height <= 0) return [];
  const period = wallPeriod(total);
  const left = camera.x - width / (2 * camera.scale) - overscan;
  const right = camera.x + width / (2 * camera.scale) + overscan;
  const top = camera.y - height / (2 * camera.scale) - overscan;
  const bottom = camera.y + height / (2 * camera.scale) + overscan;
  const result: WallTile[] = [];
  for (
    let row = Math.floor(top / (BLOCK_ROWS * WALL_PITCH));
    row <= Math.floor(bottom / (BLOCK_ROWS * WALL_PITCH));
    row++
  ) {
    for (
      let column = Math.floor(left / (BLOCK_COLUMNS * WALL_PITCH));
      column <= Math.floor(right / (BLOCK_COLUMNS * WALL_PITCH));
      column++
    ) {
      if (
        mode === "finite" &&
        (row < 0 ||
          column < 0 ||
          row >= period.rows ||
          column >= period.columns)
      )
        continue;
      for (let slot = 0; slot < WALL_TEMPLATE.length; slot++) {
        const tile = tileAt(column, row, slot, total, mode, offset);
        if (mode === "finite" && tile.index >= total) continue;
        if (
          tile.x < right &&
          tile.x + tile.width > left &&
          tile.y < bottom &&
          tile.y + tile.height > top
        )
          result.push(tile);
      }
    }
  }
  return result
    .sort(
      (a, b) =>
        Math.hypot(
          a.x + a.width / 2 - camera.x,
          a.y + a.height / 2 - camera.y,
        ) -
        Math.hypot(b.x + b.width / 2 - camera.x, b.y + b.height / 2 - camera.y),
    )
    .slice(0, 320);
}
export function expandedBlock(
  active: WallTile,
  total: number,
  mode: WallMode = "infinite",
  offset = 0,
): WallTile[] {
  return (
    layoutFocusedBlock(active.column, active.row, active.slot, WALL_METRICS) ??
    []
  )
    .map((rect) => ({
      ...tileAt(rect.column, rect.row, rect.slotIndex, total, mode, offset),
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    }))
    .filter((tile) => mode !== "finite" || tile.index < total);
}
export function nearestTile(
  index: number,
  camera: Camera,
  total: number,
  mode: WallMode = "infinite",
  offset = 0,
): WallTile {
  index = Math.max(0, Math.min(Math.max(0, total - 1), index));
  const period = wallPeriod(total);
  const raw =
    mode === "finite" ? index : modulo(index - offset, Math.max(1, total));
  if (mode === "finite") {
    const block = Math.floor(raw / WALL_TEMPLATE.length);
    return tileAt(
      block % period.columns,
      Math.floor(block / period.columns),
      raw % WALL_TEMPLATE.length,
      total,
      mode,
    );
  }
  let best: WallTile | undefined,
    distance = Infinity;
  const capacity = period.columns * period.rows * WALL_TEMPLATE.length;
  for (
    let position = raw;
    position < capacity;
    position += Math.max(1, total)
  ) {
    const block = Math.floor(position / WALL_TEMPLATE.length),
      slot = position % WALL_TEMPLATE.length;
    const baseX = block % period.columns,
      baseY = Math.floor(block / period.columns);
    const cycleX = Math.round(
      (camera.x / (BLOCK_COLUMNS * WALL_PITCH) - baseX - 0.5) / period.columns,
    );
    const cycleY = Math.round(
      (camera.y / (BLOCK_ROWS * WALL_PITCH) - baseY - 0.5) / period.rows,
    );
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const tile = tileAt(
          baseX + (cycleX + dx) * period.columns,
          baseY + (cycleY + dy) * period.rows,
          slot,
          total,
          mode,
          offset,
        );
        const d = Math.hypot(
          tile.x + tile.width / 2 - camera.x,
          tile.y + tile.height / 2 - camera.y,
        );
        if (d < distance) {
          best = tile;
          distance = d;
        }
      }
  }
  return best!;
}
export function finiteWallBounds(total: number) {
  let width = 0,
    height = 0;
  const period = wallPeriod(total);
  const blocks = Math.ceil(total / WALL_TEMPLATE.length);
  const candidates = new Set([
    blocks - 1,
    Math.min(blocks - 1, period.columns - 1),
    Math.floor((blocks - 1) / period.columns) * period.columns - 1,
  ]);
  for (const block of candidates) {
    if (block < 0) continue;
    for (
      let slot = 0;
      slot < WALL_TEMPLATE.length &&
      block * WALL_TEMPLATE.length + slot < total;
      slot++
    ) {
      const tile = tileAt(
        block % period.columns,
        Math.floor(block / period.columns),
        slot,
        total,
        "finite",
      );
      width = Math.max(width, tile.x + tile.width);
      height = Math.max(height, tile.y + tile.height);
    }
  }
  return { width, height };
}
export function clampWallCamera(
  camera: Camera,
  viewport: { width: number; height: number },
  total: number,
  mode: WallMode,
): Camera {
  if (mode !== "finite" || !total) return camera;
  const world = finiteWallBounds(total);
  const clamp = (v: number, extent: number, half: number) =>
    extent <= half * 2
      ? extent / 2
      : Math.max(half, Math.min(extent - half, v));
  return {
    ...camera,
    x: clamp(camera.x, world.width, viewport.width / (2 * camera.scale)),
    y: clamp(camera.y, world.height, viewport.height / (2 * camera.scale)),
  };
}
export function zoomAt(
  camera: Camera,
  nextScale: number,
  pointer: { x: number; y: number },
  viewport: { width: number; height: number },
): Camera {
  const minimum = Math.max(
    0.45,
    Math.sqrt(
      (viewport.width * viewport.height) /
        (WALL_PITCH * WALL_PITCH * 240 * 4.8),
    ),
  );
  const scale = Math.max(minimum, Math.min(1.8, nextScale));
  return {
    x:
      camera.x +
      (pointer.x - viewport.width / 2) * (1 / camera.scale - 1 / scale),
    y:
      camera.y +
      (pointer.y - viewport.height / 2) * (1 / camera.scale - 1 / scale),
    scale,
  };
}
