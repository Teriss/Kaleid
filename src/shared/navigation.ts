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
      ...entry,
      overlay: entry.overlay === "layout" ? null : entry.overlay,
      surfaceStack:
        entry.overlay === "layout"
          ? entry.surfaceStack?.filter((surface) => surface !== "overlay")
          : entry.surfaceStack,
      scope,
      viewer: entry.viewer ? { id: entry.viewer.id } : undefined,
      memory: { sort: entry.memory.sort },
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
    this.entries.push(structuredClone(entry));
    this.cursor = this.entries.length - 1;
    if (this.entries.length > 200) {
      this.entries.shift();
      this.cursor--;
    }
    return true;
  }
  replace(entry: NavigationEntry) {
    if (this.cursor >= 0) this.entries[this.cursor] = structuredClone(entry);
  }
  updateMemory(memory: BrowseMemory) {
    if (this.current)
      this.current.memory = {
        ...structuredClone(memory),
        sort: this.current.memory.sort,
      };
  }
  back() {
    return this.canBack ? structuredClone(this.entries[--this.cursor]) : null;
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
