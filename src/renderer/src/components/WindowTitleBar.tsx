import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { Minus, Square, Copy, X } from "lucide-react";
import type { MainWindowState } from "../../../shared/windowControls";
import { readerColors } from "../../../shared/readerColors";
import { report, useApp } from "../store";
import "./windowTitleBar.css";

export default function WindowTitleBar() {
  const [surface, setSurface] = useState<HTMLElement>();
  const [visible, setVisible] = useState(false);
  const [reading, setReading] = useState(false);
  const [state, setState] = useState<MainWindowState>({
    maximized: false,
    fullscreen: false,
  });
  const theme = useApp((s) => s.settings.readerTheme);
  const reducedMotion = useApp((s) => s.settings.reducedMotion);
  const root = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const dragging = useRef<number | undefined>(undefined);
  const nativeHover = useRef(false);
  const show = () => {
    clearTimeout(timer.current);
    timer.current = undefined;
    setVisible(true);
  };
  const hide = () => {
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = undefined;
      const node = root.current;
      if (
        nativeHover.current ||
        dragging.current !== undefined ||
        node?.matches(":hover") ||
        node?.contains(node.ownerDocument.activeElement)
      ) {
        hide();
        return;
      }
      setVisible(false);
    }, 600);
  };
  useEffect(() => {
    const videoSurface = (event: Event) =>
      setSurface(
        (event as CustomEvent<HTMLElement | null>).detail ?? undefined,
      );
    window.addEventListener("video:music-surface", videoSurface);
    const updateReading = () =>
      setReading(Boolean(document.querySelector(".reader")));
    const observer = new MutationObserver(updateReading);
    observer.observe(document.body, { childList: true, subtree: true });
    updateReading();
    const off = window.media.onWindowState((next) => {
      setState(next);
    });
    const offPointer = window.media.onWindowChromePointer((pointer) => {
      nativeHover.current = pointer.inside;
      if (pointer.reveal) show();
      else if (!pointer.inside) hide();
    });
    void window.media.windowState().then(setState).catch(report);
    return () => {
      observer.disconnect();
      off();
      offPointer();
      clearTimeout(timer.current);
      window.removeEventListener("video:music-surface", videoSurface);
    };
  }, []);
  useEffect(() => {
    const doc = surface?.ownerDocument ?? document;
    const view = doc.defaultView!;
    const move = (event: globalThis.PointerEvent) => {
      if (event.clientY <= 8) show();
      else if (event.clientY > 36) hide();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Tab") {
        show();
        hide();
      }
    };
    const blur = () => {
      if (dragging.current !== undefined) {
        dragging.current = undefined;
        void window.media
          .windowDrag({ phase: "end", x: 0, y: 0 })
          .catch(report);
      }
      hide();
    };
    doc.addEventListener("pointermove", move, true);
    doc.addEventListener("keydown", key, true);
    view.addEventListener("blur", blur);
    return () => {
      doc.removeEventListener("pointermove", move, true);
      doc.removeEventListener("keydown", key, true);
      view.removeEventListener("blur", blur);
    };
  }, [surface]);
  const gesture = (
    event: PointerEvent<HTMLDivElement>,
    phase: "begin" | "update" | "end",
  ) => {
    if (
      !surface ||
      event.button > 0 ||
      (phase !== "begin" && dragging.current !== event.pointerId)
    )
      return;
    if (phase === "begin") {
      dragging.current = event.pointerId;
      event.currentTarget.setPointerCapture(event.pointerId);
      show();
    }
    void window.media
      .windowDrag({ phase, x: event.screenX, y: event.screenY })
      .catch(report);
    if (phase === "end") {
      dragging.current = undefined;
      hide();
    }
  };
  const palette = readerColors(theme);
  const restore = state.maximized || state.fullscreen;
  const style = reading
    ? ({
        "--window-bg": palette.background,
        "--window-fg": palette.foreground,
        "--window-hover": palette.border,
      } as CSSProperties)
    : undefined;
  return createPortal(
    <>
      <div
        className="window-titlebar-edge"
        onPointerEnter={show}
        onPointerLeave={hide}
        aria-hidden="true"
      />
      <div
        ref={root}
        className={`window-titlebar ${visible ? "is-visible" : ""} ${surface ? "is-video-overlay" : ""}`}
        style={style}
        data-reduced-motion={reducedMotion}
        inert={!visible}
        onPointerEnter={show}
        onPointerLeave={hide}
        onFocusCapture={show}
        onBlurCapture={hide}
        role="toolbar"
        aria-label="应用窗口控制"
      >
        <div
          className="window-titlebar-drag"
          aria-label="拖动应用窗口"
          onPointerDown={(e) => gesture(e, "begin")}
          onPointerMove={(e) => gesture(e, "update")}
          onPointerUp={(e) => gesture(e, "end")}
          onPointerCancel={(e) => gesture(e, "end")}
          onDoubleClick={() => {
            if (surface)
              void window.media.windowCommand("toggle-maximize").catch(report);
          }}
        />
        <button
          title="最小化"
          aria-label="最小化应用窗口"
          onClick={() =>
            void window.media.windowCommand("minimize").catch(report)
          }
        >
          <Minus size={16} />
        </button>
        <button
          title={restore ? "还原" : "最大化"}
          aria-label={restore ? "还原应用窗口" : "最大化应用窗口"}
          onClick={() =>
            void window.media.windowCommand("toggle-maximize").catch(report)
          }
        >
          {restore ? <Copy size={13} /> : <Square size={13} />}
        </button>
        <button
          className="window-titlebar-close"
          title="关闭"
          aria-label="关闭应用窗口"
          onClick={() => void window.media.windowCommand("close").catch(report)}
        >
          <X size={17} />
        </button>
      </div>
    </>,
    surface ?? document.body,
  );
}
