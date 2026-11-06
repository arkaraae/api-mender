import { backendAdmin } from './backend-admin';
import { installationToken } from './github-app';
import { scanInstallationRepository } from './public-scan';
import { processBoundContractConsumers, processContractSources } from './contract-worker';

type Config = {
  NEXT_PUBLIC_SUPABASE_URL?: string; SUPABASE_SECRET_KEY?: string;
  GITHUB_APP_ID?: string; GITHUB_APP_PRIVATE_KEY?: string;
};

// Public OpenAPI repositories do not need a GitHub App installation. Poll a
// bounded, rotating slice every 15 minutes; private consumers still use the
// short-lived repository-scoped installation token.
async function pollPublicContractSources(database: ReturnType<typeof backendAdmin>) {
  const window = Math.floor(Date.now() / 900_000);
  if (Math.floor(Date.now() / 60_000) % 15 !== 0) return;
  const { data: sources, error } = await database.from('api_contract_sources')
    .select('id,repository_id').eq('paused', false).order('created_at').limit(100);
  if (error) throw error;
  const ids = [...new Set((sources || []).map(source => source.repository_id))];
  if (!ids.length) return;
  for (let i = 0; i < Math.min(ids.length, 4); i++) {
    const id = ids[(window * 4 + i) % ids.length];
    const { data: repository, error: repoError } = await database.from('monitored_repositories')
      .select('id,workspace_id,full_name,branch,target_sha,visibility,paused').eq('id', id).maybeSingle();
    if (repoError) throw repoError;
    if (!repository || repository.paused || repository.visibility !== 'public'
      || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository.full_name)
      || !/^[A-Za-z0-9_./-]{1,120}$/.test(repository.branch) || repository.branch.includes('..')) continue;
    const repo = repository.full_name.split('/').map(encodeURIComponent).join('/');
    try {
      const response = await fetch(`https://api.github.com/repos/${repo}/branches/${encodeURIComponent(repository.branch)}`, {
        headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'api-mender-contract' },
        redirect: 'manual', signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) continue;
      const branch = await response.json() as { commit?: { sha?: string } };
      const head = branch.commit?.sha;
      if (!head || !/^[a-f0-9]{40}$/.test(head)) continue;
      const sourceIds = (sources || []).filter(source => source.repository_id === id).map(source => source.id);
      const { data: versions, error: versionError } = await database.from('api_contract_versions')
        .select('source_id').in('source_id', sourceIds).eq('head_sha', head);
      if (versionError) throw versionError;
      const needsScan = (versions || []).length < sourceIds.length;
      if (head === repository.target_sha && !needsScan) continue;
      if (head !== repository.target_sha) {
        const { error: targetError } = await database.from('monitored_repositories')
          .update({ target_sha: head }).eq('id', repository.id).eq('workspace_id', repository.workspace_id);
        if (targetError) throw targetError;
      }
      const { data: previous, error: previousError } = await database.from('repository_scan_jobs')
        .select('id,status').eq('repository_id', repository.id).eq('head_sha', head).maybeSingle();
      if (previousError) throw previousError;
      if (previous && needsScan && ['succeeded', 'dead'].includes(previous.status)) {
        const { error: resetError } = await database.from('repository_scan_jobs')
          .update({ status: 'queued', attempts: 0, available_at: new Date().toISOString(),
            lease_token: null, leased_until: null, finished_at: null, last_error: null })
          .eq('id', previous.id);
        if (resetError) throw resetError;
      } else if (!previous) {
        const { error: jobError } = await database.from('repository_scan_jobs').insert({
          workspace_id: repository.workspace_id, repository_id: repository.id, head_sha: head,
        });
        if (jobError && jobError.code !== '23505') throw jobError;
      }
    } catch (error) {
      console.warn('Public contract source poll failed', error instanceof Error ? error.message : 'unknown error');
    }
  }
}

export async function processRepositoryScanJobs(config: Config) {
  if (!config.GITHUB_APP_ID || !config.GITHUB_APP_PRIVATE_KEY) throw new Error('GitHub App is not configured');
  const database = backendAdmin(config);
  await pollPublicContractSources(database);
  const { error: dueError } = await database.rpc('enqueue_due_contract_source_scans', { p_limit: 20 });
  if (dueError) throw dueError;
  const { data: jobs, error: claimError } = await database.rpc('claim_repository_scan_jobs', { p_limit: 2 });
  if (claimError) throw claimError;
  for (const job of jobs || []) {
    try {
      const { data: repository, error: repoError } = await database.from('monitored_repositories')
        .select('id,workspace_id,full_name,branch,visibility,github_repo_id,github_installation_id,paused,target_sha')
        .eq('id', job.repository_id).single();
      if (repoError || !repository || repository.workspace_id !== job.workspace_id || repository.paused)
        throw new Error('Repository is unavailable');
      const { data: publicSource, error: sourceError } = repository.visibility === 'public'
        ? await database.from('api_contract_sources').select('id').eq('repository_id', repository.id)
          .eq('paused', false).limit(1).maybeSingle()
        : { data: null, error: null };
      if (sourceError) throw sourceError;
      let token = '';
      if (!publicSource) {
        if (!repository.github_installation_id || !repository.github_repo_id)
          throw new Error('Repository installation is unavailable');
        const { data: installation, error: installationError } = await database.from('github_installations')
          .select('installation_id,workspace_id,suspended_at').eq('installation_id', repository.github_installation_id).single();
        if (installationError || !installation || installation.workspace_id !== job.workspace_id || installation.suspended_at)
          throw new Error('GitHub installation is unavailable');
        token = await installationToken({ appId: config.GITHUB_APP_ID, privateKey: config.GITHUB_APP_PRIVATE_KEY },
          Number(repository.github_installation_id), Number(repository.github_repo_id));
      }
      const result = await scanInstallationRepository(repository.full_name, job.head_sha, token);
      await processContractSources(database, repository, job.head_sha, token, result.inventory.calls);
      await processBoundContractConsumers(database, repository, job.head_sha, result.inventory.calls);
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
