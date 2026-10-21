import type { MediaItem, QueryResult } from "../../../shared/types";

/** Resolve actual contents, rather than treating a partial first page as a singleton. */
export async function singleCollectionMedia(
  entry: MediaItem,
  read: (entry: MediaItem) => Promise<QueryResult>,
): Promise<MediaItem | undefined> {
  const visited = new Set<string>();
  while (entry.kind && !visited.has(entry.id)) {
    if (
      entry.kind === "folder" &&
      entry.folderCount !== undefined &&
      entry.folderCount !== 1
    )
      return;
    visited.add(entry.id);
    const result = await read(entry);
    if (result.total !== 1 || result.items.length !== 1) return;
    const child = result.items[0];
    if (!child.kind) return child.missing ? undefined : child;
    // A chain of directories is skippable only when its indexed subtree also
    // contains exactly one medium. One subfolder alone is not one medium.
    if (child.kind !== "folder" || child.folderCount !== 1) return;
    entry = child;
  }
}
