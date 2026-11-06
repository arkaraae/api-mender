import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { processRepairProofJobs, refreshRepairProofJob } from '../lib/repair-proof-worker.ts';

test('unattended proof refresh checks validated PRs and withdraws stale proof', async () => {
  const pending = { id: 'pending', workspace_id: 'workspace', patch_sha: 'a'.repeat(40), status: 'proof_pending' };
  const validated = { id: 'validated', workspace_id: 'workspace', patch_sha: 'b'.repeat(40), status: 'validated' };
  const selected = [];
  const updates = [];
  const database = { from(table) {
    assert.equal(table, 'repair_jobs');
    return {
      select() {
        const query = { filter: '', select() { return this; },
          in(_column, values) { this.filter = values.join(','); return this; },
          eq(column, value) { if (column === 'status') this.filter = value; return this; },
          lt() { return this; }, order() { return this; },
          limit() { selected.push(this.filter); return Promise.resolve({
            data: this.filter === 'validated' ? [validated] : [pending], error: null,
          }); },
        };
        return query;
      },
      update(payload) {
        const filters = {};
        return { eq(column, value) { filters[column] = value; return this; },
          then(resolve) { updates.push({ payload, filters }); resolve({ error: null }); },
        };
      },
    };
  } };
  const refreshed = [];
  const result = await processRepairProofJobs({ GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: 'present' },
    database, async (_database, _config, job) => {
      refreshed.push(job.id);
      if (job.status === 'validated') throw new Error('The repair PR no longer points to its saved patch commit');
    });
  assert.deepEqual(selected, ['proof_pending,proof_failed', 'validated']);
  assert.deepEqual(refreshed, ['pending', 'validated']);
  assert.equal(result.checked, 2);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].payload.status, 'proof_pending');
  assert.match(updates[0].payload.proof.error, /no longer points/);
  assert.equal(updates[0].filters.status, 'validated');
});

// Shapes and SHAs mirror GitHub's real responses for api-mender-pilot PR #3: after
// main moved, the PR and its check run both kept reporting the old base SHA.
const oldBase = '1f37dde2b88f5a9941f74148d7c2ee30177d08ee';
const movedTip = '33d379a30b6c5b4ab5cbd91b596b1d17e14b344c';
const patchSha = '658df809c7fb58c84f69fd91964d071f080e46d4';
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' } });

async function refreshAgainstBranchTip(branchTip) {
  const updates = [];
  const single = data => { const query = { select() { return query; }, eq() { return query; },
    maybeSingle: async () => ({ data, error: null }) }; return query; };
  const database = { from(table) {
    if (table === 'monitored_repositories') return single({ full_name: 'customer/repo', branch: 'main',
      github_repo_id: 34, github_installation_id: 12, paused: false });
    if (table === 'github_installations') return single({ workspace_id: 'workspace', suspended_at: null });
    return { update(payload) { updates.push(payload); return single({ id: 'job' }); } };
  } };
  const original = globalThis.fetch;
  globalThis.fetch = async url => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/access_tokens')) return Response.json({ token: 'read-token',
      expires_at: new Date(Date.now() + 3_600_000).toISOString() }, { status: 201 });
    if (path.endsWith('/pulls/3')) return Response.json({ state: 'open', merge_commit_sha: null,
      head: { sha: patchSha, ref: 'mender/repair-job', repo: { id: 34 } },
      base: { sha: oldBase, ref: 'main', repo: { id: 34 } } });
    if (path.endsWith('/branches/main')) return Response.json({ commit: { sha: branchTip } });
    if (path.endsWith('/check-runs')) return Response.json({ total_count: 1, check_runs: [{
      id: 127669940346, name: 'mender-repair-proof', head_sha: patchSha, status: 'completed',
      conclusion: 'success', app: { slug: 'github-actions' },
      html_url: 'https://github.com/customer/repo/actions/runs/1',
      pull_requests: [{ number: 3, head: { sha: patchSha }, base: { sha: oldBase } }] }] });
    throw new Error(`Unexpected request: ${url}`);
  };
  try {
    const result = await refreshRepairProofJob(database,
      { GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY: privateKey },
      { id: 'job', workspace_id: 'workspace', repository_id: 'repo', pr_number: 3,
        patch_branch: 'mender/repair-job', patch_sha: patchSha, status: 'validated' });
    return { result, updates };
  } finally { globalThis.fetch = original; }
}

test('a green check validates while the PR base is still the branch tip', async () => {
  const { result, updates } = await refreshAgainstBranchTip(oldBase);
  assert.equal(result.status, 'validated');
  assert.equal(updates[0].status, 'validated');
});

test('a moved base branch withdraws proof even though GitHub still reports the old base SHA', async () => {
  await assert.rejects(refreshAgainstBranchTip(movedTip), /base branch moved/);
});
