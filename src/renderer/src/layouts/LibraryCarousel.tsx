import { useCoverFlow } from "./useCoverFlow";
import { useEffect, useRef, useState } from "react";
import { FolderOpen, Plus } from "lucide-react";
import type { BrowseMemory, Library, MediaItem } from "../../../shared/types";
import { Cover } from "../components";

export default function LibraryCarousel({
  libraries,
  open,
  create,
  memory,
  remember,
  reducedMotion,
}: {
  memory: BrowseMemory;
  remember(patch: Partial<BrowseMemory>): void;
  reducedMotion: boolean;
  libraries: Library[];
  open(lib: Library): void;
  create(): void;
}) {
  const initial = Math.max(
    0,
    Math.min(
      libraries.length - 1,
      libraries.findIndex((l) => l.id === memory.focusId) >= 0
        ? libraries.findIndex((l) => l.id === memory.focusId)
        : (memory.focusIndex ?? 0),
    ),
  );
  const [index, setIndex] = useState(initial),
    [covers, setCovers] = useState<Record<string, MediaItem>>({});
  const root = useRef<HTMLDivElement>(null);
  const flow = useCoverFlow(
    libraries.length,
    initial,
    reducedMotion,
    (next) => {
      setIndex(next);
      remember({
        focusIndex: next,
        focusId: libraries[next]?.id,
        carouselPosition: next,
      });
    },
  );
  const drag = useRef<{ x: number; start: number; moved: boolean } | null>(
      null,
    ),
    suppress = useRef(false);
  const snap = (next: number) => {
    const value = Math.max(0, Math.min(libraries.length - 1, next));
    setIndex(value);
    flow.snap(value);
  };
  useEffect(() => {
    const cancel = () => {
      drag.current = null;
      suppress.current = false;
      flow.cancel();
    };
    window.addEventListener("blur", cancel);
    return () => window.removeEventListener("blur", cancel);
  }, []);
  const from = Math.max(0, index - 4),
    to = Math.min(libraries.length, index + 5);
  const visible = libraries.slice(from, to);
  const keys = visible.map((l) => l.id).join(",");
  useEffect(() => {
    let live = true;
    for (const lib of visible)
      if (!covers[lib.id])
        void window.media
          .query({
            libraryId: lib.id,
            type: lib.type,
            browse: true,
            limit: 1,
            sort: "name",
          })
          .then((result) => {
            if (live && result.items[0])
              setCovers((c) => ({ ...c, [lib.id]: result.items[0] }));
          })
          .catch(() => {});
    return () => {
      live = false;
    };
  }, [keys]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      clearTimeout(timer);
      timer = setTimeout(
        () => snap(index + Math.sign(e.deltaX || e.deltaY)),
        60,
      );
    };
    root.current?.addEventListener("wheel", wheel, { passive: false });
    return () => {
      root.current?.removeEventListener("wheel", wheel);
      clearTimeout(timer);
    };
  }, [libraries.length, index]);
  return (
    <div
      ref={root}
      className="library-carousel"
      tabIndex={0}
      onPointerDown={(e) => {
        if (
          e.button ||
          (e.target as HTMLElement).closest(".library-carousel-create")
        )
          return;
        flow.cancel();
        suppress.current = false;
        drag.current = {
          x: e.clientX,
          start: flow.current.current,
          moved: false,
        };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        if (!d.moved && Math.abs(e.clientX - d.x) > 6) {
          d.moved = true;
          suppress.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
        }
        if (d.moved) {
          flow.move(d.start + (d.x - e.clientX) / 320);
          setIndex(Math.round(flow.current.current));
        }
      }}
      onPointerUp={(e) => {
        const moved = drag.current?.moved;
        drag.current = null;
        if (e.currentTarget.hasPointerCapture(e.pointerId))
          e.currentTarget.releasePointerCapture(e.pointerId);
        if (moved) snap(Math.round(flow.current.current));
        setTimeout(() => {
          suppress.current = false;
        }, 0);
      }}
      onPointerCancel={() => {
        suppress.current = false;
        drag.current = null;
      }}
      onLostPointerCapture={() => {
        if (drag.current) suppress.current = false;
        drag.current = null;
      }}
      onDragStart={(e) => e.preventDefault()}
      onClickCapture={(e) => {
        if (suppress.current) {
          e.preventDefault();
          e.stopPropagation();
        }
      }}
      data-spatial-scene="carousel"
      onKeyDown={(e) => {
        if (
          e.key === "Enter" &&
          !(e.target as HTMLElement).closest(".library-carousel-create") &&
          libraries[index]
        ) {
          e.preventDefault();
          remember({
            focusId: libraries[index].id,
            focusIndex: index,
            carouselPosition: flow.current.current,
          });
          open(libraries[index]);
          return;
        }
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          snap(index + (e.key === "ArrowLeft" ? -1 : 1));
        }
      }}
    >
      {visible.map((lib, n) => {
        const at = from + n,
          delta = at - flow.position;
        return (
          <button
            key={lib.id}
            data-media-id={`library:${lib.id}`}
            className="type-library-entry library-carousel-card"
            onClick={() => {
              if (at !== index || Math.abs(flow.current.current - at) > 0.02)
                snap(at);
              else {
                remember({
                  focusIndex: at,
                  focusId: lib.id,
                  carouselPosition: at,
                });
                open(lib);
              }
            }}
            style={{
              transform: `translate(calc(-50% + ${delta * 320}px),-50%) scale(${Math.max(0.4, 1 - Math.abs(delta) * 0.16)})`,
              opacity: Math.max(0.15, 1 - Math.abs(delta) * 0.24),
              zIndex: Math.round(10 - Math.abs(delta)),
              transition: "none",
            }}
          >
            {covers[lib.id] ? (
              <Cover item={covers[lib.id]} />
            ) : (
              <FolderOpen size={44} />
            )}
            <span>{lib.name}</span>
          </button>
        );
      })}
      <button className="library-carousel-create" onClick={create}>
        <Plus size={17} />
        {libraries.length ? "添加媒体库" : "创建媒体库"}
      </button>
    </div>
  );
}
