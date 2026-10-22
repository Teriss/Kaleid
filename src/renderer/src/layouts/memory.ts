import { ALL_LAYOUTS, normalizeLayout, defaultLayout } from "./policy";
export { defaultLayout } from "./policy";
import type { BrowseMemory } from "../../../shared/types";
import { isActiveMusicProvider } from "../../../shared/music";

import type { BrowseLocation } from "../../../shared/navigation";
export type BrowseScope = BrowseLocation;
export function availableScope(scope: BrowseScope): BrowseScope {
  if (scope.musicSource === "navidrome")
    return { view: "libraries", type: "music" };
  if (
    scope.view === "music" &&
    scope.providerId &&
    !isActiveMusicProvider(scope.providerId)
  )
    return {
      view: "music",
      type: "music",
      musicSource: "online",
      providerId: "netease",
      section: "discover",
    };
  return scope;
}
const memories = new Map<string, BrowseMemory>();
const dirty = new Set<string>();
let timer: ReturnType<typeof setTimeout> | undefined;
export function scopeKey(scope: BrowseScope) {
  if (scope.localOnly) return `${scope.view}:${scope.type}:local`;
  if (scope.view === "music")
    return `music:${scope.musicSource}:${scope.providerId ?? scope.serverId ?? ""}:${scope.section ?? "home"}:${scope.remoteKind ?? ""}:${scope.remoteId ?? ""}`;
  if (scope.view === "libraries") return `libraries:${scope.type}`;
  return `${scope.view}:${scope.view === "library" ? `${scope.libraryId}${scope.folder ? `:${scope.folder}` : ""}` : scope.view === "type" ? scope.type : scope.view === "folders" ? `${scope.libraryId ?? ""}:${scope.folder ?? ""}` : ""}`;
}
function layoutKey(scope: BrowseScope) {
  if (scope.view === "favorites" || scope.view === "recent")
    return `layout:view:${scope.view}`;
  const type = scope.type;
  return type ? `layout:type:${type}` : undefined;
}
export function readMemory(scope: BrowseScope): BrowseMemory {
  const key = scopeKey(scope);
  const cached = memories.get(key);
  if (cached && ["bookshelf", "list"].includes(cached.layout as string)) {
    cached.layout = "grid";
    delete cached.scrollTop;
  }
  // Upgrade removed layouts without losing the browsing anchor.
  try {
    const pref = layoutKey(scope);
    if (
      pref &&
      ["bookshelf", "list"].includes(localStorage.getItem(pref) ?? "")
    )
      localStorage.setItem(pref, "grid");
  } catch {}
  if (cached) {
    let preference: string | null = null;
    try {
      const pref = layoutKey(scope);
      preference = pref ? localStorage.getItem(pref) : null;
    } catch {
      /* Keep cached layout. */
    }
    const preferred = normalizeLayout(
      ALL_LAYOUTS.includes(preference as BrowseMemory["layout"])
        ? (preference as BrowseMemory["layout"])
        : scope.type && scope.view !== "favorites" && scope.view !== "recent"
          ? defaultLayout(scope.type)
          : cached.layout,
      scope.type,
    );
    if (preferred !== cached.layout) {
      const refreshed = { ...cached, layout: preferred };
      memories.set(key, refreshed);
      return refreshed;
    }
    return cached;
  }
  let saved: Partial<BrowseMemory> = {};
  try {
    const value = JSON.parse(
      localStorage.getItem(`browse:${key}`) ||
        localStorage.getItem(`view:${key}`) ||
        "{}",
    );
    saved =
      value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    /* An invalid preference never prevents opening the library. */
  }
  if (["bookshelf", "list"].includes(saved.layout as string)) {
    saved.layout = "grid";
    delete saved.scrollTop;
  }
  const result: BrowseMemory = {
    ...saved,
    layout: normalizeLayout(
      (() => {
        let preference: string | null = null;
        try {
          const key = layoutKey(scope);
          preference = key ? localStorage.getItem(key) : null;
        } catch {
          /* Keep defaults. */
        }
        const value =
          preference ??
          (!scope.type || scope.view === "favorites" || scope.view === "recent"
            ? saved.layout
            : undefined);
        return ALL_LAYOUTS.includes(value as BrowseMemory["layout"])
          ? (value as BrowseMemory["layout"])
          : defaultLayout(scope.type);
      })(),
      scope.type,
    ),
    sort: ["name", "added", "recent"].includes(saved.sort ?? "")
      ? saved.sort!
      : "added",
  };
  if (result.wallMode !== "finite" && result.wallMode !== "infinite")
    result.wallMode = "infinite";
  if (result.showcaseMode !== "finite" && result.showcaseMode !== "infinite")
    result.showcaseMode = "infinite";
  if (
    result.archiveShelfMode !== "finite" &&
    result.archiveShelfMode !== "infinite"
  )
    result.archiveShelfMode = "infinite";
  if (result.wallCameras && typeof result.wallCameras === "object") {
    for (const mode of ["finite", "infinite"] as const) {
      const camera = result.wallCameras[mode];
      if (
        camera &&
        (![camera.x, camera.y, camera.scale].every(Number.isFinite) ||
          camera.scale < 0.45 ||
          camera.scale > 1.8 ||
          Math.abs(camera.x) > 1e9 ||
          Math.abs(camera.y) > 1e9)
      )
        delete result.wallCameras[mode];
    }
  } else delete result.wallCameras;
  if (!Number.isSafeInteger(result.focusIndex) || result.focusIndex! < 0)
    delete result.focusIndex;
  if (typeof result.focusId !== "string") delete result.focusId;
  for (const field of [
    "carouselPosition",
    "galleryOffset",
    "verticalGalleryOffset",
    "focusRequest",
  ] as const) {
    const value = result[field];
    if (value !== undefined && (!Number.isFinite(value) || value < 0))
      delete result[field];
  }
  if (!Number.isFinite(result.scrollTop) || result.scrollTop! < 0)
    delete result.scrollTop;
  if (
    result.camera &&
    (![result.camera.x, result.camera.y, result.camera.scale].every(
      Number.isFinite,
    ) ||
      result.camera.scale < 0.45 ||
      result.camera.scale > 1.8 ||
      Math.abs(result.camera.x) > 1e9 ||
      Math.abs(result.camera.y) > 1e9)
  )
    delete result.camera;
  memories.set(key, result);
  return result;
}
export function flushMemory() {
  for (const key of dirty) {
    try {
      localStorage.setItem(`browse:${key}`, JSON.stringify(memories.get(key)));
    } catch {
      /* Browsing remains available if storage is full. */
    }
  }
  dirty.clear();
}
export function saveMemory(scope: BrowseScope, patch: Partial<BrowseMemory>) {
  const key = scopeKey(scope);
  memories.set(key, { ...readMemory(scope), ...patch });
  if (patch.layout) {
    const pref = layoutKey(scope);
    if (pref) {
      try {
        localStorage.setItem(pref, patch.layout);
      } catch {
        /* Nonessential preference. */
      }
    }
  }
  dirty.add(key);
  clearTimeout(timer);
  timer = setTimeout(flushMemory, 220);
}
export function readLastScope(): BrowseScope | null {
  try {
    const scope = JSON.parse(localStorage.getItem("last-browse") || "null");
    if (scope?.view === "library" && typeof scope.libraryId !== "string")
      return null;
    if (
      scope?.view === "type" &&
      !["image", "music", "video", "novel", "comic"].includes(scope.type)
    )
      return null;
    if (
      scope?.view === "folders" &&
      scope.folder !== undefined &&
      typeof scope.folder !== "string"
    )
      return null;
    return scope &&
      [
        "library",
        "type",
        "libraries",
        "music",
        "favorites",
        "recent",
        "folders",
      ].includes(scope.view)
      ? availableScope(scope)
      : null;
  } catch {
    return null;
  }
}
export function saveLastScope(scope: BrowseScope) {
  try {
    localStorage.setItem("last-browse", JSON.stringify(scope));
  } catch {
    /* Nonessential preference. */
  }
}
export function readLastNormalScope(): BrowseScope | null {
  try {
    const scope = JSON.parse(
      localStorage.getItem("last-normal-browse") || "null",
    );
    if (
      !scope ||
      !["library", "type", "libraries", "music", "folders"].includes(scope.view)
    )
      return null;
    if (scope.view === "library" && typeof scope.libraryId !== "string")
      return null;
    if (
      scope.view === "type" &&
      !["image", "music", "video", "novel", "comic"].includes(scope.type)
    )
      return null;
    return availableScope(scope);
  } catch {
    return null;
  }
}
export function saveLastNormalScope(scope: BrowseScope) {
  if (
    !["library", "type", "libraries", "music", "folders"].includes(scope.view)
  )
    return;
  try {
    localStorage.setItem("last-normal-browse", JSON.stringify(scope));
    if (scope.type)
      localStorage.setItem(`last-type:${scope.type}`, JSON.stringify(scope));
  } catch {
    /* Nonessential preference. */
  }
}

export function readLastTypeScope(type: string): BrowseScope | null {
  try {
    const scope = JSON.parse(
      localStorage.getItem(`last-type:${type}`) || "null",
    );
    if (
      scope?.type === type &&
      ["library", "music", "libraries", "folders"].includes(scope.view)
    )
      return availableScope(scope);
    const old = readLastNormalScope();
    return old?.type === type && old.view !== "type" ? old : null;
  } catch {
    return null;
  }
}
