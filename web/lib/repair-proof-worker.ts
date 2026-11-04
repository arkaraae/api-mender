import type { SupabaseClient } from '@supabase/supabase-js';
import { backendAdmin } from './backend-admin';
import { installationToken } from './github-app';
import { evaluateRepairProof } from './repair-proof';

type Config = {
  NEXT_PUBLIC_SUPABASE_URL?: string; SUPABASE_SECRET_KEY?: string;
  GITHUB_APP_ID?: string; GITHUB_APP_PRIVATE_KEY?: string;
};

export type PendingRepairJob = {
  id: string; workspace_id: string; repository_id: string;
  pr_number: number | null; patch_branch: string | null; patch_sha: string | null;
  status: string;
};

const sha = /^[a-f0-9]{40}$/;
const githubHeaders = { Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'api-mender-proof' };

async function githubRead(url: string, token: string) {
  const response = await fetch(url, { headers: { ...githubHeaders, Authorization: `Bearer ${token}` },
    redirect: 'manual', signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
  return response.json() as Promise<any>;
}

/** Verify the exact draft PR and customer CI check before changing its saved proof. */
export async function refreshRepairProofJob(database: SupabaseClient, config: Config, job: PendingRepairJob) {
  if (!config.GITHUB_APP_ID || !config.GITHUB_APP_PRIVATE_KEY)
    throw new Error('GitHub App is not configured');
  if (!job.pr_number || !job.patch_branch || !job.patch_sha || !sha.test(job.patch_sha)
    || !['proof_pending', 'proof_failed', 'validated'].includes(job.status))
    throw new Error('Repair job has no draft PR awaiting CI proof');
  const { data: repository, error: repoError } = await database.from('monitored_repositories')
    .select('full_name,branch,github_repo_id,github_installation_id,paused')
    .eq('id', job.repository_id).eq('workspace_id', job.workspace_id).maybeSingle();
  if (repoError || !repository || repository.paused || !repository.github_repo_id || !repository.github_installation_id)
    throw new Error('Connected repository is unavailable');
  const { data: installation, error: installationError } = await database.from('github_installations')
    .select('workspace_id,suspended_at').eq('installation_id', repository.github_installation_id).maybeSingle();
  if (installationError || !installation || installation.workspace_id !== job.workspace_id || installation.suspended_at)
    throw new Error('GitHub installation is unavailable');
  const token = await installationToken({ appId: config.GITHUB_APP_ID,
    privateKey: config.GITHUB_APP_PRIVATE_KEY }, Number(repository.github_installation_id),
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
    if (typeof pr.base?.sha !== 'string' || !sha.test(pr.base.sha))
      throw new Error('GitHub returned an invalid repair PR base commit');
    if (pr.merge_commit_sha !== null && pr.merge_commit_sha !== undefined
      && (typeof pr.merge_commit_sha !== 'string' || !sha.test(pr.merge_commit_sha)))
      throw new Error('GitHub returned an invalid repair PR merge commit');
    return { baseSha: pr.base.sha as string, mergeSha: pr.merge_commit_sha as string | null };
  };
  const current = await verifyPr();
  const checkedShas = [...new Set([job.patch_sha, current.mergeSha].filter((value): value is string => !!value))];
  const responses = await Promise.all(checkedShas.map(ref => githubRead(
    `https://api.github.com/repos/${repo}/commits/${ref}/check-runs?check_name=mender-repair-proof&per_page=100`, token)));
  if (responses.some(checks => !Number.isSafeInteger(checks.total_count) || checks.total_count > 100
    || !Array.isArray(checks.check_runs)))
    throw new Error('GitHub returned an unsupported number of CI checks');
  const result = evaluateRepairProof(responses.flatMap(checks => checks.check_runs), { checkedShas,
    patchSha: job.patch_sha, baseSha: current.baseSha, prNumber: job.pr_number });
  const after = await verifyPr();
  if (after.mergeSha !== current.mergeSha || after.baseSha !== current.baseSha)
    throw new Error('The repair PR changed while CI proof was checked');
  const proof = result.proof ? { ...result.proof, observedAt: new Date().toISOString() } : {};
  const { data: updated, error: updateError } = await database.from('repair_jobs')
    .update({ status: result.status, proof, updated_at: new Date().toISOString() })
    .eq('id', job.id).eq('workspace_id', job.workspace_id).eq('patch_sha', job.patch_sha)
    .select('id').maybeSingle();
  if (updateError || !updated) throw new Error('Could not record CI proof');
  return { jobId: job.id, status: result.status,
    validation: result.status === 'validated' ? 'customer_ci_attested' : 'pending_or_failed',
    proof: result.proof };
}

/** Refresh a bounded number of pending customer checks on each Worker cron. */
export async function processRepairProofJobs(config: Config) {
  if (!config.GITHUB_APP_ID || !config.GITHUB_APP_PRIVATE_KEY) return { checked: 0 };
  const database = backendAdmin(config);
  const { data: jobs, error } = await database.from('repair_jobs')
    .select('id,workspace_id,repository_id,pr_number,patch_branch,patch_sha,status')
    .in('status', ['proof_pending', 'proof_failed'])
    .lt('updated_at', new Date(Date.now() - 60_000).toISOString())
    .order('updated_at', { ascending: true }).limit(2);
  if (error) throw error;
  for (const job of jobs || []) {
    try { await refreshRepairProofJob(database, config, job); }
    catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Could not verify customer CI';
      const { error: updateError } = await database.from('repair_jobs')
        .update({ proof: { error: message, observedAt: new Date().toISOString() },
          updated_at: new Date().toISOString() })
        .eq('id', job.id).eq('workspace_id', job.workspace_id).eq('patch_sha', job.patch_sha);
      if (updateError) console.error('Could not record CI proof error', updateError);
    }
  }
  return { checked: (jobs || []).length };
}
