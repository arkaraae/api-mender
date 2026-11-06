import assert from 'node:assert/strict';
import { test } from 'node:test';
import { processRepairProofJobs } from '../lib/repair-proof-worker.ts';

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
