import { env } from 'cloudflare:workers';
import { authenticatedEditor, githubHeaders, onboardingDatabase, uuid } from '@/lib/github-onboarding';
import { installationToken, readBoundedBody } from '@/lib/github-app';

const noStore = { 'Cache-Control': 'no-store' };
const sha = /^[a-f0-9]{40}$/;
const cooldownMs = 5 * 60_000;

export async function POST(request: Request) {
  let body: { workspaceId?: unknown; repositoryId?: unknown } | null;
  try { body = JSON.parse(new TextDecoder().decode(await readBoundedBody(request, 2048))); }
  catch { return Response.json({ error: 'Invalid request' }, { status: 400, headers: noStore }); }
  if (!body || Object.keys(body).sort().join(',') !== 'repositoryId,workspaceId'
    || typeof body.workspaceId !== 'string' || !uuid.test(body.workspaceId)
    || typeof body.repositoryId !== 'string' || !uuid.test(body.repositoryId))
    return Response.json({ error: 'Invalid scan request' }, { status: 400, headers: noStore });
  if (!await authenticatedEditor(request, body.workspaceId))
    return Response.json({ error: 'Workspace editor sign-in required' }, { status: 403, headers: noStore });
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY)
    return Response.json({ error: 'GitHub scanning is not configured' }, { status: 503, headers: noStore });
  const database = onboardingDatabase();
  const { data: repository, error: lookupError } = await database.from('monitored_repositories')
    .select('id,workspace_id,full_name,branch,github_installation_id,github_repo_id,paused')
    .eq('id', body.repositoryId).eq('workspace_id', body.workspaceId).maybeSingle();
  if (lookupError || !repository || repository.paused || !repository.github_installation_id || !repository.github_repo_id)
    return Response.json({ error: 'Installed repository not found or paused' }, { status: 404, headers: noStore });
  try {
    const token = await installationToken({ appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_APP_PRIVATE_KEY }, Number(repository.github_installation_id), Number(repository.github_repo_id));
    const repo = repository.full_name.split('/').map(encodeURIComponent).join('/');
    const response = await fetch(`https://api.github.com/repos/${repo}/branches/${encodeURIComponent(repository.branch)}`, {
      headers: { ...githubHeaders, Authorization: `Bearer ${token}` },
      redirect: 'error', signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error('Could not verify the current GitHub branch');
    const branch = await response.json() as { commit?: { sha?: string } };
    const head = branch.commit?.sha;
    if (!head || !sha.test(head)) throw new Error('GitHub returned an invalid branch commit');
    const { data: previous, error: previousError } = await database.from('repository_scan_jobs')
      .select('status,finished_at').eq('repository_id', repository.id).eq('head_sha', head).maybeSingle();
    if (previousError) throw new Error('Could not check the previous scan');
    if (previous?.finished_at && Date.parse(previous.finished_at) > Date.now() - cooldownMs)
      return Response.json({ head, status: 'recent', retryAfterSeconds: 300 }, { headers: noStore });
    if (previous?.status === 'queued' || previous?.status === 'running')
      return Response.json({ head, status: previous.status }, { headers: noStore });
    const { error: queueError } = await database.from('repository_scan_jobs').insert({
      workspace_id: body.workspaceId, repository_id: repository.id, head_sha: head,
    });
    if (queueError && queueError.code !== '23505') throw new Error('Could not queue the installed repository scan');
    const { error: targetError } = await database.from('monitored_repositories')
      .update({ target_sha: head }).eq('id', repository.id).eq('workspace_id', body.workspaceId);
    if (targetError) throw new Error('Could not mark the latest GitHub commit');
    const { data: job, error: jobError } = await database.from('repository_scan_jobs')
      .select('id,status,finished_at').eq('repository_id', repository.id).eq('head_sha', head).maybeSingle();
    if (jobError || !job) throw new Error('Could not read the queued scan');
    if (job.status === 'queued' || job.status === 'running')
      return Response.json({ head, status: job.status }, { headers: noStore });
    if (!job.finished_at || Date.parse(job.finished_at) > Date.now() - cooldownMs)
      return Response.json({ head, status: 'recent', retryAfterSeconds: 300 }, { headers: noStore });
    const { data: reset, error: resetError } = await database.from('repository_scan_jobs')
      .update({ status: 'queued', attempts: 0, available_at: new Date().toISOString(),
        lease_token: null, leased_until: null, finished_at: null, last_error: null })
      .eq('id', job.id).in('status', ['succeeded', 'dead'])
      .lt('finished_at', new Date(Date.now() - cooldownMs).toISOString())
      .select('id').maybeSingle();
    if (resetError) throw new Error('Could not requeue the scan');
    return Response.json({ head, status: reset ? 'queued' : 'already_queued' }, { headers: noStore });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Could not start installed scan' },
      { status: 502, headers: noStore });
  }
}
