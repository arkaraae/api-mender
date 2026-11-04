import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const MAX_COLUMNS = 5000;
const MAX_OUTPUT_BYTES = 1_000_000;

/**
 * @param {string} file
 * @param {string[]} args
 * @param {{env: NodeJS.ProcessEnv, timeout: number, maxBuffer: number}} options
 */
async function runPsql(file, args, options) {
  return execFileAsync(file, args, options);
}

// The query reads catalog metadata for public tables only. It never selects
// from a customer table, evaluates customer functions, or reads row values.
export const POSTGRES_METADATA_SQL = `
with user_tables as (
  select c.oid, c.relname, n.nspname
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname not in ('pg_catalog', 'information_schema')
    and n.nspname not like 'pg_toast%' and n.nspname not like 'pg_temp_%'
    and c.relkind in ('r', 'p', 'v', 'm', 'f')
), target_tables as (
  select c.oid, c.relname
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p')
), role_safety as (
  select not (r.rolsuper or r.rolcreaterole or r.rolcreatedb or r.rolreplication or r.rolbypassrls)
    and not pg_catalog.has_database_privilege(current_user, current_database(), 'CREATE')
    and not exists (
      select 1 from pg_catalog.pg_namespace n
      where n.nspname not in ('pg_catalog', 'information_schema')
        and n.nspname not like 'pg_toast%' and n.nspname not like 'pg_temp_%'
        and pg_catalog.has_schema_privilege(current_user, n.oid, 'CREATE')
    )
    and not exists (
      select 1 from user_tables t
      where pg_catalog.has_table_privilege(current_user, t.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER')
        or pg_catalog.has_any_column_privilege(current_user, t.oid, 'SELECT, INSERT, UPDATE')
    ) as restricted_role
  from pg_catalog.pg_roles r where r.rolname = current_user
), columns as (
  select t.relname as table_name, a.attname as column_name,
    pg_catalog.format_type(a.atttypid, a.atttypmod) as data_type,
    a.attnotnull as not_null
  from target_tables t
  join pg_catalog.pg_attribute a on a.attrelid = t.oid
  where a.attnum > 0 and not a.attisdropped
  order by t.relname, a.attnum
  limit ${MAX_COLUMNS + 1}
)
select pg_catalog.json_build_object(
  'readOnly', current_setting('transaction_read_only') = 'on',
  'restrictedRole', (select restricted_role from role_safety),
  'onReplica', pg_catalog.pg_is_in_recovery(),
  'columns', coalesce((select pg_catalog.json_agg(pg_catalog.json_build_object(
    'table', table_name, 'column', column_name, 'type', data_type, 'notNull', not_null
  )) from columns), '[]'::json)
)::text;
`;

function safeName(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f]/.test(value);
}

export function parseProbeResult(stdout) {
  if (Buffer.byteLength(stdout, 'utf8') > MAX_OUTPUT_BYTES) throw new Error('Database schema is too large for this probe');
  let raw;
  try { raw = JSON.parse(stdout.trim()); } catch { throw new Error('Database did not return a valid metadata report'); }
  if (raw?.readOnly !== true || raw?.restrictedRole !== true)
    throw new Error('Use a dedicated metadata-only Postgres role in a read-only session');
  if (typeof raw.onReplica !== 'boolean' || !Array.isArray(raw.columns) || raw.columns.length > MAX_COLUMNS)
    throw new Error('Invalid or oversized database metadata');
  const columns = raw.columns.map(item => {
    if (!item || Object.keys(item).sort().join(',') !== 'column,notNull,table,type'
      || !safeName(item.table) || !safeName(item.column) || !safeName(item.type)
      || typeof item.notNull !== 'boolean') throw new Error('Unexpected database metadata field');
    return { schema: 'public', table: item.table, column: item.column,
      type: item.type, notNull: item.notNull };
  });
  columns.sort((a, b) => {
    const left = `${a.table}\0${a.column}`;
    const right = `${b.table}\0${b.column}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  for (let index = 1; index < columns.length; index++) {
    if (columns[index].table === columns[index - 1].table
      && columns[index].column === columns[index - 1].column)
      throw new Error('Duplicate database column metadata');
  }
  const fingerprint = createHash('sha256').update(JSON.stringify(columns)).digest('hex');
  return { format: 'api-mender-postgres-schema-v1', capturedAt: new Date().toISOString(),
    onReplica: raw.onReplica, fingerprint, columns };
}

export async function collectPostgresSchema(env = process.env, run = runPsql) {
  if (!env.PGHOST || !env.PGUSER || !env.PGDATABASE || (!env.PGPASSWORD && !env.PGPASSFILE))
    throw new Error('Set PGHOST, PGUSER, PGDATABASE, and PGPASSWORD or PGPASSFILE');
  // libpq treats a URI in PGDATABASE as connection settings, which could
  // override the TLS and read-only settings supplied below.
  if (!/^[A-Za-z0-9_.:-]+$/.test(env.PGHOST) || !/^[A-Za-z_][A-Za-z0-9_-]{0,62}$/.test(env.PGUSER)
    || !/^[A-Za-z_][A-Za-z0-9_-]{0,62}$/.test(env.PGDATABASE)
    || !/^\d{1,5}$/.test(env.PGPORT || '5432') || Number(env.PGPORT || '5432') > 65535)
    throw new Error('Use a TCP hostname and plain Postgres role/database names');
  if (!env.PGSSLROOTCERT) throw new Error('Set PGSSLROOTCERT to the trusted database CA certificate');
  const childEnv = {
    PATH: env.PATH,
    PGHOST: env.PGHOST, PGPORT: env.PGPORT || '5432', PGUSER: env.PGUSER,
    PGDATABASE: env.PGDATABASE, PGPASSWORD: env.PGPASSWORD,
    PGPASSFILE: env.PGPASSFILE, PGSSLROOTCERT: env.PGSSLROOTCERT,
    PGSSLMODE: 'verify-full', PGCONNECT_TIMEOUT: '5',
    PGOPTIONS: '-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=1000 -c search_path=pg_catalog',
  };
  let stdout;
  try {
    ({ stdout } = await run('psql', ['-X', '-q', '-t', '-A', '--no-password', '-c', POSTGRES_METADATA_SQL],
      { env: childEnv, timeout: 10_000, maxBuffer: MAX_OUTPUT_BYTES }));
  } catch {
    // Database errors can contain hostnames or connection details. Do not echo them.
    throw new Error('Postgres metadata probe failed; check network, TLS certificate, and read-only role');
  }
  return parseProbeResult(stdout);
}

async function main() {
  const outputIndex = process.argv.indexOf('--output');
  if (outputIndex < 0 || outputIndex !== process.argv.length - 2 || !process.argv[outputIndex + 1])
    throw new Error('Usage: node scripts/postgres-schema-probe.mjs --output ./schema-evidence.json');
  const snapshot = await collectPostgresSchema();
  const handle = await open(process.argv[outputIndex + 1], 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(snapshot, null, 2) + '\n'); }
  finally { await handle.close(); }
  process.stdout.write(`Saved ${snapshot.columns.length} column definitions (SHA-256 ${snapshot.fingerprint}). No rows were read.\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
