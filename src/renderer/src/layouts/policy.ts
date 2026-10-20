import type { MediaLayout } from "../../../shared/types";
export const ALL_LAYOUTS: readonly MediaLayout[] = [
  "bravais",
  "spatial",
  "grid",
  "carousel",
  "gallery",
  "verticalGallery",
];
export function supportedLayouts(type?: string): readonly MediaLayout[] {
  return type === "image"
    ? ALL_LAYOUTS
    : ALL_LAYOUTS.filter(
        (layout) => layout !== "gallery" && layout !== "verticalGallery",
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
