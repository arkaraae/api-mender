import assert from 'node:assert/strict';
import { test } from 'node:test';
import { proposeRequestFieldRepair } from '../lib/request-repair.ts';
import { parseStaticHttpCalls } from '../lib/static-http-calls.ts';

const file = 'src/client.mjs';
const source = `export async function createQuote(customerId, sku = 'WIDGET-1', fetch = globalThis.fetch) {
  const response = await fetch('https://apimender.com/api/managed/quotes', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ customerId, sku }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(\`Quote API returned \${response.status}\`);
  return body;
}`;
const contract = { openapi: '3.0.3', paths: { '/api/managed/quotes': { post: {
  requestBody: { content: { 'application/json': { schema: {
    type: 'object', required: ['accountId', 'sku'], properties: {
      accountId: { type: 'string' }, sku: { type: 'string' },
    },
  } } } },
} } } };

function input(text = source) {
  return { source: text, evidence: parseStaticHttpCalls(file, text)[0], contract, missing: ['accountId'] };
}

test('proposed repair changes the pinned request and passes a real request-shape check', async () => {
  const proposal = proposeRequestFieldRepair(input());
  assert.equal(proposal.staticVerified, true);
  assert.equal(proposal.runtimeVerified, false);
  assert.equal(proposal.afterSource.includes('JSON.stringify({ accountId: customerId, sku })'), true);
  assert.equal(proposal.afterSource.replace('accountId: customerId', 'customerId'), source);

  const api = async (_url, options) => {
    const payload = JSON.parse(options.body);
    const valid = typeof payload.accountId === 'string' && typeof payload.sku === 'string';
    return new Response(JSON.stringify(valid ? { id: 'quote-1' } : { error: 'accountId required' }),
      { status: valid ? 200 : 422, headers: { 'content-type': 'application/json' } });
  };
  const oldClient = await import(`data:text/javascript,${encodeURIComponent(source)}`);
  const repairedClient = await import(`data:text/javascript,${encodeURIComponent(proposal.afterSource)}`);
  await assert.rejects(oldClient.createQuote('customer-1', 'WIDGET-1', api), /422/);
  assert.deepEqual(await repairedClient.createQuote('customer-1', 'WIDGET-1', api), { id: 'quote-1' });
});

test('ambiguous or dynamic request bodies fail closed', () => {
  const ambiguous = source.replace('{ customerId, sku }', '{ customerId, metadata, sku }');
  assert.throws(() => proposeRequestFieldRepair(input(ambiguous)), /ambiguous/);
  const dynamic = source.replace('{ customerId, sku }', '{ ...payload, customerId, sku }');
  assert.throws(() => proposeRequestFieldRepair(input(dynamic)), /Unsupported|no longer matches/);
});
