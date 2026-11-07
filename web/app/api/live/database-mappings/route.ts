import { authenticatedEditor, uuid } from '@/lib/github-onboarding';
import { readBoundedBody } from '@/lib/github-app';

const noStore = { 'Cache-Control': 'no-store' };
const name = /^[^\u0000-\u001f\u007f]{1,128}$/u;
const endpointPattern = /^(GET|POST|PUT|PATCH|DELETE) \/[^\u0000-\u001f\u007f]{0,245}$/u;

async function parseBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true })
      .decode(await readBoundedBody(request, 2048)));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown> : null;
  } catch { return null; }
}

export async function GET(request: Request) {
  const workspaceId = new URL(request.url).searchParams.get('workspaceId');
  if (!workspaceId || !uuid.test(workspaceId))
    return Response.json({ error: 'Invalid workspace' }, { status: 400, headers: noStore });
  const identity = await authenticatedEditor(request, workspaceId);
  if (!identity) return Response.json({ error: 'Workspace editor sign-in required' }, { status: 403, headers: noStore });
  const { data, error } = await identity.client.from('api_database_mappings')
    .select('id,source_id,repository_id,endpoint,request_field,schema_label,table_name,column_name,created_at')
    .eq('workspace_id', workspaceId).order('created_at', { ascending: false }).limit(100);
  if (error) return Response.json({ error: 'Could not list database mappings' }, { status: 502, headers: noStore });
  return Response.json({ mappings: data }, { headers: noStore });
}

export async function POST(request: Request) {
  const body = await parseBody(request);
  if (!body || Object.keys(body).sort().join(',') !==
    'column,endpoint,repositoryId,requestField,schemaLabel,sourceId,table,workspaceId'
    || typeof body.workspaceId !== 'string' || !uuid.test(body.workspaceId)
    || typeof body.sourceId !== 'string' || !uuid.test(body.sourceId)
    || typeof body.repositoryId !== 'string' || !uuid.test(body.repositoryId)
    || typeof body.endpoint !== 'string' || !endpointPattern.test(body.endpoint)
    || typeof body.requestField !== 'string' || !name.test(body.requestField)
    || typeof body.schemaLabel !== 'string' || !name.test(body.schemaLabel) || body.schemaLabel.length > 80
    || typeof body.table !== 'string' || !name.test(body.table)
    || typeof body.column !== 'string' || !name.test(body.column))
    return Response.json({ error: 'Invalid database mapping' }, { status: 400, headers: noStore });
  const identity = await authenticatedEditor(request, body.workspaceId);
  if (!identity) return Response.json({ error: 'Workspace editor sign-in required' }, { status: 403, headers: noStore });
  const [{ data: binding, error: bindingError }, { data: snapshot, error: snapshotError },
    { count, error: countError }] = await Promise.all([
    identity.client.from('api_contract_consumers').select('id').eq('workspace_id', body.workspaceId)
      .eq('source_id', body.sourceId).eq('repository_id', body.repositoryId).eq('paused', false).maybeSingle(),
    identity.client.from('database_schema_snapshots').select('id,source,captured_at,columns')
      .eq('workspace_id', body.workspaceId).eq('label', body.schemaLabel)
      .order('captured_at', { ascending: false }).limit(1).maybeSingle(),
    identity.client.from('api_database_mappings').select('id', { count: 'exact', head: true })
      .eq('workspace_id', body.workspaceId).eq('source_id', body.sourceId).eq('repository_id', body.repositoryId),
  ]);
  if (bindingError || snapshotError || countError)
    return Response.json({ error: 'Could not verify the connected source or schema' }, { status: 502, headers: noStore });
  if (!binding) return Response.json({ error: 'Connected API consumer required' }, { status: 404, headers: noStore });
  if (!snapshot || snapshot.source !== 'customer-attested')
    return Response.json({ error: 'Customer-attested schema snapshot required' }, { status: 404, headers: noStore });
  const age = Date.now() - Date.parse(snapshot.captured_at);
  if (!Number.isFinite(age) || age < -300_000 || age > 7 * 86_400_000)
    return Response.json({ error: 'Refresh the schema snapshot before mapping it' }, { status: 409, headers: noStore });
  if (!Array.isArray(snapshot.columns) || !snapshot.columns.some(item => item?.schema === 'public'
    && item?.table === body.table && item?.column === body.column))
    return Response.json({ error: 'Column is absent from the latest schema snapshot' }, { status: 409, headers: noStore });
  if ((count || 0) >= 100) return Response.json({ error: 'Database mapping limit reached' },
    { status: 409, headers: noStore });
  const { data, error } = await identity.client.from('api_database_mappings').insert({
    workspace_id: body.workspaceId, source_id: body.sourceId, repository_id: body.repositoryId,
    endpoint: body.endpoint, request_field: body.requestField, schema_label: body.schemaLabel,
    table_name: body.table, column_name: body.column,
  }).select('id,source_id,repository_id,endpoint,request_field,schema_label,table_name,column_name,created_at').single();
  if (error) return Response.json({ error: error.code === '23505' ? 'Database mapping already exists'
    : 'Could not save database mapping' }, { status: error.code === '23505' ? 409 : 403, headers: noStore });
  return Response.json({ mapping: data, note: 'Customer-declared mapping; runtime database impact is unverified' },
    { status: 201, headers: noStore });
}

export async function DELETE(request: Request) {
  const body = await parseBody(request);
  if (!body || Object.keys(body).sort().join(',') !== 'mappingId,workspaceId'
    || typeof body.workspaceId !== 'string' || !uuid.test(body.workspaceId)
    || typeof body.mappingId !== 'string' || !uuid.test(body.mappingId))
    return Response.json({ error: 'Invalid database mapping' }, { status: 400, headers: noStore });
  const identity = await authenticatedEditor(request, body.workspaceId);
  if (!identity) return Response.json({ error: 'Workspace editor sign-in required' }, { status: 403, headers: noStore });
  const { data, error } = await identity.client.from('api_database_mappings').delete()
    .eq('workspace_id', body.workspaceId).eq('id', body.mappingId).select('id').maybeSingle();
  if (error) return Response.json({ error: 'Could not remove database mapping' }, { status: 403, headers: noStore });
  if (!data) return Response.json({ error: 'Database mapping not found' }, { status: 404, headers: noStore });
  return Response.json({ removed: true }, { headers: noStore });
}
