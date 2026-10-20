import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NavigationHistory,
  MediaNavigationHistory,
  parentLibraryLocation,
} from "../src/shared/navigation.ts";

function entry(scope, layout = "grid") {
  return {
    scope,
    memory: { layout, sort: "name" },
    search: "",
    overlay: null,
    settingsSection: "appearance",
    musicExpanded: false,
    queueOpen: false,
    matchOpen: false,
    createType: null,
  };
}

const library = (folder, type = "video") => ({
  view: "library",
  libraryId: "library-1",
  type,
  ...(folder ? { folder } : {}),
});

test("an empty startup journal walks parent folders and preserves Forward", () => {
  const history = new NavigationHistory();
  const parent = entry(library("C:\\媒体库\\剧集"));
  const child = entry(library("C:\\媒体库\\剧集\\第一季"));
  history.record(child);

  assert.equal(history.canBack, false);
  assert.deepEqual(history.back(parent), parent);
  assert.equal(history.canForward, true);
  assert.deepEqual(history.forward(), child);
  assert.deepEqual(history.back(parent), parent);
});

test("existing history takes priority over the parent fallback", () => {
  const history = new NavigationHistory();
  const libraryHome = entry(library(undefined));
  const child = entry(library("D:\\视频\\电影"));
  const parent = entry(library("D:\\视频"));
  history.record(libraryHome);
  history.record(child);

  assert.deepEqual(history.back(parent), libraryHome);
});

test("parent lookup handles drive roots, mixed separators, case and Chinese paths", () => {
  const roots = ["C:\\媒体\\影视\\"];
  assert.deepEqual(
    parentLibraryLocation(library("c:/媒体/影视/剧集/"), roots),
    library("C:\\媒体\\影视"),
  );
  assert.deepEqual(
    parentLibraryLocation(library("C:\\媒体\\影视\\"), roots),
    library(undefined),
  );
  assert.deepEqual(
    parentLibraryLocation(library("E:\\电影\\子目录"), ["E:\\"]),
    library("E:\\电影"),
  );
});

test("multi-root libraries return to their home and nested roots use the nearest boundary", () => {
  assert.deepEqual(
    parentLibraryLocation(library("D:\\影视\\电影"), [
      "D:\\影视\\电影",
      "E:\\剧集",
    ]),
    library(undefined),
  );
  assert.deepEqual(
    parentLibraryLocation(library("D:\\影视\\电影\\科幻"), [
      "D:\\影视",
      "D:\\影视\\电影",
    ]),
    library("D:\\影视\\电影"),
  );
});

test("parent lookup supports UNC and POSIX roots and rejects paths outside imports", () => {
  assert.deepEqual(
    parentLibraryLocation(library("\\\\server\\共享\\电影\\子目录"), [
      "\\\\server\\共享\\电影",
    ]),
    library("\\\\server\\共享\\电影"),
  );
  assert.deepEqual(
    parentLibraryLocation(library("/媒体/电影/子目录"), ["/媒体/电影"]),
    library("\\媒体\\电影"),
  );
  assert.equal(
    parentLibraryLocation(library("C:\\媒体库2\\文件夹"), ["C:\\媒体库"]),
    null,
  );
  assert.equal(parentLibraryLocation(library("C:\\不存在"), []), null);
});

test("a startup journal without a current entry cannot synthesize navigation", () => {
  assert.equal(new NavigationHistory().back(entry(library("C:\\"))), null);
});

test("media types keep independent navigation journals", () => {
  const journals = new MediaNavigationHistory();
  const images = journals.forType("image");
  const videos = journals.forType("video");
  images.record(entry({ view: "type", type: "image" }));
  images.record(entry({ view: "library", libraryId: "images", type: "image" }));
  videos.record(entry(library("C:\\视频\\季")));

  assert.equal(images.canBack, true);
  assert.equal(videos.canBack, false);
  assert.equal(journals.forType("video"), videos);
});
