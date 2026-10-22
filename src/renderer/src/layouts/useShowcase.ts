import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
  type MouseEvent,
} from "react";
import {
  canHandleKey,
  resolveFocusIndex,
  useViewport,
  useWindowKey,
  type LayoutProps,
} from "./shared";
import {
  boundShowcase,
  showcaseGeometry,
  showcaseIndex,
  showcasePose,
  showcaseRelease,
  showcaseSlots,
  type ShowcaseKind,
} from "./showcaseModel";
import type { WallMode } from "../../../shared/types";
import { report } from "../store";

/** One continuous coordinate; only crossing an item boundary rerenders React. */
export function useShowcase(props: LayoutProps, kind: ShowcaseKind) {
  const { source, memory, interactive } = props;
  const { ref, width, height } = useViewport();
  const latest = useRef(props);
  latest.current = props;
  const [mode, setMode] = useState<WallMode>(
    memory.showcaseMode === "finite" ? "finite" : "infinite",
  );
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const [hidden, setHidden] = useState(document.hidden);
  const [systemReduced, setSystemReduced] = useState(
    () => matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const reduced = props.reducedMotion || systemReduced;
  const [lane, setLane] = useState(() => resolveFocusIndex(source, memory));
  const position = useRef(lane),
    laneRef = useRef(lane);
  const [moving, setMoving] = useState(false);
  const nodes = useRef(new Map<number, HTMLDivElement>());
  const frame = useRef(0),
    timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const target = useRef<number | null>(null),
    serial = useRef(0);
  const mounted = useRef(true);
  const drag = useRef<{
    id: number;
    x: number;
    position: number;
    lastX: number;
    lastAt: number;
    velocity: number;
    moved: boolean;
  } | null>(null);
  const suppressClick = useRef(false);
  const externalDragging = useRef(false);
  const geometry = showcaseGeometry(kind, width, height);
  const slots = showcaseSlots(lane, source.total, width, mode);
  const index = showcaseIndex(lane, source.total),
    item = source.peek(index);
  const snapshot = source.getSnapshot();
  const paint = useRef(() => {});
  paint.current = () => {
    for (const [slot, node] of nodes.current) {
      const pose = showcasePose(kind, slot, position.current, geometry);
      node.style.transform = pose.transform;
      node.style.opacity = String(pose.opacity);
      node.style.zIndex = String(pose.zIndex);
      node.style.setProperty("--showcase-focus", String(pose.focus));
    }
  };
  useLayoutEffect(() => paint.current());
  function cancel() {
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    clearTimeout(timer.current);
    target.current = null;
  }
  function move(value: number) {
    position.current = boundShowcase(value, source.total, modeRef.current);
    const rounded = Math.round(position.current);
    if (rounded !== laneRef.current) {
      laneRef.current = rounded;
      setLane(rounded);
    }
    paint.current();
  }
  function remember() {
    const at = showcaseIndex(position.current, source.total),
      entry = source.peek(at);
    if (entry) latest.current.remember({ focusId: entry.id, focusIndex: at });
  }
  function settle() {
    // Normalize loops between gestures so the coordinate never grows unbounded.
    move(showcaseIndex(position.current, source.total));
    setMoving(false);
    remember();
  }
  function centre(value: number, settled?: () => void) {
    ++serial.current;
    cancel();
    const next = boundShowcase(
        Math.round(value),
        source.total,
        modeRef.current,
      ),
      from = position.current;
    if (Math.abs(next - from) > 0.001) latest.current.onBrowseMotion?.();
    if (reduced || hidden || Math.abs(next - from) < 0.001) {
      move(next);
      settle();
      settled?.();
      return;
    }
    target.current = next;
    setMoving(true);
    const began = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - began) / 360);
      move(from + (next - from) * (1 - (1 - t) ** 3));
      if (t < 1) frame.current = requestAnimationFrame(tick);
      else {
        frame.current = 0;
        target.current = null;
        settle();
        settled?.();
      }
    };
    frame.current = requestAnimationFrame(tick);
  }
  function step(delta: number) {
    if (!latest.current.interactive || source.total < 2) return;
    centre((target.current ?? Math.round(position.current)) + delta);
  }
  function openCurrent() {
    if (!latest.current.interactive) return;
    ++serial.current;
    cancel();
    settle();
    const at = showcaseIndex(position.current, source.total),
      entry = source.peek(at);
    if (entry) latest.current.open(entry, at);
  }
  function activate(slot: number) {
    if (!latest.current.interactive) return;
    const at = showcaseIndex(slot, source.total),
      entry = source.peek(at);
    if (!entry) return;
    if (latest.current.playInline) {
      const centred =
        Math.abs(position.current - slot) < 0.03 && !frame.current;
      if (entry.kind) {
        const request = ++serial.current;
        void latest.current
          .resolveSingle?.(entry)
          .then((single) => {
            if (!mounted.current || serial.current !== request) return;
            if (single)
              centre(
                slot,
                () => void latest.current.playInline?.(single, at, entry),
              );
            else if (centred) latest.current.open(entry, at);
            else centre(slot);
          })
          .catch((error) => {
            if (mounted.current && request === serial.current) report(error);
          });
      } else if (centred) {
        cancel();
        settle();
        void latest.current.playInline(entry, at, entry);
      } else centre(slot);
      return;
    }
    if (Math.abs(position.current - slot) < 0.03 && !frame.current) {
      openCurrent();
      return;
    }
    if (entry.kind === "folder" && latest.current.openSingle) {
      const request = ++serial.current;
      void latest.current.openSingle(entry, at).then((opened) => {
        if (!mounted.current || request !== serial.current) return;
        if (opened === false) centre(slot);
        else if (opened === true) {
          cancel();
          move(slot);
          settle();
        }
      });
    } else centre(slot);
  }
  function changeMode(next: WallMode) {
    if (!latest.current.interactive || next === modeRef.current) return;
    latest.current.onBrowseMotion?.();
    ++serial.current;
    cancel();
    drag.current = null;
    const at = showcaseIndex(position.current, source.total);
    modeRef.current = next;
    setMode(next);
    move(at);
    settle();
    latest.current.remember({ showcaseMode: next });
  }
  function contextMenu(slot: number, event: MouseEvent) {
    if (!latest.current.interactive) return;
    const at = showcaseIndex(slot, source.total),
      entry = source.peek(at);
    if (!entry) return;
    ++serial.current;
    cancel();
    move(slot);
    settle();
    latest.current.select?.(entry, at);
    latest.current.contextMenu?.(entry, at, event);
  }
  useLayoutEffect(() => {
    if (!snapshot.ready) return;
    ++serial.current;
    cancel();
    drag.current = null;
    externalDragging.current = false;
    move(resolveFocusIndex(source, latest.current.memory));
    setMoving(false);
    if (latest.current.memory.revealFocus)
      latest.current.remember({ revealFocus: false });
  }, [source, snapshot.ready, snapshot.refreshSerial, memory.focusRequest]);
  const wanted = [
    ...new Set(slots.map((slot) => showcaseIndex(slot, source.total))),
  ].join(",");
  useEffect(() => {
    if (wanted) void source.ensure(wanted.split(",").map(Number));
  }, [source, wanted]);
  useEffect(() => {
    if (item && snapshot.ready && interactive) {
      latest.current.select?.(item, index);
      remember();
    }
  }, [item, index, snapshot.ready, interactive]);
  useEffect(() => {
    if (!interactive || reduced || hidden) {
      cancel();
      drag.current = null;
      move(Math.round(position.current));
      setMoving(false);
      remember();
    }
  }, [interactive, reduced, hidden]);
  const lifecycle = useRef({ cancel, centre, remember });
  lifecycle.current = { cancel, centre, remember };
  useEffect(() => {
    mounted.current = true;
    const query = matchMedia("(prefers-reduced-motion: reduce)");
    const changed = () => setSystemReduced(query.matches);
    const visibility = () => setHidden(document.hidden);
    const blur = () => {
      if (externalDragging.current) return;
      drag.current = null;
      suppressClick.current = false;
      lifecycle.current.centre(Math.round(position.current));
    };
    query.addEventListener("change", changed);
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("blur", blur);
    return () => {
      mounted.current = false;
      externalDragging.current = false;
      ++serial.current;
      query.removeEventListener("change", changed);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("blur", blur);
      lifecycle.current.cancel();
      lifecycle.current.remember();
    };
  }, [source]);
  const wheelHandler = useRef<(event: WheelEvent) => void>(() => {});
  wheelHandler.current = (event) => {
    if (
      !latest.current.interactive ||
      source.total < 2 ||
      event.ctrlKey ||
      event.metaKey ||
      (event.target as HTMLElement | null)?.closest(
        ".showcase-caption, .showcase-heading, .showcase-pagination",
      )
    )
      return;
    event.preventDefault();
    latest.current.onBrowseMotion?.();
    ++serial.current;
    cancel();
    const delta =
      (Math.abs(event.deltaX) > Math.abs(event.deltaY)
        ? event.deltaX
        : event.deltaY) *
      (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? width : 1);
    if (reduced) timer.current = setTimeout(() => step(Math.sign(delta)), 65);
    else {
      move(position.current + delta / (geometry.pitch * 2));
      setMoving(true);
      timer.current = setTimeout(() => centre(position.current), 100);
    }
  };
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const wheel = (event: WheelEvent) => wheelHandler.current(event);
    node.addEventListener("wheel", wheel, { passive: false });
    return () => node.removeEventListener("wheel", wheel);
  }, []);
  useWindowKey((event) => {
    if (
      !canHandleKey(event, latest.current.interactive) ||
      !source.total ||
      event.isComposing
    )
      return;
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      ref.current?.focus({ preventScroll: true });
      if (event.key === "Home") centre(0);
      else if (event.key === "End") centre(source.total - 1);
      else step(event.key === "ArrowLeft" ? -1 : 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      activate(Math.round(position.current));
    }
  });
  const stageHandlers = {
    onDragStart: (event: MouseEvent) => event.preventDefault(),
    onClickCapture: (event: MouseEvent) => {
      if (suppressClick.current) {
        event.preventDefault();
        event.stopPropagation();
        suppressClick.current = false;
      }
    },
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
      if (!latest.current.interactive || source.total < 2 || event.button !== 0)
        return;
      ++serial.current;
      cancel();
      suppressClick.current = false;
      drag.current = {
        id: event.pointerId,
        x: event.clientX,
        position: position.current,
        lastX: event.clientX,
        lastAt: performance.now(),
        velocity: 0,
        moved: false,
      };
    },
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
      const d = drag.current;
      if (!d || d.id !== event.pointerId) return;
      if (!d.moved && Math.abs(event.clientX - d.x) > 6) {
        latest.current.onBrowseMotion?.();
        d.moved = true;
        suppressClick.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        setMoving(true);
      }
      if (!d.moved) return;
      const now = performance.now();
      d.velocity =
        (d.lastX - event.clientX) /
        geometry.pitch /
        Math.max(0.008, (now - d.lastAt) / 1000);
      d.lastX = event.clientX;
      d.lastAt = now;
      move(d.position + (d.x - event.clientX) / geometry.pitch);
    },
    onPointerUp: (event: PointerEvent<HTMLDivElement>) => {
      const d = drag.current;
      if (!d || d.id !== event.pointerId) return;
      drag.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId))
        event.currentTarget.releasePointerCapture(event.pointerId);
      if (d.moved)
        centre(
          showcaseRelease(
            position.current,
            reduced || performance.now() - d.lastAt >= 100 ? 0 : d.velocity,
            source.total,
            modeRef.current,
          ),
        );
    },
    onPointerCancel: () => {
      drag.current = null;
      centre(position.current);
    },
    onLostPointerCapture: () => {
      if (drag.current) {
        drag.current = null;
        centre(position.current);
      }
    },
  };
  const external = useRef<(event: Event) => void>(() => {});
  external.current = (event) => {
    const e = (event as CustomEvent<{ type: string; id: number; x: number }>)
      .detail;
    if (kind !== "screeningRoom") return;
    if (e.type === "begin") {
      externalDragging.current = true;
      ++serial.current;
      cancel();
      latest.current.onBrowseMotion?.(true);
      drag.current = {
        id: e.id,
        x: e.x,
        position: position.current,
        lastX: e.x,
        lastAt: performance.now(),
        velocity: 0,
        moved: true,
      };
      setMoving(true);
    } else if (drag.current?.id === e.id) {
      const d = drag.current;
      move(d.position + (d.x - e.x) / geometry.pitch);
      if (e.type === "end") {
        externalDragging.current = false;
        drag.current = null;
        centre(position.current);
      }
    }
  };
  useEffect(() => {
    const listener = (event: Event) => external.current(event);
    window.addEventListener("showcase:video-drag", listener);
    const wheel = (event: Event) => {
      if (kind !== "screeningRoom") return;
      const { x, y } = (event as CustomEvent).detail;
      wheelHandler.current(new WheelEvent("wheel", { deltaX: x, deltaY: y }));
    };
    window.addEventListener("showcase:video-wheel", wheel);
    return () => {
      window.removeEventListener("showcase:video-drag", listener);
      window.removeEventListener("showcase:video-wheel", wheel);
    };
  }, []);
  return {
    ref,
    geometry,
    slots,
    nodes,
    position,
    lane,
    index,
    item,
    snapshot,
    mode,
    reduced,
    hidden,
    moving,
    changeMode,
    step,
    activate,
    openCurrent,
    contextMenu,
    stageHandlers,
  };
}
