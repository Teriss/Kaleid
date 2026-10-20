import { memo, useLayoutEffect, useRef, useState } from "react";
import { Poster, type LayoutProps } from "./shared";
import type { MediaItem } from "../../../shared/types";
import type { WallTile } from "./geometry";
import type { WallFlipStep } from "./wallModel";

type Props = Pick<
  LayoutProps,
  "favorite" | "select" | "contextMenu" | "removeRecent"
> & {
  tile: WallTile;
  item?: MediaItem;
  active: boolean;
  selected: boolean;
  reduced: boolean;
  step?: WallFlipStep;
  activate(tile: WallTile): void;
  settled(key: string, token: number): void;
};
const rotation = (degrees: number) =>
  `perspective(1400px) rotateY(${degrees}deg)`;
const lifted = { transform: "translate3d(0,-90px,0) scale(.88)", opacity: 0 };
const still = { transform: "none", opacity: 1 };

// Only the face turns. Content changes at 90 degrees, leaving the world slot stable.
function WallTileFace(props: Props) {
  const { tile, item } = props;
  const planned =
    props.step?.to === (item?.id ?? null) ? props.step : undefined;
  const step =
    planned && props.reduced
      ? { ...planned, reduced: true, delay: 0, wave: undefined }
      : planned;
  const face = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState({ item, index: tile.index });
  const latest = useRef(props);
  latest.current = props;
  const animations = useRef<Animation[]>([]);
  const pending = useRef<{ step: WallFlipStep; key: string } | null>(null);
  const animationKey = step
    ? `${step.token}:${step.to}:${step.reduced}`
    : `swap:${item?.id}`;
  useLayoutEffect(() => {
    animations.current.forEach((a) => a.cancel());
    animations.current = [];
    pending.current = null;
    const element = face.current;
    if (!step || !element || shown.item?.id === item?.id) {
      if (shown.item?.id !== item?.id)
        setShown({
          item: latest.current.item,
          index: latest.current.tile.index,
        });
      if (step) props.settled(tile.key, step.token);
      return;
    }
    const reduced = step.reduced;
    const out = element.animate(
      reduced
        ? [{ opacity: 1 }, { opacity: 0 }]
        : step.wave
          ? [still, lifted]
          : [
              { transform: rotation(0) },
              { transform: rotation(90 * step.direction) },
            ],
      {
        duration: reduced ? 90 : step.wave ? 280 : 150,
        delay: reduced ? 0 : step.delay,
        fill: "forwards",
        easing: step.wave ? "cubic-bezier(.4,0,1,1)" : "ease-in",
      },
    );
    animations.current = [out];
    out.onfinish = () => {
      pending.current = { step, key: tile.key };
      setShown({ item: latest.current.item, index: latest.current.tile.index });
    };
    return () => {
      out.onfinish = null;
      animations.current.forEach((a) => a.cancel());
      props.settled(tile.key, step.token);
    };
    // The stage owns a token/target pair; unrelated selection/data renders must not restart it.
  }, [animationKey]);
  useLayoutEffect(() => {
    const entry = pending.current,
      element = face.current;
    if (!entry || !element) return;
    pending.current = null;
    const s = entry.step;
    animations.current.forEach((a) => a.cancel());
    const incoming = element.animate(
      s.reduced
        ? [{ opacity: 0 }, { opacity: 1 }]
        : s.wave
          ? [lifted, still]
          : [
              { transform: rotation(-90 * s.direction) },
              { transform: rotation(0) },
            ],
      {
        duration: s.reduced ? 90 : s.wave ? 420 : 210,
        delay: s.wave ? Math.max(0, s.wave.inDelay - s.delay - 280) : 0,
        easing: s.wave
          ? "cubic-bezier(.2,.9,.3,1.04)"
          : "cubic-bezier(.2,.7,.25,1)",
        fill: "both",
      },
    );
    animations.current = [incoming];
    incoming.onfinish = () => {
      incoming.cancel();
      latest.current.settled(entry.key, s.token);
    };
  }, [shown]);
  useLayoutEffect(
    () => () => animations.current.forEach((a) => a.cancel()),
    [],
  );
  const display =
    step && shown.item?.id !== item?.id ? shown : { item, index: tile.index };
  return (
    <div
      className="wall-slot"
      data-slot={tile.key}
      inert={Boolean(step && shown.item?.id !== item?.id)}
      style={{
        width: tile.width,
        height: tile.height,
        transform: `translate3d(${tile.x}px,${tile.y}px,0)`,
      }}
    >
      <div ref={face} className="wall-face">
        <Poster
          item={display.item}
          index={display.index}
          instance={tile.key}
          active={props.active}
          selected={props.selected}
          style={{ width: "100%", height: "100%" }}
          activate={() => latest.current.activate(latest.current.tile)}
          favorite={props.favorite}
          select={props.select}
          contextMenu={props.contextMenu}
          removeRecent={props.removeRecent}
        />
      </div>
    </div>
  );
}
export default memo(
  WallTileFace,
  (a, b) =>
    a.item === b.item &&
    a.active === b.active &&
    a.selected === b.selected &&
    a.reduced === b.reduced &&
    a.step === b.step &&
    a.activate === b.activate &&
    a.favorite === b.favorite &&
    a.select === b.select &&
    a.contextMenu === b.contextMenu &&
    a.removeRecent === b.removeRecent &&
    a.tile.key === b.tile.key &&
    a.tile.index === b.tile.index &&
    a.tile.x === b.tile.x &&
    a.tile.y === b.tile.y &&
    a.tile.width === b.tile.width &&
    a.tile.height === b.tile.height,
);
