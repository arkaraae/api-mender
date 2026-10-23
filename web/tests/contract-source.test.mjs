import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareContracts, readGitHubContract } from '../lib/contract-source.ts';

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
