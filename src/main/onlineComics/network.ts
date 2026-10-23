export const VENERA_NEXT_VERSION = "1.18.0";
export const VENERA_NEXT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36";

const hostManagedHeaders = /^(cache-time|prevent-parallel|http_client|host|content-length|connection|accept-encoding)$/i;

export function prepareSourceRequest(
  rawHeaders: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) {
  const headers = new Headers();
  let cacheTime = String(extra.cacheTime ?? extra["cache-time"] ?? "");
  let httpClient = "";
  for (const [key, value] of Object.entries(rawHeaders)) {
    if (key.toLowerCase() === "cache-time") cacheTime ||= String(value);
    if (key.toLowerCase() === "http_client") httpClient = String(value);
    if (!hostManagedHeaders.test(key)) headers.set(key, String(value));
  }
  if (!headers.has("user-agent")) headers.set("User-Agent", VENERA_NEXT_USER_AGENT);
  // Dio's default Accept header used by Venera-Next. Electron's fetch would
  // otherwise send `*/*`, which makes some HTML sites (including Cloudflare
  // fronted sources) take a different response path.
  if (!headers.has("accept")) headers.set("Accept", "application/json, text/plain, */*");
  return { headers, cacheTime: cacheTime.toLowerCase(), httpClient };
}

export function sourceResponseCacheKey(
  sourceId: string,
  url: string,
  headers: Headers,
) {
  return JSON.stringify([
    sourceId,
    url,
    [...headers.entries()].map(([key, value]) => [key.toLowerCase(), value]).sort(([a], [b]) => a.localeCompare(b)),
  ]);
}

