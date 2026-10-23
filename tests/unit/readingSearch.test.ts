import { describe, it, expect } from "vitest";
import {
  emptyReadingSearchPage,
  loadReadingSearchPage,
  searchSourcePool,
  type ReadingSearchPage,
} from "../../src/shared/readingSearch";
type Info = { items: { id: string }[]; next?: string | null; maxPage?: number };
function setup(
  fetchPage: (page: number, cursor?: string | null) => Promise<Info>,
) {
  let state = emptyReadingSearchPage<{ id: string }, Info>();
  return {
    get state() {
      return state;
    },
    async load(page: number, append = false, current = () => true) {
      await loadReadingSearchPage({
        previous: state,
        number: page,
        append,
        fetchPage,
        unpack: (info) => info,
        identity: (item) => item.id,
        current,
        update: (patch) => {
          state = { ...state, ...patch };
        },
      });
    },
  };
}
describe("共用漫画和小说搜索控制器", () => {
  it("游标跳页先补齐前序游标", async () => {
    const calls: unknown[] = [];
    const subject = setup(async (page, cursor) => {
      calls.push([page, cursor]);
      return {
        items: [{ id: String(page) }],
        next: page < 3 ? String(page + 1) : null,
      };
    });
    await subject.load(3);
    expect(calls).toEqual([
      [1, null],
      [2, "2"],
      [3, "3"],
    ]);
    expect(subject.state.page).toBe(3);
  });
  it("瀑布流去重，后续页失败保留已成功结果", async () => {
    const subject = setup(async (page) => {
      if (page === 3) throw new Error("network unavailable");
      return {
        items: [{ id: "shared" }, { id: String(page) }],
        next: String(page + 1),
      };
    });
    await subject.load(1);
    await subject.load(2, true);
    await subject.load(3, true);
    expect(subject.state.cards.map((item) => item.id)).toEqual([
      "shared",
      "1",
      "2",
    ]);
    expect(subject.state.page).toBe(2);
    expect(subject.state.error).toContain("network unavailable");
  });
  it("迟到响应不会覆盖新页面", async () => {
    let current = true;
    const subject = setup(async () => {
      current = false;
      return { items: [{ id: "old" }], maxPage: 1 };
    });
    await subject.load(1, false, () => current);
    expect(subject.state.cards).toEqual([]);
  });
  it("已知总页数可以直接跳页", async () => {
    const subject = setup(async (page) => ({
      items: [{ id: String(page) }],
      maxPage: 10,
    }));
    await subject.load(1);
    await subject.load(8);
    expect(subject.state.cards[0].id).toBe("8");
  });
  it("聚合搜索部分失败仍发布其他源结果，取消后不继续调度", async () => {
    const success: number[] = [],
      errors: number[] = [];
    await searchSourcePool([1, 2, 3], async (id) => {
      try {
        if (id === 2) throw new Error();
        success.push(id);
      } catch {
        errors.push(id);
      }
    });
    expect(success.sort()).toEqual([1, 3]);
    expect(errors).toEqual([2]);
    let count = 0;
    await searchSourcePool(
      Array.from({ length: 20 }, (_, i) => i),
      async () => {
        count++;
      },
      () => count < 1,
    );
    expect(count).toBe(1);
  });
});
