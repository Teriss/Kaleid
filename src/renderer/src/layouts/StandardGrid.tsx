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
  minimumCellWidth = 230,
}: LayoutProps) {
  const { ref, width, height } = useViewport();
  const [scroll, setScroll] = useState(memory.scrollTop ?? 0);
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
  const cellWidth = Math.max(100, (width - 80 - (columns - 1) * 22) / columns);
  const kind = source.query.type;
  const rowHeight =
    cellWidth *
      (kind === "video"
        ? 9 / 16
        : kind === "novel" || kind === "comic"
          ? 1.4
          : 1.12) +
    36;
  const from = Math.max(0, Math.floor((scroll - 150) / rowHeight) - 2);
  const to = Math.min(
    Math.ceil(source.total / columns),
    Math.ceil((scroll + height) / rowHeight) + 2,
  );
  useLayoutEffect(() => {
    if (!ref.current || !source.getSnapshot().ready) return;
    if (restored.current && consumed.current === memory.focusRequest) return;
    const index = resolveFocusIndex(source, memory);
    const top = Math.floor(index / columns) * rowHeight;
    const target = memory.revealFocus
      ? Math.max(0, 150 + top - (height - rowHeight) / 2)
      : (memory.scrollTop ?? top);
    ref.current.scrollTop = target;
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
        (Math.floor(snapshot.anchorIndex / columns) -
          Math.floor(previous.current.index / columns)) *
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
        { length: Math.max(0, (to - from) * columns) },
        (_, i) => from * columns + i,
      ),
    );
  }, [source, from, to, columns]);
  useEffect(() => {
    const element = ref.current;
    if (
      interactive &&
      element &&
      element.scrollHeight <= element.clientHeight + 24
    )
      onReachEnd?.();
  }, [source, source.total, height, onReachEnd, interactive]);
  return (
    <div
      ref={ref}
      className="standard-media standard-grid"
      data-layout="grid"
      aria-label="标准网格"
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
          e.currentTarget.scrollTop + e.currentTarget.clientHeight >=
          e.currentTarget.scrollHeight - rowHeight * 2
        )
          onReachEnd?.();
      }}
    >
      <div
        className="standard-space"
        style={{ height: Math.ceil(source.total / columns) * rowHeight }}
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
                gridTemplateColumns: `repeat(${columns},minmax(0,1fr))`,
              }}
            >
              {Array.from(
                { length: Math.min(columns, source.total - row * columns) },
                (_, column) => {
                  const index = row * columns + column,
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
