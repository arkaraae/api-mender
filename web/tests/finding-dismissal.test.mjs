import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { setFindingDismissed } from '../lib/finding-dismissal.ts';

const ids = { workspaceId: 'workspace', findingId: 'finding', userId: 'user' };

function fakeDatabase(result) {
  const calls = { filters: {} };
  const query = { eq(column, value) { calls.filters[column] = value; return query; },
    select() { return query; }, maybeSingle: async () => result };
  return { calls, from(table) { calls.table = table;
    return { update(values) { calls.values = values; return query; } }; } };
}

test('dismissing records who did it and stays inside the workspace', async () => {
  const database = fakeDatabase({ data: { id: 'finding', status: 'Dismissed' }, error: null });
  assert.equal(await setFindingDismissed(database, { ...ids, dismissed: true }), 'Dismissed');
  assert.equal(database.calls.table, 'findings');
  assert.deepEqual(database.calls.filters, { id: 'finding', workspace_id: 'workspace' });
  assert.equal(database.calls.values.status, 'Dismissed');
  assert.equal(database.calls.values.dismissed_by, 'user');
  assert.ok(database.calls.values.dismissed_at);
});

test('restoring only applies to a dismissed finding and clears who dismissed it', async () => {
  const database = fakeDatabase({ data: { id: 'finding', status: 'Action required' }, error: null });
  assert.equal(await setFindingDismissed(database, { ...ids, dismissed: false }), 'Action required');
  assert.equal(database.calls.filters.status, 'Dismissed');
  assert.equal(database.calls.values.dismissed_at, null);
  assert.equal(database.calls.values.dismissed_by, null);
});

test('a finding from another workspace reads as not found, and database errors surface', async () => {
  assert.equal(await setFindingDismissed(fakeDatabase({ data: null, error: null }), { ...ids, dismissed: true }), null);
  await assert.rejects(setFindingDismissed(fakeDatabase({ data: null, error: new Error('down') }), { ...ids, dismissed: true }), /down/);
});

test('scan insert ignores existing findings and refreshes only scan-owned fields', () => {
  const source = readFileSync(new URL('../lib/contract-worker.ts', import.meta.url), 'utf8');
  assert.equal((source.match(/from\('findings'\)\.upsert\(finding/g) || []).length, 2);
  assert.equal((source.match(/ignoreDuplicates: true, defaultToNull: false/g) || []).length, 2);
  assert.equal((source.match(/from\('findings'\)\.update\(scanFields\)/g) || []).length, 2);
  assert.doesNotMatch(source, /\bstatus: 'Action required'/);
});
