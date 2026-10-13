// Tests for watching API descriptions (lib/mender/watch.js), with an in-memory store that has
// the Workers KV methods and a pretend API host that can change its description.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkWatch, createWatch, deleteWatch, publicView, readSnapshot, readWatch, runDue } from '../lib/mender/watch.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function memoryKv() {
  const values = new Map();
  const metadata = new Map();
  return {
    values,
    async get(key, type) {
      if (!values.has(key)) return null;
      const value = values.get(key);
      const text = typeof value === 'string' ? value : new TextDecoder().decode(value);
      return type === 'json' ? JSON.parse(text) : text;
    },
    async put(key, value, options = {}) {
      values.set(key, value);
      if (options.metadata) metadata.set(key, options.metadata);
    },
    async delete(key) { values.delete(key); metadata.delete(key); },
    async list({ prefix = '' } = {}) {
      const keys = [...values.keys()].filter((key) => key.startsWith(prefix)).sort().map((name) => ({ name, metadata: metadata.get(name) }));
      return { keys, list_complete: true };
    },
  };
}

// A host serving one API description, with an ETag, that answers 304 when nothing changed.
function apiHost({ etags = true } = {}) {
  const host = {
    version: 1,
    field: 'customerId',
    status: 200,
    requests: [],
    posts: [],
    description() {
      return JSON.stringify({ openapi: '3.0.3', info: { title: 'Quote API', version: `${host.version}.0.0` }, paths: { '/quotes': { post: { requestBody: { content: { 'application/json': { schema: { type: 'object', required: [host.field], properties: { [host.field]: { type: 'string' } } } } } }, responses: { 200: { description: 'ok' } } } } } });
    },
    async fetch(url, init = {}) {
      if (init.method === 'POST') { host.posts.push({ url: String(url), body: JSON.parse(init.body) }); return new Response('ok'); }
      host.requests.push({ url: String(url), headers: init.headers ?? {} });
      if (host.status !== 200) return new Response('down', { status: host.status });
      const etag = `"v${host.version}"`;
      if (etags && init.headers?.['if-none-match'] === etag) return new Response(null, { status: 304 });
      return new Response(host.description(), { headers: etags ? { etag } : {} });
    },
  };
  return host;
}

const URL_ = 'https://api.example.com/openapi.json';

test('starting a watch keeps a first copy and labels it, and the public view hides the webhook', async () => {
  const kv = memoryKv();
  const host = apiHost();
  const watch = await createWatch(kv, { url: URL_, webhook: 'https://hooks.slack.com/services/T0/B0/secret' }, { now: 0, fetcher: host.fetch });
  assert.match(watch.id, /^[A-Za-z0-9_-]{22}$/);
  assert.deepEqual(watch.versions.map((v) => [v.n, v.title, v.version]), [[0, 'Quote API', '1.0.0']]);
  assert.equal(JSON.parse(await readSnapshot(kv, watch.id, 0)).info.version, '1.0.0');
  const view = publicView(watch);
  assert.equal(view.notifies, 'hooks.slack.com');
  assert.equal(JSON.stringify(view).includes('secret'), false);
});

test('only public https addresses of real API descriptions can be watched', async () => {
  const kv = memoryKv();
  const host = apiHost();
  for (const url of ['http://api.example.com/openapi.json', 'https://localhost/openapi.json', 'https://10.0.0.1/openapi.json', 'not a url']) {
    await assert.rejects(createWatch(kv, { url }, { fetcher: host.fetch }));
  }
  await assert.rejects(createWatch(kv, { url: URL_, webhook: 'http://hooks.example.com/x' }, { fetcher: host.fetch }), /webhook must start with https/);
  const page = async () => new Response('<html>hello</html>');
  await assert.rejects(createWatch(kv, { url: 'https://example.com/' }, { fetcher: page }), /does not serve an OpenAPI or Swagger description/);
  assert.equal(kv.values.size, 0);
});

test('an unchanged description adds nothing, whether the host says so (304) or the bytes match', async () => {
  for (const etags of [true, false]) {
    const kv = memoryKv();
    const host = apiHost({ etags });
    const watch = await createWatch(kv, { url: URL_ }, { now: 0, fetcher: host.fetch });
    const result = await checkWatch(kv, watch.id, { now: DAY, fetcher: host.fetch });
    assert.equal(result.changed, false);
    assert.equal(result.watch.versions.length, 1);
    assert.equal(result.watch.lastCheckedAt, DAY);
    if (etags) assert.equal(host.requests.at(-1).headers['if-none-match'], '"v1"');
  }
});

test('a changed description is kept as a new version and the webhook gets a link to it', async () => {
  const kv = memoryKv();
  const host = apiHost();
  const watch = await createWatch(kv, { url: URL_, webhook: 'https://discord.com/api/webhooks/1/abc' }, { now: 0, fetcher: host.fetch });
  host.version = 2;
  host.field = 'accountId';
  const result = await checkWatch(kv, watch.id, { now: DAY, fetcher: host.fetch, origin: 'https://apimender.com' });
  assert.equal(result.changed, true);
  assert.deepEqual(result.watch.versions.map((v) => [v.n, v.version]), [[0, '1.0.0'], [1, '2.0.0']]);
  assert.match(await readSnapshot(kv, watch.id, 1), /accountId/);
  assert.match(await readSnapshot(kv, watch.id, 0), /customerId/);
  assert.equal(host.posts.length, 1);
  assert.equal(host.posts[0].url, 'https://discord.com/api/webhooks/1/abc');
  assert.equal(host.posts[0].body.text, `API Mender: Quote API changed (1.0.0 → 2.0.0). See what it means for your code: https://apimender.com/watch/${watch.id}`);
  assert.equal(host.posts[0].body.content, host.posts[0].body.text);
});

test('a failing host is recorded without losing what was kept', async () => {
  const kv = memoryKv();
  const host = apiHost();
  const watch = await createWatch(kv, { url: URL_ }, { now: 0, fetcher: host.fetch });
  host.status = 503;
  const result = await checkWatch(kv, watch.id, { now: DAY, fetcher: host.fetch });
  assert.equal(result.watch.status, 'error');
  assert.match(result.watch.error, /answered 503/);
  assert.equal((await readWatch(kv, watch.id)).versions.length, 1);
  host.status = 200;
  assert.equal((await checkWatch(kv, watch.id, { now: 2 * DAY, fetcher: host.fetch })).watch.status, 'ok');
});

test('at most 20 versions are kept; the oldest copies are removed', async () => {
  const kv = memoryKv();
  const host = apiHost();
  const watch = await createWatch(kv, { url: URL_ }, { now: 0, fetcher: host.fetch });
  for (let i = 2; i <= 25; i++) {
    host.version = i;
    await checkWatch(kv, watch.id, { now: i * DAY, fetcher: host.fetch });
  }
  const kept = (await readWatch(kv, watch.id)).versions;
  assert.equal(kept.length, 20);
  assert.equal(kept[0].n, 5);
  assert.equal(await readSnapshot(kv, watch.id, 4), null);
  assert.ok(await readSnapshot(kv, watch.id, 5));
});

test('the hourly run checks only watches not checked for a day, oldest first, a few at a time', async () => {
  const kv = memoryKv();
  const host = apiHost();
  const fresh = await createWatch(kv, { url: URL_ }, { now: 47 * HOUR, fetcher: host.fetch });
  const older = await createWatch(kv, { url: URL_ }, { now: 0, fetcher: host.fetch });
  const old = await createWatch(kv, { url: URL_ }, { now: 10 * HOUR, fetcher: host.fetch });
  host.version = 2;
  const run = await runDue(kv, { now: 48 * HOUR, fetcher: host.fetch, limit: 1 });
  assert.deepEqual(run, { due: 2, checked: 1, changed: [older.id] });
  const next = await runDue(kv, { now: 48 * HOUR, fetcher: host.fetch, limit: 5 });
  assert.deepEqual(next, { due: 1, checked: 1, changed: [old.id] });
  assert.equal((await readWatch(kv, fresh.id)).versions.length, 1);
});

test('links that are not a watch read as missing, without touching storage', async () => {
  const kv = memoryKv();
  assert.equal(await readWatch(kv, '../../etc'), null);
  assert.equal(await readSnapshot(kv, 'abcdefghijklmnopqrstuv', 'x'), null);
  assert.equal(await checkWatch(kv, 'abcdefghijklmnopqrstuv'), null);
});

test('stopping a watch removes it and every kept copy; a refused watch stores nothing', async () => {
  const kv = memoryKv();
  const host = apiHost();
  const watch = await createWatch(kv, { url: URL_ }, { fetcher: host.fetch });
  host.version = 2;
  await checkWatch(kv, watch.id, { now: Date.now() + DAY, fetcher: host.fetch });
  assert.equal(kv.values.size, 3);
  assert.equal(await deleteWatch(kv, watch.id), true);
  assert.equal(kv.values.size, 0);
  assert.equal(await deleteWatch(kv, watch.id), false);
  assert.equal(await deleteWatch(kv, '../../etc'), false);
  await assert.rejects(createWatch(kv, { url: URL_ }, { fetcher: host.fetch, beforeStoring: async () => { throw new Error('over the limit'); } }), /over the limit/);
  assert.equal(kv.values.size, 0);
});
