import type { OnlineComic } from "./onlineComics";

const metadataNamespace =
  /^(category|categories|uploader|upload[ _-]?time|update[ _-]?time|time|pages|max[ _-]?page|分类|类别|上传者|上传时间|更新时间|更新|时间|页数|章节数)$/i;
const dateText = /^\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[T\s].*)?$/;

export function comicCardTags(
  comic?: Pick<OnlineComic, "tags" | "tagDisplay">,
) {
  const translated = comic?.tagDisplay
    ?.filter((group) => !metadataNamespace.test(group.namespace))
    .flatMap((group) => group.tags);
  const raw = comic?.tags as unknown;
  const isTagPair = (value: unknown): value is [string, unknown] =>
    Array.isArray(value) && value.length >= 2 && typeof value[0] === "string";
  const mapValue = raw as
    | { $map?: unknown; namespace?: unknown; category?: unknown; group?: unknown }
    | undefined;
  const serializedMap = mapValue?.$map;
  const entries: [string, unknown][] =
    raw instanceof Map
      ? [...raw.entries()].filter(
          (entry): entry is [string, unknown] => typeof entry[0] === "string",
        )
      : Array.isArray(serializedMap)
        ? serializedMap.filter(isTagPair)
        : serializedMap && typeof serializedMap === "object"
          ? Object.entries(serializedMap)
          : Array.isArray(raw) && raw.every(isTagPair)
            ? raw
            : Array.isArray(raw)
              ? [["", raw]]
              : raw && typeof raw === "object" &&
                  ("value" in raw || "tag" in raw || "name" in raw)
                ? [[
                    String(
                      mapValue?.namespace ??
                        mapValue?.category ??
                        mapValue?.group ??
                        "",
                    ),
                    raw,
                  ]]
                : raw && typeof raw === "object"
                  ? Object.entries(raw)
                  : [];
  const fallback = entries.flatMap(([namespace, values]) => {
    if (metadataNamespace.test(namespace)) return [];
    return (Array.isArray(values) ? values : [values]).flatMap((value) => {
      const tag =
        typeof value === "string"
          ? value
          : value && typeof value === "object"
            ? ["value", "tag", "name", "label"]
                .map((key) => (value as Record<string, unknown>)[key])
                .find((candidate): candidate is string =>
                  typeof candidate === "string",
                )
            : undefined;
      if (!tag?.trim()) return [];
      const actualNamespace =
        value && typeof value === "object"
          ? String(
              (value as Record<string, unknown>).namespace ??
                (value as Record<string, unknown>).category ??
                (value as Record<string, unknown>).group ??
                namespace,
            )
          : namespace;
      if (metadataNamespace.test(actualNamespace)) return [];
      return [
        {
          value: tag,
          label: tag.split(":").at(-1)!.replaceAll("_", " "),
        },
      ];
    });
  });
  const seen = new Set<string>();
  return [...(translated || []), ...fallback]
    .filter((tag) => {
      const namespace = tag.value.includes(":")
        ? tag.value.split(":", 1)[0]
        : "";
      const label = tag.label.trim();
      if (!label || metadataNamespace.test(namespace) || dateText.test(label))
        return false;
      const key = label.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 10);
}

export function comicCardTime(
  comic?: Pick<OnlineComic, "uploadTime" | "description">,
) {
  // Some Venera lists put their upload date in description. Synopsis text and
  // numeric counts must never become a date (Date.parse("1") means Jan 2001).
  const explicit = comic?.uploadTime?.trim();
  const description = comic?.description?.trim();
  const value =
    explicit ||
    (description && dateText.test(description) ? description : undefined);
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(date)
    : explicit;
}
