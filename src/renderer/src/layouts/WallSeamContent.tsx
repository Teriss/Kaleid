import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

type Props = {
  width: number;
  identity: string;
  content: ReactNode;
  reduced: boolean;
  spine: boolean;
  spineContent?: ReactNode;
  title: string;
  expand(): void;
};
export default function WallSeamContent(props: Props) {
  const element = useRef<HTMLDivElement>(null),
    latest = useRef(props);
  latest.current = props;
  const [shown, setShown] = useState(props);
  const animations = useRef<Animation[]>([]);
  useLayoutEffect(() => {
    if (!element.current) return;
    animations.current.forEach((a) => a.cancel());
    const el = element.current;
    if (shown.identity === props.identity) {
      el.inert = false;
      delete el.dataset.seamFlip;
      return;
    }
    el.inert = true;
    el.dataset.seamFlip = "out";
    const out = el.animate(
      props.reduced
        ? [{ opacity: 1 }, { opacity: 0 }]
        : [
            { transform: "perspective(1400px) rotateY(0deg)" },
            { transform: "perspective(1400px) rotateY(90deg)" },
          ],
      {
        duration: props.reduced ? 90 : 160,
        easing: "ease-in",
        fill: "forwards",
      },
    );
    animations.current = [out];
    out.onfinish = () => {
      setShown(latest.current);
    };
    return () => {
      out.onfinish = null;
      animations.current.forEach((a) => a.cancel());
    };
  }, [props.identity, props.reduced]);
  useLayoutEffect(() => {
    const el = element.current;
    if (!el || !el.dataset.seamFlip) return;
    animations.current.forEach((a) => a.cancel());
    el.dataset.seamFlip = "in";
    const incoming = el.animate(
      shown.reduced
        ? [{ opacity: 0 }, { opacity: 1 }]
        : [
            { transform: "perspective(1400px) rotateY(-90deg)" },
            { transform: "perspective(1400px) rotateY(0deg)" },
          ],
      {
        duration: shown.reduced ? 90 : 240,
        easing: "cubic-bezier(.2,.7,.25,1)",
      },
    );
    animations.current = [incoming];
    incoming.onfinish = () => {
      el.inert = false;
      delete el.dataset.seamFlip;
    };
  }, [shown]);
  useLayoutEffect(
    () => () => animations.current.forEach((a) => a.cancel()),
    [],
  );
  const display = shown.identity === props.identity ? props : shown;
  return (
    <div
      ref={element}
      className="wall-seam-face"
      style={{ width: display.width, marginLeft: -display.width / 2 }}
    >
      {display.spine && display.spineContent ? (
        display.spineContent
      ) : display.spine ? (
        <button
          className="seam-spine-title"
          aria-label="展开内容导航"
          onClick={props.expand}
        >
          {display.title}
        </button>
      ) : (
        display.content
      )}
    </div>
  );
}
