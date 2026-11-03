import { env } from 'cloudflare:workers';
import { authenticatedEditor, githubHeaders, onboardingDatabase, uuid } from '@/lib/github-onboarding';
import { installationToken, readBoundedBody } from '@/lib/github-app';
import { evaluateRepairProof } from '@/lib/repair-proof';

const noStore = { 'Cache-Control': 'no-store' };
const sha = /^[a-f0-9]{40}$/;

async function githubRead(url: string, token: string) {
  const response = await fetch(url, { headers: { ...githubHeaders, Authorization: `Bearer ${token}` },
    redirect: 'manual', signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
  return response.json() as Promise<any>;
}

/** Refresh a draft repair PR's customer-run CI attestation for its pinned patch SHA. */
export async function POST(request: Request) {
  let body: { workspaceId?: unknown; jobId?: unknown } | null;
  try { body = JSON.parse(new TextDecoder().decode(await readBoundedBody(request, 2048))); }
  catch { return Response.json({ error: 'Invalid request' }, { status: 400, headers: noStore }); }
  if (!body || Object.keys(body).sort().join(',') !== 'jobId,workspaceId'
    || typeof body.workspaceId !== 'string' || !uuid.test(body.workspaceId)
    || typeof body.jobId !== 'string' || !uuid.test(body.jobId))
    return Response.json({ error: 'Invalid proof request' }, { status: 400, headers: noStore });
  if (!await authenticatedEditor(request, body.workspaceId))
    return Response.json({ error: 'Workspace editor sign-in required' }, { status: 403, headers: noStore });
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY)
    return Response.json({ error: 'GitHub App is not configured' }, { status: 503, headers: noStore });
  const database = onboardingDatabase();
  const { data: job, error: jobError } = await database.from('repair_jobs')
    .select('id,workspace_id,repository_id,pr_number,patch_branch,patch_sha,status')
    .eq('id', body.jobId).eq('workspace_id', body.workspaceId).maybeSingle();
  if (jobError) return Response.json({ error: 'Could not load repair job' }, { status: 502, headers: noStore });
  if (!job || !job.pr_number || !job.patch_branch || !job.patch_sha || !sha.test(job.patch_sha)
    || !['proof_pending', 'proof_failed', 'validated'].includes(job.status))
    return Response.json({ error: 'Repair job has no draft PR awaiting CI proof' }, { status: 409, headers: noStore });
  const { data: repository, error: repoError } = await database.from('monitored_repositories')
    .select('full_name,branch,github_repo_id,github_installation_id,paused')
    .eq('id', job.repository_id).eq('workspace_id', body.workspaceId).maybeSingle();
  if (repoError || !repository || repository.paused || !repository.github_repo_id || !repository.github_installation_id)
    return Response.json({ error: 'Connected repository is unavailable' }, { status: 409, headers: noStore });
  try {
    const token = await installationToken({ appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_APP_PRIVATE_KEY }, Number(repository.github_installation_id),
    Number(repository.github_repo_id), 'proof-read');
    const repo = repository.full_name.split('/').map(encodeURIComponent).join('/');
    const prUrl = `https://api.github.com/repos/${repo}/pulls/${job.pr_number}`;
    const verifyPr = async () => {
      const pr = await githubRead(prUrl, token);
      if (pr.state !== 'open' || pr.head?.sha !== job.patch_sha
        || pr.head?.ref !== job.patch_branch || pr.base?.ref !== repository.branch
        || String(pr.head?.repo?.id) !== String(repository.github_repo_id)
        || String(pr.base?.repo?.id) !== String(repository.github_repo_id))
        throw new Error('The repair PR no longer points to its saved patch commit');
    };
    await verifyPr();
    const checks = await githubRead(
      `https://api.github.com/repos/${repo}/commits/${job.patch_sha}/check-runs?check_name=mender-repair-proof&per_page=100`, token);
    if (!Number.isSafeInteger(checks.total_count) || checks.total_count > 100)
      throw new Error('GitHub returned an unsupported number of CI checks');
    const result = evaluateRepairProof(checks.check_runs, job.patch_sha);
    await verifyPr();
    const proof = result.proof ? { ...result.proof, observedAt: new Date().toISOString() } : {};
    const { error: updateError } = await database.from('repair_jobs')
      .update({ status: result.status, proof, updated_at: new Date().toISOString() })
      .eq('id', job.id).eq('workspace_id', body.workspaceId).eq('patch_sha', job.patch_sha);
    if (updateError) throw new Error('Could not record CI proof');
    return Response.json({ jobId: job.id, status: result.status,
      validation: result.status === 'validated' ? 'customer_ci_attested' : 'pending_or_failed',
      proof: result.proof }, { headers: noStore });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Could not verify customer CI' },
      { status: 502, headers: noStore });
  }
}
