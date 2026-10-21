import { useEffect, useRef, useState, type RefObject } from "react";
import { report } from "./store";

/** Keep React state in the main renderer and portal controls into a layered window. */
export function useVideoOverlay(
  root: RefObject<HTMLDivElement | null>,
  close: () => void,
  floating = false,
) {
  const [surface, setSurface] = useState<HTMLElement>();
  const closeRef = useRef(close);
  closeRef.current = close;
  const floatingRef = useRef(floating);
  floatingRef.current = floating;
  useEffect(() => {
    const popup = window.open("about:blank", "kaleid-video-controls");
    if (!popup) {
      report(new Error("无法创建视频控制层，请重新打开播放器。"));
      closeRef.current();
      return;
    }
    let disposed = false;
    let frame = 0;
    let capturing = false;
    let previous = "";
    const target = popup.document;
    target.title = "Kaleid 视频控件";
    const base = target.createElement("base");
    base.href = document.baseURI;
    target.head.append(base);
    target.documentElement.style.setProperty(
      "background",
      "transparent",
      "important",
    );
    target.body.style.setProperty("background", "transparent", "important");
    target.body.style.margin = "0";
    target.body.style.overflow = "hidden";
    const copyStyles = () => {
      if (disposed || popup.closed) return;
      target.head
        .querySelectorAll("[data-video-style]")
        .forEach((node) => node.remove());
      document.head
        .querySelectorAll('link[rel="stylesheet"],style')
        .forEach((node) => {
          const clone = node.cloneNode(true) as HTMLElement;
          clone.dataset.videoStyle = "";
          target.head.append(clone);
        });
    };
    copyStyles();
    const styles = new MutationObserver(copyStyles);
    styles.observe(document.head, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    });
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (disposed || popup.closed) return;
        const visible =
          (floatingRef.current || !document.hidden) &&
          (floatingRef.current ||
            !document.querySelector(
              "dialog[open],.modal-backdrop,.context-menu",
            ));
        const regions =
          floatingRef.current ||
          capturing ||
          target.querySelector(".music-quick-panel")
            ? [
                {
                  x: 0,
                  y: 0,
                  width: popup.innerWidth,
                  height: popup.innerHeight,
                },
              ]
            : [
                ...target.querySelectorAll<HTMLElement>(
                  ".video-header:not([inert]),.video-controls:not([inert]),.video-panel,.video-message,.music-unified-dock > *",
                ),
              ]
                .filter((node) => getComputedStyle(node).display !== "none")
                .map((node) => {
                  const rect = node.getBoundingClientRect();
                  return {
                    x: rect.x,
                    y: rect.y,
                    width: rect.width,
                    height: rect.height,
                  };
                });
        const state = { visible, regions };
        const serialized = JSON.stringify(state);
        if (previous === serialized) return;
        previous = serialized;
        void window.video.overlay(state).catch(report);
      });
    };
    const mutations = new MutationObserver(update);
    mutations.observe(target.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "inert",
        "data-chrome",
        "data-fullscreen",
        "style",
        "class",
      ],
    });
    const modals = new MutationObserver(update);
    modals.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["open", "class"],
    });
    const down = () => {
      capturing = true;
      update();
    };
    const up = () => {
      capturing = false;
      update();
    };
    const navigate = (event: MouseEvent) => {
      up();
      if (event.button !== 3 && event.button !== 4) return;
      event.preventDefault();
      window.dispatchEvent(
        new CustomEvent("video:navigate", {
          detail: event.button === 3 ? "back" : "forward",
        }),
      );
    };
    const keyboard = (event: KeyboardEvent) => {
      if (
        (event.target as HTMLElement)?.closest(
          "input,textarea,select,[contenteditable=true]",
        )
      )
        return;
      if (!event.altKey || !["ArrowLeft", "ArrowRight"].includes(event.key))
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      window.dispatchEvent(
        new CustomEvent("video:navigate", {
          detail: event.key === "ArrowLeft" ? "back" : "forward",
        }),
      );
    };
    const unload = () => {
      if (!disposed) closeRef.current();
    };
    target.addEventListener("pointerdown", down, true);
    target.addEventListener("pointerup", up, true);
    target.addEventListener("pointercancel", up, true);
    popup.addEventListener("mouseup", navigate, true);
    popup.addEventListener("keydown", keyboard, true);
    popup.addEventListener("resize", update);
    popup.addEventListener("blur", up);
    popup.addEventListener("beforeunload", unload);
    document.addEventListener("visibilitychange", update);
    const sizes = new ResizeObserver(update);
    sizes.observe(target.body);
    const interval = setInterval(update, 250);
    setSurface(target.body);
    update();
    return () => {
      disposed = true;
      clearInterval(interval);
      cancelAnimationFrame(frame);
      styles.disconnect();
      mutations.disconnect();
      modals.disconnect();
      sizes.disconnect();
      document.removeEventListener("visibilitychange", update);
      target.removeEventListener("pointerdown", down, true);
      target.removeEventListener("pointerup", up, true);
      target.removeEventListener("pointercancel", up, true);
      popup.removeEventListener("mouseup", navigate, true);
      popup.removeEventListener("keydown", keyboard, true);
      popup.removeEventListener("resize", update);
      popup.removeEventListener("blur", up);
      popup.removeEventListener("beforeunload", unload);
      if (!popup.closed) popup.close();
    };
  }, [root]);
  return surface;
}
