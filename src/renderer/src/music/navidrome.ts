import type { MediaItem, MediaQuery, QueryResult } from "../../../shared/types";
import type { BrowseLocation } from "../../../shared/navigation";
export async function navidromeItem(
  raw: any,
  kind?: "album" | "playlist" | "artist",
): Promise<MediaItem> {
  const config = await window.music.navidromeConfig();
  if (!config) throw new Error("请先配置 Navidrome 服务器");
  return {
    id: `navidrome:${config.serverId}:${kind ? `${kind}:` : ""}${raw.id}`,
    sourceRef: {
      kind: "navidrome",
      serverId: config.serverId,
      mediaId: String(raw.id),
    },
    kind: kind ? "collection" : undefined,
    type: "music",
    title: raw.title ?? raw.name ?? "未命名",
    artist: raw.artist,
    album: raw.album,
    duration: raw.duration,
    path: "",
    folder: "",
    ext: raw.suffix ?? "",
    size: raw.size ?? 0,
    modifiedAt: 0,
    addedAt: 0,
    libraryIds: [],
    favorite: false,
    missing: false,
    cover: raw.coverArt ? "remote" : undefined,
    remoteCover: raw.yingjianCover,
    remoteData: { ...raw, collectionKind: kind },
  };
}
export async function navidromePage(
  scope: BrowseLocation,
  query: MediaQuery,
): Promise<QueryResult> {
  const offset = query.offset ?? 0,
    limit = query.limit ?? 100;
  let rows: any[] = [],
    kind: "album" | "playlist" | "artist" | undefined;
  let total: number | undefined;
  if (query.search) {
    const response = await window.music.navidrome("search3", {
      query: query.search,
      songCount: limit,
      songOffset: offset,
      albumCount: 0,
      artistCount: 0,
    });
    rows = response.searchResult3?.song ?? [];
  } else if (scope.remoteId) {
    const operation =
      scope.remoteKind === "album"
        ? "getAlbum"
        : scope.remoteKind === "artist"
          ? "getArtist"
          : "getPlaylist";
    const response = await window.music.navidrome(operation, {
      id: scope.remoteId,
    });
    const all =
      response.album?.song ??
      response.playlist?.entry ??
      response.artist?.album ??
      [];
    if (scope.remoteKind === "artist") kind = "album";
    total = all.length;
    rows = all.slice(offset, offset + limit);
  } else if (
    scope.section === "artists" ||
    scope.section === "playlists" ||
    scope.section === "favorites"
  ) {
    const operation =
      scope.section === "artists"
        ? "getArtists"
        : scope.section === "playlists"
          ? "getPlaylists"
          : "getStarred2";
    const response = await window.music.navidrome(operation);
    const all =
      response.artists?.index?.flatMap((row: any) => row.artist ?? []) ??
      response.playlists?.playlist ??
      response.starred2?.song ??
      [];
    total = all.length;
    rows = all.slice(offset, offset + limit);
    kind =
      scope.section === "artists"
        ? "artist"
        : scope.section === "playlists"
          ? "playlist"
          : undefined;
  } else {
    const response = await window.music.navidrome("getAlbumList2", {
      type: "alphabeticalByName",
      size: limit,
      offset,
    });
    rows = response.albumList2?.album ?? [];
    kind = "album";
  }
  const items = await Promise.all(rows.map((row) => navidromeItem(row, kind)));
  await window.music.saveCatalog(items);
  return {
    items,
    total: total ?? offset + rows.length + (rows.length === limit ? limit : 0),
  };
}
