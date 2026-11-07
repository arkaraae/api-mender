import { createClient } from '@supabase/supabase-js';
import { authenticatedEditor, onboardingDatabase } from '@/lib/github-onboarding';

function userDatabase(request: Request) {
  const token = request.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1];
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!token || !url || !key) return null;
  return { token, client: createClient(url, key, { global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false } }) };
}

export async function GET(request: Request) {
  const identity = userDatabase(request);
  if (!identity) return Response.json({ error: 'Sign in required' }, { status: 401 });
  const { data: user, error: authError } = await identity.client.auth.getUser(identity.token);
  if (authError || !user.user) return Response.json({ error: 'Session expired' }, { status: 401 });
  const workspaceId = new URL(request.url).searchParams.get('workspaceId');
  if (!workspaceId || !/^[a-f0-9-]{36}$/.test(workspaceId)) return Response.json({ error: 'Invalid workspace' }, { status: 400 });
  const { data, error } = await identity.client.from('api_contract_sources').select('id,repository_id,path,paused,created_at')
    .eq('workspace_id', workspaceId).order('created_at');
  if (error) return Response.json({ error: 'Could not list contract sources' }, { status: 502 });
  return Response.json({ sources: data });
}

export async function POST(request: Request) {
  const identity = userDatabase(request);
  if (!identity) return Response.json({ error: 'Sign in required' }, { status: 401 });
  const { data: user, error: authError } = await identity.client.auth.getUser(identity.token);
  if (authError || !user.user) return Response.json({ error: 'Session expired' }, { status: 401 });
  const body = await request.json().catch(() => null) as { workspaceId?: unknown; repositoryId?: unknown; path?: unknown } | null;
  if (typeof body?.workspaceId !== 'string' || !/^[a-f0-9-]{36}$/.test(body.workspaceId)
    || typeof body.repositoryId !== 'string' || !/^[a-f0-9-]{36}$/.test(body.repositoryId)
    || typeof body.path !== 'string' || body.path.length > 256
    || !/^[A-Za-z0-9_./-]+\.json$/.test(body.path)
    || body.path.startsWith('/') || body.path.split('/').some(part => part === '.' || part === '..'))
    return Response.json({ error: 'Invalid contract source' }, { status: 400 });
  const { data: repository, error: repoError } = await identity.client.from('monitored_repositories')
    .select('id,github_installation_id,visibility,paused').eq('id', body.repositoryId).eq('workspace_id', body.workspaceId).single();
  if (repoError || !repository || repository.paused
    || (!repository.github_installation_id && repository.visibility !== 'public'))
    return Response.json({ error: 'Connected or public repository not found' }, { status: 404 });
  // The source table's legacy insert policy requires an installation. For a
  // public repository, verify editor membership before the server-only insert;
  // the background worker will fetch its contract without any GitHub token.
  const publicWithoutInstallation = repository.visibility === 'public' && !repository.github_installation_id;
  const editor = publicWithoutInstallation ? await authenticatedEditor(request, body.workspaceId) : null;
  if (publicWithoutInstallation && !editor) return Response.json({ error: 'Workspace editor required' }, { status: 403 });
  const database = publicWithoutInstallation ? onboardingDatabase() : identity.client;
  const { data, error } = await database.from('api_contract_sources').insert({
    workspace_id: body.workspaceId, repository_id: body.repositoryId, path: body.path,
  }).select('id,path').single();
  if (error) return Response.json({ error: error.code === '23505' ? 'Contract source already exists' : 'Could not add contract source' }, { status: error.code === '23505' ? 409 : 403 });
  return Response.json({ source: data, status: 'queued_on_next_worker_tick' }, { status: 201 });
}
