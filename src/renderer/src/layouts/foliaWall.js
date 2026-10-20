// Narrow source adapters: keep Folia's geometry/input rules without starting its app stores.
export {
  BLOCK_COLS,
  BLOCK_ROWS,
  SLOTS_PER_BLOCK,
  getBlockTemplate,
} from "../../../../vendor/folia/src/components/wall/blockTemplates";
export {
  getWallSlot,
  layoutFocusedBlock,
} from "../../../../vendor/folia/src/components/wall/wallSlots";
export {
  getWrapPeriod,
  getStartWrapOffset,
  getInfiniteSlotItem,
} from "../../../../vendor/folia/src/components/wall/startTile";
export { formatWorldTransform } from "../../../../vendor/folia/src/components/wall/wallView";
export {
  blockSeamPlan,
  nearestSeamBoundaryX,
  getSeamGeometry,
  getSeamSplitOffsets,
} from "../../../../vendor/folia/src/components/wall/seamPlan";
export {
  createWallWheelClassifier,
  stepWallWheel,
  wallWheelDelta,
  WALL_PAN_INERTIA,
} from "../../../../vendor/folia/src/components/wall/wallPanMotion";
export { planFlip } from "../../../../vendor/folia/src/components/wall/flipPlan";
export { planWallWave } from "../../../../vendor/folia/src/library/suites/bravais/bravaisWallWave";
