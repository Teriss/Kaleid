import { useLayoutEffect, useEffect, useMemo, useRef, useState } from "react";
import {
  Backdrop,
  canHandleKey,
  useWindowKey,
  Poster,
  resolveFocusIndex,
  useViewport,
  type LayoutProps,
} from "./shared";
import {
  getHexCubicSpiral,
  computeHexCardFrame,
  ArtistPicture,
} from "./foliaGeometry";

import { useCoverFlow } from "./useCoverFlow";
import FoliaExplore from "./FoliaExplore";
import { artistInfo } from "../music/catalog";

export default function SpatialGrid({
  source,
  scope,
  memory,
  remember,
  open,
  favorite,
  selected,
  clearFocus,
  select,
  contextMenu,
  removeRecent,
  reducedMotion,
  interactive,
  forceCarousel = false,
}: LayoutProps & { forceCarousel?: boolean }) {
  const { ref, width, height } = useViewport();
  const scene = forceCarousel
    ? "carousel"
    : scope?.remoteKind === "artist"
      ? "artist"
      : scope?.view === "music" &&
          !scope.remoteId &&
          !scope.search &&
          !source.query.search &&
          (!scope.section || scope.section === "discover")
        ? "explore"
        : source.getSnapshot().scene;
  const carousel = scene === "carousel";
  const [artist, setArtist] = useState<{
    title: string;
    description: string;
    cover?: string;
  } | null>(null);
  useEffect(() => {
    let live = true;
    setArtist(null);
    if (scene === "artist" && scope)
      void artistInfo(scope)
        .then((info) => {
          if (live) setArtist(info);
        })
        .catch(() => {});
    return () => {
      live = false;
    };
  }, [scope?.remoteId, scope?.providerId, scene]);
  const [index, setIndex] = useState(resolveFocusIndex(source, memory));
  const cw = carousel
      ? Math.max(180, Math.min(340, width / 4))
      : Math.max(160, Math.min(250, width / 4)),
    ch = source.query.type === "video" ? cw * 0.7 : cw * 1.23;
  // Only the light geometry index covers the query. Metadata and DOM remain viewport-paged.
  const coords = useMemo(
    () =>
      getHexCubicSpiral(source.total).map((c, index) => ({
        index,
        baseX: (c.x + c.z / 2) * (cw + 60),
        baseY: c.z * (ch + 45),
      })),
    [source.total, cw, ch],
  );
  const initial = coords[index] ?? { baseX: 0, baseY: 0 };
  const [camera, setCamera] = useState(
    memory.spatialCamera ?? { x: initial.baseX, y: initial.baseY },
  );
  const flow = useCoverFlow(
    source.total,
    memory.carouselPosition ?? index,
    reducedMotion,
    (value) => {
      setIndex(value);
      remember({
        carouselPosition: value,
        focusIndex: value,
        focusId: source.peek(value)?.id,
        spatialScene: scene,
      });
    },
  );
  const cameraRef = useRef(camera);
  cameraRef.current = camera;
  useLayoutEffect(() => {
    if (!source.getSnapshot().ready) return;
    flow.cancel();
    cancelAnimationFrame(motion.current);
    const next = resolveFocusIndex(source, memory),
      coord = coords[next];
    setIndex(next);
    flow.move(memory.revealFocus ? next : (memory.carouselPosition ?? next));
    if (coord) {
      const target = memory.revealFocus
        ? { x: coord.baseX, y: coord.baseY }
        : (memory.spatialCamera ?? { x: coord.baseX, y: coord.baseY });
      cameraRef.current = target;
      setCamera(target);
    }
    if (memory.revealFocus) remember({ revealFocus: false });
  }, [source, source.getSnapshot().ready, memory.focusRequest, width, height]);
  const drag = useRef<{
    x: number;
    y: number;
    startX: number;
    startY: number;
    startIndex: number;
    moved: boolean;
  } | null>(null);
  const suppress = useRef(false),
    motion = useRef(0);
  const [moving, setMoving] = useState(false);
  const item = source.peek(index);
  const visible = carousel
    ? coords.slice(Math.max(0, index - 5), Math.min(source.total, index + 6))
    : coords
        .filter(
          (c) =>
            Math.abs(c.baseX - camera.x) < width / 2 + cw &&
            Math.abs(c.baseY - camera.y) < height / 2 + ch,
        )
        .slice(0, 160);
  const indices = visible.map((c) => c.index).join(",");
  useEffect(() => {
    void source.ensure(indices.split(",").filter(Boolean).map(Number));
  }, [source, indices]);
  useEffect(() => {
    if (
      item &&
      source.getSnapshot().ready &&
      (!memory.revealFocus || item.id === memory.focusId)
    ) {
      select?.(item, index);
    }
  }, [index, item?.id, camera.x, camera.y, scene]);
  function snap(next: number) {
    next = Math.max(0, Math.min(source.total - 1, next));
    setIndex(next);
    if (carousel) {
      flow.snap(next);
      return;
    }
    const target = coords[next];
    if (!target) return;
    const start = cameraRef.current,
      began = performance.now();
    cancelAnimationFrame(motion.current);
    const frame = () => {
      const t = reducedMotion
          ? 1
          : Math.min(1, (performance.now() - began) / 320),
        ease = 1 - Math.pow(1 - t, 3);
      setCamera({
        x: start.x + (target.baseX - start.x) * ease,
        y: start.y + (target.baseY - start.y) * ease,
      });
      if (t < 1) motion.current = requestAnimationFrame(frame);
      else
        remember({
          spatialCamera: { x: target.baseX, y: target.baseY },
          focusIndex: next,
          focusId: source.peek(next)?.id,
          spatialScene: scene,
        });
    };
    frame();
  }
  function nearest(x: number, y: number) {
    return coords.reduce(
      (best, c) =>
        Math.hypot(c.baseX - x, c.baseY - y) <
        Math.hypot(best.baseX - x, best.baseY - y)
          ? c
          : best,
      coords[0] ?? { index: 0, baseX: 0, baseY: 0 },
    );
  }
  function activate(at: number) {
    const entry = source.peek(at);
    if (!entry) return;
    if (
      (!carousel && entry.kind) ||
      (at === index &&
        (!carousel || Math.abs(flow.current.current - at) < 0.02))
    ) {
      remember(
        carousel
          ? { carouselPosition: flow.current.current }
          : { spatialCamera: cameraRef.current },
      );
      open(entry, at);
    } else snap(at);
  }
  useEffect(() => {
    const cancel = () => {
      drag.current = null;
      suppress.current = false;
      setMoving(false);
    };
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("blur", cancel);
      cancelAnimationFrame(motion.current);
    };
  }, []);
  useEffect(() => {
    if (source.getSnapshot().refreshSerial)
      snap(source.getSnapshot().anchorIndex);
  }, [source.getSnapshot().refreshSerial]);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    let timer: ReturnType<typeof setTimeout>;
    const wheel = (e: WheelEvent) => {
      if (!interactive || scene === "explore") return;
      e.preventDefault();
      cancelAnimationFrame(motion.current);
      if (carousel) {
        clearTimeout(timer);
        timer = setTimeout(
          () =>
            snap(
              index +
                Math.sign(
                  Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY,
                ),
            ),
          65,
        );
      } else {
        setCamera((c) => ({ x: c.x + e.deltaX, y: c.y + e.deltaY }));
        clearTimeout(timer);
        timer = setTimeout(() => {
          const c = cameraRef.current;
          snap(nearest(c.x, c.y).index);
        }, 140);
      }
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => {
      element.removeEventListener("wheel", wheel);
      clearTimeout(timer);
    };
  }, [interactive, scene, index, coords]);
  useWindowKey((e) => {
    if (!canHandleKey(e, interactive) || !source.total) return;
    if (e.key === "Enter" && item) {
      e.preventDefault();
      open(item, index);
    }
    const step = (
      {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
      } as Record<string, number[]>
    )[e.key];
    if (!step) return;
    e.preventDefault();
    if (carousel) snap(index + (step[0] || step[1]));
    else {
      const from = coords[index];
      const candidates = coords.filter(
        (c) =>
          (c.baseX - from.baseX) * step[0] + (c.baseY - from.baseY) * step[1] >
          1,
      );
      candidates.sort((a, b) => {
        const score = (c: typeof from) =>
          Math.hypot(c.baseX - from.baseX, c.baseY - from.baseY) +
          Math.abs(
            (c.baseX - from.baseX) * step[1] - (c.baseY - from.baseY) * step[0],
          ) *
            2;
        return score(a) - score(b);
      });
      if (candidates[0]) snap(candidates[0].index);
    }
  });
  const render = (at: number, style: React.CSSProperties) => (
    <Poster
      key={source.peek(at)?.id ?? at}
      item={source.peek(at)}
      index={at}
      active={at === index}
      selected={source.peek(at) ? selected?.(source.peek(at)!, at) : false}
      mode="spatial"
      style={style}
      select={select}
      activate={() => activate(at)}
      contextMenu={contextMenu}
      favorite={favorite}
      removeRecent={removeRecent}
    />
  );
  if (scene === "explore")
    return (
      <FoliaExplore
        {...{
          source,
          scope,
          memory,
          remember,
          open,
          favorite,
          selected,
          clearFocus,
          select,
          contextMenu,
          removeRecent,
          reducedMotion,
          interactive,
        }}
      />
    );
  return (
    <div
      ref={ref}
      className={`folia-grid spatial-grid ${carousel ? "cover-flow" : ""} ${moving ? "is-dragging" : ""}`}
      data-layout={forceCarousel ? "carousel" : "spatial"}
      data-spatial-scene={scene}
      aria-label={forceCarousel ? "封面流" : "空间网格"}
      onDragStart={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        if (
          !interactive ||
          e.button ||
          (e.target as HTMLElement).closest(
            ".tile-actions,.wall-playback-controls,button:not(.poster-hit),input",
          )
        )
          return;
        cancelAnimationFrame(motion.current);
        flow.cancel();
        drag.current = {
          x: e.clientX,
          y: e.clientY,
          startX: camera.x,
          startY: camera.y,
          startIndex: flow.current.current,
          moved: false,
        };
        suppress.current = false;
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6) {
          d.moved = true;
          suppress.current = true;
          setMoving(true);
          e.currentTarget.setPointerCapture(e.pointerId);
        }
        if (d.moved) {
          if (carousel) {
            flow.move(d.startIndex + (d.x - e.clientX) / (cw + 65));
            setIndex(Math.round(flow.current.current));
          } else {
            const c = {
              x: d.startX + d.x - e.clientX,
              y: d.startY + d.y - e.clientY,
            };
            setCamera(c);
            setIndex(nearest(c.x, c.y).index);
          }
        }
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        drag.current = null;
        setMoving(false);
        if (e.currentTarget.hasPointerCapture(e.pointerId))
          e.currentTarget.releasePointerCapture(e.pointerId);
        if (d?.moved) {
          if (carousel) snap(Math.round(flow.current.current));
          else {
            const c = cameraRef.current;
            snap(nearest(c.x, c.y).index);
          }
          setTimeout(() => (suppress.current = false), 0);
        }
      }}
      onPointerCancel={() => {
        suppress.current = false;
        drag.current = null;
        setMoving(false);
      }}
      onLostPointerCapture={() => {
        if (drag.current) suppress.current = false;
        drag.current = null;
        setMoving(false);
      }}
      onClickCapture={(e) => {
        if (suppress.current) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        if (
          !interactive ||
          (e.target as Element).closest(
            ".tile-actions,.wall-playback-controls,button:not(.poster-hit),input",
          )
        )
          return;
        // Cover clicks belong to the viewport controller. Selection must not run first and
        // restore an old viewport before the requested snap has finished.
        let card = (e.target as Element).closest<HTMLElement>(
          ".poster[data-index]",
        );
        if (!card) {
          card =
            Array.from(
              e.currentTarget.querySelectorAll<HTMLElement>(
                ".poster[data-index]",
              ),
            )
              .filter((node) => {
                const r = node.getBoundingClientRect();
                return (
                  e.clientX >= r.left &&
                  e.clientX <= r.right &&
                  e.clientY >= r.top &&
                  e.clientY <= r.bottom
                );
              })
              .sort(
                (a, b) => Number(b.style.zIndex) - Number(a.style.zIndex),
              )[0] ?? null;
        }
        if (!card) return;
        e.preventDefault();
        e.stopPropagation();
        const at = Number(card.dataset.index);
        if (Number.isSafeInteger(at)) activate(at);
      }}
    >
      <Backdrop item={item} reducedMotion={reducedMotion} />
      {scene === "artist" && artist && (
        <div className="folia-artist-intro">
          <div className="artist-picture">
            <ArtistPicture url={artist.cover ?? null} instant={reducedMotion} />
          </div>
          <div>
            <h2>{artist.title}</h2>
            <p>{artist.description}</p>
          </div>
        </div>
      )}
      <div className="spatial-plane">
        {visible.map((c) => {
          if (carousel) {
            const delta = c.index - flow.position,
              scale = Math.max(0.38, 1 - Math.abs(delta) * 0.17);
            return render(c.index, {
              width: cw,
              height: ch,
              transform: `translate3d(${width / 2 - cw / 2 + delta * (cw + 65)}px,${height / 2 - ch / 2}px,0px) scale(${scale})`,
              opacity: Math.max(0.12, 1 - Math.abs(delta) * 0.23),
              zIndex: Math.round(50 - Math.abs(delta)),
            });
          }
          const frame = computeHexCardFrame(c, -camera.x, -camera.y, {
            clipRadius: Math.hypot(width, height),
            maxDistance: Math.max(width, height) * 0.72,
            lodStart: 100,
            lodEnd: 450,
            viewportWidth: width,
            viewportHeight: height,
            cardWidth: cw,
            cardHeight: ch,
            minScale: 0.35,
            minOpacity: 0.15,
          });
          return render(c.index, {
            width: cw,
            height: ch,
            left: width / 2 - cw / 2 - camera.x,
            top: height / 2 - ch / 2 - camera.y,
            transform: frame.transform,
            opacity: +frame.opacity,
            zIndex: +frame.zIndex,
          });
        })}
      </div>
      <div className="spatial-controls">
        <button aria-label="上一项" onClick={() => snap(index - 1)}>
          ‹
        </button>
        <span>
          {index + 1} / {source.total}
        </span>
        <button aria-label="下一项" onClick={() => snap(index + 1)}>
          ›
        </button>
      </div>
      {carousel && item && (
        <div className="spatial-caption">
          <strong>{item.title}</strong>
        </div>
      )}
    </div>
  );
}
