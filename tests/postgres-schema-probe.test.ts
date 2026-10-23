import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectPostgresSchema, parseProbeResult, POSTGRES_METADATA_SQL } from '../scripts/postgres-schema-probe.mjs';
import { validateDatabaseSchemaEvidence } from '../web/lib/database-schema-evidence';

const result = JSON.stringify({ readOnly: true, restrictedRole: true, onReplica: false,
  columns: [{ table: 'orders', column: 'customer_id', type: 'uuid', notNull: true }] });

test('probe uses a read-only TLS session and keeps credentials out of command arguments', async () => {
  let called = false;
  const report = await collectPostgresSchema({ ...process.env, PATH: '/usr/bin', PGHOST: 'db.example.com', PGUSER: 'mender_probe',
    PGDATABASE: 'customer', PGPASSWORD: 'private-password', PGSSLROOTCERT: '/safe/ca.pem' }, async (file, args, options) => {
    assert.ok(args && options?.env);
    called = true;
    assert.equal(file, 'psql');
    assert.equal(args.join(' ').includes('private-password'), false);
    assert.equal(options.env.PGSSLMODE, 'verify-full');
    assert.match(String(options.env.PGOPTIONS), /default_transaction_read_only=on/);
    assert.equal(options.env.PGPASSWORD, 'private-password');
    assert.equal(args.at(-1), POSTGRES_METADATA_SQL);
    return { stdout: result, stderr: '' };
  });
  assert.equal(called, true);
  assert.equal(report.columns[0].column, 'customer_id');
  assert.match(report.fingerprint, /^[a-f0-9]{64}$/);
});

test('probe refuses a connection URI, local socket, or unverified CA setup', async () => {
  const base = { PGHOST: 'db.example.com', PGUSER: 'mender_probe', PGDATABASE: 'customer',
    PGPASSWORD: 'secret', PGSSLROOTCERT: '/safe/ca.pem' };
  for (const override of [
    { PGDATABASE: 'postgresql://user@other.example/db?sslmode=disable' },
    { PGHOST: '/var/run/postgresql' },
    { PGSSLROOTCERT: '' },
  ]) {
    await assert.rejects(collectPostgresSchema({ ...base, ...override }, async () => {
      throw new Error('must not connect');
    }));
  }
});

test('probe rejects privileged roles, writable sessions, and row-shaped payloads', () => {
  for (const change of [{ readOnly: false }, { restrictedRole: false },
    { columns: [{ table: 'orders', column: 'customer_id', type: 'uuid', notNull: true, value: 'secret' }] }]) {
    assert.throws(() => parseProbeResult(JSON.stringify({ ...JSON.parse(result), ...change })));
  }
});

test('probe never queries application rows', () => {
  assert.match(POSTGRES_METADATA_SQL, /pg_catalog\.pg_attribute/);
  assert.match(POSTGRES_METADATA_SQL, /has_any_column_privilege/);
  assert.doesNotMatch(POSTGRES_METADATA_SQL, /select\s+\*\s+from\s+public\./i);
});

test('workspace ingestion accepts a probe report and rejects altered or row-bearing evidence', async () => {
  const evidence = parseProbeResult(result);
  const accepted = await validateDatabaseSchemaEvidence(evidence);
  assert.equal(accepted.fingerprint, evidence.fingerprint);
  assert.deepEqual(accepted.columns, evidence.columns);
  await assert.rejects(validateDatabaseSchemaEvidence({ ...evidence, columns: [
    { ...evidence.columns[0], value: 'customer data' },
  ] }));
  await assert.rejects(validateDatabaseSchemaEvidence({ ...evidence, fingerprint: '0'.repeat(64) }));
});
