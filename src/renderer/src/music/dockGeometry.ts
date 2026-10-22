export interface DockMemory {
  version: 1;
  x: number;
  y: number;
  edge: "left" | "right" | null;
  collapsed: boolean;
}
export interface DockRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
const clamp = (n: number, low: number, high: number) =>
  Math.max(low, Math.min(Math.max(low, high), n));
export function readDockMemory(value: unknown): DockMemory | undefined {
  const v = value as DockMemory;
  return v?.version === 1 &&
    Number.isFinite(v.x) &&
    Number.isFinite(v.y) &&
    v.x >= 0 &&
    v.x <= 1 &&
    v.y >= 0 &&
    v.y <= 1 &&
    ["left", "right", null].includes(v.edge) &&
    typeof v.collapsed === "boolean" &&
    (!v.collapsed || v.edge !== null)
    ? v
    : undefined;
}
export function dockPoint(
  memory: DockMemory | undefined,
  width: number,
  height: number,
) {
  const x = memory ? memory.x * Math.max(1, width - 48) : width - 72;
  const y = memory ? 36 + memory.y * Math.max(1, height - 84) : height - 130;
  return { x: clamp(x, 0, width - 48), y: clamp(y, 36, height - 48) };
}
export function releaseDock(
  x: number,
  y: number,
  width: number,
  height: number,
  obstacles: DockRect[] = [],
): DockMemory {
  const edge = x <= 24 ? "left" : x + 48 >= width - 24 ? "right" : null;
  x =
    edge === "left"
      ? 0
      : edge === "right"
        ? width - 48
        : clamp(x, 0, width - 48);
  ({ x, y } = avoidDockObstacles({ x, y }, width, height, obstacles, edge));
  return {
    version: 1,
    x: clamp(x / Math.max(1, width - 48), 0, 1),
    y: clamp((y - 36) / Math.max(1, height - 84), 0, 1),
    edge,
    collapsed: edge !== null,
  };
}
export function avoidDockObstacles(
  point: { x: number; y: number },
  width: number,
  height: number,
  obstacles: DockRect[],
  edge: DockMemory["edge"] = null,
) {
  const x = clamp(point.x, 0, width - 48);
  let y = clamp(point.y, 36, height - (edge ? 80 : 48) - 8);
  {
    const tagX = edge === "left" ? 0 : edge === "right" ? width - 24 : x;
    const controlWidth = edge ? 24 : 48,
      controlHeight = edge ? 80 : 48;
    const intersects = (candidate: number) =>
      obstacles.some(
        (r) =>
          tagX < r.x + r.width + 4 &&
          tagX + controlWidth > r.x - 4 &&
          candidate < r.y + r.height + 6 &&
          candidate + controlHeight > r.y - 6,
      );
    const candidates = [
      y,
      ...obstacles.flatMap((r) => [
        r.y - controlHeight - 6,
        r.y + r.height + 6,
      ]),
    ]
      .map((n) => clamp(n, 36, height - controlHeight - 8))
      .sort((a, b) => Math.abs(a - y) - Math.abs(b - y));
    y = candidates.find((n) => !intersects(n)) ?? y;
  }
  return { x, y };
}
