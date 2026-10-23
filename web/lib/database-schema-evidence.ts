const MAX_COLUMNS = 5000;
const MAX_EVIDENCE_BYTES = 1_000_000;
const NAME_PATTERN = /^[^\u0000-\u001f\u007f]{1,128}$/u;

type Column = { schema: 'public'; table: string; column: string; type: string; notNull: boolean };

function exactKeys(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function compareColumns(left: Column, right: Column) {
  const a = `${left.table}\0${left.column}`;
  const b = `${right.table}\0${right.column}`;
  return a < b ? -1 : a > b ? 1 : 0;
}

function validName(value: unknown): value is string {
  return typeof value === 'string' && NAME_PATTERN.test(value);
}

export async function validateDatabaseSchemaEvidence(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid schema evidence');
  const evidence = value as Record<string, unknown>;
  if (!exactKeys(evidence, ['format', 'capturedAt', 'onReplica', 'fingerprint', 'columns'])
    || evidence.format !== 'api-mender-postgres-schema-v1'
    || typeof evidence.onReplica !== 'boolean'
    || typeof evidence.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(evidence.fingerprint)
    || typeof evidence.capturedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(evidence.capturedAt)
    || !Array.isArray(evidence.columns) || evidence.columns.length > MAX_COLUMNS)
    throw new Error('Invalid schema evidence');
  const capturedAt = Date.parse(evidence.capturedAt);
  if (!Number.isFinite(capturedAt) || capturedAt > Date.now() + 300_000 || capturedAt < Date.now() - 7 * 86_400_000)
    throw new Error('Schema evidence must be less than seven days old');
  const columns: Column[] = evidence.columns.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid column metadata');
    const column = item as Record<string, unknown>;
    if (!exactKeys(column, ['schema', 'table', 'column', 'type', 'notNull'])
      || column.schema !== 'public' || !validName(column.table) || !validName(column.column)
      || !validName(column.type) || typeof column.notNull !== 'boolean')
      throw new Error('Invalid column metadata');
    return { schema: 'public', table: column.table, column: column.column,
      type: column.type, notNull: column.notNull };
  });
  columns.sort(compareColumns);
  for (let index = 1; index < columns.length; index++) {
    if (compareColumns(columns[index - 1], columns[index]) === 0) throw new Error('Duplicate column metadata');
  }
  const bytes = new TextEncoder().encode(JSON.stringify(columns));
  if (bytes.byteLength > MAX_EVIDENCE_BYTES) throw new Error('Schema evidence is too large');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const fingerprint = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
  if (fingerprint !== evidence.fingerprint) throw new Error('Schema evidence fingerprint mismatch');
  return { capturedAt: evidence.capturedAt, onReplica: evidence.onReplica, fingerprint, columns };
}
