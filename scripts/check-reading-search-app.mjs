// Runs the same interaction contract against the comic and novel adapters.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron } from "playwright";
const directory = await fs.mkdtemp(
  path.join(os.tmpdir(), "kaleid-reading-search-"),
);
const env = { ...process.env, MEDIA_BROWSER_TEST_DATA: directory };
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await _electron.launch({
    executablePath: path.resolve("node_modules/electron/dist/electron.exe"),
    args: ["."],
    env,
    timeout: 30000,
  });
  await app.evaluate(({ ipcMain }) => {
    globalThis.__readingRequests = [];
    globalThis.__readingFailure = false;
    globalThis.__readingEdgeFailed = new Set();
    const cover =
      "data:image/svg+xml," +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="260"><rect width="180" height="260" fill="#618b82"/><circle cx="90" cy="100" r="48" fill="#e2cfa2"/></svg>',
      );
    for (const kind of ["comic", "novel"]) {
      ipcMain.removeHandler(`${kind}:call`);
      ipcMain.handle(`${kind}:call`, async (_event, method, args = []) => {
        const ids =
          kind === "comic"
            ? ["comic-one", "comic-two"]
            : ["lightnovelshelf", "bilinovel"];
        const sources = ids.map((id, index) => ({
          id,
          key: id,
          name: index === 0 ? "测试源甲" : "测试源乙",
          version: "1",
          enabled: true,
          logged: false,
          url: "https://example.org",
          hash: id,
          capabilities: {
            search: true,
            categories: true,
            favorites: false,
            favoriteFolders: false,
            login: [],
          },
          explore: [],
          categoryOptions: [],
          rankingOptions: [],
          searchOptions: [
            {
              label: "语言",
              type: "select",
              options: [
                { value: "all", text: "全部" },
                { value: "zh", text: "中文" },
              ],
              default: "all",
            },
          ],
          settings: {},
          settingValues: {},
        }));
        if (method === "sources") return sources;
        if (["downloads", "following", "library"].includes(method)) return [];
        if (method === "downloadDirectory") return "/fixture";
        const item = (id, query, index) => ({
          sourceId: id,
          ...(kind === "comic"
            ? { comicId: String(index) }
            : { novelId: String(index) }),
          title: `${query} · ${index}`,
          cover,
        });
        if (method === "categories")
          return { parts: [{ name: "测试分类", categories: ["瀑布流分类"] }] };
        if (method === "search" || method === "category") {
          const [id] = args;
          const query = method === "category" ? "waterfall-category" : args[1];
          const page =
            method === "category"
              ? args[4]
              : kind === "comic"
                ? args[3]
                : args[2];
          globalThis.__readingRequests.push({ kind, id, query, page });
          if (globalThis.__readingFailure && id === ids[1])
            throw new Error("[network] fixture source failure");
          if (query === "slow")
            await new Promise((resolve) => setTimeout(resolve, 450));
          const long = query.startsWith("waterfall-");
          const edge = query === "waterfall-edge";
          const cursorOnly =
            query.startsWith("waterfall-cursor") && kind === "comic";
          if (cursorOnly) assertCursor();
          function assertCursor() {
            if (page > 1 && args[4] !== String(page))
              throw new Error(`wrong cursor for page ${page}: ${args[4]}`);
          }
          if (query === "waterfall-jump-race" && page === 10)
            await new Promise((resolve) => setTimeout(resolve, 450));
          if (
            query === "waterfall-direction-edge" &&
            page === 9 &&
            !globalThis.__readingEdgeFailed.has(`${kind}:before`)
          ) {
            globalThis.__readingEdgeFailed.add(`${kind}:before`);
            throw new Error("fixture previous-page failure");
          }
          if (edge && page === 2 && !globalThis.__readingEdgeFailed.has(kind)) {
            globalThis.__readingEdgeFailed.add(kind);
            throw new Error("fixture next-page failure");
          }
          if (long) await new Promise((resolve) => setTimeout(resolve, 90));
          const items = long
            ? Array.from({ length: 24 }, (_, index) =>
                item(id, query, (page - 1) * 24 + index + 1),
              )
            : [item(id, query, page * 10 + 1), item(id, query, page * 10 + 2)];
          if (long && page > 1) items.unshift(item(id, query, (page - 1) * 24));
          if (long) items.push(items.at(-1));
          if (
            (edge && page === 3) ||
            (query === "waterfall-direction-edge" && page === 8)
          )
            items.length = 0;
          const maxPage = edge ? 4 : long ? 12 : 3;
          return kind === "comic"
            ? {
                comics: items,
                maxPage: cursorOnly ? undefined : maxPage,
                next: page < maxPage ? String(page + 1) : null,
              }
            : { novels: items, page, hasMore: page < maxPage };
        }
        if (method === "details")
          return {
            ...item(
              args[0].sourceId,
              "详情",
              Number(args[0].comicId || args[0].novelId),
            ),
            chapters: [],
            favorite: false,
          };
        return [];
      });
    }
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await page.waitForFunction(() => !!window.media?.onlineNovels);
  await page.evaluate(async () =>
    window.media.saveSettings({
      ...(await window.media.settings()),
      reducedMotion: true,
    }),
  );
  await page.reload();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const report = [];
  // Ordinary loading uses the result layout's browse boundary, never a footer button.
  const browseBoundary = async (direction, layout = "grid") => {
    if (layout === "grid") {
      await page.locator(".standard-grid").evaluate((node, direction) => {
        node.scrollTop = direction < 0 ? 0 : node.scrollHeight;
      }, direction);
      await page.locator(".standard-grid").hover();
      await page.mouse.wheel(0, direction * 40);
      return;
    }
    const active =
      layout === "archiveShelf"
        ? ".archive-volume[data-active=true]"
        : ".poster.is-focused";
    const index = Number(
      await page.locator(active).first().getAttribute("data-index"),
    );
    const text = await page.locator(".comic-waterfall-status").textContent();
    const total = Number(text.match(/共 (\d+) 条/)[1]);
    const steps = direction < 0 ? index + 1 : Math.max(1, total - 3 - index);
    for (let step = 0; step < steps; step++)
      await page
        .getByRole("button", {
          name:
            layout === "archiveShelf"
              ? direction < 0
                ? "上一份档案"
                : "下一份档案"
              : direction < 0
                ? "上一项"
                : "下一项",
          exact: true,
        })
        .click();
  };

  for (const [kind, label] of [
    ["comic", "漫画"],
    ["novel", "小说"],
  ]) {
    await page.locator(".chrome-edge-right").hover();
    await page
      .getByRole("button", { name: `浏览${label}`, exact: true })
      .first()
      .click();
    await page.mouse.move(5, 220);
    await page
      .getByRole("navigation", { name: `${label}页面`, exact: true })
      .getByRole("button", { name: "搜索", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: `聚合搜索${label}`, exact: true })
      .fill("initial");
    await page
      .locator(".comic-search-form")
      .getByRole("button", { name: "搜索", exact: true })
      .click();
    await page.waitForFunction(
      () => document.querySelectorAll(".comic-aggregate-group").length === 2,
    );
    await app.evaluate(() => {
      globalThis.__readingFailure = true;
    });
    await page
      .getByRole("textbox", { name: `聚合搜索${label}`, exact: true })
      .fill("partial");
    await page
      .locator(".comic-search-form")
      .getByRole("button", { name: "搜索", exact: true })
      .click();
    await page.waitForFunction(
      () => document.querySelectorAll(".comic-aggregate-group").length === 1,
    );
    if (kind === "comic")
      await page.locator(".comic-aggregate-failures > summary").click();
    else await page.locator(".novel-error").waitFor();
    await app.evaluate(() => {
      globalThis.__readingFailure = false;
    });
    await page
      .locator(kind === "comic" ? ".comic-aggregate-failure" : ".novel-error")
      .getByRole("button", {
        name: kind === "comic" ? "重试" : "重试此源",
        exact: true,
      })
      .click();
    await page.waitForFunction(
      () => document.querySelectorAll(".comic-aggregate-group").length === 2,
    );
    await page
      .getByRole("button", { name: "查看此源全部结果", exact: true })
      .first()
      .click();
    await page.locator(".online-layout .standard-grid").waitFor();
    assert.equal(
      await page
        .locator(".comic-search-panel")
        .evaluate((el) => el.classList.contains("is-visible")),
      false,
    );
    await page.keyboard.press("Control+f");
    await page
      .getByRole("textbox", { name: `搜索当前${label}源`, exact: true })
      .waitFor();
    assert.equal(
      await page.locator(".comic-search-panel .online-source-selector").count(),
      0,
    );
    if (kind === "comic")
      assert.equal(await page.getByLabel("语言", { exact: true }).count(), 1);
    await page
      .getByRole("textbox", { name: `搜索当前${label}源`, exact: true })
      .fill("single-only");
    await page
      .locator(".comic-search-form")
      .getByRole("button", { name: "搜索", exact: true })
      .click();
    await page.waitForFunction(() =>
      document
        .querySelector(".online-layout")
        ?.textContent?.includes("single-only"),
    );
    const requests = await app.evaluate(() => globalThis.__readingRequests);
    assert.equal(
      requests
        .filter((r) => r.kind === kind && r.query === "single-only")
        .every(
          (r) => r.id === (kind === "comic" ? "comic-one" : "lightnovelshelf"),
        ),
      true,
    );
    await page.keyboard.press("Control+f");
    await page
      .getByLabel("结果加载方式", { exact: true })
      .selectOption("waterfall");
    await page.keyboard.press("Escape");
    // Both adapters load from the visible waterfall sentinel. Clicking its
    // transient fallback button races the observer removing that button.
    await page.waitForFunction(() =>
      document
        .querySelector(".online-layout")
        ?.textContent?.includes("single-only · 21"),
    );
    await page.keyboard.press("Control+f");
    await page
      .getByLabel("结果加载方式", { exact: true })
      .selectOption("pagination");
    await page.keyboard.press("Escape");
    assert.equal(
      await page
        .locator(".comic-search-panel")
        .evaluate((el) => el.classList.contains("is-visible")),
      false,
    );
    await page.keyboard.press("Control+f");
    await page
      .getByRole("textbox", { name: `搜索当前${label}源`, exact: true })
      .fill("unsent draft");
    await page.keyboard.press("Escape");
    await page.locator(".online-layout .poster-hit").first().click();
    await page.getByRole("heading", { name: /详情/ }).waitFor();
    await page.keyboard.press("Alt+ArrowLeft");
    await page.locator(".online-layout .standard-grid").waitFor();
    assert.equal(
      await page
        .locator(".comic-search-panel")
        .evaluate((el) => el.classList.contains("is-visible")),
      false,
    );
    await page.keyboard.press("Control+f");
    assert.equal(
      await page
        .getByRole("textbox", { name: `搜索当前${label}源`, exact: true })
        .inputValue(),
      "unsent draft",
    );
    await page.keyboard.press("Escape");
    for (const layout of process.env.READING_SEARCH_EDGES_ONLY
      ? []
      : ["grid", "archiveShelf", "carousel"]) {
      const query = `waterfall-${layout}`;
      await page.keyboard.press("Control+f");
      await page
        .getByLabel("结果加载方式", { exact: true })
        .selectOption("waterfall");
      await page
        .getByLabel("单源结果布局", { exact: true })
        .selectOption(layout);
      await page
        .getByRole("textbox", { name: `搜索当前${label}源`, exact: true })
        .fill(query);
      await page
        .locator(".comic-search-form")
        .getByRole("button", { name: "搜索", exact: true })
        .click();
      await page.waitForFunction(() =>
        document
          .querySelector(".comic-waterfall-status")
          ?.textContent?.includes("共 24 条"),
      );
      // No observer outside the scroll viewport may fetch the remaining pages.
      await page.waitForTimeout(220);
      assert.equal(
        await app.evaluate(
          ({}, filter) =>
            globalThis.__readingRequests.filter(
              (r) => r.kind === filter.kind && r.query === filter.query,
            ).length,
          { kind, query },
        ),
        1,
      );
      for (let loaded = 1; loaded < 12; loaded++) {
        let before;
        if (layout === "grid") {
          before = await page
            .locator(".online-layout .standard-grid")
            .evaluate((node) => {
              node.scrollTop = node.scrollHeight - node.clientHeight;
              const bounds = node.getBoundingClientRect();
              const anchor = [
                ...node.querySelectorAll(".poster[data-index]"),
              ].find(
                (p) =>
                  p.getBoundingClientRect().bottom > bounds.top &&
                  p.getBoundingClientRect().top < bounds.bottom,
              );
              return {
                top: node.scrollTop,
                anchor: anchor?.getAttribute("data-index"),
                y: anchor?.getBoundingClientRect().top,
              };
            });
        } else {
          const next = page.getByRole("button", {
            name: layout === "archiveShelf" ? "下一份档案" : "下一项",
            exact: true,
          });
          for (let step = 0; step < (loaded === 1 ? 22 : 24); step++)
            await next.click();
          before = await page
            .locator(
              layout === "archiveShelf"
                ? ".archive-volume[data-active=true]"
                : ".poster.is-focused",
            )
            .first()
            .getAttribute("data-index");
        }
        await page.waitForFunction(
          (count) =>
            document
              .querySelector(".comic-waterfall-status")
              ?.textContent?.includes(`共 ${count} 条`),
          (loaded + 1) * 24,
        );
        if (layout === "grid") {
          const after = await page
            .locator(".online-layout .standard-grid")
            .evaluate(
              (node, anchorIndex) => ({
                top: node.scrollTop,
                y: node
                  .querySelector(`.poster[data-index="${anchorIndex}"]`)
                  ?.getBoundingClientRect().top,
              }),
              before.anchor,
            );
          assert.ok(
            Math.abs(after.top - before.top) <= 2.1,
            `${kind}/${layout}: append keeps scroll offset`,
          );
          if (before.y != null && after.y != null)
            assert.ok(
              Math.abs(after.y - before.y) <= 2.1,
              `${kind}/${layout}: visible card does not jump`,
            );
        } else {
          const after = await page
            .locator(
              layout === "archiveShelf"
                ? ".archive-volume[data-active=true]"
                : ".poster.is-focused",
            )
            .first()
            .getAttribute("data-index");
          assert.equal(
            after,
            before,
            `${kind}/${layout}: append keeps current card`,
          );
        }
      }
      await page.waitForTimeout(200);
      const calls = await app.evaluate(
        ({}, filter) =>
          globalThis.__readingRequests
            .filter((r) => r.kind === filter.kind && r.query === filter.query)
            .map((r) => r.page),
        { kind, query },
      );
      assert.deepEqual(
        calls,
        Array.from({ length: 12 }, (_, index) => index + 1),
        `${kind}/${layout}: exactly twelve pages, in order`,
      );
      if (layout === "grid") {
        await page.locator(".standard-grid").evaluate((node) => {
          node.scrollTop = node.scrollHeight;
        });
        await page
          .getByRole("button", { name: `打开 ${query} · 288`, exact: true })
          .waitFor();
        await page
          .getByRole("button", { name: `打开 ${query} · 288`, exact: true })
          .click();
        await page.getByRole("heading", { name: /详情/ }).waitFor();
        await page.keyboard.press("Alt+ArrowLeft");
        await page
          .getByRole("button", { name: `打开 ${query} · 288`, exact: true })
          .waitFor();
      } else {
        const next = page.getByRole("button", {
          name: layout === "archiveShelf" ? "下一份档案" : "下一项",
          exact: true,
        });
        for (let step = 0; step < 26; step++) {
          if (await next.isEnabled()) await next.click();
        }
        await page
          .getByRole("button", { name: `打开 ${query} · 288`, exact: true })
          .first()
          .waitFor();
      }
      await page.screenshot({
        path: `artifacts/novel-verification/${kind}-waterfall-${layout}.png`,
      });
      report.push(
        `${label}/${layout}: twelve pages, 288 unique results, stable position and ordered requests`,
      );
    }
    for (const layout of ["grid", "archiveShelf", "carousel"]) {
      const query = `waterfall-navigation-${layout}`;
      await page.keyboard.press("Control+f");
      await page
        .getByLabel("结果加载方式", { exact: true })
        .selectOption("waterfall");
      await page
        .getByLabel("单源结果布局", { exact: true })
        .selectOption(layout);
      await page
        .getByRole("textbox", { name: `搜索当前${label}源`, exact: true })
        .fill(query);
      await page
        .locator(".comic-search-form")
        .getByRole("button", { name: "搜索", exact: true })
        .click();
      const range = async (first, last) =>
        page.waitForFunction(
          ({ first, last }) =>
            document
              .querySelector(".comic-waterfall-status")
              ?.textContent?.includes(`第 ${first}–${last} 页`),
          { first, last },
        );
      const jump = async (number) => {
        await page
          .getByLabel("跳转到搜索结果页", { exact: true })
          .fill(String(number));
        await page.getByRole("button", { name: "跳转", exact: true }).click();
      };
      await page.waitForFunction(() =>
        document
          .querySelector(".comic-waterfall-status")
          ?.textContent?.includes("共 24 条"),
      );
      assert.equal(
        await page
          .getByRole("button", { name: "加载更多", exact: true })
          .count(),
        0,
      );
      assert.equal(
        await page
          .getByRole("button", { name: "加载上一页", exact: true })
          .count(),
        0,
      );
      const status = await page
        .locator(".comic-waterfall-status")
        .textContent();
      assert.ok(status.includes(kind === "comic" ? "/ 12" : "总页数未知"));
      await jump(10);
      await range(10, 10);
      const activeSelector =
        layout === "archiveShelf"
          ? ".archive-volume[data-active=true]"
          : ".poster.is-focused";
      const anchor = async () =>
        layout === "grid"
          ? page.locator(".standard-grid").evaluate((node) => {
              const bounds = node.getBoundingClientRect();
              const item = [
                ...node.querySelectorAll(".poster[data-media-id]"),
              ].find(
                (item) =>
                  item.getBoundingClientRect().bottom > bounds.top &&
                  item.getBoundingClientRect().top < bounds.bottom,
              );
              return {
                id: item?.dataset.mediaId,
                y: item?.getBoundingClientRect().top,
              };
            })
          : page
              .locator(activeSelector)
              .first()
              .evaluate((node) => ({ id: node.dataset.mediaId, y: 0 }));
      for (const previous of [9, 8]) {
        if (layout === "grid")
          await page.locator(".standard-grid").evaluate((node) => {
            node.scrollTop = 0;
          });
        else if (previous === 8) await jump(9);
        await page.waitForTimeout(100);
        const menuClose = page.locator(
          ".comic-main-menu-layer.is-open .comic-main-menu-heading button",
        );
        if (await menuClose.count()) await menuClose.click();
        const before = await anchor();
        if (layout === "grid") {
          await page.locator(".standard-grid").hover();
          await page.mouse.wheel(0, -40);
        } else if (layout === "carousel" && previous === 9) {
          const bounds = await page
            .locator(".poster.is-focused .poster-hit")
            .boundingBox();
          await page.mouse.move(
            bounds.x + bounds.width / 2,
            bounds.y + bounds.height / 2,
          );
          await page.mouse.down();
          await page.mouse.move(
            bounds.x + bounds.width / 2 + 100,
            bounds.y + bounds.height / 2,
            { steps: 4 },
          );
          await range(previous, 10);
          await page.mouse.up();
        } else
          await page
            .getByRole("button", {
              name: layout === "archiveShelf" ? "上一份档案" : "上一项",
              exact: true,
            })
            .click();
        await range(previous, 10);
        const after =
          layout === "grid"
            ? await page.locator(".standard-grid").evaluate((node, id) => {
                const item = [
                  ...node.querySelectorAll(".poster[data-media-id]"),
                ].find((item) => item.dataset.mediaId === id);
                return {
                  id: item?.dataset.mediaId,
                  y: item?.getBoundingClientRect().top,
                };
              }, before.id)
            : await anchor();
        assert.equal(
          after.id,
          before.id,
          `${kind}/${layout}: prepend preserves current item`,
        );
        assert.ok(
          Math.abs(after.y - before.y) <= 2.1,
          `${kind}/${layout}: prepend offset ${before.y} -> ${after.y}`,
        );
        await page.waitForTimeout(220);
        await range(previous, 10);
      }
      for (const next of [11, 12]) {
        assert.equal(
          await page
            .getByRole("button", { name: "加载更多", exact: true })
            .count(),
          0,
        );
        await browseBoundary(1, layout);
        await range(8, next);
      }
      assert.ok(
        (await page.locator(".comic-waterfall-status").textContent()).includes(
          "/ 12",
        ),
      );
      await jump(10);
      await range(8, 12);
      await page.waitForTimeout(120);
      const cached = await anchor();
      if (layout === "grid") {
        const targetY = await page
          .getByRole("button", { name: `打开 ${query} · 217`, exact: true })
          .evaluate(
            (node) =>
              node.getBoundingClientRect().top -
              document.querySelector(".standard-grid").getBoundingClientRect()
                .top,
          );
        assert.ok(
          Math.abs(targetY) <= 2.1,
          `${kind}: cached jump aligns target row (${targetY})`,
        );
      } else
        assert.ok(
          cached.id?.endsWith(":217"),
          `${kind}/${layout}: cached jump locates target (${cached.id})`,
        );
      if (layout === "grid") {
        await page
          .getByRole("button", { name: `打开 ${query} · 217`, exact: true })
          .click();
        await page.getByRole("heading", { name: /详情/ }).waitFor();
        await page.keyboard.press("Alt+ArrowLeft");
        await range(8, 12);
        assert.equal(
          (await anchor()).id,
          cached.id,
          `${kind}: details restores range and anchor`,
        );
      }
      const calls = await app.evaluate(
        ({}, filter) =>
          globalThis.__readingRequests
            .filter((r) => r.kind === filter.kind && r.query === filter.query)
            .map((r) => r.page),
        { kind, query },
      );
      assert.deepEqual(
        calls,
        [1, 10, 9, 8, 11, 12],
        `${kind}/${layout}: page jumps and directions request the correct pages once`,
      );
      await jump(1);
      await range(1, 1);
      assert.equal(
        await page
          .getByRole("button", { name: "加载上一页", exact: true })
          .count(),
        0,
      );
      await jump(10);
      await range(10, 10);
      await page.keyboard.press("Control+f");
      await page
        .getByLabel("结果加载方式", { exact: true })
        .selectOption("pagination");
      await page.keyboard.press("Escape");
      await page.waitForFunction(() =>
        document
          .querySelector(".online-pagination")
          ?.textContent?.includes("第 10 页"),
      );
      report.push(
        `${label}/${layout}: jump 10, prepend 9/8 with stable item and <=2px offset, append 11/12, cached jump, current-page pagination`,
      );
    }
    const submitWaterfall = async (query) => {
      await page.keyboard.press("Control+f");
      await page
        .getByLabel("结果加载方式", { exact: true })
        .selectOption("waterfall");
      await page
        .getByLabel("单源结果布局", { exact: true })
        .selectOption("grid");
      await page
        .getByRole("textbox", { name: `搜索当前${label}源`, exact: true })
        .fill(query);
      await page
        .locator(".comic-search-form")
        .getByRole("button", { name: "搜索", exact: true })
        .click();
      await page.waitForFunction(() =>
        document
          .querySelector(".comic-waterfall-status")
          ?.textContent?.includes("共 24 条"),
      );
    };
    const jumpTo = async (number) => {
      await page
        .getByLabel("跳转到搜索结果页", { exact: true })
        .fill(String(number));
      await page.getByRole("button", { name: "跳转", exact: true }).click();
    };
    const waitRange = async (first, last) =>
      page.waitForFunction(
        ({ first, last }) =>
          document
            .querySelector(".comic-waterfall-status")
            ?.textContent?.includes(`第 ${first}–${last} 页`),
        { first, last },
      );
    await submitWaterfall("waterfall-direction-edge");
    await jumpTo(10);
    await waitRange(10, 10);
    await browseBoundary(-1);
    await page
      .getByRole("button", { name: "重试加载上一页", exact: true })
      .waitFor();
    await browseBoundary(1);
    await waitRange(10, 11);
    await page
      .getByRole("button", { name: "重试加载上一页", exact: true })
      .click();
    await waitRange(9, 11);
    await browseBoundary(-1);
    await waitRange(8, 11);
    await page
      .getByRole("button", {
        name: "上一页无新增结果，继续向前加载",
        exact: true,
      })
      .waitFor();
    await page.waitForTimeout(220);
    await waitRange(8, 11);
    await page
      .getByRole("button", {
        name: "上一页无新增结果，继续向前加载",
        exact: true,
      })
      .click();
    await waitRange(7, 11);
    await jumpTo(1);
    await waitRange(1, 1);
    await jumpTo(8);
    await waitRange(8, 8);
    await page.waitForFunction(() =>
      document
        .querySelector(".comic-waterfall-status")
        ?.textContent?.includes("共 0 条"),
    );
    await browseBoundary(1);
    await waitRange(8, 9);
    report.push(
      `${label}: previous-page failure and retry, independent forward loading, empty previous page pauses, empty jump retains navigation`,
    );
    if (kind === "comic")
      for (const layout of ["grid", "archiveShelf", "carousel"]) {
        const query = `waterfall-cursor-${layout}`;
        await submitWaterfall(query);
        await page.keyboard.press("Control+f");
        await page
          .getByLabel("单源结果布局", { exact: true })
          .selectOption(layout);
        await page.keyboard.press("Escape");
        await jumpTo(10);
        await waitRange(10, 10);
        for (const previous of [9, 8]) {
          if (previous === 8) await jumpTo(9);
          const close = page.locator(
            ".comic-main-menu-layer.is-open .comic-main-menu-heading button",
          );
          if (await close.count()) await close.click();
          await browseBoundary(-1, layout);
          await waitRange(previous, 10);
          await page.waitForTimeout(150);
          await waitRange(previous, 10);
        }
        const calls = await app.evaluate(
          ({}, query) =>
            globalThis.__readingRequests
              .filter((r) => r.query === query)
              .map((r) => r.page),
          query,
        );
        assert.deepEqual(
          calls,
          Array.from({ length: 10 }, (_, i) => i + 1),
        );
        report.push(
          `漫画/${layout}: cursor jump caches pages, each backward action inserts exactly one cached page`,
        );
      }
    await submitWaterfall("waterfall-jump-race");
    await jumpTo(10);
    await page.waitForFunction(() =>
      document
        .querySelector(".comic-waterfall-status")
        ?.textContent?.includes("正在定位"),
    );
    await jumpTo(11);
    await waitRange(11, 11);
    await page.waitForTimeout(650);
    await waitRange(11, 11);
    assert.ok(
      !(await page.locator(".comic-waterfall-status").textContent()).includes(
        "正在定位",
      ),
    );
    report.push(
      `${label}: a newer jump supersedes a pending jump and its finalizer`,
    );
    await page.keyboard.press("Control+f");
    await page
      .getByLabel("结果加载方式", { exact: true })
      .selectOption("waterfall");
    await page.getByLabel("单源结果布局", { exact: true }).selectOption("grid");
    await page
      .getByRole("textbox", { name: `搜索当前${label}源`, exact: true })
      .fill("waterfall-edge");
    await page
      .locator(".comic-search-form")
      .getByRole("button", { name: "搜索", exact: true })
      .click();
    await page.waitForFunction(() =>
      document
        .querySelector(".comic-waterfall-status")
        ?.textContent?.includes("共 24 条"),
    );
    await page.locator(".standard-grid").evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await page.getByRole("button", { name: "重试加载", exact: true }).waitFor();
    const failedTop = await page
      .locator(".standard-grid")
      .evaluate((node) => node.scrollTop);
    await page.waitForTimeout(240);
    assert.equal(
      await app.evaluate(
        ({}, kind) =>
          globalThis.__readingRequests.filter(
            (r) =>
              r.kind === kind && r.query === "waterfall-edge" && r.page === 2,
          ).length,
        kind,
      ),
      1,
    );
    await page.getByRole("button", { name: "重试加载", exact: true }).click();
    await page.waitForFunction(() =>
      document
        .querySelector(".comic-waterfall-status")
        ?.textContent?.includes("共 48 条"),
    );
    const retryTop = await page
      .locator(".standard-grid")
      .evaluate((node) => node.scrollTop);
    assert.ok(
      Math.abs(retryTop - failedTop) <= 2.1,
      `${kind}: retry scroll ${failedTop} -> ${retryTop}`,
    );
    await page.locator(".standard-grid").evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await page
      .getByRole("button", { name: "本页无新增结果，继续加载", exact: true })
      .waitFor();
    await page.waitForTimeout(240);
    assert.equal(
      await app.evaluate(
        ({}, kind) =>
          globalThis.__readingRequests.filter(
            (r) =>
              r.kind === kind && r.query === "waterfall-edge" && r.page === 4,
          ).length,
        kind,
      ),
      0,
    );
    await page
      .getByRole("button", { name: "本页无新增结果，继续加载", exact: true })
      .click();
    await page.waitForFunction(() =>
      document
        .querySelector(".comic-waterfall-status")
        ?.textContent?.includes("共 73 条"),
    );
    const edgeCalls = await app.evaluate(
      ({}, kind) =>
        globalThis.__readingRequests
          .filter((r) => r.kind === kind && r.query === "waterfall-edge")
          .map((r) => r.page),
      kind,
    );
    assert.deepEqual(edgeCalls, [1, 2, 2, 3, 4]);
    report.push(
      `${label}: failed page retains scroll, retries once; empty page pauses until manual continuation`,
    );
    for (const term of ["slow", "fast"]) {
      await page.keyboard.press("Control+f");
      await page
        .getByRole("textbox", { name: `搜索当前${label}源`, exact: true })
        .fill(term);
      await page
        .locator(".comic-search-form")
        .getByRole("button", { name: "搜索", exact: true })
        .click();
    }
    await page.waitForFunction(() =>
      document.querySelector(".online-layout")?.textContent?.includes("fast"),
    );
    await page.waitForTimeout(550);
    assert.ok(
      !(await page.locator(".online-layout").textContent()).includes("slow"),
    );
    report.push(`${label}: a late response cannot overwrite a newer search`);
    await page.screenshot({
      animations: "disabled",
      path: `artifacts/novel-verification/${kind}-shared-search.png`,
    });
    report.push(
      `${label}: aggregate, fixed single source, hidden panel, filters, pagination/waterfall, partial failure retry and parent draft restoration`,
    );
    if (kind === "comic") {
      await page.mouse.move(20, 400);
      await page
        .getByRole("navigation", { name: "漫画页面", exact: true })
        .getByRole("button", { name: "分类", exact: true })
        .click();
      await page
        .getByRole("button", { name: "瀑布流分类", exact: true })
        .click();
      await page
        .getByLabel("单源结果布局", { exact: true })
        .selectOption("grid");
      await page
        .getByLabel("结果加载方式", { exact: true })
        .selectOption("waterfall");
      await page.waitForFunction(() =>
        document
          .querySelector(".comic-waterfall-status")
          ?.textContent?.includes("共 24 条"),
      );
      await jumpTo(10);
      await waitRange(10, 10);
      await browseBoundary(-1);
      await waitRange(9, 10);
      await browseBoundary(-1);
      await waitRange(8, 10);
      await browseBoundary(1);
      await waitRange(8, 11);
      await browseBoundary(1);
      await waitRange(8, 12);
      await jumpTo(10);
      await waitRange(8, 12);
      await page
        .getByLabel("结果加载方式", { exact: true })
        .selectOption("pagination");
      await page.waitForFunction(() =>
        document
          .querySelector(".online-pagination")
          ?.textContent?.includes("第 10 页"),
      );
      const calls = await app.evaluate(() =>
        globalThis.__readingRequests
          .filter((r) => r.query === "waterfall-category")
          .map((r) => r.page),
      );
      assert.deepEqual(calls, [1, 10, 9, 8, 11, 12]);
      report.push(
        "漫画分类: jump 10, prepend 9/8, append 11/12, cached jump and pagination",
      );
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: report }));
} catch (error) {
  if (app) {
    const page = await app.firstWindow();
    console.error(
      "Search failure:",
      await page.evaluate(() => ({
        status: document.querySelector(".comic-waterfall-status")?.textContent,
        error: document.querySelector(".novel-error,.online-error")
          ?.textContent,
        text: document
          .querySelector(".online-layout")
          ?.textContent?.slice(0, 500),
      })),
    );
    console.error(
      "Requests:",
      await app.evaluate(() => globalThis.__readingRequests.slice(-20)),
    );
    await page.screenshot({
      path: "artifacts/novel-verification/search-waterfall-failure.png",
    });
  }
  throw error;
} finally {
  if (app) await app.close();
}
