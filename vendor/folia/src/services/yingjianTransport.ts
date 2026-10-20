// Yingjian adaptation: provider HTTP is performed by the main process. No renderer
// network exception or reusable cookie is needed. The unmodified provider keeps
// its response normalization, capability checks and failure handling.
export async function fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  const provider = url.port === '2' ? 'qq' : 'netease';
  const result = await (window as any).music.http(provider, url.pathname + url.search, { method: init?.method, body: init?.body });
  return new Response(JSON.stringify(result.body), { status: result.status, headers: { 'Content-Type': 'application/json' } });
}
