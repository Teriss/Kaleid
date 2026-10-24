export type ComicAutoLanguage = "chinese" | "english" | "japanese";

export function appendComicAutoLanguageFilter(
  query: string,
  sourceId: string,
  filters: Record<string, ComicAutoLanguage | undefined> | undefined,
): string {
  const keyword = query.trim();
  const language = filters?.[sourceId];
  if (!keyword || !language || keyword.toLowerCase().includes("language:"))
    return keyword;
  return `${keyword} language:${language}`;
}
