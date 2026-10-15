import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { check, describe, explain, forget, handle, oldVersionCalls, serveInProcess } from '../lib/mender-gateway.js';
import { makeManaged } from '../mender/tests/managed.fixture.js';

// A real HTTP server that answers like the deployed managed Quote API, with a version 2 that
// takes accountId. The gateway is pointed at it through MENDER_UPSTREAM_URL.
let server: Server;
let upstream = '';

before(async () => {
  const api = makeManaged(['customerId', 'accountId']);
  server = createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(chunk as Buffer);
    const bodyless = incoming.method === 'GET' || incoming.method === 'HEAD';
    const response = await api(new Request(`${upstream}${incoming.url}`, { method: incoming.method, headers: incoming.headers as Record<string, string>, body: bodyless ? undefined : Buffer.concat(chunks) }));
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  upstream = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  process.env.MENDER_UPSTREAM_URL = upstream;
  forget();
});

after(() => { server.close(); delete process.env.MENDER_UPSTREAM_URL; });

const call = (version: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  handle(new Request(`http://site.test/mender/${version}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }), version, path.split('/').filter(Boolean));

test('the gateway reads the published contracts and proves the rule between them', async () => {
  const api = await describe('managed', upstream);
  assert.deepEqual(api.versions, ['1', '2']);
  assert.equal(api.proven, true);
  assert.deepEqual(api.steps[0].rules, [{ op: 'rename', old: 'customerId', new: 'accountId', in: 'request' }]);
  assert.deepEqual(api.steps[0].inWords, ['customerId is now accountId (in requests)']);
});

test('an old-style request fails directly and works through the gateway', async () => {
  const direct = await fetch(`${upstream}/api/managed/quotes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ customerId: 'customer_1', sku: 'WIDGET-1' }) });
  assert.equal(direct.status, 422);
  const through = await call('v1', '/api/managed/quotes', { customerId: 'customer_1', sku: 'WIDGET-1' }, { 'x-consumer': 'checkout-service' });
  assert.equal(through.status, 200);
  assert.equal(through.headers.get('mender-status'), 'translated');
  const quote = await through.json();
  assert.equal(quote.sku, 'WIDGET-1');
  assert.equal(quote.contractVersion, 2);
});

test('a caller already on the newest version is passed straight through', async () => {
  const response = await call('v2', '/api/managed/quotes', { accountId: 'account_1', sku: 'WIDGET-1' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('mender-status'), 'current-version');
});

test('the API\'s own errors and unknown versions are reported honestly', async () => {
  const unknownProduct = await call('v1', '/api/managed/quotes', { customerId: 'customer_1', sku: 'NOPE-9' });
  assert.equal(unknownProduct.status, 404);
  assert.deepEqual(await unknownProduct.json(), { error: 'Product not found' });
  const future = await call('v9', '/api/managed/quotes', { customerId: 'customer_1', sku: 'WIDGET-1' });
  assert.equal(future.status, 400);
  assert.equal(future.headers.get('mender-status'), 'unknown-version');
  assert.equal((await future.json()).error.type, 'unknown_version');
  const badVersion = await call('latest', '/api/managed/quotes', {});
  assert.equal(badVersion.status, 400);
});

test('the gateway only fronts the site\'s published APIs', async () => {
  for (const path of ['/api/live/scan', '/mender/v1/api/managed/quotes', '/admin']) {
    const response = await call('v1', path, {});
    assert.equal(response.status, 404, path);
  }
});

test('old-version calls are counted per caller, and the status check sends a real request', async () => {
  const counted = oldVersionCalls().find((row) => row.caller === 'checkout-service');
  assert.ok(counted && counted.version === '1' && counted.outcome === 'translated' && counted.calls >= 1);
  const result = await check('managed', upstream, 'http://site.test');
  assert.equal(result.direct.status, 422);
  assert.equal(result.throughMender.status, 200);
  assert.equal(result.keptWorking, true);
  assert.ok(oldVersionCalls().some((row) => row.caller === 'mender-status-check'));
});

test('a site can hand over its own handlers, and then nothing is sent over HTTP', async () => {
  const api = makeManaged(['customerId', 'accountId']);
  forget();
  process.env.MENDER_UPSTREAM_URL = 'http://127.0.0.1:9'; // nothing listens here
  serveInProcess({ '/api/managed/quotes': api, '/api/managed/openapi.json': api });
  try {
    const through = await call('v1', '/api/managed/quotes', { customerId: 'customer_1', sku: 'WIDGET-1' });
    assert.equal(through.status, 200);
    assert.equal(through.headers.get('mender-status'), 'translated');
    assert.equal((await through.json()).contractVersion, 2);
    const result = await check('managed', 'http://127.0.0.1:9', 'http://site.test');
    assert.equal(result.direct.status, 422);
    assert.equal(result.throughMender.status, 200);
  } finally {
    serveInProcess({ '/api/managed/quotes': null, '/api/managed/openapi.json': null });
    process.env.MENDER_UPSTREAM_URL = upstream;
    forget();
  }
});

test('rules that fail the proof are never used: the call goes through untouched', async () => {
  // Version 2 also demands a region. Nothing an old request carries can fill it, so no rule can be proven.
  const contract = (version: number, required: string[]) => ({
    openapi: '3.0.3', info: { title: 'Quotes', version: String(version) },
    paths: { '/api/managed/quotes': { post: { requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required, properties: Object.fromEntries(required.map((field) => [field, { type: 'string' }])) } } } }, responses: { 200: { description: 'ok' } } } } },
  });
  let received: unknown = null;
  forget();
  serveInProcess({
    '/api/managed/openapi.json': (request: Request) => Response.json(new URL(request.url).searchParams.get('version') === '1' ? contract(1, ['customerId', 'sku']) : contract(2, ['customerId', 'sku', 'region'])),
    '/api/managed/quotes': async (request: Request) => { received = await request.json(); return Response.json({ error: 'region is required' }, { status: 422, headers: { 'content-encoding': 'identity' } }); },
  });
  try {
    const api = await describe('managed', upstream);
    assert.equal(api.proven, false);
    assert.match(api.steps[0].proof.failures.join(' '), /region is required and missing/);
    const response = await call('v1', '/api/managed/quotes', { customerId: 'customer_1', sku: 'WIDGET-1' });
    assert.equal(response.status, 422);
    assert.equal(response.headers.get('mender-status'), 'no-proven-adapter');
    assert.equal(response.headers.get('content-encoding'), null);
    assert.deepEqual(await response.json(), { error: 'region is required' });
    assert.deepEqual(received, { customerId: 'customer_1', sku: 'WIDGET-1' });
  } finally {
    serveInProcess({ '/api/managed/openapi.json': null, '/api/managed/quotes': null });
    forget();
  }
});

test('when the API cannot be reached the caller gets a clear 502, not a crash', async () => {
  await describe('managed', upstream); // the contracts are read and remembered
  serveInProcess({ '/api/managed/quotes': () => { throw new Error('connection refused'); } });
  try {
    const response = await call('v1', '/api/managed/quotes', { customerId: 'customer_1', sku: 'WIDGET-1' });
    assert.equal(response.status, 502);
    assert.equal(response.headers.get('mender-status'), 'api-unreachable');
    assert.equal((await response.json()).error.type, 'api_unreachable');
  } finally { serveInProcess({ '/api/managed/quotes': null }); }
});

test('when the contract cannot be read the gateway says so instead of guessing', async () => {
  forget();
  process.env.MENDER_UPSTREAM_URL = 'http://127.0.0.1:9';
  try {
    const response = await call('v1', '/api/managed/quotes', { customerId: 'customer_1', sku: 'WIDGET-1' });
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.type, 'contract_unavailable');
  } finally { process.env.MENDER_UPSTREAM_URL = upstream; forget(); }
});

test('rules can be requested for two contracts or for example records', () => {
  const quotes = (field: string) => ({ openapi: '3.0.3', paths: { '/q': { post: { requestBody: { content: { 'application/json': { schema: { type: 'object', required: [field], properties: { [field]: { type: 'string' } } } } } }, responses: { 200: { description: 'ok' } } } } } });
  const fromSpecs = explain({ oldSpec: quotes('customerId'), newSpec: quotes('accountId') });
  assert.deepEqual(fromSpecs?.inWords, ['customerId is now accountId (in requests)']);
  assert.equal(fromSpecs?.proof?.ok, true);
  const fromRecords = explain({ pairs: [{ old: { amount: 12.5 }, new: { amount_cents: 1250 } }] });
  assert.deepEqual(fromRecords?.rules, [{ op: 'scale', factor: 100, old: 'amount', new: 'amount_cents' }]);
  assert.equal(explain({ nothing: true }), null);
});

test('the Studio served from public/studio matches the mender folder', () => {
  const result = spawnSync(process.execPath, [resolve(import.meta.dirname, '../mender/tools/publish-to-site.mjs'), '--check'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('every Mender suite passes', () => {
  const result = spawnSync(process.execPath, [resolve(import.meta.dirname, '../mender/tests/run.mjs')], { encoding: 'utf8', timeout: 120_000 });
  assert.equal(result.status, 0, result.stdout.split('\n').filter((line) => line.includes('FAIL')).join('\n') || result.stderr);
});
