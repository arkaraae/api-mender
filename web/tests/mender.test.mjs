// Tests for Mender inside the web app: the engine copy, the gateway, and the /check report.
// Run with `npm test` from web/. The gateway is exercised against a local copy of the managed
// Quote API (mender/tests/managed.fixture.js) that already publishes a version 2.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { makeManaged } from '../../mender/tests/managed.fixture.js';
import { callerName, callers, callsSaved, check, describe, forget, handle, oldVersionCalls, registerApi, serveInProcess, setCallLog } from '../lib/mender/gateway.js';
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

test('with a call log, every old-version call is saved, and saving never holds up or breaks the call', async () => {
  const saved = [];
  const deferred = [];
  setCallLog({ record: async (entry) => { saved.push(entry); }, list: async () => saved, defer: (promise) => deferred.push(promise) });
  try {
    assert.equal(callsSaved(), true);
    const response = await call('v1', '/api/managed/quotes', { customerId: 'customer_1', sku: 'WIDGET-1' }, { 'x-consumer': 'billing-service' });
    assert.equal(response.status, 200);
    await Promise.all(deferred);
    assert.deepEqual(saved.map((entry) => [entry.api, entry.caller, entry.version, entry.endpoint, entry.outcome, entry.calls]), [['managed', 'billing-service', '1', 'POST /api/managed/quotes', 'translated', 1]]);
    assert.deepEqual(await callers(), saved);
    setCallLog({ record: async () => { throw new Error('database is down'); }, list: async () => { throw new Error('database is down'); } });
    assert.equal((await call('v1', '/api/managed/quotes', { customerId: 'customer_1', sku: 'WIDGET-1' })).status, 200);
    assert.ok((await callers()).length > 0, 'falls back to this instance\'s counts');
  } finally {
    setCallLog(null);
  }
});

test('caller names shown on the public page are short plain names, or "unnamed"', () => {
  assert.equal(callerName(null), 'anonymous');
  assert.equal(callerName('billing-service'), 'billing-service');
  assert.equal(callerName('team@example.com'), 'team@example.com');
  for (const odd of ['<script>alert(1)</script>', 'two words', 'x'.repeat(49), '-starts-with-dash', 'émoji😀']) assert.equal(callerName(odd), 'unnamed');
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

test('a contract that cannot be read right now falls back to the last proven reading, for up to an hour', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  let failing = false;
  registerApi('flaky', {
    title: 'Flaky contract',
    endpoint: '/api/flaky/quotes',
    owns: (path) => path.startsWith('/api/flaky/'),
    async contracts() {
      if (failing) throw new Error('GitHub did not answer');
      return [{ version: '1', spec: { openapi: '3.0.3', paths: {} } }, { version: '2', spec: { openapi: '3.0.3', paths: {} } }];
    },
    probe: { method: 'POST', path: '/api/flaky/quotes', body: {} },
  });
  forget();
  assert.deepEqual((await describe('flaky', ORIGIN)).versions, ['1', '2']);
  failing = true;
  t.mock.timers.tick(5 * 60_000);
  assert.deepEqual((await describe('flaky', ORIGIN)).versions, ['1', '2']);
  t.mock.timers.tick(2 * 60 * 60_000);
  await assert.rejects(describe('flaky', ORIGIN), /GitHub did not answer/);
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
  assert.deepEqual(result.items.map((item) => [item.kind, item.severity, item.rule, item.title]), [['bridged', 'warning', 'request-property-renamed', 'customerId is now accountId']]);
  assert.deepEqual([result.counts.error, result.counts.warning], [0, 1]);
});

test('the report says "breaks" when old callers lose data, and groups fields of one object', () => {
  const user = json({ login: str, email: str, name: str, url: str });
  const result = report(spec(json({ a: str }), json({ id: str, user })), spec(json({ a: str }), json({ id: str })));
  assert.equal(result.verdict, 'breaks');
  assert.deepEqual(result.items.map((item) => [item.kind, item.severity, item.rule, item.title]), [['lost', 'error', 'response-property-removed', 'user: 4 fields are no longer returned']]);
  assert.equal(result.counts.error, 1);
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
