import { authenticatedEditor, githubConfiguration, onboardingDatabase, randomState, sha256, uuid } from '@/lib/github-onboarding';

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { workspaceId?: unknown } | null;
  if (typeof body?.workspaceId !== 'string' || !uuid.test(body.workspaceId))
    return Response.json({ error: 'Invalid workspace' }, { status: 400 });
  const identity = await authenticatedEditor(request, body.workspaceId);
  if (!identity) return Response.json({ error: 'Workspace editor sign-in required' }, { status: 403 });
  if (!githubConfiguration())
    return Response.json({ error: 'GitHub connection is being configured. Please try again later.' }, { status: 503 });
  const state = randomState();
  try {
    const { error } = await onboardingDatabase().from('github_onboarding_attempts').insert({
      state_hash: await sha256(state), workspace_id: body.workspaceId, user_id: identity.user.id,
      expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    });
    if (error) throw error;
    return Response.json({ url: `https://github.com/apps/api-mender-scanner/installations/new?state=${state}` },
      { headers: { 'Cache-Control': 'no-store' } });
  } catch { return Response.json({ error: 'Could not start GitHub connection' }, { status: 503 }); }
}
