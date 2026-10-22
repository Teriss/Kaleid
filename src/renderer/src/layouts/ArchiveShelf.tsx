import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  Heart,
  FolderOpen,
} from "lucide-react";
import { Cover, IconButton } from "../components";
import {
  canHandleKey,
  resolveFocusIndex,
  useViewport,
  useWindowKey,
  type LayoutProps,
} from "./shared";
import {
  bookIndex,
  boundShelfPosition,
  DEPTH_X,
  DEPTH_Y,
  shelfGeometry,
  shelfPose,
  shelfRelease,
  visibleShelfLanes,
} from "./archiveShelfModel";
import "./archiveShelf.css";

export default function ArchiveShelf(props: LayoutProps) {
  const { source, memory, interactive, reducedMotion } = props;
  const [systemReduced, setSystemReduced] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const reduced = reducedMotion || systemReduced;
  const [mode, setMode] = useState(
    memory.archiveShelfMode === "finite" ? "finite" : "infinite",
  );
  const loop = mode === "infinite";
  const loopRef = useRef(loop);
  loopRef.current = loop;
  const { ref, width, height } = useViewport();
  const initial = resolveFocusIndex(source, memory);
  const position = useRef(initial);
  const [lane, setLane] = useState(initial);
  const laneRef = useRef(initial);
  const [moving, setMoving] = useState(false);
  const nodes = useRef(new Map<number, HTMLDivElement>());
  const frame = useRef(0),
    entryFrame = useRef(0),
    wheelTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const targetLane = useRef<number | null>(null);
  const motionReduced = useRef(reduced);
  motionReduced.current = reduced;
  const entrance = useRef(reduced || memory.focusId ? 1 : 0);
  const latest = useRef(props);
  latest.current = props;
  const paintRef = useRef(() => {});
  const drag = useRef<{
    id: number;
    x: number;
    position: number;
    lastX: number;
    lastAt: number;
    velocity: number;
    moved: boolean;
  } | null>(null);
  const suppressClick = useRef(false);
  const scale = Math.max(
    0.65,
    Math.min(1.5, (height - 380) / shelfGeometry(520).rowHeight),
  );
  const viewport = Math.max(260, Math.min(680, (width - 64) / scale));
  const geometry = shelfGeometry(viewport);
  const lanes = visibleShelfLanes(lane, source.total, viewport, geometry, loop);
  const index = bookIndex(lane, source.total);
  const item = source.peek(index);
  const snapshot = source.getSnapshot();

  paintRef.current = () => {
    for (const [slot, node] of nodes.current) {
      const pose = shelfPose(
        slot,
        position.current,
        viewport,
        geometry,
        entrance.current,
      );
      node.style.transform = `translate(${pose.x}px,${pose.y}px)`;
    }
  };
  useLayoutEffect(() => paintRef.current());

  function cancel() {
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    targetLane.current = null;
    clearTimeout(wheelTimer.current);
  }
  function finishEntrance() {
    cancelAnimationFrame(entryFrame.current);
    entrance.current = 1;
    paintRef.current();
  }
  function move(next: number) {
    position.current = boundShelfPosition(next, source.total, loopRef.current);
    const rounded = Math.round(position.current);
    if (rounded !== laneRef.current) {
      laneRef.current = rounded;
      setLane(rounded);
    }
    paintRef.current();
  }
  function rememberPosition() {
    const at = bookIndex(position.current, source.total);
    const entry = source.peek(at);
    if (entry) latest.current.remember({ focusIndex: at, focusId: entry.id });
  }
  function animate(
    sample: (seconds: number) => number,
    duration: number,
    target: number,
  ) {
    cancel();
    finishEntrance();
    if (
      motionReduced.current ||
      source.total < 2 ||
      duration <= 0 ||
      Math.abs(target - position.current) < 0.000001
    ) {
      move(target);
      setMoving(false);
      rememberPosition();
      return;
    }
    setMoving(true);
    targetLane.current = target;
    const began = performance.now();
    const tick = (now: number) => {
      const elapsed = (now - began) / 1000;
      if (elapsed >= duration) {
        frame.current = 0;
        targetLane.current = null;
        move(target);
        setMoving(false);
        rememberPosition();
      } else {
        move(sample(elapsed));
        frame.current = requestAnimationFrame(tick);
      }
    };
    frame.current = requestAnimationFrame(tick);
  }
  function centre(next: number) {
    const from = position.current;
    const target = boundShelfPosition(
      Math.round(next),
      source.total,
      loopRef.current,
    );
    animate(
      (seconds) =>
        from + (target - from) * (1 - (1 - Math.min(1, seconds / 0.36)) ** 3),
      0.36,
      target,
    );
  }
  function release(velocity: number) {
    const simulation = shelfRelease(
      position.current,
      Math.max(-40, Math.min(40, velocity)),
      loopRef.current ? undefined : source.total,
    );
    animate(simulation.at, simulation.duration, simulation.target);
  }
  function step(delta: number) {
    centre((targetLane.current ?? Math.round(position.current)) + delta);
  }
  function changeMode(next: "finite" | "infinite") {
    if (!interactive || next === mode) return;
    cancel();
    finishEntrance();
    drag.current = null;
    // Rebase an infinite occurrence to its real item before imposing bounds.
    const at = bookIndex(position.current, source.total);
    loopRef.current = next === "infinite";
    move(at);
    setMoving(false);
    setMode(next);
    latest.current.remember({ archiveShelfMode: next });
    rememberPosition();
  }
  function openCurrent() {
    const at = bookIndex(position.current, source.total);
    const entry = source.peek(at);
    if (!entry || !latest.current.interactive) return;
    cancel();
    finishEntrance();
    move(Math.round(position.current));
    setMoving(false);
    rememberPosition();
    latest.current.open(entry, at);
  }
  function activate(slot: number) {
    if (!latest.current.interactive) return;
    if (Math.abs(position.current - slot) < 0.03 && !frame.current)
      openCurrent();
    else {
      const at = bookIndex(slot, source.total);
      const entry = source.peek(at);
      if (entry?.kind === "folder" && latest.current.openSingle) {
        void latest.current.openSingle(entry, at).then((opened) => {
          if (opened === false) centre(slot);
          else if (opened === true) {
            cancel();
            finishEntrance();
            move(slot);
            setMoving(false);
            rememberPosition();
          }
        });
      } else centre(slot);
    }
  }

  useLayoutEffect(() => {
    if (!snapshot.ready) return;
    cancel();
    drag.current = null;
    move(resolveFocusIndex(source, latest.current.memory));
    setMoving(false);
    if (latest.current.memory.revealFocus)
      latest.current.remember({ revealFocus: false });
  }, [source, snapshot.ready, snapshot.refreshSerial, memory.focusRequest]);

  // Metadata and selection update only when crossing a lane, never every frame.
  const wanted = [
    ...new Set(lanes.map((slot) => bookIndex(slot, source.total))),
  ].join(",");
  useEffect(() => {
    if (source.total) void source.ensure(wanted.split(",").map(Number));
  }, [source, wanted]);
  useEffect(() => {
    if (!snapshot.ready || !interactive) return;
    const at = bookIndex(position.current, source.total);
    const current = source.peek(at);
    if (current) latest.current.select?.(current, at);
  }, [item, index, interactive, snapshot.ready]);

  useEffect(() => {
    if (entrance.current === 1) return;
    const began = performance.now();
    const tick = (now: number) => {
      entrance.current = Math.min(1, (now - began) / 720);
      paintRef.current();
      if (entrance.current < 1)
        entryFrame.current = requestAnimationFrame(tick);
    };
    entryFrame.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(entryFrame.current);
  }, []);
  useEffect(() => {
    if (!interactive || reduced) {
      cancel();
      finishEntrance();
      drag.current = null;
      move(Math.round(position.current));
      setMoving(false);
    }
  }, [interactive, reduced]);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const changed = () => setSystemReduced(query.matches);
    query.addEventListener("change", changed);
    return () => query.removeEventListener("change", changed);
  }, []);
  useEffect(() => {
    const blur = () => {
      drag.current = null;
      suppressClick.current = false;
      centre(Math.round(position.current));
    };
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("blur", blur);
      cancel();
      cancelAnimationFrame(entryFrame.current);
    };
  }, [source]);

  const wheelHandler = useRef<(event: WheelEvent) => void>(() => {});
  wheelHandler.current = (event) => {
    if (!interactive || source.total < 2 || event.ctrlKey || event.metaKey)
      return;
    event.preventDefault();
    cancel();
    finishEntrance();
    const delta =
      (Math.abs(event.deltaX) > Math.abs(event.deltaY)
        ? event.deltaX
        : event.deltaY) *
      (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? width : 1);
    if (reduced) {
      wheelTimer.current = setTimeout(
        () => centre(Math.round(position.current) + Math.sign(delta)),
        65,
      );
    } else {
      move(position.current + delta / (geometry.pitch * scale * 2));
      setMoving(true);
      wheelTimer.current = setTimeout(() => release(0), 100);
    }
  };
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const wheel = (event: WheelEvent) => wheelHandler.current(event);
    node.addEventListener("wheel", wheel, { passive: false });
    return () => node.removeEventListener("wheel", wheel);
  }, []);
  useWindowKey((event) => {
    if (!canHandleKey(event, interactive) || !source.total || event.isComposing)
      return;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      step(event.key === "ArrowLeft" ? -1 : 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      openCurrent();
    }
  });

  const g = geometry;
  const metadata = item?.kind
    ? `文件夹 · ${item.folderCount ?? 0} 项`
    : [
        item?.ext.replace(/^\./, "").toUpperCase(),
        item?.missing
          ? "文件不可用"
          : item?.progress?.completed
            ? "已读完"
            : typeof item?.progress?.scroll === "number"
              ? `已读 ${Math.round(Math.max(0, Math.min(1, item.progress.scroll)) * 100)}%`
              : item?.progress?.page !== undefined
                ? `读至第 ${item.progress.page + 1} 页`
                : item?.lastOpened
                  ? "继续阅读"
                  : "尚未阅读",
      ]
        .filter(Boolean)
        .join(" · ");
  return (
    <section
      ref={ref}
      className="archive-shelf"
      data-layout="archiveShelf"
      data-shelf-mode={mode}
      data-moving={moving}
      data-layout-ready={snapshot.ready}
      aria-label="立体书架"
    >
      <div className="archive-shelf-content">
        <header className="archive-heading">
          <span aria-hidden="true">01 / READING ARCHIVE</span>
          <i aria-hidden="true" />
          <div className="archive-mode" role="group" aria-label="书架范围">
            <button
              type="button"
              aria-pressed={!loop}
              disabled={!interactive}
              onClick={() => changeMode("finite")}
            >
              有限
            </button>
            <button
              type="button"
              aria-pressed={loop}
              disabled={!interactive}
              onClick={() => changeMode("infinite")}
            >
              无限
            </button>
          </div>
          <b aria-hidden="true" />
        </header>
        <div
          className={`archive-bank ${moving ? "is-dragging" : ""}`}
          style={
            {
              height: g.rowHeight * scale,
              width: viewport * scale,
            } as CSSProperties
          }
          onDragStart={(event) => event.preventDefault()}
          onClickCapture={(event) => {
            if (suppressClick.current) {
              event.preventDefault();
              event.stopPropagation();
              suppressClick.current = false;
            }
          }}
          onPointerDown={(event) => {
            if (
              !interactive ||
              source.total < 2 ||
              event.button !== 0 ||
              (event.target as HTMLElement).closest("button:not(.archive-face)")
            )
              return;
            cancel();
            finishEntrance();
            suppressClick.current = false;
            drag.current = {
              id: event.pointerId,
              x: event.clientX,
              position: position.current,
              lastX: event.clientX,
              lastAt: performance.now(),
              velocity: 0,
              moved: false,
            };
          }}
          onPointerMove={(event) => {
            const d = drag.current;
            if (!d || d.id !== event.pointerId) return;
            if (!d.moved && Math.abs(event.clientX - d.x) > 6) {
              d.moved = true;
              suppressClick.current = true;
              event.currentTarget.setPointerCapture(event.pointerId);
              setMoving(true);
            }
            if (!d.moved) return;
            const now = performance.now();
            if (now > d.lastAt)
              d.velocity =
                (d.lastX - event.clientX) /
                (geometry.pitch * scale) /
                Math.max(0.008, (now - d.lastAt) / 1000);
            d.lastX = event.clientX;
            d.lastAt = now;
            move(d.position + (d.x - event.clientX) / (geometry.pitch * scale));
          }}
          onPointerUp={(event) => {
            const d = drag.current;
            if (!d || d.id !== event.pointerId) return;
            drag.current = null;
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId);
            if (d.moved)
              release(performance.now() - d.lastAt < 100 ? d.velocity : 0);
          }}
          onPointerCancel={() => {
            drag.current = null;
            centre(Math.round(position.current));
          }}
          onLostPointerCapture={() => {
            if (drag.current) {
              drag.current = null;
              centre(Math.round(position.current));
            }
          }}
        >
          <div
            className="archive-world"
            style={{
              width: viewport,
              height: g.rowHeight,
              transform: `translateX(-50%) scale(${scale})`,
            }}
          >
            {lanes.map((slot, order) => {
              const at = bookIndex(slot, source.total),
                entry = source.peek(at);
              const active = slot === lane;
              const title = entry?.title ?? "正在加载";
              const glyphs = Array.from(title);
              const shortTitle =
                glyphs.slice(0, 7).join("") + (glyphs.length > 7 ? "…" : "");
              const pose = shelfPose(
                slot,
                position.current,
                viewport,
                g,
                entrance.current,
              );
              const label = `${active ? "打开" : "居中"} ${title}`;
              return (
                <div
                  key={slot}
                  ref={(node) => {
                    if (node) nodes.current.set(slot, node);
                    else nodes.current.delete(slot);
                  }}
                  className={`archive-volume ${active ? "is-focused" : ""}`}
                  data-media-id={entry?.id}
                  data-index={at}
                  data-lane={slot}
                  data-active={active}
                  style={{
                    width: g.footprint,
                    height: g.height,
                    zIndex: order,
                    transform: `translate(${pose.x}px,${pose.y}px)`,
                  }}
                  onContextMenu={(event) => {
                    if (!interactive || !entry) return;
                    cancel();
                    finishEntrance();
                    move(slot);
                    setMoving(false);
                    props.contextMenu?.(entry, at, event);
                  }}
                >
                  <svg
                    className="archive-top"
                    aria-hidden="true"
                    width={g.footprint + 2}
                    height={g.cover * -DEPTH_Y + g.spine * 0.1 + 2}
                    style={{ top: g.cover * DEPTH_Y - 1 }}
                  >
                    <polygon
                      points={`0,${g.cover * -DEPTH_Y + 1} ${g.spine},${g.cover * -DEPTH_Y + g.spine * 0.1 + 1} ${g.footprint},${g.spine * 0.1 + 1} ${g.cover * DEPTH_X},1`}
                      onClick={() => activate(slot)}
                    />
                  </svg>
                  <button
                    type="button"
                    className="archive-face archive-spine"
                    aria-label={label}
                    disabled={!entry || !interactive}
                    tabIndex={active ? 0 : -1}
                    style={{
                      width: g.spine,
                      height: g.height,
                      transform: "matrix(1,.1,0,1,0,0)",
                    }}
                    onClick={() => activate(slot)}
                  >
                    <span className="archive-number">
                      {String(at + 1).padStart(2, "0")}
                    </span>
                    <span className="archive-spine-title">{shortTitle}</span>
                    <span className="archive-circle" />
                  </button>
                  <button
                    type="button"
                    className="archive-face archive-front"
                    aria-label={`${label}封面`}
                    disabled={!entry || !interactive}
                    tabIndex={-1}
                    style={{
                      width: g.cover,
                      height: g.height,
                      transform: `matrix(${DEPTH_X},${DEPTH_Y},0,1,${g.spine},${g.spine * 0.1})`,
                    }}
                    onClick={() => activate(slot)}
                  >
                    <span className="archive-number">
                      NO.{String(at + 1).padStart(3, "0")}
                    </span>
                    {entry?.kind ? (
                      <div className="archive-folder-cover">
                        <FolderOpen size={34} />
                        <span>{title}</span>
                      </div>
                    ) : entry ? (
                      <div className="archive-cover-wrap">
                        <Cover item={entry} />
                        {!entry.cover && (
                          <span className="archive-fallback-title">
                            {title}
                          </span>
                        )}
                      </div>
                    ) : (
                      <div className="archive-cover-loading" />
                    )}
                    <span className="archive-number archive-file-code">
                      {entry?.kind
                        ? "COLLECTION"
                        : `KD-${String(at + 1).padStart(5, "0")}`}
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
        </div>
        <div className="archive-caption">
          <button
            className="archive-open"
            disabled={!item || !interactive}
            onClick={openCurrent}
            aria-label={item ? `打开 ${item.title}` : "正在加载书籍"}
          >
            <span>
              <strong>{item?.title ?? "正在加载…"}</strong>
              <small>{metadata}</small>
            </span>
            <ArrowUpRight size={25} />
          </button>
          {item && !item.kind && (
            <IconButton
              label={
                item.favorite ? `取消收藏 ${item.title}` : `收藏 ${item.title}`
              }
              disabled={!interactive}
              active={item.favorite}
              onClick={() => props.favorite(item)}
            >
              <Heart size={19} fill={item.favorite ? "currentColor" : "none"} />
            </IconButton>
          )}
        </div>
        <footer className="archive-pagination">
          <IconButton
            label="上一份档案"
            disabled={
              source.total < 2 || !interactive || (!loop && index === 0)
            }
            onClick={() => step(-1)}
          >
            <ChevronLeft size={19} />
          </IconButton>
          <output aria-live="polite" aria-atomic="true" aria-label="书架位置">
            {String(index + 1).padStart(2, "0")} /{" "}
            {String(source.total).padStart(2, "0")}
          </output>
          <IconButton
            label="下一份档案"
            disabled={
              source.total < 2 ||
              !interactive ||
              (!loop && index === source.total - 1)
            }
            onClick={() => step(1)}
          >
            <ChevronRight size={19} />
          </IconButton>
        </footer>
        {snapshot.error && (
          <div className="archive-error" role="status">
            {snapshot.error}
            <button onClick={() => source.retry()}>重试加载</button>
          </div>
        )}
      </div>
    </section>
  );
}
