// Tests for Mender inside the web app: the engine copy, the gateway, and the /check report.
// Run with `npm test` from web/. The gateway is exercised against a local copy of the managed
// Quote API (mender/tests/managed.fixture.js) that already publishes a version 2.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { makeManaged } from '../../mender/tests/managed.fixture.js';
import { check, describe, forget, handle, oldVersionCalls, registerApi, serveInProcess } from '../lib/mender/gateway.js';
import { rulesFromOpenApi, proveWithSchemas } from '../lib/mender/openapi.js';
import { pathsOf, summarize, touches } from '../lib/mender/report.js';

const ORIGIN = 'https://site.test';
const api = makeManaged(['customerId', 'accountId']);

registerApi('managed', {
  title: 'Managed Quote API',
  endpoint: '/api/managed/quotes',
  owns: (path) => path.startsWith('/api/managed/'),
  async contracts(origin, read) {
    const latest = await read(`${origin}/api/managed/openapi.json`);
    const newest = Number.parseInt(latest.info.version, 10);
    const older = await Promise.all(Array.from({ length: newest - 1 }, (_, i) => read(`${origin}/api/managed/openapi.json?version=${i + 1}`)));
    return [...older.map((spec, i) => ({ version: String(i + 1), spec })), { version: String(newest), spec: latest }];
  },
  probe: { method: 'POST', path: '/api/managed/quotes', body: { customerId: 'customer_1', sku: 'WIDGET-1' } },
});
serveInProcess({ '/api/managed/openapi.json': api, '/api/managed/quotes': api });

const call = (version, path, body, headers = {}) => handle(
  new Request(`${ORIGIN}/mender/${version}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }),
  version,
  path.split('/').filter(Boolean),
);

test('the engine copy in web/lib/mender matches mender/src', () => {
  const result = spawnSync(process.execPath, [resolve(import.meta.dirname, '../../mender/tools/sync-web.mjs'), '--check'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('every Mender engine suite passes', () => {
  const result = spawnSync(process.execPath, [resolve(import.meta.dirname, '../../mender/tests/run.mjs')], { encoding: 'utf8', timeout: 120_000 });
  assert.equal(result.status, 0, result.stdout.split('\n').filter((line) => line.includes('FAIL')).join('\n') || result.stderr);
});

test('the gateway reads the published contracts and proves the rule between them', async () => {
  forget();
  const described = await describe('managed', ORIGIN);
  assert.deepEqual(described.versions, ['1', '2']);
  assert.equal(described.proven, true);
  assert.deepEqual(described.steps[0].inWords, ['customerId is now accountId (in requests)']);
});

test('an old-style request fails directly and works through the gateway', async () => {
  const direct = await api(new Request(`${ORIGIN}/api/managed/quotes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ customerId: 'customer_1', sku: 'WIDGET-1' }) }));
  assert.equal(direct.status, 422);
  const through = await call('v1', '/api/managed/quotes', { customerId: 'customer_1', sku: 'WIDGET-1' }, { 'x-consumer': 'checkout-service' });
  assert.equal(through.status, 200);
  assert.equal(through.headers.get('mender-status'), 'translated');
  assert.equal((await through.json()).contractVersion, 2);
  assert.ok(oldVersionCalls().some((row) => row.caller === 'checkout-service' && row.version === '1'));
});

test('callers on the newest version, unknown versions and other paths are handled honestly', async () => {
  assert.equal((await call('v2', '/api/managed/quotes', { accountId: 'account_1', sku: 'WIDGET-1' })).headers.get('mender-status'), 'current-version');
  const future = await call('v9', '/api/managed/quotes', { customerId: 'customer_1', sku: 'WIDGET-1' });
  assert.equal(future.status, 400);
  assert.equal(future.headers.get('mender-status'), 'unknown-version');
  assert.equal((await call('latest', '/api/managed/quotes', {})).status, 400);
  assert.equal((await call('v1', '/api/live/scan', {})).status, 404);
  const missing = await call('v1', '/api/managed/quotes', { customerId: 'customer_1', sku: 'NOPE-9' });
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: 'Product not found' });
});

test('the status check sends one real request both ways', async () => {
  const result = await check('managed', ORIGIN);
  assert.equal(result.direct.status, 422);
  assert.equal(result.throughMender.status, 200);
  assert.equal(result.keptWorking, true);
});

test('when the API cannot be reached the caller gets a clear 502', async () => {
  serveInProcess({ '/api/managed/quotes': () => { throw new Error('connection refused'); } });
  try {
    const response = await call('v1', '/api/managed/quotes', { customerId: 'customer_1', sku: 'WIDGET-1' });
    assert.equal(response.status, 502);
    assert.equal(response.headers.get('mender-status'), 'api-unreachable');
  } finally {
    serveInProcess({ '/api/managed/quotes': api });
  }
});

// ---------- the /check report ----------

const json = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required });
const spec = (request, response) => ({
  openapi: '3.0.3', info: { title: 't', version: '1' },
  paths: { '/v1/orders/{id}': { post: { requestBody: { content: { 'application/json': { schema: request } } }, responses: { 200: { description: 'ok', content: { 'application/json': { schema: response } } } } } } },
});
const report = (before, after) => {
  const found = rulesFromOpenApi(before, after);
  return summarize({ found, proof: proveWithSchemas(before, after, found.rules) });
};
const str = { type: 'string' };

test('the report says "safe" when nothing old callers use changed', () => {
  const same = spec(json({ customerId: str }), json({ id: str }));
  const result = report(same, structuredClone(same));
  assert.equal(result.verdict, 'safe');
  assert.equal(result.items.length, 0);
});

test('the report says "bridged" for a rename Mender can translate', () => {
  const result = report(spec(json({ customerId: str }), json({ id: str })), spec(json({ accountId: str }), json({ id: str })));
  assert.equal(result.verdict, 'bridged');
  assert.deepEqual(result.items.map((item) => [item.kind, item.title]), [['bridged', 'customerId is now accountId']]);
});

test('the report says "breaks" when old callers lose data, and groups fields of one object', () => {
  const user = json({ login: str, email: str, name: str, url: str });
  const result = report(spec(json({ a: str }), json({ id: str, user })), spec(json({ a: str }), json({ id: str })));
  assert.equal(result.verdict, 'breaks');
  assert.deepEqual(result.items.map((item) => [item.kind, item.title]), [['lost', 'user: 4 fields are no longer returned']]);
});

test('a request field the new version ignores counts as lost, not bridged', () => {
  const result = report(spec(json({ customerId: str, note: str }, ['customerId']), json({ id: str })), spec(json({ customerId: str }), json({ id: str })));
  assert.equal(result.verdict, 'breaks');
  assert.equal(result.items[0].title, "note is no longer accepted; old callers' value is ignored");
});

test('touches finds the changed fields a caller\'s code uses, without matching common words alone', () => {
  const rules = [
    { op: 'remove', old: 'hub_url', in: 'response' },
    { op: 'remove', old: 'user.login', in: 'response' },
    { op: 'remove', old: 'owner.url', in: 'response' },
    { op: 'endpoint_removed', method: 'GET', path: '/v1/legacy/{id}' },
  ];
  const code = 'console.log(root.hub_url, gist.user.login, url); await get(`/v1/legacy/${id}`);';
  assert.deepEqual(touches(code, rules).map((hit) => hit.name), ['hub_url', 'user.login', '/v1/legacy']);
});

test('pathsOf gives the fixed part of each address', () => {
  assert.deepEqual(pathsOf({ paths: { '/': {}, '/v1/orders/{id}': {}, '/v1/orders': {}, '/v2/items/{item}/parts': {} } }), ['/v1/orders', '/v2/items']);
});
