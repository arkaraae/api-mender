import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { publishDraftRepair } from '../lib/repair-pr.ts';

const baseSha = 'a'.repeat(40);
const blobSha = 'b'.repeat(40);
const patchSha = 'c'.repeat(40);
const jobId = '12345678-1234-4234-8234-123456789abc';
const source = 'export const body = { customerId: "123" };\n';
const patchedSource = 'export const body = { accountId: "123" };\n';
const digest = value => createHash('sha256').update(value).digest('hex');
const input = { token: 'scoped-token', fullName: 'customer/repo', baseBranch: 'main',
  baseSha, blobSha, jobId, file: 'src/client.ts', source, patchedSource,
  sourceSha256: digest(source), patchedSha256: digest(patchedSource) };
const branch = `mender/repair-${jobId}`;
const pull = { number: 7, draft: true, html_url: 'https://github.com/customer/repo/pull/7',
  head: { ref: branch, sha: patchSha }, base: { ref: 'main' } };

test('publisher writes only the saved patch to a deterministic branch and opens a draft', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/git/refs')) return Response.json({ ref: `refs/heads/${branch}` }, { status: 201 });
    if (String(url).endsWith('/contents/src/client.ts')) return Response.json({ commit: { sha: patchSha } });
    if (String(url).endsWith('/pulls')) return Response.json(pull, { status: 201 });
    throw new Error(`Unexpected request: ${url}`);
  };
  try {
    const result = await publishDraftRepair(input);
    assert.deepEqual(result, { prNumber: 7, prUrl: pull.html_url, patchBranch: branch, patchSha });
    assert.equal(calls.length, 3);
    assert.equal(calls.every(call => call.url.startsWith('https://api.github.com/repos/customer/repo/')),
      true);
    assert.equal(calls.every(call => call.options.headers.Authorization === 'Bearer scoped-token'
      && call.options.redirect === 'manual'), true);
    assert.deepEqual(JSON.parse(calls[0].options.body), { ref: `refs/heads/${branch}`, sha: baseSha });
    const write = JSON.parse(calls[1].options.body);
    assert.equal(write.branch, branch);
    assert.equal(write.sha, blobSha);
    assert.equal(Buffer.from(write.content, 'base64').toString(), patchedSource);
    const request = JSON.parse(calls[2].options.body);
    assert.equal(request.draft, true);
    assert.equal(request.base, 'main');
    assert.match(request.body, /Unverified/);
    assert.match(request.body, /never merges/);
  } finally { globalThis.fetch = original; }
});

test('the draft PR discloses an AI-selected field mapping and its model', async () => {
  const original = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/git/refs')) return Response.json({ ref: `refs/heads/${branch}` }, { status: 201 });
    if (String(url).endsWith('/contents/src/client.ts')) return Response.json({ commit: { sha: patchSha } });
    if (String(url).endsWith('/pulls')) {
      bodies.push(JSON.parse(options.body).body);
      return Response.json(pull, { status: 201 });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  try {
    await publishDraftRepair({ ...input, generationMethod: 'ai_assisted', modelId: 'claude-sonnet-5' });
    await publishDraftRepair({ ...input, generationMethod: 'deterministic', modelId: null });
    assert.match(bodies[0], /\*\*AI-assisted:\*\* `claude-sonnet-5`/);
    assert.doesNotMatch(bodies[1], /AI-assisted/);
  } finally { globalThis.fetch = original; }
});

test('publisher can reconcile a previously opened matching draft without another commit', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/git/refs')) return Response.json({}, { status: 422 });
    if (String(url).includes('/git/ref/heads/')) return Response.json({ object: { sha: patchSha } });
    if (String(url).includes('/contents/src/client.ts?ref=')) return Response.json({
      type: 'file', encoding: 'base64', size: Buffer.byteLength(patchedSource),
      content: Buffer.from(patchedSource).toString('base64'),
    });
    if (String(url).endsWith(`/commits/${patchSha}`)) return Response.json({
      parents: [{ sha: baseSha }], files: [{ filename: 'src/client.ts', status: 'modified' }],
    });
    if (String(url).endsWith('/pulls')) return Response.json({}, { status: 422 });
    if (String(url).includes('/pulls?state=open')) return Response.json([pull]);
    throw new Error(`Unexpected request: ${url}`);
  };
  try {
    const result = await publishDraftRepair(input);
    assert.equal(result.patchSha, patchSha);
    assert.equal(calls.some(call => call.options.method === 'PUT'), false);
  } finally { globalThis.fetch = original; }
});

test('publisher refuses altered content or an unrelated existing branch', async () => {
  await assert.rejects(publishDraftRepair({ ...input, patchedSource: source }), /hashes/);
  const original = globalThis.fetch;
  globalThis.fetch = async url => {
    if (String(url).endsWith('/git/refs')) return Response.json({}, { status: 422 });
    if (String(url).includes('/git/ref/heads/')) return Response.json({ object: { sha: 'd'.repeat(40) } });
    if (String(url).includes('/contents/')) return Response.json({
      type: 'file', encoding: 'base64', size: Buffer.byteLength(source),
      content: Buffer.from(source).toString('base64'),
    });
    throw new Error(`Unexpected request: ${url}`);
  };
  try { await assert.rejects(publishDraftRepair(input), /differs from the saved proposal/); }
  finally { globalThis.fetch = original; }
});

test('publisher refuses a repair branch with unrelated committed files', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async url => {
    if (String(url).endsWith('/git/refs')) return Response.json({}, { status: 422 });
    if (String(url).includes('/git/ref/heads/')) return Response.json({ object: { sha: patchSha } });
    if (String(url).includes('/contents/')) return Response.json({
      type: 'file', encoding: 'base64', size: Buffer.byteLength(patchedSource),
      content: Buffer.from(patchedSource).toString('base64'),
    });
    if (String(url).endsWith(`/commits/${patchSha}`)) return Response.json({
      parents: [{ sha: baseSha }], files: [
        { filename: 'src/client.ts', status: 'modified' },
        { filename: 'src/other.ts', status: 'added' },
      ],
    });
    throw new Error(`Unexpected request: ${url}`);
  };
  try { await assert.rejects(publishDraftRepair(input), /outside the saved proposal/); }
  finally { globalThis.fetch = original; }
});
