import { authenticatedEditor, base64urlSha256, githubConfiguration, onboardingDatabase, randomState, sha256, uuid } from '@/lib/github-onboarding';

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { workspaceId?: unknown } | null;
  if (typeof body?.workspaceId !== 'string' || !uuid.test(body.workspaceId))
    return Response.json({ error: 'Invalid workspace' }, { status: 400 });
  const identity = await authenticatedEditor(request, body.workspaceId);
  if (!identity) return Response.json({ error: 'Workspace editor sign-in required' }, { status: 403 });
  const config = githubConfiguration();
  if (!config)
    return Response.json({ error: 'GitHub connection is being configured. Please try again later.' }, { status: 503 });
  const state = randomState();
  try {
    const database = onboardingDatabase();
    const { data: installations, error: lookupError } = await database.from('github_installations')
      .select('installation_id').eq('workspace_id', body.workspaceId).is('suspended_at', null).limit(2);
    if (lookupError) throw lookupError;
    if ((installations?.length || 0) > 1)
      return Response.json({ error: 'This workspace has multiple GitHub installations; choose one before reconnecting' },
        { status: 409, headers: { 'Cache-Control': 'no-store' } });
    const installationId = installations?.[0]?.installation_id || null;
    const verifier = installationId ? randomState() : null;
    const { error } = await database.from('github_onboarding_attempts').insert({
      state_hash: await sha256(state), workspace_id: body.workspaceId, user_id: identity.user.id,
      installation_id: installationId, code_verifier: verifier,
      expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    });
    if (error) throw error;
    if (verifier) {
      const url = new URL('https://github.com/login/oauth/authorize');
      url.searchParams.set('client_id', config.clientId);
      url.searchParams.set('redirect_uri', config.callback);
      url.searchParams.set('state', state);
      url.searchParams.set('code_challenge', base64urlSha256(await sha256(verifier)));
      url.searchParams.set('code_challenge_method', 'S256');
      return Response.json({ url: url.toString() }, { headers: { 'Cache-Control': 'no-store' } });
    }
    return Response.json({ url: `https://github.com/apps/api-mender-scanner/installations/new?state=${state}` },
      { headers: { 'Cache-Control': 'no-store' } });
  } catch { return Response.json({ error: 'Could not start GitHub connection' }, { status: 503 }); }
}
