import { describe, expect, it } from "vitest";
import {
  containsSingleSourceSearch,
  leavesAggregateReadingSearch,
  ParentNavigationStack,
  readingHubHomeLocation,
  SuspendedSearchSessions,
  type NavigationSnapshot,
} from "../../src/shared/navigation";

const entry = (
  patch: Partial<NavigationSnapshot> = {},
): NavigationSnapshot => ({
  scope: { view: "library", type: "image", libraryId: "images" },
  memory: { layout: "bravais", sort: "name", scrollTop: 80 },
  search: "",
  overlay: null,
  settingsSection: "appearance",
  musicExpanded: false,
  queueOpen: false,
  matchOpen: false,
  createType: null,
  surfaceStack: [],
  ...patch,
});

describe("semantic parent navigation", () => {
  it("returns home directly only from aggregate search", () => {
    for (const view of ["comic", "novel"] as const) {
      expect(readingHubHomeLocation({
        view,
        section: "search",
        providerId: "source-a",
        search: "query",
      })).toEqual({ view, type: view, section: "home", providerId: "source-a" });
      expect(readingHubHomeLocation({
        view,
        section: "search",
        searchMode: "single",
        providerId: "source-a",
      })).toBeNull();
      expect(readingHubHomeLocation({ view, section: "details", remoteId: "work" })).toBeNull();
    }
  });

  it("suspends comic and novel search stacks independently and restores tag-search parents in order", () => {
    for (const view of ["comic", "novel"] as const) {
      const aggregate = entry({
        scope: { view, section: "search", searchMode: "aggregate" },
      });
      const search1 = entry({
        scope: { view, section: "search", searchMode: "single", providerId: "source-a", search: "first" },
      });
      const detail1 = entry({ scope: { view, section: "details", remoteId: "work-1" } });
      const search2 = entry({
        scope: { view, section: "search", searchMode: "single", providerId: "source-a", search: "tag" },
      });
      const detail2 = entry({ scope: { view, section: "details", remoteId: "work-2" } });
      const parents = new ParentNavigationStack();
      for (const parent of [aggregate, search1, detail1, search2]) parents.push(parent);
      expect(containsSingleSourceSearch(detail2.scope, parents.snapshot())).toBe(true);

      const sessions = new SuspendedSearchSessions();
      sessions.save({ view, current: detail2, parents: parents.snapshot() });
      const restored = sessions.take(view);
      expect(restored?.current.scope.remoteId).toBe("work-2");
      parents.restore(restored!.parents);
      expect(parents.pop()?.scope).toEqual(search2.scope);
      expect(parents.pop()?.scope).toEqual(detail1.scope);
      expect(parents.pop()?.scope).toEqual(search1.scope);
      expect(sessions.has(view)).toBe(false);
    }

    const sessions = new SuspendedSearchSessions();
    sessions.save({ view: "comic", current: entry({ scope: { view: "comic", section: "details", remoteId: "c1" } }), parents: [] });
    sessions.save({ view: "novel", current: entry({ scope: { view: "novel", section: "details", remoteId: "n1" } }), parents: [] });
    sessions.save({ view: "comic", current: entry({ scope: { view: "comic", section: "details", remoteId: "c2" } }), parents: [] });
    expect(sessions.take("comic")?.current.scope.remoteId).toBe("c2");
    expect(sessions.has("novel")).toBe(true);
  });

  it("keeps the single-source session when opening menu home and clears aggregate search on exit", () => {
    const aggregate = { view: "comic", section: "search", searchMode: "aggregate" } as const;
    const detail = { view: "comic", section: "details", remoteId: "work-1" } as const;
    const menuHome = { view: "comic", section: "home" } as const;
    expect(leavesAggregateReadingSearch(detail, menuHome)).toBe(false);
    expect(leavesAggregateReadingSearch(aggregate, menuHome)).toBe(true);
  });

  it("restores the immediate parent without a forward destination", () => {
    const parents = new ParentNavigationStack();
    const root = entry();
    const folder = entry({
      scope: { view: "library", type: "image", libraryId: "images", folder: "C:/Images/child" },
    });
    const chapter = entry({
      scope: {
        view: "comic",
        type: "comic",
        section: "search",
        providerId: "source-a",
        remoteId: "work-1",
        remoteKind: "chapter",
        comicChapterId: "chapter-4",
      },
    });

    parents.push(root);
    parents.push(folder);
    expect(parents.pop()).toEqual(folder);
    expect(parents.pop()).toEqual(root);
    expect(parents.pop()).toBeNull();
    expect(chapter.scope.comicChapterId).toBe("chapter-4");
    expect(parents).not.toHaveProperty("forward");
    expect(parents).not.toHaveProperty("canForward");
  });

  it("preserves the source page state and sanitizes transient chrome", () => {
    const parents = new ParentNavigationStack();
    const source = entry({
      scope: { view: "music", type: "music", providerId: "netease", section: "discover" },
      memory: { layout: "carousel", sort: "recent", scrollTop: 300 },
      search: "ambient",
      overlay: "settings",
      settingsSection: "music",
      queueOpen: true,
      matchOpen: true,
      surfaceStack: ["music", "overlay", "queue"],
      musicExpanded: true,
      musicDetailId: "online:netease:track-1",
    });
    parents.push(source);
    source.scope.providerId = "mutated";
    const restored = parents.pop();
    expect(restored?.scope.providerId).toBe("netease");
    expect(restored?.search).toBe("ambient");
    expect(restored?.memory).toEqual({
      layout: "carousel",
      sort: "recent",
      scrollTop: 300,
    });
    expect(restored?.overlay).toBeNull();
    expect(restored?.settingsSection).toBe("appearance");
    expect(restored?.queueOpen).toBe(false);
    expect(restored?.matchOpen).toBe(false);
    expect(restored?.surfaceStack).toEqual(["music"]);
    expect(restored?.musicExpanded).toBe(true);
  });

  it("clears parents on a top-level media or menu switch", () => {
    const parents = new ParentNavigationStack();
    parents.push(entry());
    parents.push(entry({ scope: { view: "library", libraryId: "images", folder: "C:/Images/child" } }));
    expect(parents.canBack).toBe(true);
    parents.reset();
    expect(parents.canBack).toBe(false);
    expect(parents.length).toBe(0);
  });

  it("restores independent comic and local folder parents in LIFO order", () => {
    const parents = new ParentNavigationStack();
    const comicSearch = entry({
      scope: { view: "comic", type: "comic", section: "search", providerId: "source-b", search: "story" },
      search: "story",
    });
    const work = entry({
      scope: { view: "comic", type: "comic", section: "search", providerId: "source-b", search: "story", remoteId: "42", remoteKind: "comic" },
    });
    const library = entry({ scope: { view: "library", type: "video", libraryId: "videos", folder: "D:/Shows/Season 1" } });
    parents.push(comicSearch);
    parents.push(work);
    expect(parents.pop()?.scope.remoteKind).toBe("comic");
    expect(parents.pop()?.scope.search).toBe("story");
    parents.push(library);
    expect(parents.pop()?.scope.folder).toBe("D:/Shows/Season 1");
  });

  it("restores a saved stack for failed navigation without exposing a forward path", () => {
    const parents = new ParentNavigationStack();
    parents.push(entry());
    const saved = parents.snapshot();
    parents.push(entry({ scope: { view: "library", libraryId: "images", folder: "C:/Images/child" } }));
    parents.restore(saved);
    expect(parents.length).toBe(1);
    expect(parents.pop()?.scope.view).toBe("library");
    expect(parents.pop()).toBeNull();
  });
});
