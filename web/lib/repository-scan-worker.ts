import { backendAdmin } from './backend-admin';
import { installationToken } from './github-app';
import { scanInstallationRepository } from './public-scan';
import { processContractSources } from './contract-worker';

type Config = {
  NEXT_PUBLIC_SUPABASE_URL?: string; SUPABASE_SECRET_KEY?: string;
  GITHUB_APP_ID?: string; GITHUB_APP_PRIVATE_KEY?: string;
};

export async function processRepositoryScanJobs(config: Config) {
  if (!config.GITHUB_APP_ID || !config.GITHUB_APP_PRIVATE_KEY) throw new Error('GitHub App is not configured');
  const database = backendAdmin(config);
  const { error: dueError } = await database.rpc('enqueue_due_contract_source_scans', { p_limit: 20 });
  if (dueError) throw dueError;
  const { data: jobs, error: claimError } = await database.rpc('claim_repository_scan_jobs', { p_limit: 2 });
  if (claimError) throw claimError;
  for (const job of jobs || []) {
    try {
      const { data: repository, error: repoError } = await database.from('monitored_repositories')
        .select('id,workspace_id,full_name,github_repo_id,github_installation_id,paused,target_sha')
        .eq('id', job.repository_id).single();
      if (repoError || !repository || repository.workspace_id !== job.workspace_id || repository.paused
        || !repository.github_installation_id || !repository.github_repo_id) throw new Error('Repository installation is unavailable');
      const { data: installation, error: installationError } = await database.from('github_installations')
        .select('installation_id,workspace_id,suspended_at').eq('installation_id', repository.github_installation_id).single();
      if (installationError || !installation || installation.workspace_id !== job.workspace_id || installation.suspended_at) throw new Error('GitHub installation is unavailable');
      const token = await installationToken({ appId: config.GITHUB_APP_ID, privateKey: config.GITHUB_APP_PRIVATE_KEY },
        Number(repository.github_installation_id), Number(repository.github_repo_id));
      const result = await scanInstallationRepository(repository.full_name, job.head_sha, token);
      await processContractSources(database, repository, job.head_sha, token, result.inventory.calls);
      const { data: finished, error: finishError } = await database.rpc('finish_repository_scan_job', {
        p_job_id: job.id, p_lease_token: job.lease_token, p_succeeded: true,
        p_inventory: result.inventory,
      });
      if (finishError || !finished) throw finishError || new Error('Scan lease expired');
    } catch (error) {
      await database.rpc('finish_repository_scan_job', {
        p_job_id: job.id, p_lease_token: job.lease_token, p_succeeded: false,
        p_error: error instanceof Error ? error.message : 'Scan failed',
      });
    }
  }
  return { claimed: (jobs || []).length };
}
