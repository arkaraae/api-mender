import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scanPublicRepository } from '../lib/public-scan.ts';

const head = 'a'.repeat(40);
const treeSha = 'b'.repeat(40);
const manifest = JSON.stringify({ dependencies: { '@aws-sdk/client-s3': '^3.0.0', stripe: '^17.0.0' } });
// An SDK call (no longer special-cased) next to real HTTP API calls, one built from a same-file base URL.
const code = "import { PutObjectCommand } from '@aws-sdk/client-s3';\nconst API = 'https://api.github.com';\nclient.send(new PutObjectCommand({ Bucket: 'demo' }));\nexport const repo = (o, r) => fetch(`${API}/repos/${o}/${r}`);\nexport const quote = () => fetch('https://api.example.com/v2/quotes', { method: 'POST', body: JSON.stringify({ accountId: 'a' }) });\n";

test('a public repository scan lists every external API call and reads no manifests', async () => {
  const requested = [];
  const original = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = String(input);
    requested.push(url);
    if (url.endsWith('/repos/example/customer')) return Response.json({ private: false, archived: false });
    if (url.endsWith('/branches/main')) return Response.json({ commit: { sha: head } });
    if (url.endsWith(`/git/commits/${head}`)) return Response.json({ tree: { sha: treeSha } });
    if (url.endsWith(`/git/trees/${treeSha}?recursive=1`)) return Response.json({ tree: [
      { path: 'services/storage/package.json', type: 'blob', mode: '100644', size: manifest.length },
      { path: 'services/storage/src/objects.ts', type: 'blob', mode: '100644', size: code.length },
    ] });
    if (url.endsWith('/services/storage/package.json')) return new Response(manifest);
    if (url.endsWith('/services/storage/src/objects.ts')) return new Response(code);
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    const result = await scanPublicRepository('example/customer', 'main');
    assert.equal(result.head, head);
    assert.equal(result.inventory.provider, 'http');
    assert.equal(result.inventory.sdkVersion, null);
    assert.deepEqual(result.inventory.calls.map(call => [call.symbol, call.line, call.origin, call.endpoint]), [
      ['fetch', 4, 'https://api.github.com', 'GET /repos/{}/{}'],
      ['fetch', 5, 'https://api.example.com', 'POST /v2/quotes'],
    ]);
    assert.deepEqual(result.inventory.calls[1].fields, ['accountId']);
    assert.ok(result.inventory.calls.every(call => call.uncertain));
    assert.ok(!requested.some(url => url.endsWith('package.json')), 'manifests are no longer read');
  } finally {
    globalThis.fetch = original;
  }
});

test('scanner sends the optional read-only credential only to GitHub API', async () => {
  const originalFetch = globalThis.fetch;
  const previousToken = process.env.GITHUB_READ_TOKEN;
  process.env.GITHUB_READ_TOKEN = 'test-token';
  const calls = [];
  globalThis.fetch = async (input, options) => {
    calls.push({ url: String(input), authorization: options?.headers?.Authorization });
    const url = String(input);
    if (url.endsWith('/repos/example/customer')) return Response.json({ private: false, archived: false });
    if (url.endsWith('/branches/main')) return Response.json({ commit: { sha: head } });
    if (url.endsWith(`/git/commits/${head}`)) return Response.json({ tree: { sha: treeSha } });
    if (url.endsWith(`/git/trees/${treeSha}?recursive=1`)) return Response.json({ tree: [{ path: 'package.json', type: 'blob', mode: '100644', size: manifest.length }] });
    if (url.includes('raw.githubusercontent.com')) return new Response(manifest);
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    await scanPublicRepository('example/customer', 'main');
    assert.ok(calls.filter(call => call.url.startsWith('https://api.github.com/')).every(call => call.authorization === 'Bearer test-token'));
    assert.ok(calls.filter(call => call.url.startsWith('https://raw.githubusercontent.com/')).every(call => !call.authorization));
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.GITHUB_READ_TOKEN;
    else process.env.GITHUB_READ_TOKEN = previousToken;
  }
});

test('rate-limit errors identify the missing credential without exposing it', async () => {
  const originalFetch = globalThis.fetch;
  const previousToken = process.env.GITHUB_READ_TOKEN;
  process.env.GITHUB_READ_TOKEN = 'test-token';
  globalThis.fetch = async () => new Response('rate limited', { status: 403, headers: { 'x-ratelimit-remaining': '0' } });
  try {
    await assert.rejects(scanPublicRepository('example/customer', 'main'), error => {
      assert.match(error.message, /GitHub API rate limit reached/);
      assert.doesNotMatch(error.message, /test-token/);
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.GITHUB_READ_TOKEN;
    else process.env.GITHUB_READ_TOKEN = previousToken;
  }
});
