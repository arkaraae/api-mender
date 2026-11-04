'use client';

import { useCallback, useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';

type Repository = { id: string; full_name: string };
type Source = { id: string; repository_id: string; path: string; paused: boolean };
type Consumer = { source_id: string; repository_id: string; paused: boolean };
type Snapshot = { id: string; label: string; fingerprint: string; captured_at: string; on_replica: boolean };
type Mapping = { id: string; source_id: string; repository_id: string; endpoint: string; request_field: string;
  schema_label: string; table_name: string; column_name: string };

export default function DatabaseEvidenceSetup({ database, workspaceId, repositories, sources, consumers }: {
  database: SupabaseClient; workspaceId: string; repositories: Repository[]; sources: Source[]; consumers: Consumer[];
}) {
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [mappings, setMappings] = useState<Mapping[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [label, setLabel] = useState('production');
  const [binding, setBinding] = useState('');
  const [schemaLabel, setSchemaLabel] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [requestField, setRequestField] = useState('');
  const [table, setTable] = useState('');
  const [column, setColumn] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const activeBindings = consumers.filter(consumer => !consumer.paused && sources.some(source => source.id === consumer.source_id && !source.paused));

  const api = useCallback(async <T,>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    const { data } = await database.auth.getSession();
    if (!data.session) throw new Error('Sign in again to continue');
    const response = await fetch(path, { method, headers: {
      Authorization: `Bearer ${data.session.access_token}`, 'Content-Type': 'application/json',
    }, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json() as T & { error?: string };
    if (!response.ok) throw new Error(result.error || 'Request failed');
    return result;
  }, [database]);

  const refresh = useCallback(async () => {
    try {
      const query = `?workspaceId=${encodeURIComponent(workspaceId)}`;
      const [schemaResult, mappingResult] = await Promise.all([
        api<{ snapshots: Snapshot[] }>(`/api/live/database-schemas${query}`),
        api<{ mappings: Mapping[] }>(`/api/live/database-mappings${query}`),
      ]);
      setSnapshots(schemaResult.snapshots);
      setMappings(mappingResult.mappings);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not load database evidence'); }
  }, [api, workspaceId]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function upload() {
    if (!file || !label.trim()) return;
    setBusy(true); setMessage('');
    try {
      if (file.size > 1_100_000) throw new Error('Evidence file exceeds 1.1 MB');
      const evidence: unknown = JSON.parse(await file.text());
      if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)
        || (evidence as { format?: unknown }).format !== 'api-mender-postgres-schema-v1')
        throw new Error('Choose a JSON file from the API Mender Postgres metadata probe');
      await api('/api/live/database-schemas', 'POST', { workspaceId, label: label.trim(), evidence });
      setMessage('Schema metadata saved. No database credentials or row values were uploaded.');
      setFile(null);
      await refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not upload schema metadata'); }
    finally { setBusy(false); }
  }

  async function addMapping() {
    const [sourceId, repositoryId] = binding.split(':');
    if (!sourceId || !repositoryId || !schemaLabel || !endpoint || !requestField || !table || !column) return;
    setBusy(true); setMessage('');
    try {
      await api('/api/live/database-mappings', 'POST', { workspaceId, sourceId, repositoryId,
        endpoint: endpoint.trim(), requestField: requestField.trim(), schemaLabel,
        table: table.trim(), column: column.trim() });
      setMessage('API-to-column mapping saved as customer-declared evidence. Runtime impact is still unverified.');
      await refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not save database mapping'); }
    finally { setBusy(false); }
  }

  async function removeMapping(mappingId: string) {
    setBusy(true); setMessage('');
    try { await api('/api/live/database-mappings', 'DELETE', { workspaceId, mappingId });
      setMessage('Database mapping removed.'); await refresh(); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Could not remove mapping'); }
    finally { setBusy(false); }
  }

  return <section className="live-card" id="database-evidence-setup">
    <h2>Database impact evidence</h2>
    <p>Run the <a href="/downloads/postgres-schema-probe.mjs" download>Postgres metadata probe</a> in your own network with a dedicated metadata-only role. Review its JSON output, then upload it here. Mender receives column names and types, not row values or database credentials.</p>
    <details><summary>How to run the probe</summary><p>Requires Node.js, <code>psql</code>, a trusted Postgres CA certificate, and a role with connection access but no table read or write privileges. Set <code>PGHOST</code>, <code>PGPORT</code>, <code>PGDATABASE</code>, <code>PGUSER</code>, <code>PGPASSFILE</code>, and <code>PGSSLROOTCERT</code> in your own environment. Then run:</p><pre>node postgres-schema-probe.mjs --output ./schema-evidence.json</pre><p>Review the file before uploading it. The probe enforces TLS hostname verification and a read-only session.</p></details>
    <div className="live-fields"><label>Database label<input value={label} maxLength={80} onChange={event => setLabel(event.target.value)} placeholder="orders-prod" /></label>
      <label>Probe JSON file<input type="file" accept=".json,application/json" onChange={event => setFile(event.target.files?.[0] || null)} /></label></div>
    <button disabled={busy || !file || !label.trim()} onClick={() => void upload()}>Upload reviewed metadata</button>
    {snapshots.length > 0 && <div className="live-list">{snapshots.slice(0, 5).map(snapshot => <article key={snapshot.id}><div><strong>{snapshot.label}</strong><small>Captured {new Date(snapshot.captured_at).toLocaleString()} · {snapshot.on_replica ? 'Replica' : 'Primary'} · fingerprint {snapshot.fingerprint.slice(0, 12)}</small></div></article>)}</div>}
    <h3>Declare an API-to-column mapping</h3>
    <p>This links a connected API request field to a column in uploaded metadata. It identifies possible impact; it does not verify a production failure.</p>
    {activeBindings.length === 0 ? <p className="live-muted">Connect an API contract and a consumer repository first.</p> : snapshots.length === 0 ? <p className="live-muted">Upload a current schema snapshot first.</p> : <>
      <div className="live-fields"><label>API and consumer<select value={binding} onChange={event => setBinding(event.target.value)}><option value="">Choose connected pair</option>{activeBindings.map(item => { const source = sources.find(row => row.id === item.source_id); const repo = repositories.find(row => row.id === item.repository_id); return <option key={`${item.source_id}:${item.repository_id}`} value={`${item.source_id}:${item.repository_id}`}>{source?.path || 'API'} → {repo?.full_name || 'Consumer'}</option>; })}</select></label>
        <label>Schema label<select value={schemaLabel} onChange={event => setSchemaLabel(event.target.value)}><option value="">Choose snapshot</option>{[...new Set(snapshots.map(snapshot => snapshot.label))].map(name => <option key={name} value={name}>{name}</option>)}</select></label>
        <label>Endpoint<input value={endpoint} maxLength={256} onChange={event => setEndpoint(event.target.value)} placeholder="POST /quotes" /></label>
        <label>Request field<input value={requestField} maxLength={128} onChange={event => setRequestField(event.target.value)} placeholder="accountId" /></label>
        <label>Table<input value={table} maxLength={128} onChange={event => setTable(event.target.value)} placeholder="quotes" /></label>
        <label>Column<input value={column} maxLength={128} onChange={event => setColumn(event.target.value)} placeholder="account_id" /></label></div>
      <button disabled={busy || !binding || !schemaLabel || !endpoint.trim() || !requestField.trim() || !table.trim() || !column.trim()} onClick={() => void addMapping()}>Save mapping</button>
    </>}
    {mappings.length > 0 && <div className="live-list">{mappings.map(mapping => <article key={mapping.id}><div><strong>{mapping.endpoint} · {mapping.request_field} → {mapping.table_name}.{mapping.column_name}</strong><small>{mapping.schema_label} · customer-declared · runtime unverified</small></div><button disabled={busy} onClick={() => void removeMapping(mapping.id)}>Remove</button></article>)}</div>}
    {message && <p className="live-message" role="status">{message}</p>}
  </section>;
}
