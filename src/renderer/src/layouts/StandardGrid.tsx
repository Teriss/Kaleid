import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Poster,
  resolveFocusIndex,
  useViewport,
  type LayoutProps,
} from "./shared";

export default function StandardGrid({
  source,
  memory,
  remember,
  open,
  favorite,
  selected,
  clearFocus,
  select,
  contextMenu,
  removeRecent,
  interactive,
  onReachEnd,
  onReachStart,
  onViewportAnchorChange,
  minimumCellWidth = 230,
}: LayoutProps) {
  const { ref, width, height } = useViewport();
  const [scroll, setScroll] = useState(memory.scrollTop ?? 0);
  const ready = source.getSnapshot().ready;
  const total = source.total;
  const frozen = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    if (!ref.current) return;
    if (!interactive) frozen.current = ref.current.scrollTop;
    else if (frozen.current !== undefined)
      ref.current.scrollTop = frozen.current;
  }, [interactive]);
  const restored = useRef(false),
    consumed = useRef<number | undefined>(undefined);
  const columns = Math.max(1, Math.floor((width - 80) / minimumCellWidth));
  const kind = source.query.type;
  const comicRows = kind === "comic" && source.external;
  const columnWidth = comicRows
    ? Math.max(minimumCellWidth, 340)
    : minimumCellWidth;
  const comicColumns = Math.max(1, Math.floor((width - 80) / columnWidth));
  const gridColumns = comicRows ? comicColumns : columns;
  const cellWidth = Math.max(
    100,
    (width - 80 - (gridColumns - 1) * 22) / gridColumns,
  );
  const rowHeight = comicRows
    ? 222
    : cellWidth *
        (kind === "video"
          ? 9 / 16
          : kind === "novel" || kind === "comic"
            ? 1.4
            : 1.12) +
      36;
  const from = Math.max(0, Math.floor((scroll - 150) / rowHeight) - 2);
  const to = Math.min(
    Math.ceil(source.total / gridColumns),
    Math.ceil((scroll + height) / rowHeight) + 2,
  );
  const visibleAnchor = useRef<{ id: string; offset: number } | undefined>(
    undefined,
  );
  const corrected = useRef<number | undefined>(undefined);
  const externalSerial = source.getSnapshot().externalChange?.serial;
  const consumedExternal = useRef<number | undefined>(undefined);
  const reachStartRef = useRef(onReachStart);
  reachStartRef.current = onReachStart;
  const reachEndRef = useRef(onReachEnd);
  reachEndRef.current = onReachEnd;
  useEffect(() => {
    const element = ref.current;
    if (!element || !interactive) return;
    const wheel = (event: WheelEvent) => {
      if (event.deltaY < 0 && element.scrollTop <= 2 && reachStartRef.current) {
        // Consume overscroll so its deferred default action cannot move the
        // viewport after an immediately cached previous page is inserted.
        event.preventDefault();
        reachStartRef.current();
      }
      if (
        event.deltaY > 0 &&
        element.scrollTop + element.clientHeight >= element.scrollHeight - 2 &&
        reachEndRef.current
      ) {
        reachEndRef.current();
      }
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [interactive]);
  useLayoutEffect(() => {
    const change = source.getSnapshot().externalChange;
    if (!change || consumedExternal.current === change.serial || !ref.current)
      return;
    // A remount (e.g. returning from details) uses its saved scroll position.
    if (consumedExternal.current !== undefined || !memory.scrollTop) {
      const anchor = visibleAnchor.current;
      const id =
        change.kind === "jump"
          ? change.targetId
          : change.kind === "prepend"
            ? anchor?.id
            : undefined;
      const index = id ? source.indexOfId(id) : change.kind === "jump" ? 0 : -1;
      if (index >= 0) {
        const topPadding =
          parseFloat(getComputedStyle(ref.current).paddingTop) || 0;
        ref.current.scrollTop = Math.max(
          0,
          topPadding +
            Math.floor(index / gridColumns) * rowHeight -
            (change.kind === "prepend" ? (anchor?.offset ?? 0) : 0),
        );
        corrected.current = ref.current.scrollTop;
        setScroll(ref.current.scrollTop);
        remember({ scrollTop: ref.current.scrollTop });
      }
    }
    consumedExternal.current = change.serial;
  }, [externalSerial]);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !total) return;
    const padding = parseFloat(getComputedStyle(element).paddingTop) || 0;
    const row = Math.max(
      0,
      Math.floor((element.scrollTop - padding) / rowHeight),
    );
    const index = Math.min(total - 1, row * gridColumns),
      item = source.peek(index);
    if (item) {
      visibleAnchor.current = {
        id: item.id,
        offset: padding + row * rowHeight - element.scrollTop,
      };
    }
  }, [scroll, externalSerial, total, gridColumns, rowHeight]);
  useLayoutEffect(() => {
    if (!ref.current || !source.getSnapshot().ready) return;
    if (restored.current && consumed.current === memory.focusRequest) return;
    const index = resolveFocusIndex(source, memory);
    const top = Math.floor(index / gridColumns) * rowHeight;
    const target = memory.revealFocus
      ? Math.max(0, 150 + top - (height - rowHeight) / 2)
      : (memory.scrollTop ?? top);
    ref.current.scrollTop = target;
    corrected.current = ref.current.scrollTop;
    setScroll(ref.current.scrollTop);
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
  }, [source, source.getSnapshot().ready, memory.focusRequest, width, height]);
  const previous = useRef({
    index: source.getSnapshot().anchorIndex,
    serial: 0,
  });
  useLayoutEffect(() => {
    const snapshot = source.getSnapshot();
    if (snapshot.refreshSerial !== previous.current.serial && ref.current) {
      ref.current.scrollTop +=
        (Math.floor(snapshot.anchorIndex / gridColumns) -
          Math.floor(previous.current.index / gridColumns)) *
        rowHeight;
      setScroll(ref.current.scrollTop);
    }
    previous.current = {
      index: snapshot.anchorIndex,
      serial: snapshot.refreshSerial,
    };
  }, [source.getSnapshot().refreshSerial]);
  useEffect(() => {
    void source.ensure(
      Array.from(
        { length: Math.max(0, (to - from) * gridColumns) },
        (_, i) => from * gridColumns + i,
      ),
    );
  }, [source, from, to, gridColumns]);
  useEffect(() => {
    const element = ref.current;
    if (
      ready &&
      total > 0 &&
      interactive &&
      element &&
      element.scrollHeight <= element.clientHeight + 24
    )
      // Via the ref: a new callback identity must not retrigger pagination.
      reachEndRef.current?.();
  }, [source, total, ready, height, interactive]);
  return (
    <div
      ref={ref}
      className={`standard-media standard-grid${comicRows ? " comic-result-grid" : ""}`}
      style={source.external ? { overflowAnchor: "none" } : undefined}
      data-layout="grid"
      aria-label="标准网格"
      onKeyDown={(event) => {
        if (
          interactive &&
          onReachStart &&
          event.currentTarget.scrollTop <= 2 &&
          ["ArrowUp", "PageUp", "Home"].includes(event.key)
        ) {
          event.preventDefault();
          onReachStart();
        }
      }}
      onClick={(e) => {
        if (!(e.target as HTMLElement).closest(".poster,.media-row"))
          clearFocus?.();
      }}
      onScroll={(e) => {
        if (!interactive) {
          if (
            frozen.current !== undefined &&
            e.currentTarget.scrollTop !== frozen.current
          )
            e.currentTarget.scrollTop = frozen.current;
          return;
        }
        setScroll(e.currentTarget.scrollTop);
        frozen.current = e.currentTarget.scrollTop;
        if (restored.current)
          remember({ scrollTop: e.currentTarget.scrollTop });
        if (
          corrected.current !== undefined &&
          Math.abs(e.currentTarget.scrollTop - corrected.current) <= 1
        ) {
          corrected.current = undefined;
          return;
        }
        corrected.current = undefined;
        const padding =
          parseFloat(getComputedStyle(e.currentTarget).paddingTop) || 0;
        const row = Math.max(
          0,
          Math.floor((e.currentTarget.scrollTop - padding) / rowHeight),
        );
        const at = Math.min(
            total - 1,
            row * gridColumns + Math.floor(gridColumns / 2),
          ),
          item = source.peek(at);
        if (item) onViewportAnchorChange?.(item, at);
        if (
          e.currentTarget.scrollTop + e.currentTarget.clientHeight >=
          e.currentTarget.scrollHeight - rowHeight * 2
        )
          onReachEnd?.();
      }}
    >
      <div
        className="standard-space"
        style={{ height: Math.ceil(source.total / gridColumns) * rowHeight }}
      >
        {Array.from({ length: Math.max(0, to - from) }, (_, offset) => {
          const row = from + offset;
          return (
            <div
              className="standard-row"
              key={row}
              style={{
                transform: `translateY(${row * rowHeight}px)`,
                height: rowHeight,
                gridTemplateColumns: `repeat(${gridColumns},minmax(0,1fr))`,
              }}
            >
              {Array.from(
                {
                  length: Math.min(
                    gridColumns,
                    source.total - row * gridColumns,
                  ),
                },
                (_, column) => {
                  const index = row * gridColumns + column,
                    item = source.peek(index);
                  const activate = () => {
                    if (item) {
                      remember({ focusId: item.id, focusIndex: index });
                      open(item, index);
                    }
                  };
                  return (
                    <Poster
                      key={item?.id ?? index}
                      item={item}
                      index={index}
                      mode="grid"
                      richComic={comicRows}
                      selected={item ? selected?.(item, index) : false}
                      select={select}
                      contextMenu={contextMenu}
                      removeRecent={removeRecent}
                      activate={activate}
                      favorite={favorite}
                    />
                  );
                },
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
