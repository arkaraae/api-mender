import { authenticatedEditor, base64urlSha256, githubConfiguration, onboardingDatabase, randomState, sha256, statePattern } from '@/lib/github-onboarding';

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { state?: unknown; installationId?: unknown } | null;
  const installationId = Number(body?.installationId);
  if (typeof body?.state !== 'string' || !statePattern.test(body.state)
    || !Number.isSafeInteger(installationId) || installationId <= 0)
    return Response.json({ error: 'Invalid GitHub return' }, { status: 400 });
  const config = githubConfiguration();
  if (!config) return Response.json({ error: 'GitHub authorization is not configured' }, { status: 503 });
  const database = onboardingDatabase();
  const stateHash = await sha256(body.state);
  const { data: attempt, error } = await database.from('github_onboarding_attempts')
    .select('workspace_id,user_id,installation_id,code_verifier,expires_at,consumed_at')
    .eq('state_hash', stateHash).maybeSingle();
  if (error || !attempt || attempt.consumed_at || Date.parse(attempt.expires_at) <= Date.now())
    return Response.json({ error: 'GitHub connection expired; start again' }, { status: 410 });
  const identity = await authenticatedEditor(request, attempt.workspace_id);
  if (!identity || identity.user.id !== attempt.user_id)
    return Response.json({ error: 'Sign in to the workspace account that started this connection' }, { status: 403 });
  if (attempt.installation_id && attempt.installation_id !== installationId)
    return Response.json({ error: 'GitHub installation changed; start again' }, { status: 409 });
  let verifier = attempt.code_verifier as string | null;
  if (!verifier) {
    verifier = randomState();
    const { data: updated, error: updateError } = await database.from('github_onboarding_attempts')
      .update({ installation_id: installationId, code_verifier: verifier })
      .eq('state_hash', stateHash).is('installation_id', null).is('consumed_at', null)
      .select('state_hash').maybeSingle();
    if (updateError || !updated) return Response.json({ error: 'GitHub connection changed; start again' }, { status: 409 });
  }
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.callback);
  url.searchParams.set('state', body.state);
  url.searchParams.set('code_challenge', base64urlSha256(await sha256(verifier)));
  url.searchParams.set('code_challenge_method', 'S256');
  return Response.json({ url: url.toString() }, { headers: { 'Cache-Control': 'no-store' } });
}
