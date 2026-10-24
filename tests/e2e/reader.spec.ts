import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { createRequire } from "node:module";
const EpubCFI = createRequire(import.meta.url)("epubjs/lib/epubcfi.js").default;
const compareCFI = (a: string, b: string) => new EpubCFI().compare(a, b);
const environment = process.env.READER_TEST_DEV === "1" ? "dev" : "build";
let devServer: import("vite").ViteDevServer | undefined;
let performanceSpine: string[] = [];
const runtimeErrors: string[] = [];
const rendererLogs: string[] = [];

test.describe.configure({ mode: "serial" });
let app: ElectronApplication;
let page: Page;
let temp: string;
let root: string;
let performanceBookTitle = "";

test.beforeAll(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), "kaleid-reader-"));
  root = path.join(temp, "novels");
  await fs.mkdir(root, { recursive: true });
  const chapters = Array.from(
    { length: 180 },
    (_, index) =>
      `${index === 0 ? "第一章 风起" : index === 90 ? "第二章 远行" : `第${index + 1}段`}\n这是一段用于检查阅读进度、选择和拖动翻页的小说正文。序号 ${index + 1}。`,
  ).join("\n");
  await fs.writeFile(path.join(root, "拖拽阅读.txt"), chapters, "utf8");

  const epub = new JSZip();
  epub.file("mimetype", "application/epub+zip");
  epub.file(
    "META-INF/container.xml",
    '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  );
  const epubChapters = Array.from({ length: 57 }, (_, index) => {
    const id = String(index + 1).padStart(2, "0");
    const title = index === 0 ? "第一章 星河" : `第${index + 1}章 远行`;
    const paragraphCount = index === 0 ? 160 : 36;
    const image =
      index === 0
        ? '<img src="../images/pixel.svg" alt="星河插画" /><div id="book-css-image" style="width:24px;height:24px;background-image:url(../images/pixel.svg)"></div>'
        : "";
    return {
      id,
      title,
      manifest: `<item id="chapter-${id}" href="text/chapter-${id}.xhtml" media-type="application/xhtml+xml"/>`,
      spine: `<itemref idref="chapter-${id}"/>`,
      document: `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title></head><body><h1>${title}</h1>${image}${Array.from({ length: paragraphCount }, (_, paragraph) => `<p>星河就有了方向。EPUB 拖动与阅读位置检查段落 ${paragraph + 1}。</p>`).join("")}</body></html>`,
    };
  });
  epub.file(
    "OEBPS/book.opf",
    `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book">reader-fixture</dc:identifier><dc:title>星河之间</dc:title><dc:language>zh</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="pixel" href="images/pixel.svg" media-type="image/svg+xml"/>${epubChapters.map((chapter) => chapter.manifest).join("")}</manifest><spine>${epubChapters.map((chapter) => chapter.spine).join("")}</spine></package>`,
  );
  epub.file(
    "OEBPS/nav.xhtml",
    '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body><nav epub:type="toc"><ol><li><a href="text/chapter-01.xhtml">第一章 星河</a></li></ol></nav></body></html>',
  );
  epub.file(
    "OEBPS/images/pixel.svg",
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><rect width="24" height="24" fill="#64856f"/><circle cx="12" cy="12" r="6" fill="#e9ddc8"/></svg>',
  );
  epubChapters.forEach((chapter) =>
    epub.file(`OEBPS/text/chapter-${chapter.id}.xhtml`, chapter.document),
  );
  await fs.writeFile(
    path.join(root, "星河之间.epub"),
    await epub.generateAsync({ type: "nodebuffer" }),
  );

  epub.remove("OEBPS/text/chapter-02.xhtml");
  epub.file(
    "OEBPS/nav.xhtml",
    '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body><nav epub:type="toc"><ol><li><a href="text/chapter-01.xhtml">第一章 正常内容</a></li><li><a href="text/chapter-02.xhtml">第二章 缺失测试</a></li></ol></nav></body></html>',
  );
  await fs.writeFile(
    path.join(root, "损坏章节.epub"),
    await epub.generateAsync({ type: "nodebuffer" }),
  );

  const performanceEpub = process.env.READER_PERF_EPUB;
  if (performanceEpub) {
    try {
      await fs.access(performanceEpub);
      performanceBookTitle = path
        .basename(performanceEpub)
        .replace(/\.epub$/i, "");
      await fs.copyFile(
        performanceEpub,
        path.join(root, path.basename(performanceEpub)),
      );
      const realZip = await JSZip.loadAsync(await fs.readFile(performanceEpub));
      const containerXml = await realZip
        .file("META-INF/container.xml")!
        .async("string");
      const opfPath = containerXml.match(/full-path="([^"]+)/)![1];
      const opf = await realZip.file(opfPath)!.async("string");
      const items = new Map(
        [...opf.matchAll(/<item\b[^>]*>/g)].map(([tag]) => [
          tag.match(/\bid="([^"]+)/)?.[1],
          tag.match(/\bhref="([^"]+)/)?.[1] ?? "",
        ]),
      );
      performanceSpine = [
        ...opf.matchAll(/<itemref\b[^>]*idref="([^"]+)/g),
      ].map((match) => items.get(match[1]) ?? "");
    } catch {
      performanceBookTitle = "";
    }
  }

  const env: Record<string, string> = Object.fromEntries(
    Object.entries({
      ...process.env,
      MEDIA_BROWSER_TEST_DATA: path.join(temp, "data"),
    }).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  if (environment === "dev") {
    const { createServer } = await import("vite");
    const configuration = (await import("../../electron.vite.config"))
      .default as any;
    devServer = await createServer({
      ...configuration.renderer,
      configFile: false,
      logLevel: "error",
      server: { host: "127.0.0.1", port: 5188 },
    });
    await devServer.listen();
    env.ELECTRON_RENDERER_URL = devServer.resolvedUrls!.local[0];
  }
  const launch = () =>
    electron.launch({
      args: [path.resolve("out/main/index.js")],
      env,
      timeout: 60000,
    });
  try {
    app = await launch();
  } catch (error) {
    // Windows can transiently reject Playwright's randomly allocated inspector port.
    if (!String(error).includes("WebSocket error")) throw error;
    app = await launch();
  }
  page = await app.firstWindow();
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  page.on("console", (message) => {
    if (["warning", "error"].includes(message.type()))
      rendererLogs.push(message.text());
  });
  await expect(page.locator(".browser-shell")).toBeVisible();
  await page.evaluate(async () =>
    window.media.saveSettings({
      ...(await window.media.settings()),
      navigationAutoHide: false,
    }),
  );
  await app.evaluate(({ dialog }, mediaRoot) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [mediaRoot],
    });
  }, root);
  const roots = await page.evaluate(() => window.media.chooseFolders());
  const library = await page.evaluate(async (roots) => {
    const result = await window.media.createLibrary({
      name: "阅读器验证",
      type: "novel",
      roots,
    });
    await window.media.scan(result.id);
    return result;
  }, roots);
  await expect
    .poll(() =>
      page.evaluate(
        async (id) =>
          (await window.media.libraries()).find((entry) => entry.id === id)
            ?.count,
        library.id,
      ),
    )
    .toBe(performanceBookTitle ? 4 : 3);
  await page.reload();
  await page.getByRole("button", { name: "浏览小说", exact: true }).click();
  await page.getByRole("button", { name: "媒体库", exact: true }).click();
  await page
    .locator(".library-picker")
    .getByRole("button", { name: "阅读器验证", exact: true })
    .click();
});

test.afterAll(async () => {
  await fs.mkdir("artifacts", { recursive: true });
  await fs.writeFile(
    `artifacts/reader-${environment}-runtime.json`,
    JSON.stringify({ runtimeErrors, rendererLogs }, null, 2),
  );
  await app?.close();
  await devServer?.close();
});

async function showReaderMenu() {
  if (await page.locator(".reader-bottom-panel").count()) return;
  if (await page.locator(".reader-selecting").count())
    await page.keyboard.press("Escape");
  await page.locator(".epub-host,.text-scroll").click();
  await expect(
    page.getByRole("dialog", { name: "阅读菜单", exact: true }),
  ).toBeVisible();
}
async function readerAction(name: string) {
  if (name === "退出文字选择") {
    await page.keyboard.press("Escape");
    await showReaderMenu();
    return;
  }
  await showReaderMenu();
  await page.getByRole("button", { name, exact: true }).click();
}

async function openBook(title: string) {
  if (await page.locator(".reader").count()) await readerAction("返回媒体库");
  const libraryPicker = page.locator(".library-picker");
  const escapedTitle = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const target = page
    .getByRole("button", {
      name: new RegExp(`^(打开|聚焦) ${escapedTitle}$`),
    })
    .first();
  await expect(target).toBeVisible();
  const label = await target.getAttribute("aria-label");
  const layout = await target.evaluate((element) =>
    element.closest("[data-layout]")?.getAttribute("data-layout"),
  );
  if (await libraryPicker.count())
    await target.evaluate((element) => {
      element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      element.dispatchEvent(
        new MouseEvent("dblclick", { bubbles: true, detail: 2 }),
      );
    });
  else if (layout === "grid")
    await target.evaluate((element) => {
      element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      element.dispatchEvent(
        new MouseEvent("dblclick", { bubbles: true, detail: 2 }),
      );
    });
  else {
    await target.click();
    if (!label?.startsWith("打开")) {
      await expect(page.locator(".poster.is-focused")).toBeVisible();
      await page.keyboard.press("Enter");
    }
  }
  await expect(page.locator(".reader")).toBeVisible();
  await expect(
    page.locator(".reader-topbar, .reader-footer, .reader-bottom-panel"),
  ).toHaveCount(0);
  await expect(page.getByLabel("阅读进度文本", { exact: true })).toBeVisible();
  await showReaderMenu();
}

test("TXT presets, drag paging, text selection, bookmarks and text-offset restore", async () => {
  await openBook("拖拽阅读");
  await expect(page.locator(".book-text")).toContainText("第二章 远行");
  const textLayout = page.locator(".book-text");
  const firstWidth = await textLayout.evaluate(
    (element) => element.clientWidth,
  );
  await page.setViewportSize({ width: 1680, height: 980 });
  await expect
    .poll(() => textLayout.evaluate((element) => element.clientWidth))
    .toBeGreaterThan(firstWidth);
  const horizontalPadding = await textLayout.evaluate((element) => {
    const style = getComputedStyle(element);
    return [style.paddingLeft, style.paddingRight];
  });
  expect(horizontalPadding[0]).toBe(horizontalPadding[1]);

  await readerAction("阅读外观");
  await expect(page.getByLabel("左右留白")).toBeVisible();
  await page.getByRole("radio", { name: "暖棕", exact: true }).click();
  await expect(page.locator(".reader")).toHaveCSS(
    "background-color",
    "rgb(233, 221, 200)",
  );
  await page.getByLabel("小说翻页模式").selectOption("paged");
  await page.getByRole("button",{name:"关闭阅读菜单",exact:true}).click();
  const textBox = (await page.locator(".text-scroll").boundingBox())!;
  const before = await page
    .locator(".text-scroll")
    .evaluate((element) => element.scrollLeft);
  await page.mouse.move(
    textBox.x + textBox.width * 0.58,
    textBox.y + textBox.height * 0.5,
  );
  await page.mouse.down();
  await page.mouse.move(
    textBox.x + textBox.width * 0.38,
    textBox.y + textBox.height * 0.5,
    { steps: 5 },
  );
  await page.mouse.up();
  await expect
    .poll(() =>
      page.locator(".text-scroll").evaluate((element) => element.scrollLeft),
    )
    .toBeGreaterThan(before);
  const beforeKeyboardPage = await page
    .locator(".text-scroll")
    .evaluate((element) => element.scrollLeft);
  await page.locator(".text-scroll").focus();
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(() =>
      page.locator(".text-scroll").evaluate((element) => element.scrollLeft),
    )
    .toBeGreaterThan(beforeKeyboardPage);

  await readerAction("选择文字");
  const paragraph = page.locator(".book-text p").nth(10);
  await expect(paragraph).toBeVisible();
  await paragraph.scrollIntoViewIfNeeded();
  const pageBeforeSelection = await page
    .locator(".text-scroll")
    .evaluate((element) => element.scrollLeft);
  await paragraph.selectText();
  await expect(page.locator(".reader")).toHaveClass(/reader-selecting/);
  expect(
    await page.evaluate(() => window.getSelection()?.toString().length ?? 0),
  ).toBeGreaterThan(0);
  expect(
    await page
      .locator(".text-scroll")
      .evaluate((element) => element.scrollLeft),
  ).toBe(pageBeforeSelection);
  await readerAction("退出文字选择");
  await readerAction("阅读外观");
  await page.getByLabel("小说翻页模式").selectOption("scroll");
  await page.getByRole("button",{name:"关闭阅读菜单",exact:true}).click();
  const scrollBefore = await page
    .locator(".text-scroll")
    .evaluate((element) => element.scrollTop);
  const scrollBox = (await page.locator(".text-scroll").boundingBox())!;
  await page.mouse.move(
    scrollBox.x + scrollBox.width / 2,
    scrollBox.y + scrollBox.height * 0.65,
  );
  await page.mouse.down();
  await page.mouse.move(
    scrollBox.x + scrollBox.width / 2,
    scrollBox.y + scrollBox.height * 0.4,
    { steps: 5 },
  );
  await page.mouse.up();
  await expect
    .poll(() =>
      page.locator(".text-scroll").evaluate((element) => element.scrollTop),
    )
    .toBeGreaterThan(scrollBefore);
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          (await window.media.query({ type: "novel", search: "拖拽阅读" }))
            .items[0].progress?.textOffset ?? 0,
      ),
    )
    .toBeGreaterThan(0);

  await readerAction("添加书签");
  await readerAction("目录与书签");
  await page.getByRole("tab", { name: /书签/ }).click();
  await expect(page.locator(".reader-toc")).toContainText("书签 01");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.locator(".reader-bottom-panel")).toHaveCount(0);
  await readerAction("返回媒体库");
  await expect(page.locator(".reader")).toHaveCount(0);
  await openBook("拖拽阅读");
  await expect
    .poll(() =>
      page.locator(".text-scroll").evaluate((element) => element.scrollTop),
    )
    .toBeGreaterThan(0);
});

test("EPUB themes, mode changes, progress generation and iframe selection gestures", async () => {
  await page.keyboard.press("Escape");
  await openBook("星河之间");
  const frame = page.frameLocator(".epub-host iframe");
  await expect(frame.locator("body")).toContainText("星河就有了方向");
  await expect
    .poll(() =>
      frame
        .locator('img[alt="星河插画"]')
        .evaluate((image) => (image as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(0);
  await expect(frame.locator("#book-css-image")).toHaveCSS(
    "background-image",
    /blob:/,
  );
  await expect(frame.locator("script")).toHaveCount(0);
  expect(
    await page.locator(".epub-host iframe").first().getAttribute("sandbox"),
  ).not.toContain("allow-scripts");
  await readerAction("阅读外观");
  await page.getByRole("radio", { name: "墨蓝", exact: true }).click();
  await expect
    .poll(() =>
      page.locator(".reader").evaluate((reader) => {
        const iframe =
          reader.querySelector<HTMLIFrameElement>(".epub-host iframe");
        const paragraph = iframe?.contentDocument?.querySelector("p");
        const title = reader.querySelector(".reader-book-title");
        return !!(
          paragraph &&
          title &&
          iframe?.contentWindow &&
          iframe.contentWindow.getComputedStyle(paragraph).color ===
            getComputedStyle(title).color
        );
      }),
    )
    .toBe(true);
  await page.getByLabel("小说翻页模式").selectOption("paged");
  await expect(page.locator(".reader")).toHaveClass(/reader-mode-paged/);
  await expect(page.locator(".epub-host iframe:visible").first()).toBeVisible();
  await expect(frame.locator("body")).toContainText("段落 80");
  await page.getByLabel("小说翻页模式").selectOption("scroll");
  await expect(page.locator(".reader")).toHaveClass(/reader-mode-scroll/);
  await expect(page.locator(".epub-host iframe:visible").first()).toBeVisible();
  await expect(frame.locator("body")).toContainText("段落 80");
  await readerAction("选择文字");
  const paragraph = frame.locator("p").nth(5);
  await paragraph.selectText();
  await expect(page.locator(".reader")).toHaveClass(/reader-selecting/);
  expect(
    await frame
      .locator("body")
      .evaluate(
        (node) => node.ownerDocument.getSelection()?.toString().length ?? 0,
      ),
  ).toBeGreaterThan(0);
  await readerAction("退出文字选择");
  await expect
    .poll(() =>
      page.getByRole("button", { name: "跳转", exact: true }).isDisabled(),
    )
    .toBe(false, { timeout: 30000 });
  await readerAction("阅读外观");
  await frame.locator("body").evaluate((body) => {
    body.tabIndex = 0;
    body.focus();
  });
  await page.keyboard.press("Escape");
  await expect(page.locator(".reader-appearance")).toHaveCount(0);
  await readerAction("阅读外观");
  await expect(
    page.locator(".reader-appearance .reader-theme-card"),
  ).toHaveCount(6);
  await page.screenshot({ path: "artifacts/reader-presets.png" });
  await page.setViewportSize({ width: 800, height: 600 });
  const panel = (await page.locator(".reader-appearance").boundingBox())!;
  expect(panel.x).toBeGreaterThanOrEqual(0);
  expect(panel.y).toBeGreaterThanOrEqual(0);
  expect(panel.x + panel.width).toBeLessThanOrEqual(800);
  expect(panel.y + panel.height).toBeLessThanOrEqual(600);
});

test("EPUB continuous wheel scrolling advances through the long spine", async () => {
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await openBook("星河之间");
  await readerAction("阅读外观");
  await page.getByLabel("小说翻页模式").selectOption("scroll");
  await readerAction("阅读外观");

  const currentHref = async () =>
    page.evaluate(async () => {
      const result = await window.media.query({
        type: "novel",
        search: "星河之间",
      });
      return result.items[0]?.progress?.href ?? "";
    });
  const startHref = await currentHref();
  const frameBox = (await page
    .locator(".epub-host iframe")
    .first()
    .boundingBox())!;
  await page.mouse.move(
    frameBox.x + frameBox.width / 2,
    Math.max(180, Math.min(frameBox.y + 180, 520)),
  );
  for (let index = 0; index < 24; index += 1) {
    await page.mouse.wheel(0, 650);
    await page.waitForTimeout(30);
  }
  await expect.poll(currentHref, { timeout: 20000 }).not.toBe(startHref);
});

test("the supplied long EPUB scrolls across chapters without blocking the UI", async () => {
  test.skip(!performanceBookTitle, "Set READER_PERF_EPUB to a local EPUB path");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await openBook(performanceBookTitle);
  await expect(page.locator(".epub-host iframe:visible").first()).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator(".epub-host iframe:visible")
        .evaluateAll(
          (frames) =>
            frames.flatMap((frame) =>
              Array.from(
                (frame as HTMLIFrameElement).contentDocument?.querySelectorAll(
                  ".kaleid-missing-image",
                ) ?? [],
              ),
            ).length,
        ),
    )
    .toBe(0);
  await readerAction("阅读外观");
  await page.getByLabel("小说翻页模式").selectOption("scroll");
  await readerAction("阅读外观");

  await page.evaluate(() => {
    const longTasks: number[] = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) longTasks.push(entry.duration);
    }).observe({ type: "longtask", buffered: true });
    (window as Window & { __readerLongTasks?: number[] }).__readerLongTasks =
      longTasks;
  });
  const currentHref = async () =>
    page.evaluate(async (title) => {
      const result = await window.media.query({ type: "novel", search: title });
      return result.items[0]?.progress?.href ?? "";
    }, performanceBookTitle);
  const startHref = await currentHref();
  const frame = page.locator(".epub-host iframe:visible").first();
  const frameBox = (await frame.boundingBox())!;
  await page.mouse.move(
    frameBox.x + frameBox.width / 2,
    frameBox.y + Math.min(180, frameBox.height / 2),
  );
  for (let index = 0; index < 30; index += 1) {
    await page.mouse.wheel(0, 720);
    await page.waitForTimeout(35);
  }
  await expect.poll(currentHref, { timeout: 20000 }).not.toBe(startHref);
  await expect(page.locator(".reader-error")).toHaveCount(0);
  const longTasks = await page.evaluate(
    () =>
      (window as Window & { __readerLongTasks?: number[] }).__readerLongTasks ??
      [],
  );
  const maximumLongTask = Math.max(0, ...longTasks);
  console.log(
    `Real EPUB scroll stress: ${longTasks.length} main-thread long tasks; max ${Math.round(maximumLongTask)} ms`,
  );
  expect(maximumLongTask).toBeLessThan(500);
});

async function snapshot() {
  return page
    .locator(".epub-host")
    .evaluate((host) =>
      JSON.parse((host as HTMLElement).dataset.readerLocation ?? "null"),
    );
}

async function waitForIndex() {
  await expect(page.locator(".epub-host")).toHaveAttribute(
    "data-reader-indexed",
    "true",
    { timeout: 30000 },
  );
}

async function seekTo(value: number) {
  await waitForIndex();
  await showReaderMenu();
  await page
    .getByLabel("阅读进度百分比", { exact: true })
    .fill(String(value / 10));
  await page.getByRole("button", { name: "跳转", exact: true }).click();
  await page.waitForTimeout(350);
}

async function reopenRealSection(href: string) {
  const location = await snapshot();
  const index = performanceSpine.indexOf(href);
  expect(index, href).toBeGreaterThanOrEqual(0);
  const base = location.start.cfi.match(/^(epubcfi\(\/\d+)\/\d+/)![1];
  const cfi = `${base}/${(index + 1) * 2}!/4/1:0)`;
  await readerAction("返回媒体库");
  await expect(page.locator(".reader")).toHaveCount(0);
  await page.evaluate(
    async ({ title, cfi }) => {
      const result = await window.media.query({ type: "novel", search: title });
      await window.media.saveProgress(result.items[0].id, { cfi });
    },
    { title: performanceBookTitle, cfi },
  );
  await openBook(performanceBookTitle);
  await expect.poll(async () => (await snapshot())?.start.index).toBe(index);
}

async function decodedImages() {
  return page
    .locator(".epub-host iframe:visible")
    .evaluateAll(async (frames) => {
      const images: Array<{
        kind: string;
        url: string;
        width: number;
        height: number;
      }> = [];
      for (const frame of frames) {
        const doc = (frame as HTMLIFrameElement).contentDocument!;
        for (const image of doc.querySelectorAll("img,svg image")) {
          const html = image as HTMLImageElement;
          const svg = image.localName === "image";
          const url = svg
            ? (image.getAttribute("href") ??
              image.getAttribute("xlink:href") ??
              "")
            : html.currentSrc || html.src;
          const decoded = svg ? new Image() : html;
          if (svg) decoded.src = url;
          await decoded.decode();
          images.push({
            kind: svg ? "svg" : "img",
            url,
            width: decoded.naturalWidth,
            height: decoded.naturalHeight,
          });
        }
      }
      return images;
    });
}

test("real EPUB SVG cover and JPEG content images decode before and after reopening", async () => {
  test.skip(!performanceBookTitle, "Set READER_PERF_EPUB");
  await seekTo(0);
  const cover = await decodedImages();
  expect(cover.some((image) => image.kind === "svg" && image.width > 0)).toBe(
    true,
  );
  await page.screenshot({ path: `artifacts/reader-${environment}-cover.png` });
  for (const href of [
    "text/part0001.html",
    "text/part0006_split_001.html",
    "text/part0008_split_001.html",
  ]) {
    await reopenRealSection(href);
    const images = await decodedImages();
    expect(images.length, href).toBeGreaterThan(0);
    for (const image of images) {
      expect(image.url).toMatch(/^blob:/);
      expect(image.width).toBeGreaterThan(0);
      expect(image.height).toBeGreaterThan(0);
    }
    if (href === "text/part0006_split_001.html") {
      await page.locator(".epub-host iframe").evaluateAll((frames) => {
        for (const frame of frames) {
          const image = (
            frame as HTMLIFrameElement
          ).contentDocument?.querySelector('img[alt="image_embedded.png"]');
          image?.scrollIntoView({ block: "center", behavior: "instant" });
        }
      });
      await expect
        .poll(() =>
          page.locator(".epub-host iframe").evaluateAll((frames) =>
            frames.some((frame) => {
              const image = (
                frame as HTMLIFrameElement
              ).contentDocument?.querySelector<HTMLImageElement>(
                'img[alt="image_embedded.png"]',
              );
              if (!image || !image.naturalWidth) return false;
              const imageBox = image.getBoundingClientRect();
              const frameBox = frame.getBoundingClientRect();
              return (
                imageBox.bottom + frameBox.top > 70 &&
                imageBox.top + frameBox.top < window.innerHeight - 62
              );
            }),
          ),
        )
        .toBe(true);
    }
    await page.screenshot({
      path: `artifacts/reader-${environment}-${path.basename(href)}.png`,
    });
  }
});

test("rapid bidirectional wheel bursts preserve CFI order across recycling and stop at 100%", async () => {
  test.skip(!performanceBookTitle, "Set READER_PERF_EPUB");
  await reopenRealSection("text/part0026_split_001.html");
  await waitForIndex();
  const records: { direction: number; cfi: string }[] = [];
  for (const direction of [1, -1, 1]) {
    const before = (await snapshot()).start.cfi;
    await page.locator(".epub-shell").hover({ position: { x: 400, y: 250 } });
    const locations: string[] = [before];
    await page.evaluate(() => {
      const trace = window as any;
      trace.__readingCFIs = [];
      trace.__readingInterval = setInterval(() => {
        const value =
          document.querySelector<HTMLElement>(".epub-host")?.dataset
            .readerLiveLocation;
        const cfi = value ? JSON.parse(value).start.cfi : undefined;
        if (cfi && cfi !== trace.__readingCFIs.at(-1))
          trace.__readingCFIs.push(cfi);
      }, 20);
    });
    for (let burst = 0; burst < 12; burst++) {
      for (let tick = 0; tick < 8; tick++)
        await page.mouse.wheel(0, direction * 400);
      await page.waitForTimeout(160);
      const current = await snapshot();
      if (current) locations.push(current.start.cfi);
    }
    await page.waitForTimeout(600);
    locations.push((await snapshot()).start.cfi);
    const live: string[] = await page.evaluate(() => {
      const trace = window as any;
      clearInterval(trace.__readingInterval);
      return trace.__readingCFIs;
    });
    for (let index = 1; index < live.length; index++) {
      expect(
        compareCFI(live[index], live[index - 1]) * direction,
        `${live[index - 1]} -> ${live[index]}`,
      ).toBeGreaterThanOrEqual(0);
    }
    records.push(...live.map((cfi) => ({ direction, cfi })));
    for (let index = 1; index < locations.length; index++) {
      expect(
        compareCFI(locations[index], locations[index - 1]) * direction,
        `${locations[index - 1]} -> ${locations[index]}`,
      ).toBeGreaterThanOrEqual(0);
    }
    expect(compareCFI(locations.at(-1)!, before) * direction).toBeGreaterThan(
      0,
    );
    records.push(...locations.map((cfi) => ({ direction, cfi })));
  }
  await seekTo(1000);
  await expect.poll(async () => (await snapshot())?.atEnd).toBe(true);
  await expect(page.locator(".reader-progress-value")).toHaveText("100.0%");
  const end = (await snapshot()).start.cfi;
  await page
    .getByRole("button", { name: "上一页", exact: true })
    .dispatchEvent("click");
  await expect
    .poll(async () => compareCFI((await snapshot()).start.cfi, end))
    .toBeLessThan(0);
  await page.getByRole("button", { name: "关闭阅读菜单", exact: true }).click();
  await page.keyboard.press("PageDown");
  await expect.poll(async () => (await snapshot())?.atEnd).toBe(true);
  await fs.writeFile(
    `artifacts/reader-${environment}-cfi-trace.json`,
    JSON.stringify(records, null, 2),
  );
  expect(runtimeErrors).toEqual([]);
});

test("paged navigation reaches both book boundaries and survives resize, mode switch and reopen", async () => {
  test.skip(!performanceBookTitle, "Set READER_PERF_EPUB");
  await page.setViewportSize({ width: 800, height: 600 });
  if (!(await page.locator(".reader").count()))
    await openBook(performanceBookTitle);
  await readerAction("阅读外观");
  await page.getByLabel("小说翻页模式").selectOption("paged");
  await expect(page.locator(".epub-host iframe:visible").first()).toBeVisible();
  await waitForIndex();
  await readerAction("阅读外观");
  await seekTo(940);
  let previous = (await snapshot()).start.cfi;
  let steps = 0;
  while (!(await snapshot()).atEnd && steps++ < 65) {
    await page
      .getByRole("button", { name: "关闭阅读菜单", exact: true })
      .click();
    await page.keyboard.press("PageDown");
    await expect
      .poll(async () => compareCFI((await snapshot()).start.cfi, previous))
      .toBeGreaterThan(0)
      .catch(async (error) => {
        console.log(
          "paging stall",
          steps,
          runtimeErrors,
          await page
            .locator(".epub-host")
            .getAttribute("data-reader-navigation"),
          await snapshot(),
          await page.locator(".epub-container").evaluate((el) => ({
            left: el.scrollLeft,
            width: el.clientWidth,
            scrollWidth: el.scrollWidth,
            height: el.clientHeight,
            childWidth: el.firstElementChild?.getBoundingClientRect().width,
          })),
        );
        throw error;
      });
    previous = (await snapshot()).start.cfi;
  }
  expect((await snapshot()).atEnd).toBe(true);
  await expect(page.locator(".reader-progress-value")).toHaveText("100.0%");
  await page
    .getByRole("button", { name: "上一页", exact: true })
    .dispatchEvent("click");
  await expect
    .poll(async () => compareCFI((await snapshot()).start.cfi, previous))
    .toBeLessThan(0);
  const saved = (await snapshot()).start.cfi;
  await page.setViewportSize({ width: 1440, height: 940 });
  await page.waitForTimeout(500);
  await expect(page.locator(".reader-error")).toHaveCount(0);
  await readerAction("返回媒体库");
  await openBook(performanceBookTitle);
  await expect
    .poll(async () => (await snapshot())?.start.index)
    .toBe(new EpubCFI(saved).spinePos);
  const browserWindow = await app.browserWindow(page);
  for (const zoom of [1.25, 1.5]) {
    await browserWindow.evaluate(
      (window, zoom) => window.webContents.setZoomFactor(zoom),
      zoom,
    );
    await page.waitForTimeout(400);
    await seekTo(940);
    const anchor = (await snapshot()).start.cfi;
    await page
      .getByRole("button", { name: "关闭阅读菜单", exact: true })
      .click();
    await page.keyboard.press("PageDown");
    await expect
      .poll(async () => compareCFI((await snapshot()).start.cfi, anchor))
      .toBeGreaterThan(0);
    await seekTo(1000);
    await expect.poll(async () => (await snapshot())?.atEnd).toBe(true);
    await expect(page.locator(".reader-progress-value")).toHaveText("100.0%");
    await page.screenshot({
      path: `artifacts/reader-${environment}-zoom-${zoom}.png`,
    });
  }
  await browserWindow.evaluate((window) => window.webContents.setZoomFactor(1));
  await page.waitForTimeout(300);
  await seekTo(0);
  await expect.poll(async () => (await snapshot())?.atStart).toBe(true);
  await expect(page.locator(".reader-progress-value")).toHaveText("0.0%");
  await page.screenshot({ path: `artifacts/reader-${environment}-paged.png` });
  expect(runtimeErrors).toEqual([]);
  expect(
    rendererLogs.filter((entry) =>
      entry.includes("violates the following Content Security Policy"),
    ),
  ).toEqual([]);
});

test("rapid reopening cannot publish old locations or leave live listeners", async () => {
  if (await page.locator(".reader").count()) await readerAction("返回媒体库");
  for (let index = 0; index < 6; index++) {
    await openBook("星河之间");
    await readerAction("返回媒体库");
  }
  await openBook("星河之间");
  await expect.poll(async () => (await snapshot())?.start.cfi).toBeTruthy();
  await waitForIndex();
  await page.waitForTimeout(400);
  await expect(page.locator(".epub-container")).toHaveCount(1);
  await expect(page.locator(".reader-error")).toHaveCount(0);
  expect(runtimeErrors).toEqual([]);
});

test("a missing chapter recovers once and leaves a working retry instead of a stuck navigation lock", async () => {
  if (await page.locator(".reader").count()) await readerAction("返回媒体库");
  await openBook("损坏章节");
  await expect.poll(async () => (await snapshot())?.start.cfi).toBeTruthy();
  const original = (await snapshot()).start.cfi;
  await readerAction("目录与书签");
  await page
    .locator(".reader-toc")
    .getByRole("button", { name: "第二章 缺失测试", exact: true })
    .click();
  // The first failure rebuilds the book and restores its last stable location.
  await page.waitForTimeout(500);
  await expect.poll(async () => (await snapshot())?.start.cfi).toBe(original);
  await expect(page.locator(".reader-error")).toHaveCount(0);
  await readerAction("目录与书签");
  await page
    .locator(".reader-toc")
    .getByRole("button", { name: "第二章 缺失测试", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "重试打开", exact: true }),
  ).toBeVisible({ timeout: 20000 });
  await page.getByRole("button", { name: "重试打开", exact: true }).click();
  await expect(page.locator(".reader-error")).toHaveCount(0);
  await expect.poll(async () => (await snapshot())?.start.cfi).toBeTruthy();
  await page.getByRole("button", { name: "关闭阅读菜单", exact: true }).click();
  await page.keyboard.press("PageDown");
  await expect
    .poll(async () => compareCFI((await snapshot()).start.cfi, original))
    .toBeGreaterThan(0);
  expect(runtimeErrors).toEqual([]);
});

for (const kind of ["txt", "epub"] as const)
  for (const mode of ["scroll", "paged"] as const) {
    test(`${kind} ${mode}: numeric seeking and immersive wheel progress`, async () => {
      await openBook(kind === "txt" ? "拖拽阅读" : "星河之间");
      await page.getByLabel("小说翻页模式").selectOption(mode);
      if (kind === "epub") await waitForIndex();
      await page.getByLabel("阅读进度百分比", { exact: true }).fill("20");
      await page.getByRole("button", { name: "跳转", exact: true }).click();
      if (kind === "epub")
        await expect
          .poll(async () => Math.abs((await snapshot()).whole - 0.2))
          .toBeLessThan(0.04);
      else
        await expect
          .poll(() =>
            page
              .locator(".text-scroll")
              .evaluate((el) => el.scrollTop + el.scrollLeft),
          )
          .toBeGreaterThan(0);
      await page
        .getByRole("button", { name: "关闭阅读菜单", exact: true })
        .click();
      const progress = page.getByLabel("阅读进度文本", { exact: true });
      const before = await progress.textContent();
      const host = page.locator(kind === "txt" ? ".text-scroll" : ".epub-host");
      const box = (await host.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.4);
      for (let i = 0; i < 12; i++) {
        await page.mouse.wheel(0, mode === "paged" ? 100 : 220);
        await page.waitForTimeout(120);
      }
      await expect(progress).not.toHaveText(before!);
      await expect(page.locator(".reader-bottom-panel")).toHaveCount(0);
      await expect(page.locator(".reader input[type=range]")).toHaveCount(0);
      await readerAction("返回媒体库");
      await openBook(kind === "txt" ? "拖拽阅读" : "星河之间");
      await expect(page.locator(".reader-error")).toHaveCount(0);
      expect(runtimeErrors).toEqual([]);
    });
  }

test("slow EPUB positioning does not overwrite a newer numeric seek draft", async () => {
  await openBook("星河之间");
  await waitForIndex();
  await page.getByLabel("阅读进度百分比", { exact: true }).fill("20");
  await page.getByRole("button", { name: "跳转", exact: true }).click();
  await page.getByLabel("阅读进度百分比", { exact: true }).fill("65");
  await page.waitForTimeout(400);
  await expect(page.getByLabel("阅读进度百分比", { exact: true })).toHaveValue(
    "65",
  );
  await page.getByRole("button", { name: "跳转", exact: true }).click();
  await expect
    .poll(async () => Math.abs((await snapshot()).whole - 0.65))
    .toBeLessThan(0.04);
  await expect(page.locator(".reader-error")).toHaveCount(0);
  expect(runtimeErrors).toEqual([]);
});
