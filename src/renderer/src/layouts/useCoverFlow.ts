import { useRef, useState, useEffect } from "react";
/** A continuous horizontal coordinate; pointer movement never rounds the viewport. */
export function useCoverFlow(
  total: number,
  initial: number,
  reduced: boolean,
  settled: (position: number) => void,
) {
  const [position, set] = useState(initial);
  const current = useRef(initial),
    frame = useRef(0),
    callback = useRef(settled);
  callback.current = settled;
  const cancel = () => cancelAnimationFrame(frame.current);
  const move = (value: number) => {
    const next = Math.max(0, Math.min(Math.max(0, total - 1), value));
    current.current = next;
    set(next);
  };
  const snap = (value: number) => {
    cancel();
    const next = Math.max(
      0,
      Math.min(Math.max(0, total - 1), Math.round(value)),
    );
    const from = current.current,
      began = performance.now();
    const tick = () => {
      const t = reduced ? 1 : Math.min(1, (performance.now() - began) / 320);
      move(from + (next - from) * (1 - Math.pow(1 - t, 3)));
      if (t < 1) frame.current = requestAnimationFrame(tick);
      else callback.current(next);
    };
    tick();
  };
  useEffect(() => cancel, []);
  return { position, current, move, snap, cancel };
}
