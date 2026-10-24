import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { ComicPreviewSession } from "../src/renderer/src/comicPreviewSession.ts";
import { parseThumbnail, cropThumbnail } from "../src/main/onlineComics/thumbnails.ts";

test("preview cursors share requests, preserve duplicate pages and stop at null", async () => {
  const cursors = [];
  let complete;
  const session = new ComicPreviewSession(["initial"], (cursor) => {
    cursors.push(cursor);
    return new Promise((resolve) => { complete = resolve; });
  });
  const first = session.loadNext();
  assert.equal(first, session.loadNext());
  await Promise.resolve();
  complete({ thumbnails: ["same", "same"], next: "" });
  await first;
  assert.deepEqual(session.snapshot().items, ["initial", "same", "same"]);
  await session.start();
  assert.deepEqual(cursors, [null], "返回详情不主动请求下一游标");
  const second = session.loadNext();
  await Promise.resolve();
  complete({ thumbnails: ["last"], next: null });
  await second;
  await session.loadNext();
  assert.deepEqual(cursors, [null, ""]);
  assert.equal(session.snapshot().hasMore, false);
});

test("failed/cyclic pagination keeps accepted pages and retries the same cursor", async () => {
  let attempt = 0;
  const cursors = [];
  const session = new ComicPreviewSession([], async (cursor) => {
    cursors.push(cursor);
    if (++attempt === 1) throw Error("HTTP 210");
    if (attempt === 2) return { thumbnails: ["one"], next: "a" };
    if (attempt === 3) return { thumbnails: ["bad"], next: "a" };
    if (attempt === 4) return { thumbnails: ["two"], next: "b" };
    return { thumbnails: ["cycle"], next: "a" };
  });
  await session.loadNext();
  assert.match(session.snapshot().error, /210/);
  await session.loadNext();
  await session.loadNext();
  assert.match(session.snapshot().error, /重复/);
  assert.deepEqual(session.snapshot().items, ["one"]);
  await session.loadNext();
  await session.loadNext();
  assert.deepEqual(cursors, [null, null, "a", "a", "b"]);
  assert.deepEqual(session.snapshot().items, ["one", "two"]);
  assert.match(session.snapshot().error, /重复/);
});

test("retired preview requests cannot publish into another visit", async () => {
  let complete;
  const session = new ComicPreviewSession([], () => new Promise((resolve) => { complete = resolve; }));
  const request = session.loadNext();
  await Promise.resolve();
  session.dispose();
  complete({ thumbnails: ["late"], next: null });
  await request;
  assert.deepEqual(session.snapshot().items, []);
});

test("thumbnail sprite crops support partial coordinates and invalid-crop fallback", async () => {
  const buffer = await sharp({ create: { width: 120, height: 100, channels: 3, background: "red" } }).png().toBuffer();
  const cropped = await cropThumbnail(buffer, parseThumbnail("https://image.invalid/sprite@x=60-120").crop);
  assert.equal((await sharp(cropped).metadata()).width, 60);
  assert.equal((await sharp(cropped).metadata()).height, 100);
  assert.equal((await sharp(await cropThumbnail(buffer, { y1: 10, y2: 80 })).metadata()).height, 70);
  assert.equal(await cropThumbnail(buffer, { x1: 200, x2: 250 }), buffer);
  assert.equal(await cropThumbnail(buffer, { x1: 80, x2: 20 }), buffer);
  assert.equal(parseThumbnail("https://image.invalid/a@b.png").url, "https://image.invalid/a@b.png");
  assert.deepEqual(parseThumbnail("https://image.invalid/a@x=bad"), { url: "https://image.invalid/a" });
});
