import { describe, expect, it } from "vitest";
import { PagedMediaSource } from "../../src/renderer/src/layouts/source";
import type { MediaItem, QueryResult } from "../../src/shared/types";
const items = (count: number) =>
  Array.from(
    { length: count },
    (_, index) => ({ id: String(index), title: String(index) }) as MediaItem,
  );
describe("external search result publication", () => {
  it("appends twelve pages without an empty intermediate snapshot or anchor reset", () => {
    const source = new PagedMediaSource(
      {},
      async () => ({ items: [], total: 0 }),
      true,
    );
    const totals: number[] = [];
    source.subscribe(() => totals.push(source.total));
    source.replaceExternalItems(items(24), "8", 0);
    const initial = source.getSnapshot();
    for (let page = 2; page <= 12; page++)
      source.replaceExternalItems(items(page * 24));
    expect(totals).toEqual(
      Array.from({ length: 12 }, (_, page) => (page + 1) * 24),
    );
    expect(source.getSnapshot().ready).toBe(true);
    expect(source.getSnapshot().anchorIndex).toBe(8);
    expect(source.getSnapshot().refreshSerial).toBe(initial.refreshSerial);
    expect(source.peek(287)?.id).toBe("287");
  });
  it("invalidates an older pending initialization", async () => {
    let finish!: (result: QueryResult) => void;
    const source = new PagedMediaSource(
      {},
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      true,
    );
    const pending = source.initialize();
    source.replaceExternalItems(items(240));
    finish({ items: items(2), total: 2 });
    await pending;
    expect(source.total).toBe(240);
    expect(source.peek(239)?.id).toBe("239");
  });
  it("rejects replacing a local library source", () => {
    const source = new PagedMediaSource({}, async () => ({
      items: [],
      total: 0,
    }));
    expect(() => source.replaceExternalItems([])).toThrow("external");
  });
});
