export function getHexCubicSpiral(
  count: number,
): { x: number; y: number; z: number }[];
export function computeHexCardFrame(
  coord: any,
  dx: number,
  dy: number,
  options: any,
): any;
export function planFlip(options: any): any;
export function flightBoxKeyframes(
  source: any,
  target: any,
): { box: Keyframe[]; corners: Keyframe[] };
export const FLIGHT_MS: number;
export const HANDOVER_MS: number;

export function getSeamGeometry(options: any): any;
export function getSeamSplitOffsets(
  width: number,
  scale: number,
  metrics: any,
): { left: number; right: number };
export function nearestSeamBoundaryX(
  x: number,
  metrics: any,
  blockWidth?: number,
): number;

export const ArtistPicture: import("react").ComponentType<{
  url: string | null;
  instant?: boolean;
}>;

export function planWallWave(options: any): any;

export function flyInAnimation(input: any): {
  keyframes: Keyframe[];
  timing: KeyframeAnimationOptions;
};
export function collectionMorphFlyIn(
  card: any,
  origin: any,
  spacing: number,
  reach: number,
  seed: number,
): any;
export function collectionMorphSeed(key: string): number;
export function collectionMorphEntranceTravel(view: any): number;
export function scatterPush(
  card: any,
  origin: any,
  reach: number,
  farthest: number,
  seed: number,
): any;
