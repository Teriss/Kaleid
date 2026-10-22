/**
 * Geometry and motion adapted from Wenku8 Flutter by mikufoxxx and contributors.
 * SPDX-License-Identifier: GPL-3.0-only
 * Upstream, original sources and modification notice: vendor/wenku8/ADAPTATIONS.md.
 * Ported to TypeScript for Kaleid, 2026-10-22.
 */
export const DEPTH_X = 0.66;
export const DEPTH_Y = -0.3;
const clamp = (n: number, low: number, high: number) =>
  Math.max(low, Math.min(high, n));

export function bookIndex(lane: number, count: number) {
  return count > 0 ? ((Math.round(lane) % count) + count) % count : 0;
}

export function boundShelfPosition(
  position: number,
  count: number,
  loop = true,
) {
  return count < 2 ? 0 : loop ? position : clamp(position, 0, count - 1);
}

export function shelfGeometry(viewport: number) {
  const spine = clamp(viewport * 0.043, 14, 18);
  const cover = clamp(viewport * 0.32, 100, 128);
  const height = ((cover - 20) * 166) / 118 + 54;
  const pitch = spine + 11;
  const footprint = spine + cover * DEPTH_X;
  const baseY = -cover * DEPTH_Y + height * 0.6 + 12;
  return {
    spine,
    cover,
    height,
    pitch,
    footprint,
    baseY,
    rowHeight: baseY + height + 60,
  };
}
export type ShelfGeometry = ReturnType<typeof shelfGeometry>;

export function extractionWeight(distance: number) {
  return Math.abs(distance) >= 1.48
    ? 0
    : Math.cos(((distance / 1.48) * Math.PI) / 2) ** 2;
}

export function shelfPose(
  lane: number,
  position: number,
  viewport: number,
  g: ShelfGeometry,
  entrance = 1,
) {
  const distance = lane - position;
  const crest = 1 - (1 - clamp((entrance - 0.38) / 0.62, 0, 1)) ** 3;
  const weight = extractionWeight(distance) * crest;
  const pull = g.cover * 0.84 * weight * (1.24 - 0.24 * weight);
  const lift = weight * weight * (3 - 2 * weight);
  const rail = clamp(distance, -7, 7);
  const order = clamp(distance + viewport / g.pitch / 2 + 2, 0, 16);
  const assembly =
    56 * (1 - clamp((entrance - order * 0.018) / 0.52, 0, 1)) ** 3;
  return {
    x:
      viewport / 2 -
      g.footprint / 2 +
      distance * g.pitch -
      pull * DEPTH_X +
      assembly * DEPTH_X,
    y:
      g.baseY +
      rail * 2.5 +
      rail * rail * 0.45 -
      pull * DEPTH_Y -
      g.height * 0.6 * lift +
      assembly * DEPTH_Y,
  };
}

export function visibleShelfLanes(
  position: number,
  count: number,
  viewport: number,
  g: ShelfGeometry,
  loop = true,
) {
  if (count < 2) return count === 1 ? [0] : [];
  const span =
    Math.ceil(
      (viewport / 2 + g.footprint + g.cover * 0.84 * DEPTH_X) / g.pitch,
    ) + 2;
  const lanes = Array.from(
    { length: span * 2 + 1 },
    (_, i) => Math.round(position) - span + i,
  );
  return loop ? lanes : lanes.filter((lane) => lane >= 0 && lane < count);
}

/** Position and velocity are in book lanes and lanes/second, respectively. */
export function shelfRelease(
  position: number,
  velocity: number,
  finiteCount?: number,
) {
  const drag = 4.4,
    omega = 12;
  const directional = Math.abs(velocity) >= 1.7;
  const release = directional ? velocity : 0;
  let target = Math.round(position + release / drag);
  if (
    directional &&
    (target - position) * Math.sign(release) < Math.abs(release) / omega
  ) {
    const runway = position + release / omega;
    target = release > 0 ? Math.ceil(runway) : Math.floor(runway);
  }
  if (finiteCount !== undefined) {
    const bounded = boundShelfPosition(target, finiteCount, false);
    if (bounded !== target) {
      const distance = bounded - position;
      const duration =
        Math.abs(distance) < 0.000001
          ? 0
          : clamp(
              (3 * Math.abs(distance)) / Math.max(1, Math.abs(release)),
              0.12,
              0.5,
            );
      return {
        target: bounded,
        duration,
        at: (seconds: number) =>
          duration === 0
            ? bounded
            : position +
              distance * (1 - (1 - clamp(seconds / duration, 0, 1)) ** 3),
      };
    }
  }
  const coast =
    directional && Math.abs(release) > 4
      ? Math.log(Math.abs(release) / 4) / drag
      : 0;
  const handoff = position + (release / drag) * (1 - Math.exp(-drag * coast));
  const handoffVelocity = release * Math.exp(-drag * coast);
  const landing = directional ? (3 * (target - handoff)) / handoffVelocity : 0;
  return {
    target,
    duration: directional ? coast + landing : 0.85,
    at(seconds: number) {
      if (!directional) {
        if (seconds >= 0.85) return target;
        return (
          target +
          (position - target) *
            (1 + omega * seconds) *
            Math.exp(-omega * seconds)
        );
      }
      if (seconds < coast)
        return position + (release / drag) * (1 - Math.exp(-drag * seconds));
      const remaining = clamp(1 - (seconds - coast) / landing, 0, 1);
      return target - (target - handoff) * remaining ** 3;
    },
  };
}
