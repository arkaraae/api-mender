import { createClient } from '@supabase/supabase-js';
import { backendAdmin } from '../../../../lib/backend-admin';
import { validateDatabaseSchemaEvidence } from '../../../../lib/database-schema-evidence';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MAX_BODY_BYTES = 1_100_000;
const noStore = { 'Cache-Control': 'no-store' };

function userDatabase(request: Request) {
  const token = request.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1];
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!token || !url || !key) return null;
  return { token, client: createClient(url, key, { global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false } }) };
}

async function readBoundedJson(request: Request) {
  if (!request.body) throw new Error('Missing request body');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) throw new Error('Schema evidence exceeds 1.1 MB');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
}

export async function GET(request: Request) {
  const identity = userDatabase(request);
  if (!identity) return Response.json({ error: 'Sign in required' }, { status: 401, headers: noStore });
  const { data: user, error: authError } = await identity.client.auth.getUser(identity.token);
  if (authError || !user.user) return Response.json({ error: 'Session expired' }, { status: 401, headers: noStore });
  const workspaceId = new URL(request.url).searchParams.get('workspaceId');
  if (!workspaceId || !UUID.test(workspaceId))
    return Response.json({ error: 'Invalid workspace' }, { status: 400, headers: noStore });
  const { data, error } = await identity.client.from('database_schema_snapshots')
    .select('id,label,source,fingerprint,captured_at,on_replica,created_at')
    .eq('workspace_id', workspaceId).order('captured_at', { ascending: false }).limit(50);
  if (error) return Response.json({ error: 'Could not list schema evidence' }, { status: 502, headers: noStore });
  return Response.json({ snapshots: data }, { headers: noStore });
}

export async function POST(request: Request) {
  const identity = userDatabase(request);
  if (!identity) return Response.json({ error: 'Sign in required' }, { status: 401, headers: noStore });
  const { data: user, error: authError } = await identity.client.auth.getUser(identity.token);
  if (authError || !user.user) return Response.json({ error: 'Session expired' }, { status: 401, headers: noStore });
  let body: unknown;
  try { body = await readBoundedJson(request); }
  catch { return Response.json({ error: 'Invalid or oversized JSON' }, { status: 400, headers: noStore }); }
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return Response.json({ error: 'Invalid request' }, { status: 400, headers: noStore });
  if (Object.keys(body).sort().join(',') !== 'evidence,label,workspaceId')
    return Response.json({ error: 'Unexpected request field' }, { status: 400, headers: noStore });
  const { workspaceId, label, evidence } = body as Record<string, unknown>;
  if (typeof workspaceId !== 'string' || !UUID.test(workspaceId)
    || typeof label !== 'string' || !/^[^\u0000-\u001f\u007f]{1,80}$/u.test(label))
    return Response.json({ error: 'Invalid workspace or label' }, { status: 400, headers: noStore });
  let snapshot;
  try { snapshot = await validateDatabaseSchemaEvidence(evidence); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : 'Invalid schema evidence' },
    { status: 400, headers: noStore }); }
  const { data: member, error: memberError } = await identity.client.from('workspace_members')
    .select('role').eq('workspace_id', workspaceId).eq('user_id', user.user.id).maybeSingle();
  if (memberError) return Response.json({ error: 'Could not verify workspace access' }, { status: 502, headers: noStore });
  if (member?.role !== 'owner' && member?.role !== 'editor')
    return Response.json({ error: 'Workspace editor access required' }, { status: 403, headers: noStore });
  let database;
  try { database = backendAdmin({ NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY }); }
  catch { return Response.json({ error: 'Schema evidence ingestion is not configured' }, { status: 503, headers: noStore }); }
  const { data, error } = await database.from('database_schema_snapshots').insert({
    workspace_id: workspaceId, label, source: 'customer-attested',
    fingerprint: snapshot.fingerprint, captured_at: snapshot.capturedAt,
    on_replica: snapshot.onReplica, columns: snapshot.columns,
  }).select('id,label,source,fingerprint,captured_at,on_replica,created_at').single();
  if (error) return Response.json({ error: error.code === '23505' ? 'Schema snapshot already exists'
    : 'Could not save schema evidence' }, { status: error.code === '23505' ? 409 : 403, headers: noStore });
  return Response.json({ snapshot: data }, { status: 201, headers: noStore });
}
