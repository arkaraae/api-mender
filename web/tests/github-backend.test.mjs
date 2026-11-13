import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, verify } from 'node:crypto';
import { test } from 'node:test';
import { archiveResponse, tarGz } from './helpers/tar.mjs';
import { githubAppJwt, installationToken, parsePushEvent, readBoundedBody, verifyWebhookSignature } from '../lib/github-app.ts';
import { scanInstallationRepository } from '../lib/public-scan.ts';

test('webhook validation rejects changed bodies and ignores non-default-branch pushes', async () => {
  const body = new TextEncoder().encode(JSON.stringify({ after: 'a'.repeat(40) }));
  const signature = `sha256=${createHmac('sha256', 'webhook-secret').update(body).digest('hex')}`;
  assert.equal(await verifyWebhookSignature(body, signature, 'webhook-secret'), true);
  assert.equal(await verifyWebhookSignature(new TextEncoder().encode('{}'), signature, 'webhook-secret'), false);
  assert.equal(await verifyWebhookSignature(body, null, 'webhook-secret'), false);

  const push = { installation: { id: 12 }, repository: { id: 34, default_branch: 'main' }, ref: 'refs/heads/main', after: 'a'.repeat(40) };
  assert.deepEqual(parsePushEvent('push', push), { installationId: 12, repositoryId: 34, head: 'a'.repeat(40) });
  assert.equal(parsePushEvent('push', { ...push, ref: 'refs/heads/feature' }), null);
  assert.equal(parsePushEvent('push', { ...push, deleted: true }), null);
  assert.equal(parsePushEvent('pull_request', push), null);
  await assert.rejects(readBoundedBody(new Request('https://example.test', { method: 'POST', body: '12345' }), 4), /Payload too large/);
});

test('installation token is restricted to one repository and read-only contents', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url: String(url), options };
    return Response.json({ token: 'temporary-token', expires_at: '2026-10-22T12:00:00Z' });
  };
  try {
    const token = await installationToken({ appId: '123', privateKey }, 12, 34);
    assert.equal(token, 'temporary-token');
    assert.equal(request.url, 'https://api.github.com/app/installations/12/access_tokens');
    assert.equal(request.options.redirect, 'manual');
    assert.deepEqual(JSON.parse(request.options.body), { repository_ids: [34], permissions: { contents: 'read' } });
    assert.match(request.options.headers.Authorization, /^Bearer [^.]+\.[^.]+\.[^.]+$/);
    await installationToken({ appId: '123', privateKey }, 12, 'private-repo');
    assert.deepEqual(JSON.parse(request.options.body), { repositories: ['private-repo'], permissions: { contents: 'read' } });
    await installationToken({ appId: '123', privateKey }, 12, 34, 'repair-write');
    assert.deepEqual(JSON.parse(request.options.body), { repository_ids: [34], permissions: { contents: 'write', pull_requests: 'write' } });
    await installationToken({ appId: '123', privateKey }, 12, 34, 'proof-read');
    assert.deepEqual(JSON.parse(request.options.body), { repository_ids: [34], permissions: { contents: 'read', pull_requests: 'read', checks: 'read' } });
  } finally { globalThis.fetch = originalFetch; }
});

test('GitHub App JWT accepts downloaded PKCS#1 RSA keys', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const jwt = await githubAppJwt({ appId: '123', privateKey });
  const [header, payload, signature] = jwt.split('.');
  assert.equal(JSON.parse(Buffer.from(payload, 'base64url').toString()).iss, '123');
  assert.equal(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url')), true);
});

test('private scan downloads one pinned archive and never sends its token to codeload', async () => {
  const originalFetch = globalThis.fetch;
  const head = 'a'.repeat(40);
  const source = "export const meta = () => fetch('https://api.github.com/meta');\n";
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), auth: options?.headers?.Authorization, redirect: options?.redirect });
    if (String(url) === `https://api.github.com/repos/customer/private-repo/tarball/${head}`)
      return new Response(null, { status: 302, headers: { location: 'https://codeload.github.com/customer/private-repo/legacy.tar.gz/signed?token=t' } });
    if (String(url).startsWith('https://codeload.github.com/')) return archiveResponse(tarGz({ 'src/objects.ts': source, 'README.md': '# x' }));
    throw new Error(`Unexpected GitHub fetch: ${url}`);
  };
  try {
    const result = await scanInstallationRepository('customer/private-repo', head, 'installation-token');
    assert.equal(result.head, head);
    assert.deepEqual([result.inventory.calls[0].symbol, result.inventory.calls[0].endpoint], ['fetch', 'GET /meta']);
    assert.equal(requests[0].auth, 'Bearer installation-token');
    assert.equal(requests[0].redirect, 'manual');
    assert.equal(requests[1].auth, undefined, 'the token stays on api.github.com');
    assert.equal(requests.length, 2);
  } finally { globalThis.fetch = originalFetch; }
});

test('private scan refuses an archive redirect to any host but codeload', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/archive.tar.gz' } });
  try {
    await assert.rejects(scanInstallationRepository('customer/private-repo', 'a'.repeat(40), 'installation-token'), /codeload/);
  } finally { globalThis.fetch = originalFetch; }
});

test('public contract source scan reads a pinned commit without an App token', async () => {
  const originalFetch = globalThis.fetch;
  const head = 'd'.repeat(40);
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), auth: options?.headers?.Authorization });
    if (String(url).endsWith(`/tarball/${head}`)) return new Response(null, { status: 302, headers: { location: 'https://codeload.github.com/customer/public-api/legacy.tar.gz/x' } });
    if (String(url).startsWith('https://codeload.github.com/')) return archiveResponse(tarGz({}));
    throw new Error(`Unexpected GitHub fetch: ${url}`);
  };
  try {
    const result = await scanInstallationRepository('customer/public-api', head, '');
    assert.equal(result.head, head);
    assert.ok(requests.every(request => !request.auth));
  } finally { globalThis.fetch = originalFetch; }
});
