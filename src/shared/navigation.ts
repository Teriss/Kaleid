import type { BrowseMemory, MediaType } from "./types";

export interface BrowseLocation {
  view:
    | "library"
    | "type"
    | "libraries"
    | "music"
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
  remoteKind?: "playlist" | "album" | "artist";
  serverId?: string;
}

export type NavigationSurface =
  "viewer" | "music" | "queue" | "match" | "overlay" | "create" | "manage";
export interface NavigationEntry {
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

/** A session history of UI destinations, never commands that mutate media or playback. */
export class NavigationHistory {
  private entries: NavigationEntry[] = [];
  private cursor = -1;
  get current() {
    return this.entries[this.cursor];
  }
  get canBack() {
    return this.cursor > 0;
  }
  get canForward() {
    return this.cursor + 1 < this.entries.length;
  }
  get length() {
    return this.entries.length;
  }
  static destination(entry: NavigationEntry) {
    const scope = Object.fromEntries(
      Object.entries(entry.scope)
        .filter(
          ([key, value]) =>
            value !== undefined && (key !== "search" || Boolean(value)),
        )
        .sort(([a], [b]) => a.localeCompare(b)),
    );
    return JSON.stringify({
      scope,
      viewer: entry.viewer ? { id: entry.viewer.id } : undefined,
      musicDetailId: entry.musicExpanded ? entry.musicDetailId : undefined,
      search: entry.search || undefined,
    });
  }
  private saved(entry: NavigationEntry): NavigationEntry {
    return structuredClone({
      ...entry,
      overlay: null,
      settingsSection: "appearance",
      queueOpen: false,
      matchOpen: false,
      createType: null,
      manageId: undefined,
      surfaceStack: entry.viewer
        ? ["viewer"]
        : entry.musicExpanded
          ? ["music"]
          : [],
    });
  }
  record(entry: NavigationEntry) {
    if (
      this.current &&
      NavigationHistory.destination(this.current) ===
        NavigationHistory.destination(entry)
    ) {
      this.replace(entry);
      return false;
    }
    this.entries.splice(this.cursor + 1);
    this.entries.push(this.saved(entry));
    this.cursor = this.entries.length - 1;
    if (this.entries.length > 200) {
      this.entries.shift();
      this.cursor--;
    }
    return true;
  }
  replace(entry: NavigationEntry) {
    if (this.cursor >= 0) this.entries[this.cursor] = this.saved(entry);
  }
  updateMemory(memory: BrowseMemory) {
    if (this.current) this.current.memory = structuredClone(memory);
  }
  back(parentFallback?: NavigationEntry) {
    if (this.canBack) return structuredClone(this.entries[--this.cursor]);
    if (
      this.cursor !== 0 ||
      !parentFallback ||
      NavigationHistory.destination(this.entries[0]) ===
        NavigationHistory.destination(parentFallback)
    )
      return null;
    // Keep the current and forward entries in place so Forward returns to the
    // child folder; discard the farthest destination if the journal is full.
    if (this.entries.length >= 200) this.entries.pop();
    this.entries.splice(0, 0, structuredClone(parentFallback));
    this.cursor = 1;
    return structuredClone(this.entries[--this.cursor]);
  }
  forward() {
    return this.canForward
      ? structuredClone(this.entries[++this.cursor])
      : null;
  }
  closeSurface(contains: (entry: NavigationEntry) => boolean) {
    for (let index = this.cursor - 1; index >= 0; index--) {
      if (!contains(this.entries[index])) {
        this.cursor = index;
        return structuredClone(this.entries[index]);
      }
    }
    return null;
  }
}

/** A type switch selects a journal; it is never an entry in either journal. */
export class MediaNavigationHistory {
  private journals = new Map<string, NavigationHistory>();
  forType(type: string) {
    let journal = this.journals.get(type);
    if (!journal) this.journals.set(type, (journal = new NavigationHistory()));
    return journal;
  }
}
