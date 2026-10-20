import { useEffect, useState } from "react";
import { Backdrop, Poster, useViewport, type LayoutProps } from "./shared";
import type { MediaItem } from "../../../shared/types";
import { musicItems } from "../music/catalog";

/** Feed sections keep their own shape while their covers share the ordinary paged source. */
export default function FoliaExplore({
  source,
  scope,
  open,
  select,
  selected,
  favorite,
  contextMenu,
  removeRecent,
  reducedMotion,
  remember,
}: LayoutProps) {
  const { ref, width, height } = useViewport(),
    [scroll, setScroll] = useState(0),
    [recent, setRecent] = useState<MediaItem[]>([]);
  const columns = Math.max(2, Math.floor((width - 120) / 210));
  const sections = source.getSnapshot().sections.length
    ? source.getSnapshot().sections
    : [{ title: "为你推荐", start: 0, count: source.total }];
  useEffect(() => {
    let live = true;
    void window.music
      .special("recent", 0, 100)
      .then((r) => musicItems(r.items.map((item) => item.id)))
      .then((items) => {
        if (live)
          setRecent(
            items
              .filter(
                (item) =>
                  item.sourceRef?.kind === "online" &&
                  item.sourceRef.providerId === scope?.providerId,
              )
              .slice(0, 10),
          );
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [scope?.providerId]);
  let top = recent.length ? 250 : 0;
  const rows: { title?: string; top: number; indices: number[] }[] = [];
  for (const section of sections) {
    rows.push({ title: section.title, top, indices: [] });
    top += 55;
    for (let i = 0; i < section.count; i += columns) {
      if (top + 280 >= scroll - 200 && top < scroll + height + 250)
        rows.push({
          top,
          indices: Array.from(
            { length: Math.min(columns, section.count - i) },
            (_, n) => section.start + i + n,
          ),
        });
      top += 280;
    }
    top += 25;
  }
  const indices = rows.flatMap((row) => row.indices).join(",");
  useEffect(() => {
    void source.ensure(indices.split(",").filter(Boolean).map(Number));
  }, [source, indices]);
  const focus = (item: MediaItem, index: number) => {
    select?.(item, index);
    remember({ focusId: item.id, focusIndex: index });
  };
  return (
    <div
      ref={ref}
      className="folia-explore"
      data-layout="spatial"
      data-spatial-scene="explore"
      onScroll={(e) => setScroll(e.currentTarget.scrollTop)}
    >
      <Backdrop item={source.peek(0)} reducedMotion={reducedMotion} />
      <div className="explore-virtual" style={{ height: top }}>
        {recent.length > 0 && (
          <section className="explore-recent">
            <h2>最近播放</h2>
            <div>
              {recent.map((item) => (
                <button key={item.id} onClick={() => open(item, -1)}>
                  {item.title}
                  <small>{item.artist}</small>
                </button>
              ))}
            </div>
          </section>
        )}
        {rows.map((row, r) =>
          row.title ? (
            <h2
              className="explore-section-title"
              key={`title:${r}`}
              style={{ top: row.top }}
            >
              {row.title}
            </h2>
          ) : (
            <div
              key={row.top}
              className="explore-virtual-row"
              style={{
                top: row.top,
                gridTemplateColumns: `repeat(${columns},minmax(0,1fr))`,
              }}
            >
              {row.indices.map((index) => {
                const item = source.peek(index);
                return (
                  <Poster
                    key={item?.id ?? index}
                    mode="grid"
                    item={item}
                    index={index}
                    selected={item ? selected?.(item, index) : false}
                    select={focus}
                    activate={() => item && open(item, index)}
                    favorite={favorite}
                    contextMenu={contextMenu}
                    removeRecent={removeRecent}
                    style={{ width: "100%", height: 240 }}
                  />
                );
              })}
            </div>
          ),
        )}
      </div>
    </div>
  );
}
