import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Focus,
  Minus,
  Plus,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { animate } from "framer-motion";
import { IconButton } from "../components";
import {
  expandedBlock,
  clampWallCamera,
  finiteWallBounds,
  nearestTile,
  visibleWall,
  zoomAt,
  tileAt,
  WALL_METRICS,
  type Camera,
  type WallTile,
  type WallMode,
} from "./geometry";
import {
  canHandleKey,
  useWindowKey,
  resolveFocusIndex,
  useViewport,
  type LayoutProps,
} from "./shared";
import { useContentNavigation } from "./ContentNavigation";
import {
  blockSeamPlan,
  formatWorldTransform,
  getSeamGeometry,
  getSeamSplitOffsets,
  getStartWrapOffset,
  nearestSeamBoundaryX,
  type Bounds,
} from "./foliaWall";
import {
  defaultWallScale,
  defaultSeamLevel,
  seamWidthFor,
  migrateWallMemory,
  needsWallCull,
  parseSlot,
  planWallChange,
  worldBounds,
  WALL_LAYOUT_VERSION,
  type SeamLevel,
  type WallFlipStep,
} from "./wallModel";
import { useWallMotion } from "./useWallMotion";
import { wallTransition } from "./wallTransition";
import { scopeKey } from "./memory";
import WallTileFace from "./WallTileFace";
import WallSeamContent from "./WallSeamContent";

type Display = {
  source: LayoutProps["source"];
  key: string;
  offset: number;
  start?: string;
};

export default function BravaisWall(props: LayoutProps) {
  const { ref, width, height } = useViewport();
  const navigation = useContentNavigation();
  const latest = useRef(props);
  latest.current = props;
  const renderCount = useRef(0);
  renderCount.current++;
  const initial = useRef(migrateWallMemory(props.memory)).current;
  const key = props.scope ? scopeKey(props.scope) : "";
  const [mode, setMode] = useState<WallMode>(initial.wallMode ?? "infinite");
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const initialCamera = initial.wallCameras?.[mode] ??
    initial.camera ?? {
      x: nearestSeamBoundaryX(0, WALL_METRICS),
      y: height / (2 * defaultWallScale(width)),
      scale: defaultWallScale(width),
    };
  const camera = useRef<Camera>(initialCamera);
  const [cullCamera, setCullCamera] = useState(initialCamera);
  const [selected, setSelected] = useState<WallTile | null>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const keyboardFocus = useRef(initial.wallFocusedSlotKey);
  const [display, setDisplay] = useState<Display>(() => ({
    source: props.source,
    key,
    offset: getStartWrapOffset(
      parseSlot(initial.wallStartSlotKey),
      props.source.total,
    ),
    start: initial.wallStartSlotKey,
  }));
  const displayRef = useRef(display);
  displayRef.current = display;
  const shownNavigation = useRef(navigation);
  if (display.key === key && display.source === props.source)
    shownNavigation.current = navigation;
  const [stageReady, setStageReady] = useState(false);
  const [steps, setSteps] = useState(new Map<string, WallFlipStep>());
  const [exitingTiles, setExitingTiles] = useState<WallTile[]>([]);
  const initialized = useRef(false),
    serial = useRef(0);
  const [anchor, setAnchor] = useState(
    initial.seam?.anchor ?? nearestSeamBoundaryX(initialCamera.x, WALL_METRICS),
  );
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;
  const family =
    navigation?.sourceKind === "online"
      ? "online"
      : "local:" + (props.scope?.type ?? props.source.query.type ?? "");
  const defaultLevel: SeamLevel = family === "online" ? "spine" : "hidden";
  const seamSession = useRef<{
    level: SeamLevel;
    restore: SeamLevel;
    family: string;
  }>({ level: defaultLevel, restore: "spine", family }).current;
  const [level, setLevelState] = useState<SeamLevel>(seamSession.level);
  const [searchActive, setSearchActive] = useState(false);
  const searchRestore = useRef<{
    level: SeamLevel;
    restore: SeamLevel;
    camera: Camera;
    anchor: number;
  }>({
    level: defaultLevel,
    restore: "spine",
    camera: { ...camera.current },
    anchor,
  });
  const home = false;
  const targetWidth = navigation
    ? Math.min(
        Math.max(120, width - 48),
        searchActive ? 360 : seamWidthFor(level, home),
      )
    : 0;
  useLayoutEffect(() => {
    if (seamSession.family === family) return;
    seamSession.family = family;
    seamSession.level = defaultLevel;
    seamSession.restore = "spine";
    // Restore each source's own viewport; tabs inside the source keep it live.
    initialized.current = false;
    setLevelState(defaultLevel);
    setSearchActive(false);
  }, [family]);
  const frame = useRef({
    width,
    height,
    openWidth: 0,
    targetWidth,
    navigation: Boolean(navigation),
  });
  Object.assign(frame.current, {
    width,
    height,
    targetWidth,
    navigation: Boolean(navigation),
  });
  const left = useRef<HTMLDivElement>(null),
    right = useRef<HTMLDivElement>(null),
    seam = useRef<HTMLElement>(null),
    seamBody = useRef<HTMLDivElement>(null),
    emptyLeft = useRef<HTMLElement>(null),
    emptyRight = useRef<HTMLElement>(null),
    tab = useRef<HTMLButtonElement>(null),
    percent = useRef<HTMLSpanElement>(null);
  const bounds = useRef<Bounds | null>(null),
    cullFrame = useRef(0);
  const seamAnimation = useRef<{ stop(): void } | null>(null);
  const cameras = useRef(initial.wallCameras ?? {});
  const manualScale = useRef(initial.wallManualScale ?? false);
  const previousWidth = useRef(width);
  const settling = useRef<{
    token: number;
    pending: Set<string>;
    timer?: ReturnType<typeof setTimeout>;
  } | null>(null);

  const renderFrame = useCallback(() => {
    const c = camera.current,
      f = frame.current;
    ref.current?.setAttribute("data-camera", JSON.stringify(c));
    const geometry = getSeamGeometry({
      anchorX: anchorRef.current,
      cameraX: c.x,
      openWidth: f.openWidth,
      view: { width: f.width, height: f.height, scale: c.scale },
    });
    const split = getSeamSplitOffsets(geometry.width, c.scale, WALL_METRICS);
    const x = f.width / 2 - c.x * c.scale,
      y = f.height / 2 - c.y * c.scale;
    if (left.current)
      left.current.style.transform = formatWorldTransform(
        x + split.left,
        y,
        c.scale,
      );
    if (right.current)
      right.current.style.transform = formatWorldTransform(
        x + split.right,
        y,
        c.scale,
      );
    if (seam.current) {
      seam.current.style.transform = `translate3d(${geometry.screenX - geometry.width / 2}px,0,0)`;
      seam.current.style.width = `${geometry.width}px`;
      seam.current.style.visibility =
        f.navigation && geometry.width >= 2 ? "visible" : "hidden";
      seam.current.inert =
        !f.navigation || geometry.width < Math.min(48, f.targetWidth);
    }
    const splitX = f.targetWidth ? geometry.screenX : f.width / 2;
    if (emptyLeft.current)
      emptyLeft.current.style.right = `${Math.max(0, f.width - splitX + geometry.width / 2)}px`;
    if (emptyRight.current)
      emptyRight.current.style.left = `${Math.max(0, splitX + geometry.width / 2)}px`;
    if (seamBody.current)
      seamBody.current.style.opacity = String(
        Math.min(1, geometry.width / Math.max(1, f.targetWidth)),
      );
    if (tab.current) {
      tab.current.style.display =
        f.navigation && (f.targetWidth === 0 || geometry.collapsed)
          ? ""
          : "none";
      tab.current.dataset.side = geometry.side;
    }
    if (percent.current)
      percent.current.textContent = `${Math.round(c.scale * 100)}%`;
  }, []);
  useLayoutEffect(
    () => renderFrame(),
    [Boolean(navigation?.empty), renderFrame],
  );
  const recull = useCallback((force = false) => {
    const f = frame.current,
      visible = worldBounds(
        camera.current,
        f.width,
        f.height,
        Math.max(f.openWidth, f.targetWidth),
      );
    if (!force && !needsWallCull(visible, bounds.current)) return;
    if (cullFrame.current) return;
    cullFrame.current = requestAnimationFrame(() => {
      cullFrame.current = 0;
      const f = frame.current;
      bounds.current = worldBounds(
        camera.current,
        f.width,
        f.height,
        Math.max(f.openWidth, f.targetWidth),
      );
      setCullCamera({ ...camera.current });
    });
  }, []);
  const constrain = useCallback((c: Camera, dragging = false) => {
    const f = frame.current,
      d = displayRef.current;
    const clamped = clampWallCamera(c, f, d.source.total, modeRef.current);
    // The finite wall's camera span also includes its seam, so opening it is not clamped away.
    if (f.targetWidth > 0 && modeRef.current === "finite") {
      const world = finiteWallBounds(d.source.total),
        half = f.width / (2 * c.scale);
      const min = Math.min(
        world.width <= half * 2 ? world.width / 2 : half,
        anchorRef.current - (f.width / 2 - f.targetWidth / 2 - 14) / c.scale,
      );
      const max = Math.max(
        world.width <= half * 2 ? world.width / 2 : world.width - half,
        anchorRef.current + (f.width / 2 - f.targetWidth / 2 - 14) / c.scale,
      );
      clamped.x = Math.max(min, Math.min(max, c.x));
    }
    return dragging
      ? {
          ...c,
          x: clamped.x + (c.x - clamped.x) * 0.35,
          y: clamped.y + (c.y - clamped.y) * 0.35,
        }
      : clamped;
  }, []);
  const apply = useCallback(
    (c: Camera, dragging = false) => {
      camera.current = constrain(c, dragging);
      renderFrame();
      recull();
    },
    [constrain, renderFrame, recull],
  );
  const persist = useCallback(() => {
    const p = latest.current,
      d = displayRef.current;
    if (!initialized.current || (p.scope && scopeKey(p.scope) !== d.key))
      return;
    cameras.current = {
      ...cameras.current,
      [modeRef.current]: { ...camera.current },
    };
    p.remember({
      wallLayoutVersion: WALL_LAYOUT_VERSION,
      wallManualScale: manualScale.current,
      camera: { ...camera.current },
      wallCameras: cameras.current,
      wallMode: modeRef.current,
      seam: {
        anchor: anchorRef.current,
        hidden: seamSession?.level === "hidden",
      },
      wallStartSlotKey: d.start,
      wallFocusedSlotKey: keyboardFocus.current,
    });
  }, []);
  const motionRef = useRef<{ stop(): void; travel(c: Camera): void } | null>(
    null,
  );
  const rest = useCallback(() => {
    const f = frame.current;
    const menuX =
      f.width / 2 +
      (anchorRef.current - camera.current.x) * camera.current.scale;
    if (seamSession.level !== "hidden" && (menuX < 0 || menuX > f.width)) {
      seamSession.restore = seamSession.level;
      seamSession.level = "hidden";
      setLevelState("hidden");
      setSearchActive(false);
      window.dispatchEvent(new Event("wall:search-dismiss"));
    }
    const target = constrain(camera.current);
    if (
      Math.hypot(target.x - camera.current.x, target.y - camera.current.y) > 0.5
    )
      motionRef.current?.travel(target);
    else {
      recull(true);
      persist();
    }
  }, [constrain, persist, recull]);
  const motion = useWallMotion({
    container: ref,
    camera,
    viewport: { width, height },
    interactive: props.interactive && stageReady,
    reduced: props.reducedMotion,
    apply,
    reserve: (target) => {
      const f = frame.current,
        from = worldBounds(camera.current, f.width, f.height, f.targetWidth),
        to = worldBounds(target, f.width, f.height, f.targetWidth);
      const merged = {
        left: Math.min(from.left, to.left),
        right: Math.max(from.right, to.right),
        top: Math.min(from.top, to.top),
        bottom: Math.max(from.bottom, to.bottom),
      };
      const area = (b: Bounds) => (b.right - b.left) * (b.bottom - b.top);
      bounds.current = area(merged) > area(to) * 3 ? to : merged;
      const b = bounds.current;
      setCullCamera({
        x: (b.left + b.right) / 2,
        y: (b.top + b.bottom) / 2,
        scale: Math.min(
          f.width / (b.right - b.left),
          f.height / (b.bottom - b.top),
        ),
      });
    },
    rest,
    zoomed: () => {
      manualScale.current = true;
    },
  });
  motionRef.current = motion;
  const settled = useCallback(
    (slot: string, token: number) => {
      const s = settling.current;
      if (!s || s.token !== token) return;
      s.pending.delete(slot);
      if (!s.pending.size) {
        clearTimeout(s.timer);
        settling.current = null;
        setExitingTiles([]);
        wallTransition.settle(token);
        ref.current?.removeAttribute("data-wall-settling");
      }
    },
    [ref],
  );

  const tiles = useMemo(() => {
    if (!display.source.total) return exitingTiles;
    const f = frame.current;
    const all = visibleWall(
      cullCamera,
      width + Math.max(f.openWidth, f.targetWidth) * 2,
      height,
      display.source.total,
      mode,
      display.offset,
    );
    if (!selected) return all;
    const expanded = expandedBlock(
        selected,
        display.source.total,
        mode,
        display.offset,
      ),
      map = new Map(expanded.map((t) => [t.key, t]));
    const result = all.map((t) => map.get(t.key) ?? t),
      seen = new Set(result.map((t) => t.key));
    return [...result, ...expanded.filter((t) => !seen.has(t.key))];
  }, [
    cullCamera,
    width,
    height,
    display,
    display.source.total,
    mode,
    selected,
    exitingTiles,
  ]);
  const tilesRef = useRef(tiles);
  tilesRef.current = tiles;
  const indices = [...new Set(tiles.map((t) => t.index))]
    .sort((a, b) => a - b)
    .join(",");
  useEffect(() => {
    if (display.source === props.source)
      void display.source.ensure(
        indices.split(",").filter(Boolean).map(Number),
      );
  }, [display.source, props.source, indices]);

  // Keep the outgoing display until all target-visible metadata is available. Only this effect
  // may commit a new source; each await is guarded against rapid navigation and late page loads.
  useLayoutEffect(() => {
    const generation = ++serial.current;
    if (!props.source.getSnapshot().ready) {
      setStageReady(false);
      motion.stop();
      return;
    }
    let live = true;
    const commit = async () => {
      const p = props,
        previous = displayRef.current,
        m = migrateWallMemory(p.memory);
      const changed = previous.source !== p.source || previous.key !== key;
      if (!changed && initialized.current && !p.memory.revealFocus) {
        setStageReady(true);
        return;
      }
      motion.stop();
      setStageReady(false);
      const sameFamily = previous.source.query.type === p.source.query.type;
      const keepViewport = initialized.current && sameFamily;
      const nextMode = keepViewport
        ? modeRef.current
        : (m.wallMode ?? modeRef.current);
      const start =
        initialized.current &&
        wallTransition.direction === "push" &&
        wallTransition.startSlotKey
          ? wallTransition.startSlotKey
          : p.memory.wallLayoutVersion === WALL_LAYOUT_VERSION
            ? m.wallStartSlotKey
            : undefined;
      const offset = getStartWrapOffset(parseSlot(start), p.source.total);
      let target = keepViewport
        ? { ...camera.current }
        : (m.wallCameras?.[nextMode] ??
          m.camera ??
          (changed && initialized.current
            ? { ...camera.current }
            : { ...initialCamera }));
      if (!keepViewport && !m.wallManualScale)
        target = { ...target, scale: defaultWallScale(width) };
      const index = resolveFocusIndex(p.source, m);
      let focused: WallTile | null = null;
      if (m.focusId && p.source.total) {
        const address = parseSlot(m.wallFocusedSlotKey);
        const saved = address
          ? tileAt(
              address.column,
              address.row,
              address.slotIndex,
              p.source.total,
              nextMode,
              offset,
            )
          : null;
        focused =
          saved && p.source.peek(saved.index)?.id === m.focusId
            ? saved
            : nearestTile(index, target, p.source.total, nextMode, offset);
        if (
          !initialized.current &&
          (p.memory.revealFocus ||
            p.memory.wallLayoutVersion !== WALL_LAYOUT_VERSION)
        ) {
          const rect =
            expandedBlock(focused, p.source.total, nextMode, offset).find(
              (t) => t.key === focused!.key,
            ) ?? focused;
          target = {
            x: rect.x + rect.width / 2,
            y: rect.y + rect.height / 2,
            scale: Math.max(
              0.45,
              Math.min(defaultWallScale(width), (height - 160) / rect.height),
            ),
          };
        }
      }
      let nextAnchor = initialized.current
        ? anchorRef.current
        : (m.seam?.anchor ?? anchorRef.current);
      if (!initialized.current && navigation && targetWidth > 0) {
        const screenX = width / 2 + (nextAnchor - target.x) * target.scale;
        const plan = blockSeamPlan({
          cameraX: target.x,
          openWidth: targetWidth,
          view: { width, height, scale: target.scale },
          metrics: WALL_METRICS,
          preferX: screenX > 0 && screenX < width ? nextAnchor : undefined,
        });
        nextAnchor = plan.x;
        target = { ...target, x: plan.cameraX };
      }
      if (!initialized.current)
        target = clampWallCamera(
          target,
          { width, height },
          p.source.total,
          nextMode,
        );
      const upcoming = visibleWall(
        target,
        width + targetWidth * 2,
        height,
        p.source.total,
        nextMode,
        offset,
      );
      // Include the outgoing viewport too: slots retain identity while the camera returns.
      const outgoing = tilesRef.current;
      const union = new Map(outgoing.map((t) => [t.key, t]));
      for (const t of upcoming) union.set(t.key, t);
      const nextTiles = p.source.total
        ? [...union.values()]
            .map((t) =>
              tileAt(t.column, t.row, t.slot, p.source.total, nextMode, offset),
            )
            .filter(
              (t) =>
                nextMode !== "finite" ||
                (t.index >= 0 && t.index < p.source.total),
            )
        : outgoing.map((tile) => ({ ...tile, index: -1 }));
      await p.source.ensure(nextTiles.map((t) => t.index));
      if (!live || generation !== serial.current) return;
      if (p.source.getSnapshot().error && p.source.total) {
        wallTransition.settle(wallTransition.token);
        setStageReady(true);
        return;
      }
      const before = new Map(
        outgoing.map((t) => [t.key, previous.source.peek(t.index)?.id ?? null]),
      );
      const after = new Map(
        nextTiles.map((t) => [t.key, p.source.peek(t.index)?.id ?? null]),
      );
      const token = wallTransition.token;
      const originAddress = parseSlot(wallTransition.startSlotKey);
      const originTile = originAddress
        ? tileAt(
            originAddress.column,
            originAddress.row,
            originAddress.slotIndex,
            Math.max(1, p.source.total),
          )
        : null;
      const origin = originTile
        ? {
            kind: "point" as const,
            x: originTile.x + originTile.width / 2,
            y: originTile.y + originTile.height / 2,
          }
        : { kind: "point" as const, x: nextAnchor, y: target.y };
      const plan = planWallChange({
        token,
        tiles: nextTiles,
        before,
        after,
        origin,
        visible: worldBounds(
          camera.current,
          width,
          height,
          targetWidth + 420 * camera.current.scale,
        ),
        kind: wallTransition.kind,
        reduced: p.reducedMotion,
      });
      clearTimeout(settling.current?.timer);
      if (initialized.current && changed) {
        settling.current = { token, pending: new Set(plan.steps.keys()) };
        // A computed safety bound covers unmounted slots and backgrounded/aborted WAAPI animations.
        settling.current.timer = setTimeout(() => {
          if (settling.current?.token === token) {
            settling.current = null;
            setExitingTiles([]);
            wallTransition.settle(token);
            ref.current?.removeAttribute("data-wall-settling");
          }
        }, plan.durationMs + 250);
        setSteps(plan.steps);
        if (plan.steps.size)
          ref.current?.setAttribute("data-wall-settling", String(token));
        else wallTransition.settle(token);
      } else {
        setSteps(new Map());
        wallTransition.settle(token);
      }
      const next = { source: p.source, key, offset, start };
      setExitingTiles(p.source.total ? [] : nextTiles);
      displayRef.current = next;
      setDisplay(next);
      modeRef.current = nextMode;
      setMode(nextMode);
      if (!keepViewport) {
        cameras.current = m.wallCameras ?? {};
        manualScale.current = m.wallManualScale ?? false;
      }
      anchorRef.current = nextAnchor;
      setAnchor(nextAnchor);
      keyboardFocus.current = focused?.key;
      const expandedFocus =
        focused && !p.source.peek(focused.index)?.kind ? focused : null;
      selectedRef.current = expandedFocus;
      setSelected(expandedFocus);
      initialized.current = true;
      const returning =
        changed &&
        !sameFamily &&
        wallTransition.direction === "back" &&
        Boolean(m.camera) &&
        !p.reducedMotion;
      if (!returning) camera.current = target;
      renderFrame();
      bounds.current = null;
      setCullCamera({ ...target });
      setStageReady(true);
      p.remember({
        ...m,
        revealFocus: false,
        wallLayoutVersion: WALL_LAYOUT_VERSION,
        camera: target,
        wallStartSlotKey: start,
        wallFocusedSlotKey: focused?.key,
      });
      if (returning) motion.travel(target);
      else persist();
    };
    void commit();
    return () => {
      live = false;
    };
  }, [
    props.source,
    props.source.getSnapshot().ready,
    props.memory.focusRequest,
    key,
  ]);

  useLayoutEffect(() => {
    if (previousWidth.current !== width && !manualScale.current)
      apply({ ...camera.current, scale: defaultWallScale(width) });
    previousWidth.current = width;
    renderFrame();
    recull(true);
  }, [width, height, anchor, renderFrame, recull, apply]);
  useLayoutEffect(() => {
    seamAnimation.current?.stop();
    const from = frame.current.openWidth;
    if (props.reducedMotion) {
      frame.current.openWidth = targetWidth;
      renderFrame();
      recull(true);
      return;
    }
    seamAnimation.current = animate(from, targetWidth, {
      duration: 0.36,
      ease: [0.65, 0, 0.35, 1],
      onUpdate: (value) => {
        frame.current.openWidth = value;
        renderFrame();
        recull();
      },
      onComplete: () => {
        recull(true);
        persist();
      },
    });
    return () => seamAnimation.current?.stop();
  }, [targetWidth, props.reducedMotion, renderFrame, recull, persist]);
  useEffect(() => {
    const flush = () => persist();
    window.addEventListener("wall:flush", flush);
    window.addEventListener("blur", flush);
    return () => {
      window.removeEventListener("wall:flush", flush);
      window.removeEventListener("blur", flush);
      motion.stop();
      persist();
      cancelAnimationFrame(cullFrame.current);
      clearTimeout(settling.current?.timer);
      wallTransition.settle(wallTransition.token);
    };
  }, [motion.stop, persist]);
  useEffect(() => {
    if (
      !props.source.getSnapshot().refreshSerial ||
      display.source !== props.source ||
      !selectedRef.current
    )
      return;
    const old = selectedRef.current;
    const next = nearestTile(
      props.source.getSnapshot().anchorIndex,
      camera.current,
      props.source.total,
      modeRef.current,
      display.offset,
    );
    selectedRef.current = next;
    keyboardFocus.current = next.key;
    setSelected(next);
    props.remember({
      focusId: props.source.peek(next.index)?.id,
      focusIndex: next.index,
      wallFocusedSlotKey: next.key,
    });
    apply({
      ...camera.current,
      x: camera.current.x + next.x - old.x,
      y: camera.current.y + next.y - old.y,
    });
    persist();
  }, [props.source.getSnapshot().refreshSerial]);

  const focus = useCallback(
    (tile: WallTile) => {
      const p = latest.current,
        d = displayRef.current;
      if (p.source !== d.source) return;
      const item = d.source.peek(tile.index);
      if (!item) return;
      keyboardFocus.current = tile.key;
      if (selectedRef.current?.key === tile.key || item.kind) {
        p.remember({
          focusId: item.id,
          focusIndex: tile.index,
          wallFocusedSlotKey: tile.key,
        });
        persist();
        p.open(item, tile.index);
        return;
      }
      p.select?.(item, tile.index);
      selectedRef.current = tile;
      setSelected(tile);
      p.remember({
        focusId: item.id,
        wallFocusId: item.id,
        focusIndex: tile.index,
        wallFocusedSlotKey: tile.key,
      });
      const grown = expandedBlock(
        tile,
        d.source.total,
        modeRef.current,
        d.offset,
      ).find((t) => t.key === tile.key)!;
      const f = frame.current,
        scale = Math.max(
          0.45,
          Math.min(
            camera.current.scale,
            (f.height - 160) / grown.height,
            (f.width - f.targetWidth - 48) / grown.width,
          ),
        );
      motionRef.current?.travel({
        x:
          grown.x +
          grown.width / 2 +
          ((grown.x < anchorRef.current ? -1 : 1) * f.targetWidth) /
            (2 * scale),
        y: grown.y + grown.height / 2,
        scale,
      });
    },
    [persist],
  );
  const handlers = useMemo<
    Pick<LayoutProps, "favorite" | "select" | "contextMenu" | "removeRecent">
  >(
    () => ({
      favorite: (item) => latest.current.favorite(item),
      select: (item, index, event) =>
        latest.current.select?.(item, index, event),
      contextMenu: (item, index, event) =>
        latest.current.contextMenu?.(item, index, event),
      removeRecent: (item) => latest.current.removeRecent?.(item),
    }),
    [],
  );
  useWindowKey((event) => {
    if (!canHandleKey(event, props.interactive && stageReady)) return;
    if (event.key === "Escape" && selectedRef.current) {
      event.preventDefault();
      selectedRef.current = null;
      keyboardFocus.current = undefined;
      setSelected(null);
      props.remember({
        focusId: undefined,
        wallFocusId: undefined,
        wallFocusedSlotKey: undefined,
      });
      props.clearFocus?.();
      persist();
      return;
    }
    if (event.key === "Enter" && selectedRef.current) {
      event.preventDefault();
      const t = selectedRef.current,
        item = display.source.peek(t.index);
      if (item) props.open(item, t.index);
      return;
    }
    const direction = (
      {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
      } as Record<string, number[]>
    )[event.key];
    if (!direction) return;
    if (
      (event.target as HTMLElement).closest(
        ".wall-seam,.wall-tools,.seam-recall",
      )
    )
      return;
    event.preventDefault();
    motion.stop();
    const from = selectedRef.current;
    const candidates = visibleWall(
      camera.current,
      width * 2,
      height * 2,
      display.source.total,
      mode,
      display.offset,
    );
    const cx = from ? from.x + from.width / 2 : camera.current.x,
      cy = from ? from.y + from.height / 2 : camera.current.y;
    const score = (t: WallTile) => {
      const dx = t.x + t.width / 2 - cx,
        dy = t.y + t.height / 2 - cy;
      return (
        Math.hypot(dx, dy) + Math.abs(dx * direction[1] - dy * direction[0]) * 2
      );
    };
    const next = candidates
      .filter(
        (t) =>
          t.key !== from?.key &&
          (t.x + t.width / 2 - cx) * direction[0] +
            (t.y + t.height / 2 - cy) * direction[1] >
            1,
      )
      .sort((a, b) => score(a) - score(b))[0];
    if (next) {
      const source = display.source;
      void source.at(next.index).then(() => {
        if (latest.current.source === source) focus(next);
      });
    }
  });
  const changeLevel = (
    next: SeamLevel,
    desiredWidth = seamWidthFor(next, false),
    remember = true,
  ) => {
    motion.stop();
    if (remember && next === "hidden" && level !== "hidden")
      seamSession!.restore = level;
    seamSession!.level = next;
    setLevelState(next);
    if (next !== "hidden") {
      const c = camera.current,
        f = frame.current,
        screenX = width / 2 + (anchorRef.current - c.x) * c.scale;
      const need = Math.min(desiredWidth, width - 48) / 2 + 24;
      if (screenX >= need && screenX <= width - need) {
        persist();
        return;
      }
      const plan = blockSeamPlan({
        cameraX: c.x,
        openWidth: Math.min(desiredWidth, width - 48),
        view: { width, height, scale: c.scale },
        metrics: WALL_METRICS,
        preferX: screenX > 0 && screenX < width ? anchorRef.current : undefined,
      });
      anchorRef.current = plan.x;
      setAnchor(plan.x);
      motion.travel({ ...c, x: plan.cameraX });
    } else persist();
  };
  const title =
    props.scope?.folder?.split(/[\\/]/).filter(Boolean).at(-1) ??
    navigation?.title ??
    "媒体库";
  useEffect(() => {
    if (navigation?.empty?.requiresNavigation && level === "hidden")
      changeLevel(
        seamSession.restore === "hidden" ? "spine" : seamSession.restore,
      );
  }, [key, navigation?.empty?.requiresNavigation]);
  useEffect(() => {
    const presentation = (event: Event) => {
      const open = (event as CustomEvent).detail === true;
      if (open) {
        if (!searchActive)
          searchRestore.current = {
            level,
            restore: seamSession.restore,
            camera: { ...camera.current },
            anchor: anchorRef.current,
          };
        setSearchActive(true);
        changeLevel("full", 360, false);
      } else if (searchActive) {
        setSearchActive(false);
        seamSession.restore = searchRestore.current.restore;
        anchorRef.current = searchRestore.current.anchor;
        setAnchor(searchRestore.current.anchor);
        apply(searchRestore.current.camera);
        changeLevel(searchRestore.current.level, undefined, false);
      }
    };
    window.addEventListener("wall:search-presentation", presentation);
    return () =>
      window.removeEventListener("wall:search-presentation", presentation);
  });
  return (
    <div
      ref={ref}
      className={`bravais-wall ${selected ? "has-focus" : ""}`}
      data-layout="bravais"
      data-layout-ready={stageReady && display.source === props.source}
      data-renders={renderCount.current}
      aria-label="Bravais 墙面"
      {...motion.pointer}
      onDragStart={(e) => e.preventDefault()}
    >
      {(["left", "right"] as const).map((side) => (
        <div
          ref={side === "left" ? left : right}
          className="wall-plane"
          data-wall-half={side}
          key={side}
        >
          {tiles
            .filter((t) => (t.x < anchor ? "left" : "right") === side)
            .map((tile) => (
              <WallTileFace
                key={tile.key}
                tile={tile}
                item={display.source.peek(tile.index)}
                active={selected?.key === tile.key}
                reduced={props.reducedMotion}
                selected={Boolean(
                  display.source.peek(tile.index) &&
                  (props.selected?.(
                    display.source.peek(tile.index)!,
                    tile.index,
                  ) ||
                    keyboardFocus.current === tile.key),
                )}
                step={steps.get(tile.key)}
                activate={focus}
                settled={settled}
                favorite={handlers.favorite}
                select={handlers.select}
                contextMenu={handlers.contextMenu}
                removeRecent={
                  props.removeRecent ? handlers.removeRecent : undefined
                }
              />
            ))}
        </div>
      ))}
      {navigation?.empty && (
        <div className="wall-empty-pair" aria-live="polite">
          {(["left", "right"] as const).map((side) => (
            <section
              ref={side === "left" ? emptyLeft : emptyRight}
              className="wall-empty-half"
              data-empty-half={side}
              key={side}
              style={
                side === "left"
                  ? { right: "calc(50% + " + targetWidth / 2 + "px)" }
                  : { left: "calc(50% + " + targetWidth / 2 + "px)" }
              }
            >
              <p>{navigation.empty!.message}</p>
              {navigation.empty!.action && (
                <button
                  className="button secondary"
                  onClick={navigation.empty!.action}
                >
                  {navigation.empty!.actionLabel}
                </button>
              )}
            </section>
          ))}
        </div>
      )}
      {navigation && (
        <>
          <aside
            ref={seam}
            className={`wall-seam wall-seam-${level}`}
            aria-label="当前内容导航"
            data-seam-level={level}
          >
            <div className="seam-controls">
              <button
                aria-label={level === "spine" ? "展开内容导航" : "收为书脊"}
                onClick={() =>
                  changeLevel(level === "spine" ? "full" : "spine")
                }
              >
                <PanelLeftOpen size={16} />
              </button>
              <button
                aria-label="隐藏内容导航"
                onClick={() => changeLevel("hidden")}
              >
                <PanelLeftClose size={16} />
              </button>
            </div>
            <div ref={seamBody} className="wall-seam-content">
              <WallSeamContent
                width={targetWidth || seamWidthFor(seamSession!.restore, home)}
                identity={display.key}
                reduced={props.reducedMotion}
                content={shownNavigation.current?.content}
                spine={level === "spine"}
                spineContent={shownNavigation.current?.spineContent}
                title={String(title)}
                expand={() => changeLevel("full")}
              />
            </div>
          </aside>
          <button
            ref={tab}
            className="seam-recall"
            aria-label="在当前位置打开内容导航"
            onClick={() =>
              changeLevel(
                seamSession!.restore === "hidden"
                  ? defaultSeamLevel(width)
                  : seamSession!.restore,
              )
            }
          >
            {title}
            {navigation.filter?.query && (
              <span className="wall-filter-count">
                {navigation.filter.query}
              </span>
            )}
          </button>
          {level === "hidden" && navigation.filter?.query && (
            <button
              className="wall-filter-clear"
              aria-label="清除当前视图过滤"
              onClick={navigation.filter.clear}
            >
              清除过滤
            </button>
          )}
        </>
      )}
      <div className="wall-tools">
        <button
          type="button"
          className={`wall-mode-toggle ${mode === "infinite" ? "active" : ""}`}
          aria-label={`当前为${mode === "infinite" ? "无限" : "有限"}墙面，切换到${mode === "infinite" ? "有限" : "无限"}墙面`}
          aria-pressed={mode === "infinite"}
          onClick={() => {
            motion.stop();
            const next = mode === "infinite" ? "finite" : "infinite";
            cameras.current[mode] = camera.current;
            modeRef.current = next;
            setMode(next);
            const t = nearestTile(
              selectedRef.current?.index ??
                resolveFocusIndex(display.source, props.memory),
              camera.current,
              display.source.total,
              next,
              display.offset,
            );
            if (selectedRef.current) {
              selectedRef.current = t;
              setSelected(t);
            }
            if (keyboardFocus.current) keyboardFocus.current = t.key;
            apply(
              cameras.current[next] ?? {
                ...camera.current,
                x: t.x + t.width / 2,
                y: t.y + t.height / 2,
              },
            );
            recull(true);
            persist();
          }}
        >
          ∞
        </button>
        <IconButton
          label="缩小墙面"
          onClick={() => {
            motion.stop();
            manualScale.current = true;
            apply(
              zoomAt(
                camera.current,
                camera.current.scale / 1.15,
                { x: width / 2, y: height / 2 },
                { width, height },
              ),
            );
            persist();
          }}
        >
          <Minus size={16} />
        </IconButton>
        <span ref={percent}>{Math.round(camera.current.scale * 100)}%</span>
        <IconButton
          label="放大墙面"
          onClick={() => {
            motion.stop();
            manualScale.current = true;
            apply(
              zoomAt(
                camera.current,
                camera.current.scale * 1.15,
                { x: width / 2, y: height / 2 },
                { width, height },
              ),
            );
            persist();
          }}
        >
          <Plus size={16} />
        </IconButton>
        <IconButton
          label="定位焦点"
          onClick={() => {
            const t = selectedRef.current;
            if (t) {
              selectedRef.current = null;
              focus(t);
            } else
              motion.travel({
                x: anchorRef.current,
                y: height / (2 * defaultWallScale(width)),
                scale: defaultWallScale(width),
              });
          }}
        >
          <Focus size={16} />
        </IconButton>
      </div>
    </div>
  );
}
