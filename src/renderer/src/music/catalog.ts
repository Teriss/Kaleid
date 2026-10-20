import { QueryFailure, queryFailure } from "../layouts/queryFailure";
import type { BrowseLocation } from "../../../shared/navigation";
import type { MediaItem, MediaQuery, QueryResult } from "../../../shared/types";
import type {
  MusicCollection,
  MusicProviderSummary,
  PlaybackSourceRef,
} from "../../../shared/music";
import { runtime } from "./folia-runtime";
import { navidromePage, navidromeItem } from "./navidrome";

const loaded = new Map<string, MediaItem>();
function rememberItem(item: MediaItem) {
  loaded.delete(item.id);
  loaded.set(item.id, item);
  while (loaded.size > 1000) loaded.delete(loaded.keys().next().value!);
}
const collections = new Map<string, MusicCollection>();
const pages = new Map<string, Promise<QueryResult>>();
export const isRemote = (item: MediaItem) =>
  item.sourceRef && item.sourceRef.kind !== "local";
export async function providers(): Promise<MusicProviderSummary[]> {
  return (await runtime()).list().map((p) => ({
    id: p.id,
    name:
      (
        {
          netease: "网易云音乐",
          qq: "QQ 音乐",
          kugou: "酷狗音乐",
          bodian: "波点音乐",
          ytm: "YouTube Music",
          spotify: "Spotify",
        } as Record<string, string>
      )[p.id] ?? p.displayName,
    capabilities: {
      ...p.capabilities,
      personalFm: Boolean(p.recommendations?.getPersonalFm),
      dailyRecommendations: Boolean(p.recommendations?.getDailySongs),
      createPlaylist: Boolean(p.mutations?.createPlaylist),
    },
  }));
}
export async function provider(id: string) {
  return (await runtime()).provider(id);
}
export function cachedMusic(id: string) {
  return loaded.get(id);
}
export function invalidateMusicPages(providerId?: string) {
  if (providerId) {
    for (const key of pages.keys()) {
      const [scope] = JSON.parse(key);
      if (scope.providerId === providerId) pages.delete(key);
    }
    return;
  }
  pages.clear();
}
export async function favoriteRemote(item: MediaItem, value: boolean) {
  await window.music.favorite(item.id, value);
  loaded.set(item.id, { ...item, favorite: value });
}
export async function specialPage(
  kind: "favorites" | "recent",
  query: MediaQuery,
): Promise<QueryResult> {
  const local = await window.media.query(query);
  const remote = await window.music.special(
    kind,
    Math.max(0, (query.offset ?? 0) - local.total),
    Math.max(0, (query.limit ?? 100) - local.items.length),
  );
  const items: MediaItem[] = [];
  for (const raw of remote.items) {
    const item = (await musicItems([raw.id]))[0];
    if (item)
      items.push({
        ...item,
        favorite: raw.favorite,
        lastOpened: raw.lastOpened,
      });
  }
  return {
    items: [...local.items, ...items],
    total: local.total + remote.total,
  };
}
async function protectedCover(providerId: string, url?: string) {
  if (!url) return undefined;
  try {
    return await window.music.resource(providerId, url);
  } catch {
    return undefined;
  }
}
export async function songItem(
  providerId: string,
  song: any,
): Promise<MediaItem> {
  const p = await provider(providerId);
  const metadata = p.songMetadata?.getSongMetadata(song);
  const sourceRef: PlaybackSourceRef = {
    kind: "online",
    providerId: p.id,
    mediaId: String(song.sourceRef?.mediaId ?? song.id),
  };
  const id = `online:${providerId}:${sourceRef.mediaId}`;
  const old = loaded.get(id);
  if (old) return old;
  const cover =
    metadata?.coverUrl ??
    metadata?.album?.coverUrl ??
    song.cover ??
    song.picUrl ??
    song.al?.picUrl;
  const item: MediaItem = {
    id,
    type: "music",
    title: song.name || song.title || "未命名歌曲",
    path: "",
    folder: "",
    ext: "",
    size: 0,
    modifiedAt: 0,
    addedAt: 0,
    favorite: false,
    missing: false,
    libraryIds: [],
    sourceRef,
    artist:
      metadata?.artists?.map((a: any) => a.name).join(" / ") ||
      song.artists?.map((a: any) => a.name).join(" / "),
    album: metadata?.album?.name ?? song.al?.name,
    duration: (metadata?.durationMs ?? song.dt ?? 0) / 1000,
    cover: cover ? "remote" : undefined,
    remoteCover: await protectedCover(providerId, cover),
    remoteData: song,
  };
  rememberItem(item);
  return item;
}
async function collectionItem(value: MusicCollection): Promise<MediaItem> {
  const id = `collection:${value.providerId}:${value.type}:${value.id}`;
  collections.set(id, value);
  const item: MediaItem = {
    id,
    kind: "collection",
    type: "music",
    title: value.name,
    path: "",
    folder: "",
    ext: "",
    size: 0,
    addedAt: 0,
    modifiedAt: 0,
    favorite: false,
    missing: false,
    libraryIds: [],
    cover: value.coverUrl ? "remote" : undefined,
    remoteCover: await protectedCover(value.providerId, value.coverUrl),
    remoteData: value,
    sourceRef: {
      kind: "online",
      providerId: value.providerId as any,
      mediaId: String(value.id),
    },
  };
  rememberItem(item);
  return item;
}
export function collectionLocation(item: MediaItem): BrowseLocation {
  if (item.sourceRef?.kind === "navidrome")
    return {
      view: "music",
      type: "music",
      musicSource: "navidrome",
      serverId: item.sourceRef.serverId,
      remoteId: item.sourceRef.mediaId,
      remoteKind: item.remoteData?.collectionKind,
      section: "collection",
    };
  const c = collections.get(item.id) ?? (item.remoteData as MusicCollection);
  return {
    view: "music",
    type: "music",
    musicSource: "online",
    providerId: c.providerId,
    section: "collection",
    remoteId: String(c.id),
    remoteKind: c.type as any,
  };
}
export async function musicPage(
  scope: BrowseLocation,
  query: MediaQuery,
): Promise<QueryResult> {
  const key = JSON.stringify([scope, query.search, query.offset, query.limit]);
  if (!pages.has(key)) {
    pages.set(
      key,
      fetchPage(scope, query).catch((error) => {
        pages.delete(key);
        throw queryFailure(error);
      }),
    );
    while (pages.size > 20) pages.delete(pages.keys().next().value!);
  }
  return pages.get(key)!;
}
async function fetchPage(
  scope: BrowseLocation,
  query: MediaQuery,
): Promise<QueryResult> {
  if (scope.musicSource === "navidrome") {
    const result = await navidromePage(scope, query);
    result.items.forEach((item) => rememberItem(item));
    return result;
  }
  const p = await provider(scope.providerId ?? "netease");
  const limit = query.limit ?? 100,
    offset = query.offset ?? 0;
  let answer: any;
  let collectionRows = false;
  if (query.search)
    answer = await p.search.searchSongs(query.search, limit, offset);
  else if (scope.remoteId) {
    const c = [...collections.values()].find(
      (c) => c.providerId === p.id && String(c.id) === scope.remoteId,
    ) ?? {
      providerId: p.id,
      id: scope.remoteId,
      type: scope.remoteKind,
      name: "",
    };
    const method =
      scope.remoteKind === "album"
        ? "getAlbumTracks"
        : scope.remoteKind === "artist"
          ? "getArtistSongs"
          : c.type === "cloud"
            ? "getCloudTracks"
            : "getPlaylistTracks";
    if (!p.catalog?.[method]) throw new Error("该平台不支持读取此类集合");
    answer =
      method === "getCloudTracks"
        ? await p.catalog[method](limit, offset, c)
        : await p.catalog[method](scope.remoteId, limit, offset, c);
  } else if (scope.section === "mine" || scope.section === "albums") {
    const user = await p.auth?.getLoginStatus();
    if (!user) throw new QueryFailure("auth-required", "请先登录该音乐平台");
    const method =
      scope.section === "albums"
        ? p.library?.getUserAlbums
        : p.library?.getUserPlaylists;
    if (!method) throw new Error("该平台不支持此音乐库栏目");
    answer = await method(user.id, limit, offset);
    collectionRows = true;
  } else if (scope.section === "radio" || scope.section === "daily") {
    const method =
      scope.section === "radio"
        ? p.recommendations?.getPersonalFm
        : p.recommendations?.getDailySongs;
    if (!method) throw new Error("该平台不支持此推荐方式");
    const items = await method();
    answer = {
      items: items.slice(offset, offset + limit),
      total: items.length,
      hasMore: offset + limit < items.length,
    };
  } else {
    if (p.recommendations?.getRecommendedCollections) {
      const items = await p.recommendations.getRecommendedCollections(100);
      answer = {
        items: items.slice(offset, offset + limit),
        total: items.length,
        hasMore: offset + limit < items.length,
      };
      collectionRows = true;
    } else if (p.explore?.getFeed) {
      const feed = await p.explore.getFeed();
      const items = feed.sections.flatMap((section: any) => section.items);
      const rows = await Promise.all(
        items.map((row: any) =>
          row.kind === "song"
            ? songItem(p.id, row.song)
            : collectionItem(row.collection),
        ),
      );
      let cursor = 0;
      const sections = feed.sections
        .map((section: any) => {
          const result = {
            title: section.title || section.name || "推荐",
            start: cursor,
            count: section.items.length,
          };
          cursor += section.items.length;
          return result;
        })
        .filter((section: any) => section.count);
      await window.music.saveCatalog(rows);
      return {
        items: rows.slice(offset, offset + limit),
        total: rows.length,
        sections,
      };
    } else return { items: [], total: 0 };
  }
  const items = await Promise.all(
    (answer.items ?? []).map((row: any) =>
      collectionRows ? collectionItem(row) : songItem(p.id, row),
    ),
  );
  const total =
    answer.total ?? offset + items.length + (answer.hasMore ? limit : 0);
  await window.music.saveCatalog(items);
  return { items, total };
}
export async function musicItems(ids: string[]) {
  const local = ids.filter(
    (id) => !id.startsWith("online:") && !id.startsWith("navidrome:"),
  );
  const remote = ids.filter((id) => !local.includes(id));
  const cached = remote
    .map((id) => loaded.get(id))
    .filter(Boolean) as MediaItem[];
  const restored = await window.music.items(
    remote.filter((id) => !loaded.has(id)),
  );
  for (const item of restored) {
    if (item.remoteData && item.sourceRef?.kind === "online") {
      loaded.delete(item.id);
      cached.push(await songItem(item.sourceRef.providerId, item.remoteData));
    }
    if (item.sourceRef?.kind === "navidrome") {
      const config = await window.music.navidromeConfig();
      if (config?.serverId !== item.sourceRef.serverId) continue;
      const response = await window.music.navidrome("getSong", {
        id: item.sourceRef.mediaId,
      });
      const row = await navidromeItem(response.song);
      rememberItem(row);
      cached.push(row);
    }
  }
  const result = [
    ...cached,
    ...(local.length ? await window.media.musicItems(local) : []),
  ];
  return ids
    .map((id) => result.find((item) => item.id === id))
    .filter(Boolean) as MediaItem[];
}
export async function resolveAudio(item: MediaItem): Promise<string> {
  if (item.sourceRef?.kind === "navidrome") {
    const config = await window.music.navidromeConfig();
    if (config?.serverId !== item.sourceRef.serverId)
      throw new Error("该歌曲所属的 Navidrome 服务器已变更");
    return window.music.navidrome("stream", { id: item.sourceRef.mediaId });
  }
  if (item.sourceRef?.kind !== "online") throw new Error("不是在线歌曲");
  const p = await provider(item.sourceRef.providerId);
  const levels = ["standard", "high", "ultra", "lossless", "hires"];
  const wanted = localStorage.getItem("yingjian:audio-quality") || "high";
  const allowed = p.playback.audioQualityLevels ?? [
    "standard",
    "high",
    "lossless",
    "hires",
  ];
  const quality =
    [...levels]
      .reverse()
      .find(
        (level) =>
          allowed.includes(level) &&
          levels.indexOf(level) <= levels.indexOf(wanted),
      ) ?? allowed[0];
  const answer = await p.playback.getAudioSource(item.remoteData, quality);
  if (!answer?.url)
    throw new Error("该平台未提供可播放的音频，请检查登录或会员权限");
  if (answer.preview)
    window.dispatchEvent(
      new CustomEvent("music:notice", { detail: "该平台仅提供试听片段" }),
    );
  return window.music.resource(p.id, answer.url);
}
export async function onlineLyrics(item: MediaItem) {
  if (item.sourceRef?.kind === "navidrome") {
    const response = await window.music.navidrome("getLyricsBySongId", {
      id: item.sourceRef.mediaId,
    });
    const lyric = response.lyricsList?.structuredLyrics?.[0];
    return lyric
      ? {
          lyrics: {
            lines: lyric.line?.map((line: any, index: number) => ({
              startTime: (line.start ?? index * 5000) / 1000,
              fullText: line.value,
            })),
          },
        }
      : null;
  }
  if (item.sourceRef?.kind !== "online") return null;
  const p = await provider(item.sourceRef.providerId);
  return p.lyrics?.getLyrics(item.remoteData);
}
export async function stableQueue(scope: BrowseLocation, search?: string) {
  const ids: string[] = [];
  for (let offset = 0; offset < 100000; offset += 100) {
    const result = await musicPage(scope, { search, offset, limit: 100 });
    ids.push(
      ...result.items
        .filter((item) => item.kind !== "collection")
        .map((item) => item.id),
    );
    if (offset + result.items.length >= result.total || !result.items.length)
      break;
  }
  return [...new Set(ids)];
}

export async function artistInfo(scope: BrowseLocation) {
  if (
    !scope.remoteId ||
    scope.remoteKind !== "artist" ||
    scope.musicSource !== "online"
  )
    return null;
  const p = await provider(scope.providerId ?? "netease");
  const info = await p.catalog?.getArtistDetail?.(scope.remoteId);
  return info
    ? {
        title: info.name,
        description: info.description ?? "",
        cover: await protectedCover(p.id, info.coverUrl),
      }
    : null;
}
