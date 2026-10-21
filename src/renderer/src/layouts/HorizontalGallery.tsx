import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MediaMetric } from "../../../shared/types";
import {
  Poster,
  resolveFocusIndex,
  useViewport,
  type LayoutProps,
} from "./shared";

/** One virtualized strip: equal heights horizontally, equal widths vertically. */
export default function Gallery({
  source,
  memory,
  remember,
  select,
  open,
  favorite,
  selected,
  clearFocus,
  contextMenu,
  removeRecent,
  interactive,
  vertical = false,
}: LayoutProps & { vertical?: boolean }) {
  const { ref, width, height } = useViewport();
  const offsetKey = vertical ? "verticalGalleryOffset" : "galleryOffset";
  const [metrics, setMetrics] = useState<MediaMetric[]>([]),
    [scroll, setScroll] = useState(memory[offsetKey] ?? 0);
  const [metricsReady, setMetricsReady] = useState(source.external);
  const coverHeight = Math.max(100, height - 250),
    coverWidth = Math.max(100, width - 80),
    viewport = vertical ? height : width;
  const slots = useMemo(() => {
    let offset = vertical ? 0 : 40;
    return Array.from({ length: source.total }, (_, index) => {
      const item = source.peek(index),
        metric = metrics[index];
      const raw =
        metric?.aspect ??
        (item?.width && item.height ? item.width / item.height : 1);
      const aspect = Number.isFinite(raw) && raw > 0 ? raw : 1;
      const w = vertical ? coverWidth : coverHeight * aspect,
        h = vertical ? coverWidth / aspect : coverHeight;
      const slot = {
        index,
        offset,
        width: w,
        height: h,
        length: vertical ? h + 36 : w,
      };
      offset += slot.length + 16;
      return slot;
    });
  }, [
    source,
    source.total,
    source.getSnapshot().metricsVersion,
    metrics,
    coverWidth,
    coverHeight,
    vertical,
  ]);
  const end = (slots.at(-1)?.offset ?? 0) + (slots.at(-1)?.length ?? 0) + 40;
  const lowerBound = (value: number) => {
    let lo = 0,
      hi = slots.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (slots[mid].offset + slots[mid].length < value) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const contentOffset = vertical ? Math.max(0, scroll - 120) : scroll;
  const first = Math.max(0, lowerBound(contentOffset - viewport)),
    last = Math.min(slots.length, lowerBound(contentOffset + viewport * 2) + 1);
  const restored = useRef(false),
    consumed = useRef<number | undefined>(undefined);
  const suppress = useRef(false),
    drag = useRef<{
      coordinate: number;
      offset: number;
      moved: boolean;
    } | null>(null);
  const readOffset = (node: HTMLDivElement) =>
    vertical ? node.scrollTop : node.scrollLeft;
  const writeOffset = (node: HTMLDivElement, value: number) => {
    if (vertical) node.scrollTop = value;
    else node.scrollLeft = value;
  };
  const frozenOffset = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    if (!ref.current) return;
    if (!interactive) frozenOffset.current = readOffset(ref.current);
    else if (frozenOffset.current !== undefined)
      writeOffset(ref.current, frozenOffset.current);
  }, [interactive]);
  useEffect(() => {
    let live = true;
    if (!source.external && source.getSnapshot().ready) {
      setMetricsReady(false);
      void window.media
        .layoutMetrics(source.query)
        .then((value) => {
          if (live) {
            setMetrics(value);
            setMetricsReady(true);
          }
        })
        .catch(() => {
          if (live) setMetricsReady(true);
        });
    }
    return () => {
      live = false;
    };
  }, [
    source,
    source.total,
    source.getSnapshot().ready,
    source.getSnapshot().metricsVersion,
  ]);
  useLayoutEffect(() => {
    if (!ref.current || !source.getSnapshot().ready || !metricsReady) return;
    if (restored.current && consumed.current === memory.focusRequest) return;
    const index = resolveFocusIndex(source, memory),
      slot = slots[index];
    const target =
      memory.revealFocus || memory[offsetKey] === undefined
        ? Math.max(
            0,
            (vertical ? 120 : 0) +
              (slot?.offset ?? 0) +
              (slot?.length ?? 0) / 2 -
              viewport / 2,
          )
        : memory[offsetKey]!;
    writeOffset(ref.current, target);
    setScroll(readOffset(ref.current));
    restored.current = true;
    consumed.current = memory.focusRequest;
    let live = true;
    void source.at(index).then((item) => {
      if (live && item) select?.(item, index);
    });
    if (memory.revealFocus) remember({ revealFocus: false });
    return () => {
      live = false;
    };
  }, [
    source,
    source.getSnapshot().ready,
    metricsReady,
    slots,
    memory.focusRequest,
    viewport,
    vertical,
  ]);
  useEffect(() => {
    void source.ensure(slots.slice(first, last).map((s) => s.index));
  }, [source, first, last, slots]);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const wheel = (e: WheelEvent) => {
      if (!interactive || e.ctrlKey) return;
      e.preventDefault();
      writeOffset(
        node,
        readOffset(node) +
          (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY),
      );
    };
    const cancel = () => {
      drag.current = null;
      suppress.current = false;
    };
    node.addEventListener("wheel", wheel, { passive: false });
    window.addEventListener("blur", cancel);
    return () => {
      node.removeEventListener("wheel", wheel);
      window.removeEventListener("blur", cancel);
    };
  }, [interactive, vertical]);
  return (
    <div
      ref={ref}
      className={`horizontal-gallery ${vertical ? "vertical-gallery" : ""}`}
      data-layout={vertical ? "verticalGallery" : "gallery"}
      data-layout-ready={metricsReady ? "true" : "false"}
      aria-label={vertical ? "等宽画廊" : "等高画廊"}
      onScroll={(e) => {
        if (!interactive) {
          if (frozenOffset.current !== undefined)
            writeOffset(e.currentTarget, frozenOffset.current);
          return;
        }
        const value = readOffset(e.currentTarget);
        frozenOffset.current = value;
        setScroll(value);
        if (restored.current) remember({ [offsetKey]: value });
      }}
      onDragStart={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        if (
          !interactive ||
          e.button ||
          (e.target as Element).closest(
            ".tile-actions,button:not(.poster-hit),input",
          )
        )
          return;
        suppress.current = false;
        drag.current = {
          coordinate: vertical ? e.clientY : e.clientX,
          offset: readOffset(e.currentTarget),
          moved: false,
        };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const coordinate = vertical ? e.clientY : e.clientX;
        if (!d.moved && Math.abs(coordinate - d.coordinate) > 6) {
          d.moved = true;
          suppress.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
        }
        if (d.moved)
          writeOffset(e.currentTarget, d.offset + d.coordinate - coordinate);
      }}
      onPointerUp={(e) => {
        drag.current = null;
        if (e.currentTarget.hasPointerCapture(e.pointerId))
          e.currentTarget.releasePointerCapture(e.pointerId);
        setTimeout(() => {
          suppress.current = false;
        }, 0);
      }}
      onPointerCancel={() => {
        drag.current = null;
        suppress.current = false;
      }}
      onLostPointerCapture={() => {
        if (drag.current) suppress.current = false;
        drag.current = null;
      }}
      onClickCapture={(e) => {
        if (suppress.current) {
          e.preventDefault();
          e.stopPropagation();
        }
      }}
      onClick={(e) => {
        if (!(e.target as Element).closest(".poster")) clearFocus?.();
      }}
    >
      <div
        className="horizontal-gallery-space"
        style={
          vertical
            ? { width: coverWidth, height: end, marginInline: "auto" }
            : { width: Math.max(width, end), height: coverHeight + 42 }
        }
      >
        {slots.slice(first, last).map((slot) => {
          const item = source.peek(slot.index);
          return (
            <Poster
              key={item?.id ?? slot.index}
              item={item}
              index={slot.index}
              mode="grid"
              style={{
                position: "absolute",
                left: vertical ? 0 : slot.offset,
                top: vertical ? slot.offset : 0,
                width: slot.width,
                height: slot.height + 36,
              }}
              selected={item ? selected?.(item, slot.index) : false}
              select={select}
              favorite={favorite}
              contextMenu={contextMenu}
              removeRecent={removeRecent}
              activate={() => {
                if (item) open(item, slot.index);
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
