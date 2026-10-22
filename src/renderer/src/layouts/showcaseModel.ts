import type { MediaItem, WallMode } from "../../../shared/types";

export type ShowcaseKind = "recordCrate" | "screeningRoom" | "photoLightbox";
const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

export function showcaseIndex(position: number, total: number) {
  return total > 0 ? ((Math.round(position) % total) + total) % total : 0;
}
export function boundShowcase(position: number, total: number, mode: WallMode) {
  if (total < 2 || !Number.isFinite(position)) return 0;
  return mode === "finite" ? clamp(position, 0, total - 1) : position;
}
export function showcaseSlots(
  position: number,
  total: number,
  width: number,
  mode: WallMode,
) {
  if (!total) return [];
  if (total === 1) return [0];
  const centre = Math.round(position),
    radius = width < 640 ? 3 : width < 1100 ? 4 : 5;
  const start =
    mode === "finite" ? Math.max(0, centre - radius) : centre - radius;
  const end =
    mode === "finite" ? Math.min(total - 1, centre + radius) : centre + radius;
  return Array.from(
    { length: Math.max(0, end - start + 1) },
    (_, i) => start + i,
  );
}
export function showcaseGeometry(
  kind: ShowcaseKind,
  width: number,
  height: number,
) {
  const stageHeight = clamp(
    height - (kind === "recordCrate" ? 400 : 350) - (width < 640 ? 40 : 0),
    230,
    610,
  );
  const available = Math.max(160, width - 56);
  const maxWidth =
    kind === "recordCrate"
      ? Math.min(340, available * 0.64, stageHeight * 0.61)
      : kind === "screeningRoom"
        ? Math.min(600, available * 0.72)
        : Math.min(460, available * 0.66);
  const maxHeight =
    kind === "recordCrate"
      ? maxWidth
      : Math.min(kind === "screeningRoom" ? 340 : 360, stageHeight * 0.67);
  const pitch =
    kind === "recordCrate"
      ? maxWidth * 0.38
      : kind === "screeningRoom"
        ? maxWidth * 0.77
        : maxWidth * 0.78;
  return { stageHeight, maxWidth, maxHeight, pitch: Math.max(52, pitch) };
}
export function showcaseSize(
  kind: ShowcaseKind,
  geometry: ReturnType<typeof showcaseGeometry>,
  item?: Pick<MediaItem, "width" | "height" | "kind">,
) {
  if (kind === "recordCrate")
    return { width: geometry.maxWidth, height: geometry.maxHeight };
  const raw =
    item?.width && item.height
      ? item.width / item.height
      : kind === "screeningRoom"
        ? 16 / 9
        : 4 / 3;
  const aspect = Number.isFinite(raw) && raw > 0 ? raw : 1;
  // Fit the complete frame, including portrait and extreme panoramic media.
  const paddingX = kind === "photoLightbox" ? 20 : 12;
  const paddingY = kind === "photoLightbox" ? 36 : 12;
  const width = Math.min(
    geometry.maxWidth - paddingX,
    (geometry.maxHeight - paddingY) * aspect,
  );
  return { width: width + paddingX, height: width / aspect + paddingY };
}
export function showcasePose(
  kind: ShowcaseKind,
  slot: number,
  position: number,
  geometry: ReturnType<typeof showcaseGeometry>,
) {
  const d = slot - position,
    a = Math.abs(d),
    focus = Math.max(0, 1 - a) ** 2;
  let x = d * geometry.pitch,
    y = 0,
    z = 0,
    rx = 0,
    ry = 0,
    rz = 0;
  if (kind === "recordCrate") {
    y = 48 - focus * 88 + Math.min(a, 4) * 8;
    z = -a * 52;
    rx = (1 - focus) * 9;
    ry = -clamp(d, -1, 1) * 24;
  } else if (kind === "screeningRoom") {
    x =
      Math.sign(d) *
      geometry.pitch *
      (Math.min(a, 1) + Math.max(0, a - 1) * 0.72);
    y = Math.min(a, 4) * 18;
    z = -a * 165;
    ry = -clamp(d, -1.5, 1.5) * 25;
  } else {
    y = (1 - focus) * (32 + (1 - Math.cos(d * Math.PI)) * 17) - focus * 22;
    z = -a * 125;
    ry = -clamp(d, -1, 1) * 8;
    rz = (1 - focus) * Math.sin(d * 1.7) * 7;
  }
  return {
    transform: `translate(-50%, -50%) translate3d(${x}px, ${y}px, ${z}px) rotateX(${rx}deg) rotateY(${ry}deg) rotateZ(${rz}deg)`,
    opacity: 1,
    zIndex: 100 - Math.round(a * 10),
    focus,
  };
}
export function showcaseRelease(
  position: number,
  velocity: number,
  total: number,
  mode: WallMode,
) {
  const travel = clamp(Number.isFinite(velocity) ? velocity * 0.16 : 0, -3, 3);
  return boundShowcase(Math.round(position + travel), total, mode);
}
export function videoProgress(item: MediaItem) {
  if (item.progress?.completed) return 1;
  const duration = item.progress?.duration || item.duration;
  return duration && Number.isFinite(item.progress?.position)
    ? clamp(item.progress!.position! / duration, 0, 1)
    : 0;
}
