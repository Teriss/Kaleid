import fs from "node:fs/promises";
import type { ComicTagDisplayGroup } from "../../shared/onlineComics";

type TranslationData = Record<string, Record<string, string>>;
export type TranslationIndex = {
  namespaces: Record<string, string>;
  tags: Record<string, Record<string, string>>;
};

// These aliases and the fallback namespace order follow Venera's tag translator.
const NAMESPACE_ALIASES: Record<string, string> = {
  languages: "language",
  artists: "artist",
  groups: "group",
  parodies: "parody",
  characters: "character",
};
const CATEGORY_LABELS: Record<string, string> = {
  category: "分类",
  categories: "分类",
  languages: "语言",
  artists: "画师",
  characters: "角色",
  groups: "团队",
  tags: "标签",
  parodies: "原作",
  time: "时间",
  uploader: "上传者",
  "upload time": "上传时间",
  uploadtime: "上传时间",
  pages: "页数",
};
const FALLBACK_NAMESPACES = [
  "male",
  "female",
  "language",
  "parody",
  "character",
  "other",
  "mixed",
];

export function indexDatabase(data: TranslationData): TranslationIndex {
  const { rows = {}, ...tags } = data;
  return { namespaces: rows, tags };
}

function namespaceKey(value: string) {
  const key = value.toLowerCase();
  return NAMESPACE_ALIASES[key] || key;
}

function translateGeneric(value: string, index: TranslationIndex): string | undefined {
  const key = value.trim().toLowerCase();
  for (const namespace of FALLBACK_NAMESPACES) {
    const translation = index.tags[namespace]?.[key];
    if (translation) return translation;
  }
  return undefined;
}

export function translateTag(
  value: string,
  namespace: string | undefined,
  index: TranslationIndex,
): string {
  const raw = value.trim();
  if (!raw) return value;

  if (raw.includes("|")) {
    const [first, second] = raw.split("|").map((part) => part.trim());
    return (
      translateGeneric(first, index) ||
      translateGeneric(second, index) ||
      raw
    );
  }

  const qualified = raw.match(/^([^:]+):([^:]+)$/);
  if (qualified) {
    const key = namespaceKey(qualified[1]);
    const tag = qualified[2].trim().toLowerCase();
    if (index.tags[key]) return index.tags[key][tag] || tag;
    return raw;
  }

  const key = namespace ? namespaceKey(namespace) : "";
  const contextual = key ? index.tags[key]?.[raw.toLowerCase()] : undefined;
  return contextual || translateGeneric(raw, index) || value;
}

export function translateTagGroups(
  tags: unknown,
  index: TranslationIndex,
): ComicTagDisplayGroup[] {
  const entries: [string, unknown][] = Array.isArray(tags)
    ? [["Tags", tags]]
    : (tags as any)?.$map || Object.entries(tags || {});

  return entries.map(([namespace, rawValues]) => {
    const values = Array.isArray(rawValues)
      ? rawValues
      : rawValues == null || rawValues === ""
        ? []
        : [rawValues];
    const key = namespace.toLowerCase();
    const groupKey = namespaceKey(namespace);
    return {
      namespace,
      label:
        index.namespaces[key] ||
        index.namespaces[groupKey] ||
        CATEGORY_LABELS[key] ||
        namespace,
      tags: values.map((raw) => {
        const value = String(raw);
        return {
          value,
          label: translateTag(value, groupKey, index),
        };
      }),
    };
  });
}

export class ComicTagTranslations {
  private loading?: Promise<TranslationIndex>;

  constructor(private readonly file: string) {}

  private database() {
    if (!this.loading) {
      this.loading = fs
        .readFile(this.file, "utf8")
        .then((content) => indexDatabase(JSON.parse(content) as TranslationData));
    }
    return this.loading;
  }

  async translate(tags: unknown) {
    try {
      return translateTagGroups(tags, await this.database());
    } catch {
      // A missing/corrupt optional translation asset must not break comic details.
      return [];
    }
  }
}
