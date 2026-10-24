import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkCurrentContractCalls, compareContracts, matchContractCalls, readGitHubContract } from '../lib/contract-source.ts';
import { extractCalls } from '../lib/public-scan.ts';

function spec(field) {
  return { openapi: '3.0.3', info: { title: 'Orders', version: '1' }, paths: {
    '/orders': { post: { requestBody: { content: { 'application/json': { schema: {
      type: 'object', required: [field], properties: { [field]: { type: 'string' } },
    } } } }, responses: { 200: { description: 'ok' } } } },
  } };
}

test('contract reader pins GitHub content to a commit and keeps the token on the API host', async () => {
  const originalFetch = globalThis.fetch;
  const head = 'a'.repeat(40);
  const text = JSON.stringify(spec('customerId'));
  let called;
  globalThis.fetch = async (url, options) => {
    called = { url: String(url), options };
    return Response.json({ type: 'file', encoding: 'base64', size: Buffer.byteLength(text), content: Buffer.from(text).toString('base64') });
  };
  try {
    const result = await readGitHubContract('customer/api', head, 'openapi.json', 'short-token');
    assert.equal(result.document.openapi, '3.0.3');
    assert.match(result.sha256, /^[a-f0-9]{64}$/);
    assert.equal(called.url, `https://api.github.com/repos/customer/api/contents/openapi.json?ref=${head}`);
    assert.equal(called.options.headers.Authorization, 'Bearer short-token');
    await assert.rejects(readGitHubContract('customer/api', head, '../openapi.json', 'short-token'), /Invalid contract source/);
  } finally { globalThis.fetch = originalFetch; }
});

test('contract comparison reports a required request field rename as a possible break', () => {
  const report = compareContracts(spec('customerId'), spec('accountId'));
  assert.notEqual(report.verdict, 'safe');
  assert.ok(report.changes.length || report.notes.length);
  assert.equal(typeof report.sampleProof.ok, 'boolean');
});

test('changed OpenAPI operation links only to static calls on its declared HTTPS server', () => {
  const before = { ...spec('customerId'), servers: [{ url: 'https://api.customer.example/v1' }] };
  const after = { ...spec('accountId'), servers: [{ url: 'https://api.customer.example/v1' }] };
  const report = compareContracts(before, after);
  assert.ok(report.affectedEndpoints.includes('POST /orders'));
  const calls = extractCalls('src/orders.ts', [
    "await fetch('https://api.customer.example/v1/orders', { method: 'POST', body: JSON.stringify(order) });",
    "await axios.post('https://other.example/v1/orders', order);",
    "await fetch('https://api.customer.example/v1/orders');",
    "await fetch(`${base}/v1/orders`, { method: 'POST' });",
  ].join('\n'));
  const candidates = matchContractCalls(before, report.affectedEndpoints, calls);
  assert.deepEqual(candidates.map(call => [call.file, call.line, call.endpoint]), [
    ['src/orders.ts', 1, 'POST /v1/orders'],
  ]);
});

test('template paths match one segment and unresolved servers produce no candidate', () => {
  const call = extractCalls('src/orders.ts', "axios.get('https://api.customer.example/v1/orders/42')");
  assert.equal(matchContractCalls({ servers: [{ url: 'https://api.customer.example/v1' }] },
    ['GET /orders/{id}'], call).length, 1);
  assert.equal(matchContractCalls({ servers: [{ url: 'https://{tenant}.customer.example/v1' }] },
    ['GET /orders/{id}'], call).length, 0);
});

test('current contract identifies the pilot request body missing accountId', () => {
  const current = { ...spec('accountId'), servers: [{ url: 'https://apimender.com' }] };
  const code = [
    "export async function createQuote(customerId, sku, fetch = globalThis.fetch) {",
    "  return fetch('https://apimender.com/orders', {",
    "    method: 'POST',",
    "    body: JSON.stringify({ customerId, sku }),",
    '  });',
    '}',
  ].join('\n');
  const calls = extractCalls('src/client.mjs', code);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].fields, ['customerId', 'sku']);
  assert.equal(calls[0].fieldsComplete, true);
  assert.equal(calls[0].bodyLine, 4);
  assert.deepEqual(checkCurrentContractCalls(current, calls).map(issue => ({
    missing: issue.missing, file: issue.call.file, line: issue.call.bodyLine,
  })), [{ missing: ['accountId'], file: 'src/client.mjs', line: 4 }]);
});

test('dynamic JSON bodies and spreads cannot create missing-field findings', () => {
  const current = { ...spec('accountId'), servers: [{ url: 'https://apimender.com' }] };
  const calls = extractCalls('src/orders.ts', [
    "fetch('https://apimender.com/orders', { method: 'POST', body: JSON.stringify(order) });",
    "fetch('https://apimender.com/orders', { method: 'POST', body: JSON.stringify({ ...order, sku }) });",
    "fetch('https://apimender.com/orders', { method: 'POST', body: JSON.stringify({ accountId, sku }) });",
  ].join('\n'));
  assert.deepEqual(calls.map(call => call.fieldsComplete), [false, false, true]);
  assert.deepEqual(checkCurrentContractCalls(current, calls), []);
});
