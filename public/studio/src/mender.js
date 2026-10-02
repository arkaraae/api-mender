// Mender runtime: runs version adapters in front of your newest API handler, so callers
// pinned to an old version keep working. It wraps any fetch-style handler,
// (Request) => Promise<Response>: Next.js route handlers, Hono, Cloudflare Workers, Bun, Deno.
//
// An adapter is plain code: { from, to, upgradeRequest, downgradeResponse, untranslatable }.
// No AI runs at request time. Every translated call is reported through onCall, which is
// how a provider learns who is still on the old version.
//
//   withMender(handler, {
//     latest: '2026-09-01',              // the version your handler speaks
//     adapters: [compileRules(rules)],   // one per step, e.g. 03-01 → 09-01
//     versionHeader: 'Api-Version',      // where callers say which version they use
//     version: (request) => '…',         // or work it out yourself (API key, URL, …)
//     defaultVersion: '2026-03-01',      // callers that say nothing are on this version
//     sunset: '2027-03-01', guide: 'https://…', identify, onCall,
//   })

const JSON_TYPE = /^application\/([\w.-]+\+)?json\b/i;
const FORM_TYPE = /^application\/x-www-form-urlencoded\b/i;
const NO_BODY = new Set([204, 205, 304]);
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

// ---------- form bodies: a[b]=1&items[0][sku]=x&tags[]=y ----------

function place(root, parts, value) {
  let node = root;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const last = i === parts.length - 1;
    const key = Array.isArray(node) ? (part === '' ? node.length : Number(part)) : part;
    if (last) { node[key] = value; return true; }
    if (part === '' && Array.isArray(node)) return false; // items[][sku]: which item is ambiguous
    const next = parts[i + 1];
    if (/^\d+$/.test(next) && Number(next) > 999) return false;
    if (node[key] === undefined || typeof node[key] !== 'object') node[key] = next === '' || /^\d+$/.test(next) ? [] : {};
    node = node[key];
  }
  return true;
}

// Returns the form as a nested object, or null when the form can't be read without guessing
// (unbalanced brackets, items[][sku]). Mender then leaves the body alone. A key sent several
// times without brackets (tag=a&tag=b) becomes a list, and its name is added to `repeated`
// so encodeForm can write it back the same way.
export function parseForm(text, repeated = new Set()) {
  const root = {};
  for (const [name, value] of new URLSearchParams(text)) {
    const head = name.match(/^[^[]*/)[0];
    const rest = name.slice(head.length);
    const groups = [...rest.matchAll(/\[([^\]]*)\]/g)];
    if (head === '' || groups.map((g) => g[0]).join('') !== rest) return null;
    const parts = [head, ...groups.map((g) => g[1])];
    if (parts.some((p) => FORBIDDEN_KEYS.has(p))) return null;
    if (parts.length === 1 && Object.prototype.hasOwnProperty.call(root, name)) {
      if (!repeated.has(name)) {
        if (root[name] !== null && typeof root[name] === 'object') return null;
        root[name] = [root[name]];
        repeated.add(name);
      }
      root[name].push(value);
      continue;
    }
    if (!place(root, parts, value)) return null;
  }
  return root;
}

export function encodeForm(object, repeated = new Set()) {
  const out = new URLSearchParams();
  const walk = (value, name) => {
    if (Array.isArray(value)) {
      const simple = value.every((item) => item === null || typeof item !== 'object');
      if (simple && repeated.has(name)) { value.forEach((item) => walk(item, name)); return; }
      value.forEach((item, i) => walk(item, simple ? `${name}[]` : `${name}[${i}]`));
    } else if (value !== null && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) walk(item, name ? `${name}[${key}]` : key);
    } else if (value !== undefined) {
      out.append(name, value === null ? '' : String(value));
    }
  };
  walk(object, '');
  return out.toString();
}

// ---------- the runtime ----------

export function withMender(handler, options) {
  const {
    latest,
    adapters = [],
    versionHeader = 'Api-Version',
    version,
    defaultVersion,
    sunset,
    guide,
    identify = () => 'unknown',
    onCall = () => {},
  } = options;
  const newest = String(latest);
  const byFrom = new Map(adapters.map((adapter) => [String(adapter.from), adapter]));
  const supported = [...new Set([...byFrom.keys(), newest])];
  const released = Date.parse(`${newest}T00:00:00Z`);
  const sunsetDate = sunset ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(sunset) ? `${sunset}T00:00:00Z` : sunset) : null;

  // The adapters to run for a caller on `pinned`, oldest step first, or null for a version
  // nobody declared. Following from → to works for any naming: dates, v1/v2, numbers.
  function chainFrom(pinned) {
    const chain = [];
    const seen = new Set();
    let at = pinned;
    while (at !== newest) {
      const adapter = byFrom.get(at);
      if (!adapter || seen.has(at)) return null;
      seen.add(at);
      chain.push(adapter);
      at = String(adapter.to);
    }
    return chain;
  }

  function notice(headers, pinned) {
    headers.set(versionHeader, pinned);
    if (!Number.isNaN(released)) headers.set('Deprecation', `@${Math.floor(released / 1000)}`);
    if (sunsetDate && !Number.isNaN(sunsetDate.getTime())) headers.set('Sunset', sunsetDate.toUTCString());
    if (guide) headers.set('Link', `<${guide}>; rel="deprecation"; type="text/html"`);
    return headers;
  }

  function reply(status, body, pinned) {
    const headers = new Headers({ 'content-type': 'application/json' });
    return new Response(JSON.stringify(body), { status, headers: pinned ? notice(headers, pinned) : headers });
  }

  return async function menderHandler(request) {
    let said = null;
    try { said = version ? await version(request) : request.headers.get(versionHeader); } catch { said = null; }
    const pinned = String(said || defaultVersion || newest);
    if (pinned === newest) return handler(request);
    const chain = chainFrom(pinned);
    if (!chain) {
      return reply(400, { error: { type: 'unknown_version', message: `API version '${pinned}' is not supported. Supported versions: ${supported.join(', ')}.` } });
    }
    if (request.method === 'OPTIONS') return handler(request);

    const url = new URL(request.url);
    const original = { method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams) };
    let customer = 'unknown';
    try { customer = (await identify(request)) ?? 'unknown'; } catch { /* an unknown caller is still served */ }
    const report = (event) => {
      try { onCall({ customer, version: pinned, method: original.method, path: original.path, query: original.query, ...event }); } catch { /* reporting never breaks a request */ }
    };

    // Read the body once. Only JSON and form bodies are translated; anything else (files,
    // text, broken JSON) is forwarded byte for byte.
    let bytes = null;
    let kind = 'none';
    let parsed;
    const repeated = new Set();
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      bytes = await request.arrayBuffer();
      if (bytes.byteLength > 0) {
        kind = 'raw';
        const type = request.headers.get('content-type') || '';
        const text = JSON_TYPE.test(type) || FORM_TYPE.test(type) || type === '' || /^text\/plain\b/i.test(type) ? new TextDecoder().decode(bytes) : null;
        if (text !== null && (JSON_TYPE.test(type) || (!FORM_TYPE.test(type) && /^\s*[{[]/.test(text)))) {
          try { parsed = JSON.parse(text); kind = 'json'; } catch { /* not JSON after all */ }
        } else if (text !== null && FORM_TYPE.test(type)) {
          const form = parseForm(text, repeated);
          if (form) { parsed = form; kind = 'form'; }
        }
      }
    }

    const calls = [];
    let up = { ...original, body: parsed };
    try {
      for (const adapter of chain) {
        const gone = adapter.untranslatable?.find((u) => u.method === String(up.method).toUpperCase() && u.path.test(up.path));
        if (gone) {
          report({ outcome: 'untranslatable', reason: gone.reason });
          return reply(410, { error: { type: 'version_gone', message: gone.reason, doc_url: gone.guide } }, pinned);
        }
        calls.push({ method: up.method, path: up.path, query: up.query });
        if (adapter.upgradeRequest) up = adapter.upgradeRequest(structuredClone(up)) ?? up;
      }
    } catch (error) {
      report({ outcome: 'adapter_error', error: String(error?.message ?? error) });
      return reply(500, { error: { type: 'adapter_error', message: 'Mender could not translate this request, so it was not sent to the API.' } }, pinned);
    }

    const target = new URL(up.path, url);
    if (JSON.stringify(up.query ?? {}) === JSON.stringify(original.query)) {
      target.search = url.search;
    } else {
      for (const [key, value] of Object.entries(up.query ?? {})) target.searchParams.set(key, value);
    }
    const headers = new Headers(request.headers);
    headers.set(versionHeader, newest);
    headers.delete('content-length');
    const method = String(up.method).toUpperCase();
    let body;
    if (method !== 'GET' && method !== 'HEAD') {
      if (kind === 'json') body = JSON.stringify(up.body);
      else if (kind === 'form') body = encodeForm(up.body, repeated);
      else if (kind === 'raw') body = bytes;
    }
    const upstream = await handler(new Request(target, { method, headers, body }));

    const out = notice(new Headers(upstream.headers), pinned);
    const answerType = upstream.headers.get('content-type') || '';
    if (NO_BODY.has(upstream.status) || request.method === 'HEAD' || !JSON_TYPE.test(answerType)) {
      report({ outcome: 'translated', status: upstream.status });
      return new Response(NO_BODY.has(upstream.status) ? null : upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
    }

    const text = await upstream.text();
    out.delete('content-length');
    out.delete('content-encoding');
    let payload;
    try { payload = JSON.parse(text); } catch {
      report({ outcome: 'translated', status: upstream.status });
      return new Response(text, { status: upstream.status, statusText: upstream.statusText, headers: out });
    }
    let down = { status: upstream.status, body: payload };
    try {
      for (let i = chain.length - 1; i >= 0; i--) {
        if (chain[i].downgradeResponse) down = chain[i].downgradeResponse(structuredClone(down), calls[i]) ?? down;
      }
    } catch (error) {
      // The API already did its work, so failing the call now could make the caller repeat it.
      // Hand back the untranslated answer and say so.
      report({ outcome: 'adapter_error', status: upstream.status, error: String(error?.message ?? error) });
      out.set('Mender-Warning', 'response-not-translated');
      return new Response(text, { status: upstream.status, statusText: upstream.statusText, headers: out });
    }
    report({ outcome: 'translated', status: down.status });
    return new Response(JSON.stringify(down.body), { status: down.status, statusText: upstream.statusText, headers: out });
  };
}
