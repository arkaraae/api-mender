import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pollPublicContractSources } from '../lib/repository-scan-worker.ts';

test('public source polling queues a changed pinned commit without a GitHub credential', async () => {
  const originalFetch = globalThis.fetch;
  const oldHead = 'a'.repeat(40);
  const newHead = 'b'.repeat(40);
  const writes = [];
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url: String(url), options };
    return Response.json({ commit: { sha: newHead } });
  };
  const database = {
    from(table) {
      let action = 'select';
      let value;
      const builder = {
        select() { return this; }, eq() { return this; }, in() { return this; },
        order() { return this; }, limit() { return this; },
        update(row) { action = 'update'; value = row; return this; },
        insert(row) { action = 'insert'; value = row; return this; },
        maybeSingle: async () => ({ data: table === 'monitored_repositories'
          ? { id: 'r1', workspace_id: 'w1', full_name: 'owner/public-api', branch: 'main',
            target_sha: oldHead, visibility: 'public', paused: false } : null, error: null }),
        then(resolve, reject) {
          if (action !== 'select') writes.push({ table, action, value });
          const data = table === 'api_contract_sources' ? [{ id: 's1', repository_id: 'r1' }] : [];
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
  };
  try {
    await pollPublicContractSources(database, Date.UTC(2026, 10, 6, 1, 15));
    assert.equal(request.url, 'https://api.github.com/repos/owner/public-api/branches/main');
    assert.equal(request.options.headers.Authorization, undefined);
    assert.equal(request.options.redirect, 'manual');
    assert.deepEqual(writes, [
      { table: 'monitored_repositories', action: 'update', value: { target_sha: newHead } },
      { table: 'repository_scan_jobs', action: 'insert', value: {
        workspace_id: 'w1', repository_id: 'r1', head_sha: newHead,
      } },
    ]);
  } finally { globalThis.fetch = originalFetch; }
});
