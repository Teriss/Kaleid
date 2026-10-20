import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { RefObject } from "react";

const IDLE_MS = 1500;
const FADE_MS = 160;
const hoveredChrome =
  ".video-header:hover,.video-controls:hover,.video-panel:hover";
const modalSelector = "dialog[open],.modal-backdrop,.context-menu";

/** Only fade overlay controls; the native video keeps a constant viewport. */
export function useVideoChrome(
  root: RefObject<HTMLDivElement | null>,
  locked: boolean,
  sessionKey: string,
  reducedMotion: boolean,
  surfaceDocument: Document = document,
) {
  const [phase, setPhase] = useState<"visible" | "hiding" | "hidden">(
    "visible",
  );
  const lock = useRef(locked);
  lock.current = locked;
  const wake = useRef<() => void>(() => {});
  const activity = useCallback(() => wake.current(), []);

  useEffect(() => {
    const surfaceWindow = surfaceDocument.defaultView ?? window;
    let idle: ReturnType<typeof setTimeout>;
    let fade: ReturnType<typeof setTimeout>;
    let disposed = false;
    const pointers = new Set<number>();
    const blocked = () => {
      const node = root.current;
      const focused = surfaceDocument.activeElement;
      return (
        lock.current ||
        pointers.size > 0 ||
        !!document.querySelector(modalSelector) ||
        !!node?.querySelector(hoveredChrome) ||
        (surfaceDocument.hasFocus() &&
          !!focused &&
          node?.contains(focused) &&
          focused.matches(
            ":focus-visible,input:focus,select:focus,textarea:focus,[aria-expanded=true]",
          ))
      );
    };
    const arm = () => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        // Inert can trigger focusout. Do not restart an already finished fade.
        if (root.current?.dataset.chrome !== "visible") return;
        if (blocked()) {
          arm();
          return;
        }
        setPhase("hiding");
        fade = setTimeout(
          () => {
            if (blocked()) show();
            else setPhase("hidden");
          },
          reducedMotion ? 0 : FADE_MS,
        );
      }, IDLE_MS);
    };
    const show = () => {
      if (disposed) return;
      clearTimeout(fade);
      setPhase("visible");
      arm();
    };
    wake.current = show;
    const pointer = (event: PointerEvent) => {
      if (root.current?.contains(event.target as Node)) show();
    };
    const down = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) return;
      pointers.add(event.pointerId);
      show();
    };
    const up = (event: PointerEvent) => {
      pointers.delete(event.pointerId);
      show();
    };
    const key = (event: KeyboardEvent) => {
      // Remove inert before the browser performs its default Tab navigation.
      if (event.key === "Tab") flushSync(show);
      else show();
    };
    const blur = () => {
      pointers.clear();
      arm();
    };
    let modal = !!document.querySelector(modalSelector);
    const mutations = new MutationObserver(() => {
      const next = !!document.querySelector(modalSelector);
      if (next !== modal) {
        modal = next;
        show();
      }
    });
    mutations.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["open", "class"],
    });
    surfaceDocument.addEventListener("pointermove", pointer, true);
    surfaceDocument.addEventListener("pointerdown", down, true);
    surfaceDocument.addEventListener("pointerup", up, true);
    surfaceDocument.addEventListener("pointercancel", up, true);
    surfaceDocument.addEventListener("focusin", show);
    surfaceDocument.addEventListener("focusout", arm);
    surfaceWindow.addEventListener("keydown", key, true);
    surfaceWindow.addEventListener("blur", blur);
    show();
    return () => {
      disposed = true;
      wake.current = () => {};
      clearTimeout(idle);
      clearTimeout(fade);
      mutations.disconnect();
      surfaceDocument.removeEventListener("pointermove", pointer, true);
      surfaceDocument.removeEventListener("pointerdown", down, true);
      surfaceDocument.removeEventListener("pointerup", up, true);
      surfaceDocument.removeEventListener("pointercancel", up, true);
      surfaceDocument.removeEventListener("focusin", show);
      surfaceDocument.removeEventListener("focusout", arm);
      surfaceWindow.removeEventListener("keydown", key, true);
      surfaceWindow.removeEventListener("blur", blur);
    };
  }, [root, sessionKey, reducedMotion, surfaceDocument]);

  useEffect(() => {
    activity();
  }, [locked, activity]);
  return { chrome: locked ? "visible" : phase, activity };
}
