import { describe, expect, it } from "vitest";
import {
  normalizeWheelDeltaY,
  pagedClickDirection,
  pagedDragDirection,
} from "../../src/shared/readerGestures";

describe("reader page gestures", () => {
  it("requires a deliberate horizontal drag", () => {
    expect(pagedDragDirection(-48, 0)).toBe(1);
    expect(pagedDragDirection(70, 0)).toBe(-1);
    expect(pagedDragDirection(-47, 0)).toBe(0);
    expect(pagedDragDirection(-90, 76)).toBe(0);
  });

  it("keeps the outer page edges for previous and next", () => {
    expect(pagedClickDirection(22, 0, 100)).toBe(-1);
    expect(pagedClickDirection(50, 0, 100)).toBe(0);
    expect(pagedClickDirection(78, 0, 100)).toBe(1);
  });

  it("converts line and page wheel deltas to pixel distances", () => {
    expect(normalizeWheelDeltaY(2, 1, 24, 700)).toBe(48);
    expect(normalizeWheelDeltaY(-1, 2, 24, 700)).toBe(-700);
    expect(normalizeWheelDeltaY(36, 0, 24, 700)).toBe(36);
  });
});
