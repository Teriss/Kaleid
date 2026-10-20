export async function fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const result = await (window as any).music.proxy(String(input), { method: init?.method, headers: init?.headers, body: init?.body });
  return new Response(result.bodyText, { status: result.status, headers: result.headers });
}
