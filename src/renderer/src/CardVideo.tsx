import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Maximize2, Pause, Play, X } from "lucide-react";
import type { MediaItem } from "../../shared/types";
import { report, time } from "./store";
import {
  isPlaybackSpaceShortcut,
  shouldPreventPlaybackSpace,
} from "./playbackSpace";
import { isTextEntryTarget } from "./desktopInteraction";
import { useVideoOverlay } from "./useVideoOverlay";
import { hideVideo, useVideoSession, videoBounds } from "./videoSession";

export default function CardVideo({
  id,
  item,
  anchor,
  blocked,
  stop,
  expand,
}: {
  id: string;
  item: MediaItem;
  anchor: HTMLElement | null;
  blocked: boolean;
  stop(): void;
  expand(): void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const surface = useVideoOverlay(root, stop);
  const state = useVideoSession((s) => (s.id === id ? s.state : undefined));
  const [rect, setRect] = useState({ x: 0, y: 0, width: 0, height: 0 });
  const gesture = useRef<{
    id: number;
    x: number;
    y: number;
    lastX: number;
    moved: boolean;
  } | null>(null);
  const latest = useRef({ state, stop, expand, blocked });
  latest.current = { state, stop, expand, blocked };
  const command = (value: Parameters<typeof window.video.command>[1]) =>
    useVideoSession.getState().id === id
      ? window.video.command(id, value).catch(report)
      : Promise.resolve();
  useEffect(() => {
    void window.video.present(id, "card").catch(() => {});
  }, [id]);
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent("video:music-surface", { detail: surface ?? null }),
    );
    return () => {
      window.dispatchEvent(
        new CustomEvent("video:music-surface", { detail: null }),
      );
      void hideVideo(id);
    };
  }, [surface, id]);
  useLayoutEffect(() => {
    const element = anchor?.querySelector<HTMLElement>(".screen-object");
    if (!element) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (gesture.current?.moved) return;
        const b = element.getBoundingClientRect();
        const r = {
          x: b.x + 6,
          y: b.y + 6,
          width: Math.max(1, b.width - 12),
          height: Math.max(1, b.height - 12),
        };
        setRect((previous) =>
          JSON.stringify(previous) === JSON.stringify(r) ? previous : r,
        );
        const hidden =
          latest.current.blocked ||
          document.hidden ||
          latest.current.state?.status === "error" ||
          r.y < 36 ||
          r.y + r.height > innerHeight;
        void videoBounds(id, { ...r, visible: !hidden }).catch(() => {});
        if (hidden && !latest.current.state?.paused)
          void command({ type: "pause", value: true });
      });
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    document.addEventListener("visibilitychange", update);
    const interval = setInterval(update, 250);
    update();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      clearInterval(interval);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      document.removeEventListener("visibilitychange", update);
    };
  }, [anchor, id, blocked, state?.status, surface]);
  useEffect(() => {
    if (blocked || document.hidden) {
      void hideVideo(id);
      void command({ type: "pause", value: true });
    }
  }, [blocked]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.code === "Space" || event.key === " ") {
        if (
          isTextEntryTarget(event.target) ||
          document.querySelector("dialog[open],.media-context-menu") ||
          latest.current.blocked
        )
          return;
        const current = latest.current.state;
        if (!current || !shouldPreventPlaybackSpace(event)) return;
        const shouldToggle = isPlaybackSpaceShortcut(event);
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!shouldToggle) return;
        void command({ type: "pause", value: !current.paused });
        return;
      }
      if (
        (event.target as HTMLElement)?.closest(
          "input,select,textarea,.music-unified-dock",
        ) ||
        document.querySelector("dialog[open],.media-context-menu") ||
        latest.current.blocked
      )
        return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (latest.current.state?.fullscreen)
          void command({ type: "fullscreen", value: false });
        else latest.current.stop();
      } else if (event.key === "Enter") {
        if ((event.target as HTMLElement)?.closest("button")) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        void command({ type: "pause", value: !latest.current.state?.paused });
      } else if (
        event.currentTarget !== window &&
        ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        window.dispatchEvent(
          new KeyboardEvent("keydown", { key: event.key, bubbles: true }),
        );
      }
    };
    window.addEventListener("keydown", key, true);
    const owner = surface?.ownerDocument.defaultView;
    owner?.addEventListener("keydown", key, true);
    const off = window.video.onInput(({ sessionId, action }) => {
      if (sessionId !== id) return;
      if (action === "escape" || action === "close") latest.current.stop();
      else if (action === "fullscreen" || action === "restore")
        latest.current.expand();
    });
    return () => {
      window.removeEventListener("keydown", key, true);
      owner?.removeEventListener("keydown", key, true);
      off();
    };
  }, [id, surface]);
  const sendDrag = (
    type: string,
    event: { pointerId: number; clientX: number },
  ) =>
    window.dispatchEvent(
      new CustomEvent("showcase:video-drag", {
        detail: {
          type,
          id: event.pointerId,
          x: type === "begin" ? gesture.current!.x : event.clientX,
        },
      }),
    );
  const end = (
    event: { pointerId: number; clientX: number },
    cancelled = false,
  ) => {
    const g = gesture.current;
    if (!g || event.pointerId !== g.id) return;
    // Native window hit regions can change during a drag. Finish once even if
    // pointerup is delivered to the document instead of the original card.
    gesture.current = null;
    if (g.moved) {
      sendDrag("end", event);
      latest.current.stop();
    } else if (!cancelled)
      void command({ type: "pause", value: !latest.current.state?.paused });
    if (root.current?.hasPointerCapture(event.pointerId))
      root.current.releasePointerCapture(event.pointerId);
  };
  const move = (event: globalThis.PointerEvent) => {
    const g = gesture.current;
    if (!g || g.id !== event.pointerId) return;
    g.lastX = event.clientX;
    if (event.buttons === 0) {
      end(event, true);
      return;
    }
    if (!g.moved && Math.hypot(event.clientX - g.x, event.clientY - g.y) > 6) {
      g.moved = true;
      void hideVideo(id);
      sendDrag("begin", event);
    }
    if (g.moved) sendDrag("move", event);
  };
  const gestureHandlers = useRef({ end, move });
  gestureHandlers.current = { end, move };
  useEffect(() => {
    if (!surface) return;
    const documents = [document, surface.ownerDocument];
    const move = (event: globalThis.PointerEvent) =>
      gestureHandlers.current.move(event);
    const up = (event: globalThis.PointerEvent) =>
      gestureHandlers.current.end(event);
    const cancel = (event: globalThis.PointerEvent) =>
      gestureHandlers.current.end(event, true);
    const mouseUp = (event: MouseEvent) => {
      const g = gesture.current;
      if (g && event.button === 0)
        gestureHandlers.current.end({ pointerId: g.id, clientX: g.lastX });
    };
    for (const target of documents) {
      target.addEventListener("pointermove", move, true);
      target.addEventListener("pointerup", up, true);
      target.addEventListener("pointercancel", cancel, true);
      target.addEventListener("mouseup", mouseUp, true);
    }
    return () => {
      for (const target of documents) {
        target.removeEventListener("pointermove", move, true);
        target.removeEventListener("pointerup", up, true);
        target.removeEventListener("pointercancel", cancel, true);
        target.removeEventListener("mouseup", mouseUp, true);
      }
    };
  }, [surface]);
  if (!surface) return null;
  const ready = state?.status === "ready" || state?.status === "ended";
  return createPortal(
    <div
      ref={root}
      className="card-video-controls"
      role="group"
      aria-label={`卡片视频 ${item.title}`}
      data-status={state?.status ?? "loading"}
      data-session-id={id}
      style={{
        left: rect.x,
        top: rect.y,
        width: rect.width,
        height: rect.height,
        visibility: blocked ? "hidden" : "visible",
      }}
      onPointerDown={(event) => {
        event.stopPropagation();
        if (
          event.button !== 0 ||
          (event.target as HTMLElement).closest("button,input")
        )
          return;
        gesture.current = {
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          lastX: event.clientX,
          moved: false,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        event.stopPropagation();
      }}
      onPointerUp={(event) => {
        event.stopPropagation();
        end(event);
      }}
      onPointerCancel={(event) => {
        event.stopPropagation();
        end(event, true);
      }}
      onLostPointerCapture={(event) => event.stopPropagation()}
      onContextMenu={(event) => {
        event.stopPropagation();
        event.preventDefault();
        anchor?.dispatchEvent(
          new MouseEvent("contextmenu", {
            clientX: event.clientX,
            clientY: event.clientY,
            bubbles: true,
            cancelable: true,
          }),
        );
      }}
      onWheel={(event) => {
        event.stopPropagation();
        event.preventDefault();
        latest.current.stop();
        window.dispatchEvent(
          new CustomEvent("showcase:video-wheel", {
            detail: { x: event.deltaX, y: event.deltaY },
          }),
        );
      }}
    >
      {state?.status === "loading" && (
        <span className="card-video-notice" role="status">
          正在加载…
        </span>
      )}
      {state?.error && (
        <span className="card-video-notice" role="status">
          {state.error.message}
        </span>
      )}
      <div
        className="card-video-toolbar"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <button
          aria-label={state?.paused ? "播放卡片视频" : "暂停卡片视频"}
          disabled={!ready}
          onClick={() => void command({ type: "pause", value: !state?.paused })}
        >
          {state?.paused ? <Play size={18} /> : <Pause size={18} />}
        </button>
        <small>{time(state?.position)}</small>
        <input
          type="range"
          aria-label="卡片视频进度"
          min={0}
          max={state?.duration || 1}
          step={0.1}
          value={Math.min(state?.position ?? 0, state?.duration || 1)}
          disabled={!ready}
          onChange={(event) =>
            void command({ type: "seek", value: Number(event.target.value) })
          }
        />
        <small>{time(state?.duration)}</small>
        <button aria-label="展开视频播放器" onClick={expand}>
          <Maximize2 size={17} />
        </button>
        <button aria-label="停止卡片视频" onClick={stop}>
          <X size={17} />
        </button>
      </div>
    </div>,
    surface,
  );
}
