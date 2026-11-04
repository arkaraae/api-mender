import { createClient } from '@supabase/supabase-js';

const uuid = /^[a-f0-9-]{36}$/;

async function signedInDatabase(request: Request) {
  const token = request.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1];
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!token || !url || !key) return null;
  const client = createClient(url, key, { global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await client.auth.getUser(token);
  return error || !data.user ? null : client;
}

export async function GET(request: Request) {
  const database = await signedInDatabase(request);
  if (!database) return Response.json({ error: 'Sign in required' }, { status: 401 });
  const workspaceId = new URL(request.url).searchParams.get('workspaceId');
  if (!workspaceId || !uuid.test(workspaceId)) return Response.json({ error: 'Invalid workspace' }, { status: 400 });
  const { data, error } = await database.from('api_contract_consumers')
    .select('id,source_id,repository_id,paused,created_at')
    .eq('workspace_id', workspaceId).order('created_at');
  if (error) return Response.json({ error: 'Could not list contract consumers' }, { status: 502 });
  return Response.json({ consumers: data });
}

export async function POST(request: Request) {
  const database = await signedInDatabase(request);
  if (!database) return Response.json({ error: 'Sign in required' }, { status: 401 });
  const body = await request.json().catch(() => null) as
    { workspaceId?: unknown; sourceId?: unknown; repositoryId?: unknown } | null;
  if (typeof body?.workspaceId !== 'string' || !uuid.test(body.workspaceId)
    || typeof body.sourceId !== 'string' || !uuid.test(body.sourceId)
    || typeof body.repositoryId !== 'string' || !uuid.test(body.repositoryId))
    return Response.json({ error: 'Invalid contract consumer' }, { status: 400 });
  const [{ data: source }, { data: consumer }] = await Promise.all([
    database.from('api_contract_sources').select('id,repository_id,paused')
      .eq('workspace_id', body.workspaceId).eq('id', body.sourceId).single(),
    database.from('monitored_repositories').select('id,github_installation_id,paused')
      .eq('workspace_id', body.workspaceId).eq('id', body.repositoryId).single(),
  ]);
  if (!source || source.paused || !consumer || consumer.paused || !consumer.github_installation_id)
    return Response.json({ error: 'Connected source and consumer repositories are required' }, { status: 404 });
  if (source.repository_id === consumer.id)
    return Response.json({ error: 'Choose a separate consumer repository' }, { status: 400 });
  const { data, error } = await database.from('api_contract_consumers').insert({
    workspace_id: body.workspaceId, source_id: body.sourceId, repository_id: body.repositoryId,
  }).select('id,source_id,repository_id,paused').single();
  if (error) return Response.json({ error: error.code === '23505' ? 'Contract consumer already connected' : 'Could not connect contract consumer' },
    { status: error.code === '23505' ? 409 : 403 });
  return Response.json({ consumer: data }, { status: 201 });
}

export async function DELETE(request: Request) {
  const database = await signedInDatabase(request);
  if (!database) return Response.json({ error: 'Sign in required' }, { status: 401 });
  const body = await request.json().catch(() => null) as { workspaceId?: unknown; consumerId?: unknown } | null;
  if (typeof body?.workspaceId !== 'string' || !uuid.test(body.workspaceId)
    || typeof body.consumerId !== 'string' || !uuid.test(body.consumerId))
    return Response.json({ error: 'Invalid contract consumer' }, { status: 400 });
  const { data, error } = await database.from('api_contract_consumers').delete()
    .eq('workspace_id', body.workspaceId).eq('id', body.consumerId).select('id').maybeSingle();
  if (error) return Response.json({ error: 'Could not disconnect contract consumer' }, { status: 403 });
  if (!data) return Response.json({ error: 'Contract consumer not found' }, { status: 404 });
  return Response.json({ removed: true });
}
