import { env } from 'cloudflare:workers';
import { authenticatedEditor, githubConfiguration, githubHeaders, githubJson, onboardingDatabase, sha256, statePattern } from '@/lib/github-onboarding';
import { matchingInstallation, validAccessibleRepositories } from '@/lib/github-onboarding-policy';

import type { VerifiedInstallation as Installation, AccessibleRepository as Repository } from '@/lib/github-onboarding-policy';

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { state?: unknown; code?: unknown } | null;
  if (typeof body?.state !== 'string' || !statePattern.test(body.state)
    || typeof body.code !== 'string' || !/^[A-Za-z0-9_-]{8,256}$/.test(body.code))
    return Response.json({ error: 'Invalid GitHub authorization' }, { status: 400 });
  const config = githubConfiguration();
  if (!config || !env.GITHUB_APP_ID) return Response.json({ error: 'GitHub authorization is not configured' }, { status: 503 });
  const database = onboardingDatabase();
  const stateHash = await sha256(body.state);
  const { data: attempt, error: lookupError } = await database.from('github_onboarding_attempts')
    .select('workspace_id,user_id,installation_id,code_verifier,expires_at,consumed_at')
    .eq('state_hash', stateHash).maybeSingle();
  if (lookupError || !attempt || attempt.consumed_at || Date.parse(attempt.expires_at) <= Date.now()
    || !attempt.installation_id || !attempt.code_verifier)
    return Response.json({ error: 'GitHub connection expired; start again' }, { status: 410 });
  const identity = await authenticatedEditor(request, attempt.workspace_id);
  if (!identity || identity.user.id !== attempt.user_id)
    return Response.json({ error: 'Sign in to the workspace account that started this connection' }, { status: 403 });
  const { data: claimed, error: claimError } = await database.from('github_onboarding_attempts')
    .update({ consumed_at: new Date().toISOString() }).eq('state_hash', stateHash)
    .is('consumed_at', null).gt('expires_at', new Date().toISOString())
    .select('state_hash').maybeSingle();
  if (claimError || !claimed) return Response.json({ error: 'GitHub connection was already used' }, { status: 409 });
  let userToken: string | null = null;
  try {
    const exchange = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret,
        code: body.code, redirect_uri: config.callback, code_verifier: attempt.code_verifier }),
    });
    if (!exchange.ok) throw new Error('GitHub authorization exchange failed');
    const tokenResponse = await exchange.json() as { access_token?: string; error?: string };
    if (!tokenResponse.access_token || tokenResponse.error) throw new Error('GitHub authorization was denied or expired');
    const token = tokenResponse.access_token;
    userToken = token;
    let selected: Installation | undefined;
    for (let page = 1; page <= 5 && !selected; page++) {
      const listing = await githubJson<{ installations?: Installation[] }>(
        `https://api.github.com/user/installations?per_page=100&page=${page}`, token);
      selected = matchingInstallation(listing.installations || [], attempt.installation_id, env.GITHUB_APP_ID);
      if ((listing.installations?.length || 0) < 100) break;
    }
    if (!selected || !selected.account?.login || selected.suspended_at)
      return Response.json({ error: 'Your GitHub user cannot access this API Mender installation' }, { status: 403 });
    const repoResponse = await githubJson<{ total_count?: number; repositories?: Repository[] }>(
      `https://api.github.com/user/installations/${selected.id}/repositories?per_page=100`, token);
    const repositories = repoResponse.repositories || [];
    if ((repoResponse.total_count || 0) > 25 || repositories.length > 25)
      return Response.json({ error: 'Select 25 or fewer repositories in the GitHub installation, then reconnect' }, { status: 400 });
    if (!validAccessibleRepositories(repositories, repoResponse.total_count || 0))
      throw new Error('GitHub returned invalid repository metadata');
    const { data: existing, error: existingError } = await database.from('github_installations')
      .select('workspace_id').eq('installation_id', selected.id).maybeSingle();
    if (existingError) throw existingError;
    if (existing && existing.workspace_id !== attempt.workspace_id)
      return Response.json({ error: 'This GitHub installation is connected to another workspace' }, { status: 409 });
    const { error: installError } = await database.from('github_installations').upsert({
      installation_id: selected.id, workspace_id: attempt.workspace_id,
      account_login: selected.account.login, suspended_at: null,
    }, { onConflict: 'installation_id' });
    if (installError) throw installError;
    let queued = 0;
    for (const repo of repositories.filter(item => !item.archived)) {
      const { data: current, error: currentError } = await database.from('monitored_repositories')
        .select('id,github_installation_id').eq('workspace_id', attempt.workspace_id)
        .eq('full_name', repo.full_name).eq('branch', repo.default_branch).maybeSingle();
      if (currentError) throw currentError;
      if (current?.github_installation_id && current.github_installation_id !== selected.id)
        throw new Error('Repository is connected to a different installation');
      const values = { visibility: repo.private ? 'private' : 'public', github_installation_id: selected.id,
        github_repo_id: repo.id, paused: false };
      const write = current
        ? database.from('monitored_repositories').update(values).eq('id', current.id)
        : database.from('monitored_repositories').insert({ workspace_id: attempt.workspace_id,
          full_name: repo.full_name, branch: repo.default_branch, ...values });
      const { error: writeError } = await write;
      if (writeError) throw writeError;
      try {
        const branch = await githubJson<{ commit?: { sha?: string } }>(
          `https://api.github.com/repos/${repo.full_name}/branches/${encodeURIComponent(repo.default_branch)}`, token);
        if (typeof branch.commit?.sha !== 'string' || !/^[a-f0-9]{40}$/.test(branch.commit.sha)) continue;
        const { data: accepted, error: queueError } = await database.rpc('enqueue_github_scan', {
          p_delivery_id: crypto.randomUUID(), p_installation_id: selected.id,
          p_github_repo_id: repo.id, p_head_sha: branch.commit.sha, p_event: 'push',
        });
        if (!queueError && accepted) queued++;
      } catch { /* A later push can still queue a scan for this connected repository. */ }
    }
    return Response.json({ account: selected.account.login, repositories: repositories.length, scansQueued: queued },
      { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json({ error: 'Could not verify the GitHub installation or save its repositories. Start again.' }, { status: 502 });
  } finally {
    // The user token exists only to prove installation and repository access once.
    if (userToken) {
      try {
        await fetch(`https://api.github.com/applications/${config.clientId}/token`, {
          method: 'DELETE', redirect: 'error', signal: AbortSignal.timeout(5_000),
          headers: { ...githubHeaders, Authorization: `Basic ${btoa(`${config.clientId}:${config.clientSecret}`)}`,
            'Content-Type': 'application/json' },
          body: JSON.stringify({ access_token: userToken }),
        });
      } catch { /* The token was never persisted and GitHub will expire it. */ }
    }
  }
}
