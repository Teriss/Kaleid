import type { BrowseMemory, MediaType } from "./types";

export interface BrowseLocation {
  view:
    | "library"
    | "type"
    | "libraries"
    | "music"
    | "comic"
    | "novel"
    | "favorites"
    | "recent"
    | "folders";
  libraryId?: string;
  type?: string;
  folder?: string;
  root?: boolean;
  localOnly?: boolean;
  search?: string;
  musicSource?: "online" | "navidrome";
  providerId?: string;
  section?: string;
  remoteId?: string;
  remoteKind?: "playlist" | "album" | "artist" | "comic" | "chapter" | "novel";
  novelChapterId?: string;
  novelPage?: number;
  novelSearchId?: string;
  novelSearchSources?: string[];
  comicChapterId?: string | null;
  /** One-shot reader entry, zero-based; independent of saved reading progress. */
  comicInitialPage?: number;
  searchMode?: "aggregate" | "single";
  /** Distinguishes independent comic search result pages in the parent stack. */
  comicSearchId?: string;
  comicCategory?: string;
  comicCategoryParam?: unknown;
  serverId?: string;
}

export type NavigationSurface =
  "viewer" | "music" | "queue" | "match" | "overlay" | "create" | "manage";
export type NavigationMode = "root" | "push" | "replace";

/** Only aggregate search returns home; all other pages follow the parent stack. */
export function readingHubHomeLocation(
  scope: BrowseLocation,
): BrowseLocation | null {
  if (
    (scope.view !== "comic" && scope.view !== "novel") ||
    scope.section !== "search" ||
    scope.searchMode === "single" ||
    scope.remoteId ||
    scope.novelChapterId ||
    scope.remoteKind === "chapter"
  )
    return null;
  return {
    view: scope.view,
    type: scope.view,
    section: "home",
    ...(scope.providerId ? { providerId: scope.providerId } : {}),
  };
}

/** A restorable page snapshot used by the semantic parent stack. */
export interface NavigationSnapshot {
  surfaceStack?: NavigationSurface[];
  scope: BrowseLocation;
  memory: BrowseMemory;
  search: string;
  overlay: string | null;
  settingsSection: string;
  viewer?: { id: string; index: number };
  musicDetailId?: string;
  musicExpanded: boolean;
  queueOpen: boolean;
  matchOpen: boolean;
  createType: MediaType | null;
  manageId?: string;
}

export type ReadingSearchView = "comic" | "novel";

export interface SuspendedSearchSession {
  view: ReadingSearchView;
  current: NavigationSnapshot;
  parents: NavigationSnapshot[];
}

export function hasSingleSourceSearch(
  scope: BrowseLocation,
): scope is BrowseLocation & { view: ReadingSearchView } {
  return (
    (scope.view === "comic" || scope.view === "novel") &&
    scope.section === "search" &&
    scope.searchMode === "single"
  );
}

export function containsSingleSourceSearch(
  current: BrowseLocation,
  parents: readonly NavigationSnapshot[],
) {
  return (
    hasSingleSourceSearch(current) ||
    parents.some((parent) => hasSingleSourceSearch(parent.scope))
  );
}

export function leavesAggregateReadingSearch(
  current: BrowseLocation,
  next: BrowseLocation,
) {
  return (
    (current.view === "comic" || current.view === "novel") &&
    current.section === "search" &&
    current.searchMode !== "single" &&
    (current.view !== next.view ||
      current.section !== next.section ||
      current.searchMode !== next.searchMode ||
      current.search !== next.search ||
      current.providerId !== next.providerId)
  );
}

/** Keeps one in-memory search visit for each reading type. */
export class SuspendedSearchSessions {
  private sessions: Partial<Record<ReadingSearchView, SuspendedSearchSession>> =
    {};

  has(view: ReadingSearchView) {
    return Boolean(this.sessions[view]);
  }

  save(session: SuspendedSearchSession) {
    this.sessions[session.view] = structuredClone(session);
  }

  take(view: ReadingSearchView) {
    const session = this.sessions[view];
    delete this.sessions[view];
    return session ? structuredClone(session) : null;
  }

  clear(view: ReadingSearchView) {
    delete this.sessions[view];
  }
}

function normalizedPath(value: string) {
  const isUnc = /^(?:\\\\|\/\/)/.test(value);
  let path = value.replace(/[\\/]+/g, "\\");
  if (isUnc) path = `\\${path}`;
  const unc = path.startsWith("\\\\");
  const driveRoot = /^[a-z]:\\$/i.test(path);
  const posixRoot = path === "\\";
  if (unc) {
    const parts = path.slice(2).split("\\").filter(Boolean);
    if (parts.length <= 2) return `\\\\${parts.join("\\")}\\`;
  }
  if (driveRoot || posixRoot) return path;
  return path.replace(/\\+$/, "");
}

function pathIsWithin(root: string, folder: string) {
  const base = normalizedPath(root).toLowerCase();
  const target = normalizedPath(folder).toLowerCase();
  return (
    target === base ||
    (base.endsWith("\\")
      ? target.startsWith(base)
      : target.startsWith(`${base}\\`))
  );
}

/** Returns the parent browser location without crossing an imported root. */
export function parentLibraryLocation(
  scope: BrowseLocation,
  roots: readonly string[] | undefined,
): BrowseLocation | null {
  if (
    scope.view !== "library" ||
    !scope.libraryId ||
    !scope.folder ||
    !roots?.length
  )
    return null;
  const folder = normalizedPath(scope.folder);
  const root = roots
    .map(normalizedPath)
    .filter((candidate) => pathIsWithin(candidate, folder))
    .sort((a, b) => b.length - a.length)[0];
  if (!root) return null;
  if (folder.toLowerCase() === root.toLowerCase())
    return { view: "library", libraryId: scope.libraryId, type: scope.type };

  const separator = folder.lastIndexOf("\\");
  if (separator < 0) return null;
  let parent = folder.slice(0, separator);
  if (/^[a-z]:$/i.test(parent)) parent += "\\";
  if (
    parent.startsWith("\\\\") &&
    parent.slice(2).split("\\").filter(Boolean).length === 2
  )
    parent += "\\";
  if (!parent && folder.startsWith("\\")) parent = "\\";
  if (!parent || !pathIsWithin(root, parent)) return null;
  if (parent.toLowerCase() === root.toLowerCase()) parent = root;
  return {
    view: "library",
    libraryId: scope.libraryId,
    type: scope.type,
    folder: parent,
  };
}

/** Stores only the page that opened the current child; it has no forward path. */
export class ParentNavigationStack {
  private parents: NavigationSnapshot[] = [];
  get canBack() {
    return this.parents.length > 0;
  }
  get length() {
    return this.parents.length;
  }
  snapshot() {
    return structuredClone(this.parents);
  }
  restore(parents: readonly NavigationSnapshot[]) {
    this.parents = parents.map((parent) => this.saved(parent));
  }
  private saved(entry: NavigationSnapshot): NavigationSnapshot {
    const saved = { ...entry };
    delete saved.manageId;
    return structuredClone({
      ...saved,
      overlay: null,
      settingsSection: "appearance",
      queueOpen: false,
      matchOpen: false,
      createType: null,
      surfaceStack: (entry.surfaceStack ?? []).filter(
        (surface) => surface === "viewer" || surface === "music",
      ),
    });
  }
  push(parent: NavigationSnapshot) {
    this.parents.push(this.saved(parent));
    if (this.parents.length > 100) this.parents.shift();
  }
  pop() {
    const parent = this.parents.pop();
    return parent ? structuredClone(parent) : null;
  }
  reset() {
    this.parents = [];
  }
}
