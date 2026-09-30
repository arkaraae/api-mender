// Mender runtime: runs version adapters in front of your newest API handler, so callers
// pinned to an old version keep working. It wraps any fetch-style handler,
// (Request) => Promise<Response>: Next.js route handlers, Hono, Cloudflare Workers, Bun, Deno.
//
// An adapter is plain code: { from, to, upgradeRequest, downgradeResponse, untranslatable }.
// No AI runs at request time. Every translated call is reported through onCall, which is
// how a provider learns who is still on the old version.

export function withMender(handler, options) {
  const {
    latest,
    adapters,
    versionHeader = 'Api-Version',
    sunset,
    guide,
    identify = () => 'unknown',
    onCall = () => {},
  } = options;
  const ordered = [...adapters].sort((a, b) => a.from.localeCompare(b.from));
  const deprecation = `@${Math.floor(Date.parse(`${latest}T00:00:00Z`) / 1000)}`;

  function notice(headers, pinned) {
    headers.set(versionHeader, pinned);
    headers.set('Deprecation', deprecation);
    if (sunset) headers.set('Sunset', new Date(`${sunset}T00:00:00Z`).toUTCString());
    if (guide) headers.set('Link', `<${guide}>; rel="deprecation"; type="text/html"`);
    return headers;
  }

  return async function menderHandler(request) {
    const pinned = request.headers.get(versionHeader) || latest;
    const chain = ordered.filter((a) => a.from >= pinned && a.to <= latest);
    if (pinned >= latest || chain.length === 0) return handler(request);

    const url = new URL(request.url);
    const call = { method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams) };
    const customer = identify(request);

    for (const adapter of chain) {
      const gone = adapter.untranslatable?.find((u) => u.method === call.method && u.path.test(call.path));
      if (gone) {
        onCall({ customer, version: pinned, ...call, outcome: 'untranslatable', reason: gone.reason });
        const body = { error: { type: 'version_gone', message: gone.reason, doc_url: gone.guide } };
        const headers = notice(new Headers({ 'content-type': 'application/json' }), pinned);
        return new Response(JSON.stringify(body), { status: 410, headers });
      }
    }

    const hasBody = !['GET', 'HEAD'].includes(request.method);
    let up = { ...call, body: hasBody ? await request.json().catch(() => undefined) : undefined };
    for (const adapter of chain) up = adapter.upgradeRequest ? adapter.upgradeRequest(structuredClone(up)) : up;

    const target = new URL(up.path, url);
    for (const [key, value] of Object.entries(up.query ?? {})) target.searchParams.set(key, value);
    const headers = new Headers(request.headers);
    headers.set(versionHeader, latest);
    headers.delete('content-length');
    const upstream = await handler(new Request(target, {
      method: up.method,
      headers,
      body: up.body === undefined ? undefined : JSON.stringify(up.body),
    }));

    const text = await upstream.text();
    let payload;
    try { payload = JSON.parse(text); } catch { payload = undefined; }
    let down = { status: upstream.status, body: payload };
    if (payload !== undefined) {
      for (const adapter of [...chain].reverse()) {
        down = adapter.downgradeResponse ? adapter.downgradeResponse(structuredClone(down), call) : down;
      }
    }

    onCall({ customer, version: pinned, ...call, outcome: 'translated', status: down.status });
    return new Response(payload === undefined ? text : JSON.stringify(down.body), {
      status: down.status,
      headers: notice(new Headers(upstream.headers), pinned),
    });
  };
}
