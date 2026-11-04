import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessDatabaseImpact, loadDatabaseImpact } from '../lib/database-impact.ts';

const mapping = { endpoint: 'POST /quotes', request_field: 'accountId', schema_label: 'orders-prod',
  table_name: 'quotes', column_name: 'account_id' };
const now = Date.parse('2026-11-03T22:00:00.000Z');
const fresh = { id: 'snapshot-1', source: 'customer-attested', fingerprint: 'a'.repeat(64),
  captured_at: '2026-11-03T21:00:00.000Z', columns: [
    { schema: 'public', table: 'quotes', column: 'account_id', notNull: true },
  ] };

test('database mapping reports column metadata but never claims runtime verification', () => {
  assert.deepEqual(assessDatabaseImpact(mapping, fresh, now), {
    evidenceType: 'customer-attested-schema', endpoint: 'POST /quotes', requestField: 'accountId',
    schemaLabel: 'orders-prod', table: 'quotes', column: 'account_id', status: 'column-present',
    notNull: true, snapshotId: 'snapshot-1', schemaFingerprint: 'a'.repeat(64),
    capturedAt: fresh.captured_at, runtimeVerified: false,
  });
  assert.equal(assessDatabaseImpact(mapping, { ...fresh, columns: [] }, now).status, 'column-absent');
  assert.equal(assessDatabaseImpact(mapping, null, now).status, 'snapshot-missing');
  assert.equal(assessDatabaseImpact(mapping, { ...fresh, captured_at: '2026-10-01T00:00:00.000Z' }, now).status,
    'snapshot-stale');
});

test('only an explicit mapping for the affected operation and missing field is considered', async () => {
  let snapshotReads = 0;
  const rows = { api_database_mappings: [mapping,
    { ...mapping, endpoint: 'POST /other' }, { ...mapping, request_field: 'sku' }],
  database_schema_snapshots: fresh };
  const database = { from(table) { const result = { data: rows[table], error: null }; return {
    select() { return this; }, eq() { return this; }, order() { snapshotReads++; return this; },
    limit() { return this; }, maybeSingle: async () => result,
    then(resolve) { return Promise.resolve(result).then(resolve); },
  }; } };
  const impacts = await loadDatabaseImpact(database, 'workspace-1', 'source-1', 'repository-1',
    [{ operation: 'POST /quotes', missing: ['accountId'] }]);
  assert.equal(snapshotReads, 1);
  assert.equal(impacts.get('POST /quotes\0accountId').length, 1);
  assert.equal(impacts.get('POST /quotes\0accountId')[0].requestField, 'accountId');
});
