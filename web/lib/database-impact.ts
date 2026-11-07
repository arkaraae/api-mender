import type { SupabaseClient } from '@supabase/supabase-js';

export type DatabaseImpact = {
  evidenceType: 'customer-attested-schema';
  endpoint: string;
  requestField: string;
  schemaLabel: string;
  table: string;
  column: string;
  status: 'column-present' | 'column-absent' | 'snapshot-missing' | 'snapshot-stale';
  notNull?: boolean;
  snapshotId?: string;
  schemaFingerprint?: string;
  capturedAt?: string;
  runtimeVerified: false;
};

type Mapping = { endpoint: string; request_field: string; schema_label: string;
  table_name: string; column_name: string };
type Snapshot = { id: string; source: string; fingerprint: string; captured_at: string;
  columns: { schema: string; table: string; column: string; notNull: boolean }[] };

export function assessDatabaseImpact(mapping: Mapping, snapshot: Snapshot | null, now = Date.now()): DatabaseImpact {
  const result: DatabaseImpact = { evidenceType: 'customer-attested-schema',
    endpoint: mapping.endpoint, requestField: mapping.request_field,
    schemaLabel: mapping.schema_label, table: mapping.table_name, column: mapping.column_name,
    status: 'snapshot-missing', runtimeVerified: false };
  if (!snapshot || snapshot.source !== 'customer-attested') return result;
  result.snapshotId = snapshot.id;
  result.schemaFingerprint = snapshot.fingerprint;
  result.capturedAt = snapshot.captured_at;
  const age = now - Date.parse(snapshot.captured_at);
  if (!Number.isFinite(age) || age < -300_000 || age > 7 * 86_400_000) {
    result.status = 'snapshot-stale';
    return result;
  }
  const column = Array.isArray(snapshot.columns) ? snapshot.columns.find(item =>
    item.schema === 'public' && item.table === mapping.table_name && item.column === mapping.column_name) : undefined;
  result.status = column ? 'column-present' : 'column-absent';
  if (column) result.notNull = column.notNull;
  return result;
}

// Only customer-declared links are considered. No column name or table is
// inferred from an API field, and a schema match never verifies runtime use.
export async function loadDatabaseImpact(database: SupabaseClient, workspaceId: string,
  sourceId: string, repositoryId: string,
  mismatches: { operation: string; missing: string[] }[]): Promise<Map<string, DatabaseImpact[]>> {
  const output = new Map<string, DatabaseImpact[]>();
  if (!mismatches.length) return output;
  const { data: mappings, error } = await database.from('api_database_mappings')
    .select('endpoint,request_field,schema_label,table_name,column_name')
    .eq('workspace_id', workspaceId).eq('source_id', sourceId).eq('repository_id', repositoryId).limit(101);
  if (error) throw error;
  // An oversized mapping set must not stop the repository scan or produce an
  // incomplete assessment that looks exhaustive.
  if ((mappings || []).length > 100) return output;
  const wanted = (mappings || []).filter(mapping => mismatches.some(mismatch =>
    mismatch.operation === mapping.endpoint && mismatch.missing.includes(mapping.request_field)));
  const labels = [...new Set(wanted.map(mapping => mapping.schema_label))];
  const snapshots = new Map<string, Snapshot | null>();
  for (const label of labels) {
    const { data, error: snapshotError } = await database.from('database_schema_snapshots')
      .select('id,source,fingerprint,captured_at,columns')
      .eq('workspace_id', workspaceId).eq('label', label)
      .order('captured_at', { ascending: false }).limit(1).maybeSingle();
    if (snapshotError) throw snapshotError;
    snapshots.set(label, data as Snapshot | null);
  }
  for (const mismatch of mismatches) {
    const impacts = wanted.filter(mapping => mapping.endpoint === mismatch.operation
      && mismatch.missing.includes(mapping.request_field))
      .map(mapping => assessDatabaseImpact(mapping, snapshots.get(mapping.schema_label) || null));
    output.set(`${mismatch.operation}\0${mismatch.missing.join(',')}`, impacts);
  }
  return output;
}
