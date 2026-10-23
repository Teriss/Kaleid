import { useEffect, useRef, useState, type ReactNode } from "react";
import { useApp } from "../store";

/** Hidden chrome is inert; an edge sentinel is the only remaining hit target. */
export default function AutoHideNavigation({
  children,
  edge,
  className = "",
  locked = false,
  alwaysAutoHide = false,
}: {
  children: ReactNode;
  edge: "top" | "bottom" | "left" | "right";
  className?: string;
  locked?: boolean;
  alwaysAutoHide?: boolean;
}) {
  const enabled = useApp((s) => s.settings.navigationAutoHide) || alwaysAutoHide;
  const [visible, setVisible] = useState(true);
  const root = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hide = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const node = root.current;
      if (
        node?.matches(":hover") ||
        node?.querySelector(
          ":focus-visible,input:focus,textarea:focus,select:focus,details[open],[aria-expanded=true]",
        )
      ) {
        hide();
        return;
      }
      setVisible(false);
    }, 800);
  };
  const show = () => {
    clearTimeout(timer.current);
    setVisible(true);
  };
  useEffect(() => {
    hide();
    return () => clearTimeout(timer.current);
  }, []);
  useEffect(() => {
    const reveal = (e: KeyboardEvent) => {
      if (e.key === "Tab") {
        show();
        hide();
      }
    };
    window.addEventListener("keydown", reveal, true);
    return () => window.removeEventListener("keydown", reveal, true);
  }, []);
  const shown = visible || !enabled || locked;
  return (
    <>
      <div
        className={`chrome-edge chrome-edge-${edge}`}
        onPointerEnter={show}
        onPointerLeave={hide}
      />
      <div
        ref={root}
        className={`auto-chrome ${className} ${shown ? "chrome-shown" : "chrome-hidden"}`}
        inert={!shown}
        onPointerEnter={show}
        onPointerLeave={hide}
        onFocusCapture={show}
        onBlurCapture={hide}
        onPointerUp={hide}
      >
        {children}
      </div>
    </>
  );
}
