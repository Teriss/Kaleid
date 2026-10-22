import type { MediaItem, QueryResult } from "../../../shared/types";

/** Resolve actual contents, rather than treating a partial first page as a singleton. */
export async function singleCollectionMedia(
  entry: MediaItem,
  read: (entry: MediaItem) => Promise<QueryResult>,
): Promise<MediaItem | undefined> {
  const visited = new Set<string>();
  while (entry.kind && !visited.has(entry.id)) {
    visited.add(entry.id);
    const result = await read(entry);
    if (result.total !== 1 || result.items.length !== 1) return;
    const child = result.items[0];
    if (!child.kind) return child.missing ? undefined : child;
    // A sole subfolder is not proof of a sole medium: inspect every level.
    // Cached folderCount may be stale while the directory watcher catches up.
    if (child.kind !== "folder") return;
    entry = child;
  }
}
