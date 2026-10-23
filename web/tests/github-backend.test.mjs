import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, verify } from 'node:crypto';
import { test } from 'node:test';
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
    assert.deepEqual(JSON.parse(request.options.body), { repository_ids: [34], permissions: { contents: 'read' } });
    assert.match(request.options.headers.Authorization, /^Bearer [^.]+\.[^.]+\.[^.]+$/);
    await installationToken({ appId: '123', privateKey }, 12, 'private-repo');
    assert.deepEqual(JSON.parse(request.options.body), { repositories: ['private-repo'], permissions: { contents: 'read' } });
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

test('private scan reads only pinned GitHub blobs using its installation token', async () => {
  const originalFetch = globalThis.fetch;
  const head = 'a'.repeat(40);
  const tree = 'b'.repeat(40);
  const blob = 'c'.repeat(40);
  const source = "import { PutObjectCommand } from '@aws-sdk/client-s3';\nnew PutObjectCommand({ Bucket: 'bucket' });\n";
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), auth: options?.headers?.Authorization });
    if (String(url).endsWith(`/git/commits/${head}`)) return Response.json({ tree: { sha: tree } });
    if (String(url).endsWith(`/git/trees/${tree}?recursive=1`)) return Response.json({ tree: [{ path: 'src/objects.ts', type: 'blob', mode: '100644', size: Buffer.byteLength(source), sha: blob }] });
    if (String(url).endsWith(`/git/blobs/${blob}`)) return Response.json({ encoding: 'base64', size: Buffer.byteLength(source), content: Buffer.from(source).toString('base64') });
    throw new Error(`Unexpected GitHub fetch: ${url}`);
  };
  try {
    const result = await scanInstallationRepository('customer/private-repo', head, 'installation-token');
    assert.equal(result.head, head);
    assert.equal(result.inventory.calls[0].symbol, 'PutObjectCommand');
    assert.ok(requests.every(request => request.url.startsWith('https://api.github.com/') && request.auth === 'Bearer installation-token'));
  } finally { globalThis.fetch = originalFetch; }
});
