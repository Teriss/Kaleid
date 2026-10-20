import { animate } from "framer-motion";
import {
  useCallback,
  useEffect,
  useRef,
  type RefObject,
  type PointerEvent as ReactPointerEvent,
  type MouseEvent,
} from "react";
import {
  createWallWheelClassifier,
  stepWallWheel,
  wallWheelDelta,
  WALL_PAN_INERTIA,
} from "./foliaWall";
import { zoomAt, type Camera } from "./geometry";

type Options = {
  container: RefObject<HTMLDivElement | null>;
  camera: RefObject<Camera>;
  viewport: { width: number; height: number };
  interactive: boolean;
  reduced: boolean;
  apply(camera: Camera, dragging?: boolean): void;
  reserve(camera: Camera): void;
  rest(): void;
  zoomed(): void;
};
// Folia's input/animation rules adapted to the host's world-centre camera and poster buttons.
export function useWallMotion(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const animation = useRef<{ stop(): void } | null>(null);
  const pointer = useRef<{
    id: number;
    x: number;
    y: number;
    camera: Camera;
    lastX: number;
    lastY: number;
    time: number;
    vx: number;
    vy: number;
    moved: boolean;
  } | null>(null);
  const didDrag = useRef(false);
  const wheelFrame = useRef(0),
    restTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pending = useRef({ x: 0, y: 0 });
  const stop = useCallback(() => {
    animation.current?.stop();
    animation.current = null;
    cancelAnimationFrame(wheelFrame.current);
    wheelFrame.current = 0;
    pending.current = { x: 0, y: 0 };
    clearTimeout(restTimer.current);
  }, []);
  const resting = useCallback(() => {
    latest.current.rest();
    latest.current.container.current?.classList.remove("is-dragging");
  }, []);
  const idle = useCallback(() => {
    clearTimeout(restTimer.current);
    restTimer.current = setTimeout(resting, 180);
  }, [resting]);
  const travel = useCallback(
    (target: Camera) => {
      stop();
      const o = latest.current,
        from = { ...o.camera.current };
      o.reserve(target);
      if (o.reduced) {
        o.apply(target);
        resting();
        return;
      }
      animation.current = animate(0, 1, {
        duration: 0.42,
        ease: [0.22, 1, 0.36, 1],
        onUpdate: (p) =>
          latest.current.apply({
            x: from.x + (target.x - from.x) * p,
            y: from.y + (target.y - from.y) * p,
            scale: from.scale + (target.scale - from.scale) * p,
          }),
        onComplete: () => {
          animation.current = null;
          resting();
        },
      });
    },
    [stop, resting],
  );
  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const o = latest.current;
      if (!o.interactive || e.button !== 0 || !e.isPrimary || pointer.current)
        return;
      const target = e.target as HTMLElement;
      if (
        target.closest(
          '.wall-seam,.wall-tools,.seam-recall,.tile-actions,.wall-playback-controls,input,select,textarea,a,[role="slider"]',
        ) ||
        (target.closest("button") && !target.closest(".poster-hit"))
      )
        return;
      stop();
      didDrag.current = false;
      pointer.current = {
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        camera: { ...o.camera.current },
        lastX: e.clientX,
        lastY: e.clientY,
        time: e.timeStamp,
        vx: 0,
        vy: 0,
        moved: false,
      };
    },
    [stop],
  );
  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const p = pointer.current;
    if (!p || p.id !== e.pointerId) return;
    const dx = e.clientX - p.x,
      dy = e.clientY - p.y;
    if (!p.moved && Math.hypot(dx, dy) > 7) {
      p.moved = true;
      didDrag.current = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      e.currentTarget.classList.add("is-dragging");
    }
    const dt = e.timeStamp - p.time;
    if (dt > 0) {
      p.vx = ((e.clientX - p.lastX) / dt) * 1000;
      p.vy = ((e.clientY - p.lastY) / dt) * 1000;
    }
    p.lastX = e.clientX;
    p.lastY = e.clientY;
    p.time = e.timeStamp;
    if (p.moved)
      latest.current.apply(
        {
          ...p.camera,
          x: p.camera.x - dx / p.camera.scale,
          y: p.camera.y - dy / p.camera.scale,
        },
        true,
      );
  }, []);
  const onPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const p = pointer.current;
      if (!p || p.id !== e.pointerId) return;
      pointer.current = null;
      if (e.currentTarget.hasPointerCapture(e.pointerId))
        e.currentTarget.releasePointerCapture(e.pointerId);
      e.currentTarget.classList.remove("is-dragging");
      const speed = Math.hypot(p.vx, p.vy),
        o = latest.current;
      if (
        !p.moved ||
        o.reduced ||
        e.timeStamp - p.time > WALL_PAN_INERTIA.staleReleaseMs ||
        speed < WALL_PAN_INERTIA.minSpeed
      ) {
        resting();
        return;
      }
      const from = { ...o.camera.current },
        velocity = Math.min(speed, WALL_PAN_INERTIA.maxSpeed);
      animation.current = animate(0, velocity * WALL_PAN_INERTIA.power, {
        type: "inertia",
        velocity,
        power: WALL_PAN_INERTIA.power,
        timeConstant: WALL_PAN_INERTIA.timeConstant,
        restDelta: WALL_PAN_INERTIA.restDelta,
        onUpdate: (d) =>
          latest.current.apply({
            ...from,
            x: from.x - (d * p.vx) / speed / from.scale,
            y: from.y - (d * p.vy) / speed / from.scale,
          }),
        onComplete: () => {
          animation.current = null;
          resting();
        },
      });
    },
    [resting],
  );
  const cancel = useCallback(() => {
    pointer.current = null;
    stop();
    resting();
  }, [stop, resting]);
  const onClickCapture = useCallback((e: MouseEvent<HTMLDivElement>) => {
    if (!didDrag.current || e.detail === 0) return;
    didDrag.current = false;
    e.preventDefault();
    e.stopPropagation();
  }, []);
  useEffect(() => {
    const el = options.container.current;
    if (!el) return;
    const classify = createWallWheelClassifier();
    let latch: {
      x: number;
      y: number;
      timer: ReturnType<typeof setTimeout>;
    } | null = null;
    const release = () => {
      if (latch) clearTimeout(latch.timer);
      latch = null;
      window.removeEventListener("wheel", latched, true);
      window.removeEventListener("pointermove", moved, true);
    };
    const moved = (e: globalThis.PointerEvent) => {
      if (latch && Math.hypot(e.clientX - latch.x, e.clientY - latch.y) > 4)
        release();
    };
    const tick = (now: number) => {
      const o = latest.current;
      wheelFrame.current = 0;
      if (!o.interactive) {
        stop();
        return;
      }
      const result = stepWallWheel(
        pending.current,
        previousTime ? now - previousTime : 1000 / 60,
      );
      previousTime = now;
      const c = o.camera.current,
        next = {
          ...c,
          x: c.x + result.step.x / c.scale,
          y: c.y + result.step.y / c.scale,
        };
      o.apply(next);
      const actual = o.camera.current;
      pending.current = {
        x: Math.abs(actual.x - next.x) > 0.5 ? 0 : result.pending.x,
        y: Math.abs(actual.y - next.y) > 0.5 ? 0 : result.pending.y,
      };
      if (pending.current.x || pending.current.y)
        wheelFrame.current = requestAnimationFrame(tick);
      else {
        previousTime = 0;
        idle();
      }
    };
    let previousTime = 0;
    const wheel = (e: WheelEvent, held = false) => {
      const o = latest.current;
      if (
        !o.interactive ||
        (!held &&
          (e.target as Element).closest(".wall-seam,.wall-tools,.seam-recall"))
      )
        return;
      e.preventDefault();
      if (pointer.current) return;
      if (e.ctrlKey || e.metaKey) {
        stop();
        const b = el.getBoundingClientRect();
        o.zoomed();
        o.apply(
          zoomAt(
            o.camera.current,
            o.camera.current.scale * Math.exp(-e.deltaY * 0.002),
            { x: e.clientX - b.left, y: e.clientY - b.top },
            o.viewport,
          ),
        );
        idle();
        return;
      }
      if (!latch) {
        latch = { x: e.clientX, y: e.clientY, timer: setTimeout(release, 160) };
        window.addEventListener("wheel", latched, {
          passive: false,
          capture: true,
        });
        window.addEventListener("pointermove", moved, true);
      }
      clearTimeout(latch.timer);
      latch.timer = setTimeout(release, 160);
      const source = classify(e),
        { dx, dy } = wallWheelDelta(e, o.viewport.height);
      if (source === "trackpad" || o.reduced) {
        const carry = pending.current;
        stop();
        const c = o.camera.current;
        o.apply({
          ...c,
          x: c.x + (carry.x + dx) / c.scale,
          y: c.y + (carry.y + dy) / c.scale,
        });
        idle();
        return;
      }
      animation.current?.stop();
      animation.current = null;
      pending.current.x += dx;
      pending.current.y += dy;
      if (!wheelFrame.current) {
        previousTime = 0;
        wheelFrame.current = requestAnimationFrame(tick);
      }
    };
    const latched = (e: WheelEvent) => {
      e.stopPropagation();
      wheel(e, true);
    };
    const onWheel = (e: WheelEvent) => wheel(e);
    const keyboard = (e: KeyboardEvent) => {
      if (!["Shift", "Control", "Alt", "Meta"].includes(e.key)) cancel();
    };
    const outside = (e: globalThis.PointerEvent) => {
      if (pointer.current?.id === e.pointerId) cancel();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("keydown", keyboard, true);
    window.addEventListener("blur", cancel);
    window.addEventListener("pointerup", outside);
    window.addEventListener("pointercancel", outside);
    return () => {
      release();
      stop();
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("keydown", keyboard, true);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("pointerup", outside);
      window.removeEventListener("pointercancel", outside);
    };
  }, [options.container, cancel, stop, idle]);
  useEffect(() => {
    if (!options.interactive || options.reduced) cancel();
  }, [options.interactive, options.reduced, cancel]);
  return {
    stop,
    travel,
    pointer: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: cancel,
      onLostPointerCapture: () => {
        if (pointer.current) cancel();
      },
      onClickCapture,
    },
  };
}
