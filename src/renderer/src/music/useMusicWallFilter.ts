import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { BrowseMemory, MediaItem } from "../../../shared/types";
import { PagedMediaSource } from "../layouts/source";
import { wallTransition } from "../layouts/wallTransition";

/** A stable snapshot: projected ensure()/at() calls never read the upstream provider. */
export function createMusicFilterSource(
  base: PagedMediaSource,
  items: MediaItem[],
  query: string,
) {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const rows = items.filter((item) => {
    const text = [
      item.title,
      item.artist,
      item.album,
      item.comicInfo?.series,
      item.comicInfo?.writer,
    ]
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase();
    return words.every((word) => text.includes(word));
  });
  const source = new PagedMediaSource(
    base.query,
    async (q) => ({
      items: rows.slice(q.offset ?? 0, (q.offset ?? 0) + (q.limit ?? 100)),
      total: rows.length,
    }),
    base.external,
  );
  return source;
}
export default function useMusicWallFilter(
  base: PagedMediaSource,
  scopeKey: string,
  enabled: boolean,
  readMemory: () => BrowseMemory,
  remember: (value: Partial<BrowseMemory>) => void,
) {
  const [query, setQuery] = useState("");
  const saved = useRef<
    | {
        items: MediaItem[];
        indices: Map<string, number>;
        total: number;
        memory: BrowseMemory;
      }
    | undefined
  >(undefined);
  const filteredMemory = useRef<BrowseMemory>(readMemory());
  const currentScope = useRef(scopeKey);
  if (currentScope.current !== scopeKey || !enabled) {
    currentScope.current = scopeKey;
    saved.current = undefined;
  }
  const effective = enabled && currentScope.current === scopeKey ? query : "";
  const source = useMemo(
    () =>
      effective && saved.current
        ? createMusicFilterSource(base, saved.current.items, effective)
        : base,
    [base, effective],
  );
  const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot);
  useEffect(() => {
    if (source === base) return;
    void source.initialize();
    return () => source.dispose();
  }, [source, base]);
  useEffect(() => {
    setQuery("");
    saved.current = undefined;
  }, [scopeKey, enabled, base]);
  useEffect(() => {
    if (!saved.current) return;
    const latest = new Map(base.cachedItems().map((item) => [item.id, item]));
    saved.current.items = saved.current.items.map((item) => {
      const next = latest.get(item.id) ?? item;
      if (next !== item && source !== base) source.patch(item.id, next);
      return next;
    });
  }, [base, base.getSnapshot().version, source]);
  function update(value: string) {
    if (value && !saved.current) {
      window.dispatchEvent(new Event("wall:flush"));
      const memory = readMemory();
      saved.current = {
        items: base.cachedItems(),
        indices: new Map(
          base.cachedItems().map((item) => [item.id, base.indexOfId(item.id)]),
        ),
        total: base.total,
        memory: structuredClone(memory),
      };
      filteredMemory.current = {
        ...structuredClone(memory),
        focusId: undefined,
        focusIndex: 0,
        wallFocusedSlotKey: undefined,
      };
    }
    wallTransition.token++;
    wallTransition.kind = "flip";
    wallTransition.direction = "replace";
    setQuery(value);
    if (!value && saved.current) {
      const memory = readMemory();
      remember({
        ...saved.current.memory,
        sort: memory.sort,
        layout: memory.layout,
      });
      saved.current = undefined;
    }
  }
  return {
    query: effective,
    update,
    source,
    ...snapshot,
    active: source !== base,
    memory: filteredMemory.current,
    remember: (patch: Partial<BrowseMemory>) =>
      Object.assign(filteredMemory.current, patch),
    loaded: saved.current?.items.length ?? base.cacheSize,
    originalTotal: saved.current?.total ?? base.total,
    originalIndex: (id: string) =>
      saved.current?.indices.get(id) ?? base.indexOfId(id),
  };
}
