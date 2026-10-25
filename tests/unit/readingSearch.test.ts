import { describe, it, expect } from "vitest";
import {
  emptyReadingSearchPage,
  loadReadingSearchPage,
  searchSourcePool,
  normalizeReadingSearchTerms,
  orderReadingSearchHistory,
  limitReadingSearchHistory,
  readingResultModePatch,
  type ReadingSearchPage,
  type ReadingLoadOperation,
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
    async load(
      page: number,
      append: boolean | ReadingLoadOperation = false,
      current = () => true,
    ) {
      await loadReadingSearchPage({
        previous: state,
        number: page,
        append: append === true,
        operation: typeof append === "string" ? append : undefined,
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
  it("规范化搜索历史，并把收藏记录稳定排在前面", () => {
    const terms = normalizeReadingSearchTerms([
      "最近搜索",
      " 收藏项 ",
      "最近搜索",
      "",
      12,
    ]);
    expect(terms).toEqual(["最近搜索", "收藏项"]);
    expect(orderReadingSearchHistory(terms, ["收藏项", "已删除", "收藏项"])).toEqual([
      "收藏项",
      "最近搜索",
    ]);
    expect(
      limitReadingSearchHistory(["新词", "收藏项", "旧词"], ["收藏项"], 2),
    ).toEqual(["收藏项", "新词"]);
  });
  it("切回分页保留当前可见页和缓存，切回瀑布流可继续使用缓存", async () => {
    const calls: number[] = [];
    const subject = setup(async (page) => {
      calls.push(page);
      return {
        items: [{ id: String(page) }, { id: String(page) }],
        maxPage: 12,
      };
    });
    await subject.load(1);
    await subject.load(10, "jump");
    await subject.load(11, "append");
    subject.state.visiblePage = 10;
    Object.assign(
      subject.state,
      readingResultModePatch(subject.state, "pagination", []),
    );
    expect(subject.state.page).toBe(10);
    expect(subject.state.cards).toEqual([{ id: "10" }]);
    expect(subject.state.pages[11]).toBeDefined();
    Object.assign(
      subject.state,
      readingResultModePatch(subject.state, "waterfall", []),
    );
    await subject.load(11, "append");
    expect(calls).toEqual([1, 10, 11]);
    expect([subject.state.startPage, subject.state.endPage]).toEqual([10, 11]);
  });
  it("游标跳页遇到末页保留原列表，并记住末页边界及已取得的缓存", async () => {
    const calls: number[] = [];
    const subject = setup(async (page) => {
      calls.push(page);
      return {
        items: [{ id: String(page) }],
        next: page < 3 ? String(page + 1) : null,
      };
    });
    await subject.load(1);
    await subject.load(10, "jump");
    expect(calls).toEqual([1, 2, 3]);
    expect(subject.state.cards).toEqual([{ id: "1" }]);
    expect(subject.state.maxPage).toBe(3);
    expect(subject.state.jumpError).toContain("第 3 页");
    expect(subject.state.failedPage).toBe(10);
    await subject.load(3, "jump");
    expect(calls).toEqual([1, 2, 3]);
    expect(subject.state.cards).toEqual([{ id: "3" }]);
    expect(subject.state.jumpError).toBe("");
  });
  it("同一响应内去重，无新增结果时暂停自动加载，手动继续可恢复", async () => {
    const subject = setup(async (page) => ({
      items: [
        { id: page < 3 ? "same" : "new" },
        { id: page < 3 ? "same" : "new" },
      ],
      next: String(page + 1),
    }));
    await subject.load(1);
    expect(subject.state.cards).toEqual([{ id: "same" }]);
    await subject.load(2, true);
    expect(subject.state.page).toBe(2);
    expect(subject.state.autoLoadPaused).toBe(true);
    await subject.load(3, true);
    expect(subject.state.cards).toEqual([{ id: "same" }, { id: "new" }]);
    expect(subject.state.autoLoadPaused).toBe(false);
  });
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
  it("跳到第十页后双向扩展，按页排序去重，并直接定位已显示的页", async () => {
    const calls: number[] = [];
    const subject = setup(async (page) => {
      calls.push(page);
      return {
        items: [
          { id: String(page - 1) },
          { id: String(page) },
          { id: String(page) },
        ],
        maxPage: 12,
        next: page < 12 ? String(page + 1) : null,
      };
    });
    await subject.load(1);
    await subject.load(10, "jump");
    expect([subject.state.startPage, subject.state.endPage]).toEqual([10, 10]);
    await subject.load(9, "prepend");
    await subject.load(8, "prepend");
    await subject.load(11, "append");
    await subject.load(12, "append");
    expect([subject.state.startPage, subject.state.endPage]).toEqual([8, 12]);
    expect(subject.state.cards.map((item) => item.id)).toEqual([
      "7",
      "8",
      "9",
      "10",
      "11",
      "12",
    ]);
    expect(subject.state.itemPages["9"]).toBe(9);
    const before = subject.state.cards;
    await subject.load(10, "jump");
    expect(subject.state.cards).toEqual(before);
    expect(subject.state.change?.targetId).toBe("10");
    expect(subject.state.visiblePage).toBe(10);
    await subject.load(1, "jump");
    expect(subject.state.startPage).toBe(1);
    expect(calls).toEqual([1, 10, 9, 8, 11, 12]);
  });
  it("游标跳页保留补齐过程中的页面缓存，向前加载不重复请求", async () => {
    const calls: number[] = [];
    const subject = setup(async (page, cursor) => {
      calls.push(page);
      expect(cursor).toBe(page === 1 ? null : `cursor-${page}`);
      return {
        items: [{ id: String(page) }],
        next: page < 12 ? `cursor-${page + 1}` : null,
      };
    });
    await subject.load(10, "jump");
    expect(Object.keys(subject.state.pages)).toHaveLength(10);
    expect(subject.state.cards).toEqual([{ id: "10" }]);
    await subject.load(9, "prepend");
    await subject.load(8, "prepend");
    await subject.load(11, "append");
    expect(calls).toEqual(Array.from({ length: 11 }, (_, i) => i + 1));
    expect(subject.state.cards.map((item) => item.id)).toEqual([
      "8",
      "9",
      "10",
      "11",
    ]);
  });
  it("向前失败独立暂停，另一方向仍能成功，重试保留旧结果", async () => {
    let failure = true;
    const subject = setup(async (page) => {
      if (page === 9 && failure) throw new Error("previous failed");
      return { items: page === 8 ? [] : [{ id: String(page) }], maxPage: 12 };
    });
    await subject.load(1);
    await subject.load(10, "jump");
    await subject.load(9, "prepend");
    expect(subject.state.beforeError).toContain("previous failed");
    expect(subject.state.beforePaused).toBe(true);
    expect(subject.state.afterPaused).toBe(false);
    await subject.load(11, "append");
    expect(subject.state.beforePaused).toBe(true);
    expect(subject.state.cards.map((item) => item.id)).toEqual(["10", "11"]);
    failure = false;
    await subject.load(9, "prepend");
    expect(subject.state.beforePaused).toBe(false);
    await subject.load(8, "prepend");
    expect(subject.state.beforePaused).toBe(true);
    expect(subject.state.startPage).toBe(8);
    await subject.load(7, "prepend");
    expect(subject.state.beforePaused).toBe(false);
  });
  it("连续跳页使旧响应及失败回调失效", async () => {
    let state = emptyReadingSearchPage<{ id: string }, Info>();
    let generation = 0,
      release!: () => void;
    const run = async (page: number) => {
      const token = ++generation;
      return loadReadingSearchPage({
        previous: state,
        number: page,
        operation: "jump",
        cursorBased: false,
        fetchPage: async () => {
          if (page === 10) await new Promise<void>((r) => (release = r));
          return { items: [{ id: String(page) }], maxPage: 12 };
        },
        unpack: (info) => info,
        identity: (item) => item.id,
        current: () => token === generation,
        update: (patch) => {
          state = { ...state, ...patch };
        },
      });
    };
    const slow = run(10);
    await run(11);
    release();
    await slow;
    expect(state.visiblePage).toBe(11);
    expect(state.busy).toBe(false);
    expect(state.cards).toEqual([{ id: "11" }]);
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
