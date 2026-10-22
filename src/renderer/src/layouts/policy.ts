import type { MediaLayout } from "../../../shared/types";
export const ALL_LAYOUTS: readonly MediaLayout[] = [
  "bravais",
  "spatial",
  "grid",
  "carousel",
  "gallery",
  "verticalGallery",
  "archiveShelf",
  "recordCrate",
  "screeningRoom",
  "photoLightbox",
];
export function supportedLayouts(type?: string): readonly MediaLayout[] {
  return ALL_LAYOUTS.filter((layout) =>
    layout === "recordCrate"
      ? type === "music"
      : layout === "screeningRoom"
        ? type === "video"
        : layout === "photoLightbox"
          ? type === "image"
          : layout === "archiveShelf"
            ? type === "novel" || type === "comic"
            : layout === "gallery" || layout === "verticalGallery"
              ? type === "image"
              : true,
  );
}
export function defaultLayout(type?: string): MediaLayout {
  if (type === "video") return "spatial";
  if (type === "novel" || type === "comic") return "grid";
  return "bravais";
}
export function normalizeLayout(value: unknown, type?: string): MediaLayout {
  if (value === "list" || value === "bookshelf") return "grid";
  if (!ALL_LAYOUTS.includes(value as MediaLayout)) return defaultLayout(type);
  // An old folder record may lack its media type; App resolves it from the library.
  if (type && !supportedLayouts(type).includes(value as MediaLayout))
    return defaultLayout(type);
  return value as MediaLayout;
}
