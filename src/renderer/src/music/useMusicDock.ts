import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
  type PointerEvent,
  type CSSProperties,
} from "react";
import {
  dockPoint,
  readDockMemory,
  releaseDock,
  avoidDockObstacles,
  type DockMemory,
} from "./dockGeometry";
const key = "kaleid:music-dock:v1";
function obstacles() {
  return [
    ...document.querySelectorAll<HTMLElement>(
      ".side-rail button,.floating-header button",
    ),
  ]
    .filter((node) => node.getClientRects().length)
    .map((node) => {
      const r = node.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
}
function load() {
  try {
    return readDockMemory(JSON.parse(localStorage.getItem(key) ?? "null"));
  } catch {
    return undefined;
  }
}
export function useMusicDock(
  root: RefObject<HTMLDivElement | null>,
  surface: HTMLElement | null,
  begin: () => void,
) {
  const [memory, setMemory] = useState(load);
  const [size, setSize] = useState({ width: innerWidth, height: innerHeight });
  const [point, setPoint] = useState(() =>
    dockPoint(memory, innerWidth, innerHeight),
  );
  const [dragging, setDragging] = useState(false);
  const gesture = useRef<{
    id: number;
    x: number;
    y: number;
    start: typeof point;
    moved: boolean;
    memory: typeof memory;
  } | null>(null);
  const suppress = useRef(false),
    position = useRef(point),
    current = useRef(memory);
  position.current = point;
  current.current = memory;
  const latestBegin = useRef(begin);
  latestBegin.current = begin;
  const owner = surface?.ownerDocument.defaultView ?? window;
  function visiblePoint(width: number, height: number) {
    return avoidDockObstacles(
      dockPoint(current.current, width, height),
      width,
      height,
      obstacles(),
      current.current?.collapsed ? current.current.edge : null,
    );
  }
  useLayoutEffect(() => {
    gesture.current = null;
    setDragging(false);
    const resize = () => {
      const width = owner.innerWidth,
        height = owner.innerHeight;
      setSize({ width, height });
      setPoint(visiblePoint(width, height));
    };
    resize();
    owner.addEventListener("resize", resize);
    return () => owner.removeEventListener("resize", resize);
  }, [owner]);
  useLayoutEffect(() => {
    if (gesture.current) return;
    const next = visiblePoint(size.width, size.height);
    setPoint((previous) =>
      previous.x === next.x && previous.y === next.y ? previous : next,
    );
  });
  useEffect(
    () => () => {
      gesture.current = null;
    },
    [owner],
  );
  function persist(value: DockMemory) {
    current.current = value;
    setMemory(value);
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  }
  function expand() {
    const p = dockPoint(current.current, size.width, size.height);
    const x =
      current.current?.edge === "left"
        ? 8
        : current.current?.edge === "right"
          ? size.width - 56
          : p.x;
    setPoint({ x, y: p.y });
    persist({
      version: 1,
      x: x / Math.max(1, size.width - 48),
      y: Math.min(1, Math.max(0, (p.y - 36) / Math.max(1, size.height - 84))),
      edge: null,
      collapsed: false,
    });
  }
  function end(event: PointerEvent<HTMLButtonElement>, cancelled = false) {
    const g = gesture.current;
    if (!g || g.id !== event.pointerId) return;
    gesture.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (!g.moved) return;
    suppress.current = true;
    if (cancelled) {
      setMemory(g.memory);
      setPoint(g.start);
      return;
    }
    const value = releaseDock(
      position.current.x,
      position.current.y,
      size.width,
      size.height,
      obstacles(),
    );
    persist(value);
    setPoint(dockPoint(value, size.width, size.height));
  }
  const inward = memory?.edge === "left" ? point.x : size.width - 48 - point.x;
  const collapsed = Boolean(memory?.collapsed) && !(dragging && inward > 24);
  const x = collapsed
    ? memory?.edge === "left"
      ? 0
      : size.width - 24
    : point.x;
  const above = point.y > size.height / 2;
  const panelWidth = Math.min(330, size.width - 24);
  const style = {
    position: "fixed",
    left: x,
    top: collapsed ? Math.min(point.y, size.height - 88) : point.y,
    right: "auto",
    bottom: "auto",
    transform: "none",
    "--dock-panel-x": `${Math.max(12, Math.min(size.width - panelWidth - 12, x)) - x}px`,
    "--dock-panel-space": `${Math.max(100, above ? point.y - 48 : size.height - point.y - 60)}px`,
  } as CSSProperties;
  return {
    style,
    collapsed,
    dragging,
    edge: memory?.edge,
    above,
    expand,
    handlers: {
      onPointerDown: (event: PointerEvent<HTMLButtonElement>) => {
        if (event.button !== 0) return;
        suppress.current = false;
        gesture.current = {
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          start: position.current,
          moved: false,
          memory: current.current,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      },
      onPointerMove: (event: PointerEvent<HTMLButtonElement>) => {
        const g = gesture.current;
        if (!g || g.id !== event.pointerId) return;
        const dx = event.clientX - g.x,
          dy = event.clientY - g.y;
        if (!g.moved && Math.hypot(dx, dy) > 6) {
          g.moved = true;
          setDragging(true);
          latestBegin.current();
        }
        if (!g.moved) return;
        const next = {
          x: Math.max(0, Math.min(size.width - 48, g.start.x + dx)),
          y: Math.max(36, Math.min(size.height - 48, g.start.y + dy)),
        };
        position.current = next;
        setPoint(next);
      },
      onPointerUp: (event: PointerEvent<HTMLButtonElement>) => end(event),
      onPointerCancel: (event: PointerEvent<HTMLButtonElement>) =>
        end(event, true),
      onLostPointerCapture: () => {
        if (gesture.current?.moved) {
          setPoint(gesture.current.start);
          setMemory(gesture.current.memory);
          suppress.current = true;
        }
        gesture.current = null;
        setDragging(false);
      },
      onClickCapture: (event: React.MouseEvent) => {
        if (suppress.current) {
          event.preventDefault();
          event.stopPropagation();
          suppress.current = false;
        }
      },
    },
  };
}
