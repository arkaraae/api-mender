// Watching an API description for changes: the free side of API Mender.
//
// Someone gives the address of an API description they depend on. Mender keeps a copy, checks
// the address again every day, and when the description changes it keeps the new copy, notes
// the change, and (if asked) posts to a Slack or Discord webhook. The comparison itself runs in
// the visitor's browser on /check, so the server only downloads and stores.
//
// Storage is anything with the Workers KV methods: get(key, 'json'|'text'), put(key, value,
// { metadata }), delete(key), list({ prefix, cursor }). The tests pass an in-memory one.

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_VERSIONS = 20;
const DAY = 24 * 60 * 60 * 1000;
export const CHECK_AGAIN_AFTER = 60 * 1000;

// Only public https addresses: not this site, not local or private names.
export function publicHttps(raw, what) {
  let url;
  try { url = new URL(String(raw ?? '').trim()); } catch { throw new Error(`Enter the full address of the ${what}, starting with https://`); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:') throw new Error(`The ${what} must start with https://`);
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || /^[\d.]+$/.test(host) || host.includes(':')) {
    throw new Error(`The ${what} must be on a public website.`);
  }
  return url;
}

export function newId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

const validId = (id) => /^[A-Za-z0-9_-]{16,32}$/.test(String(id ?? ''));

async function sha256(buffer) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// Title and version from the start of the file, without parsing all of it.
function labelOf(text) {
  const title = text.match(/"title"\s*:\s*"([^"\n]{1,120})"/)?.[1] ?? text.match(/^\s{0,4}title:\s*['"]?([^'"\n]{1,120})/m)?.[1];
  const version = text.match(/"version"\s*:\s*"([^"\n]{1,40})"/)?.[1] ?? text.match(/^\s{0,4}version:\s*['"]?([^'"\n]{1,40})/m)?.[1];
  return { title: title?.trim() ?? null, version: version?.trim() ?? null };
}

// Downloads the description. Returns { unchanged: true } when the server says it has not
// changed since last time (ETag or Last-Modified), so nothing large is read for no reason.
async function download(url, previous, fetcher) {
  const headers = { accept: 'application/json, application/yaml, text/yaml, text/plain;q=0.9, */*;q=0.5' };
  if (previous?.etag) headers['if-none-match'] = previous.etag;
  if (previous?.lastModified) headers['if-modified-since'] = previous.lastModified;
  let response;
  try {
    response = await fetcher(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new Error(`Could not reach ${new URL(url).hostname}.`);
  }
  if (response.status === 304) return { unchanged: true };
  if (!response.ok) throw new Error(`${new URL(url).hostname} answered ${response.status}.`);
  if (Number(response.headers.get('content-length') || 0) > MAX_BYTES) throw new Error('The description is larger than 20 MB.');
  const body = await response.arrayBuffer();
  if (body.byteLength > MAX_BYTES) throw new Error('The description is larger than 20 MB.');
  const start = new TextDecoder().decode(body.slice(0, 8192));
  if (!/\b(openapi|swagger)\b/i.test(start)) throw new Error('That address does not serve an OpenAPI or Swagger description.');
  return { body, start, etag: response.headers.get('etag'), lastModified: response.headers.get('last-modified'), hash: await sha256(body), size: body.byteLength };
}

const save = (kv, watch) => kv.put(`watch:${watch.id}`, JSON.stringify(watch), { metadata: { lastCheckedAt: watch.lastCheckedAt } });

// What a visitor with the link may see: everything but the webhook address itself.
export function publicView(watch) {
  const { webhook, hash, etag, lastModified, ...rest } = watch;
  return { ...rest, notifies: webhook ? new URL(webhook).hostname : null };
}

// createWatch(kv, { url, webhook }) → the new watch, with its first copy stored.
export async function createWatch(kv, input, { now = Date.now(), fetcher = fetch } = {}) {
  const url = publicHttps(input?.url, 'API description');
  const webhook = input?.webhook ? publicHttps(input.webhook, 'webhook') : null;
  const got = await download(url.href, null, fetcher);
  const id = newId();
  const watch = {
    id,
    url: url.href,
    webhook: webhook?.href ?? null,
    createdAt: new Date(now).toISOString(),
    lastCheckedAt: now,
    lastChangedAt: null,
    status: 'ok',
    error: null,
    etag: got.etag,
    lastModified: got.lastModified,
    hash: got.hash,
    versions: [{ n: 0, at: new Date(now).toISOString(), size: got.size, ...labelOf(got.start) }],
  };
  await kv.put(`snap:${id}:0`, got.body);
  await save(kv, watch);
  return watch;
}

export async function readWatch(kv, id) {
  return validId(id) ? kv.get(`watch:${id}`, 'json') : null;
}

export async function readSnapshot(kv, id, n) {
  return validId(id) && /^\d{1,4}$/.test(String(n)) ? kv.get(`snap:${id}:${n}`, 'text') : null;
}

async function notify(watch, origin, fetcher) {
  const [before, after] = watch.versions.slice(-2);
  const name = after.title ?? new URL(watch.url).hostname;
  const versions = before.version && after.version && before.version !== after.version ? ` (${before.version} → ${after.version})` : '';
  const text = `API Mender: ${name} changed${versions}. See what it means for your code: ${origin}/watch/${watch.id}`;
  // Slack reads "text", Discord reads "content"; each ignores the other.
  await fetcher(watch.webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, content: text }), signal: AbortSignal.timeout(10_000) });
}

// checkWatch(kv, id) → { watch, changed } or null when there is no such watch.
export async function checkWatch(kv, id, { now = Date.now(), fetcher = fetch, origin = 'https://apimender.com' } = {}) {
  const watch = await readWatch(kv, id);
  if (!watch) return null;
  watch.lastCheckedAt = now;
  try {
    const got = await download(watch.url, watch, fetcher);
    watch.status = 'ok';
    watch.error = null;
    if (got.unchanged || got.hash === watch.hash) {
      if (!got.unchanged) Object.assign(watch, { etag: got.etag, lastModified: got.lastModified });
      await save(kv, watch);
      return { watch, changed: false };
    }
    const n = watch.versions.at(-1).n + 1;
    await kv.put(`snap:${id}:${n}`, got.body);
    watch.versions.push({ n, at: new Date(now).toISOString(), size: got.size, ...labelOf(got.start) });
    while (watch.versions.length > MAX_VERSIONS) await kv.delete(`snap:${id}:${watch.versions.shift().n}`);
    Object.assign(watch, { hash: got.hash, etag: got.etag, lastModified: got.lastModified, lastChangedAt: new Date(now).toISOString() });
    await save(kv, watch);
    if (watch.webhook) await notify(watch, origin, fetcher).catch(() => {});
    return { watch, changed: true };
  } catch (error) {
    watch.status = 'error';
    watch.error = error instanceof Error ? error.message : String(error);
    await save(kv, watch);
    return { watch, changed: false };
  }
}

// Checks the watches not checked for a day, oldest first, at most `limit` per run (a Worker may
// only make so many requests at once). Run it every hour and each watch is checked about daily.
export async function runDue(kv, { now = Date.now(), fetcher = fetch, origin = 'https://apimender.com', limit = 20 } = {}) {
  const due = [];
  let cursor;
  do {
    const page = await kv.list({ prefix: 'watch:', cursor });
    for (const key of page.keys) {
      const last = key.metadata?.lastCheckedAt ?? 0;
      if (now - last >= DAY) due.push({ id: key.name.slice('watch:'.length), last });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  due.sort((a, b) => a.last - b.last);
  const results = [];
  for (const { id } of due.slice(0, limit)) results.push(await checkWatch(kv, id, { now, fetcher, origin }));
  return { due: due.length, checked: results.length, changed: results.filter((r) => r?.changed).map((r) => r.watch.id) };
}
