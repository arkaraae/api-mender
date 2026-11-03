import { env } from 'cloudflare:workers';
import { authenticatedEditor, githubHeaders, onboardingDatabase, sha256, uuid } from '@/lib/github-onboarding';
import { installationToken, readBoundedBody } from '@/lib/github-app';
import { proposeRequestFieldRepair } from '@/lib/request-repair';
import { publishDraftRepair } from '@/lib/repair-pr';

const noStore = { 'Cache-Control': 'no-store' };
const stagingOrigin = 'https://api-mender-staging.amorales8.workers.dev';
const filePath = /^[A-Za-z0-9_./-]+\.(?:m?js|c?js|tsx?)$/;
const sha = /^[a-f0-9]{40}$/;

const reply = (status: number, error: string) => Response.json({ error }, { status, headers: noStore });

/** Opens a draft PR only; it is never merged or called validated until customer CI proves it. */
export async function POST(request: Request) {
  if (env.SITE_ORIGIN !== stagingOrigin) return reply(404, 'Repair publishing is not enabled here');
  let body: { workspaceId?: unknown; jobId?: unknown } | null;
  try { body = JSON.parse(new TextDecoder().decode(await readBoundedBody(request, 2048))); }
  catch { return reply(400, 'Invalid request'); }
  if (!body || Object.keys(body).sort().join(',') !== 'jobId,workspaceId'
    || typeof body.workspaceId !== 'string' || !uuid.test(body.workspaceId)
    || typeof body.jobId !== 'string' || !uuid.test(body.jobId)) return reply(400, 'Invalid repair job');
  if (!await authenticatedEditor(request, body.workspaceId)) return reply(403, 'Workspace editor sign-in required');
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) return reply(503, 'GitHub App is not configured');
  const database = onboardingDatabase();
  const { data: job, error: jobError } = await database.from('repair_jobs')
    .select('id,workspace_id,finding_id,repository_id,base_sha,contract_sha256,file_path,line_number,source_sha256,patched_sha256,old_field,new_field,before_snippet,after_snippet,status,pr_number,pr_url,patch_branch,patch_sha,publish_started_at')
    .eq('id', body.jobId).eq('workspace_id', body.workspaceId).maybeSingle();
  if (jobError) return reply(502, 'Could not load repair job');
  if (!job) return reply(404, 'Repair job not found');
  let jobStatus = job.status;
  if (jobStatus === 'publishing' && job.publish_started_at
    && Date.parse(job.publish_started_at) < Date.now() - 5 * 60_000) {
    const { data: reclaimed, error: reclaimError } = await database.from('repair_jobs')
      .update({ status: 'proposed', publish_started_at: null, updated_at: new Date().toISOString() })
      .eq('id', job.id).eq('workspace_id', body.workspaceId).eq('status', 'publishing')
      .eq('publish_started_at', job.publish_started_at).select('id').maybeSingle();
    if (reclaimError || !reclaimed) return reply(409, 'Another repair publication is in progress');
    jobStatus = 'proposed';
  }
  if (jobStatus !== 'proposed') {
    if (job.pr_url && job.pr_number && job.patch_sha && job.patch_branch)
      return Response.json({ status: job.status, prUrl: job.pr_url, prNumber: job.pr_number,
        patchSha: job.patch_sha }, { headers: noStore });
    return reply(409, 'Repair job is not ready for publishing');
  }
  const { data: finding, error: findingError } = await database.from('findings')
    .select('id,workspace_id,repository_id,base_sha,evidence').eq('id', job.finding_id)
    .eq('workspace_id', body.workspaceId).maybeSingle();
  const evidence = finding?.evidence as Record<string, any> | undefined;
  const call = evidence?.call;
  if (findingError || !finding || finding.repository_id !== job.repository_id
    || finding.base_sha !== job.base_sha || evidence?.kind !== 'request-schema-mismatch'
    || evidence.contractSha256 !== job.contract_sha256
    || typeof evidence.sourceId !== 'string' || !uuid.test(evidence.sourceId)
    || !Array.isArray(evidence.missing) || evidence.missing.length !== 1
    || !call || call.file !== job.file_path || typeof call.file !== 'string'
    || !filePath.test(call.file) || call.file.length > 512 || call.file.startsWith('/')
    || call.file.split('/').some((part: string) => part === '.' || part === '..'))
    return reply(409, 'Repair evidence is no longer current');
  const { data: repository, error: repoError } = await database.from('monitored_repositories')
    .select('id,workspace_id,full_name,branch,github_repo_id,github_installation_id,head_sha,target_sha,paused')
    .eq('id', job.repository_id).eq('workspace_id', body.workspaceId).maybeSingle();
  if (repoError || !repository || repository.paused || !repository.github_repo_id
    || !repository.github_installation_id || repository.head_sha !== job.base_sha
    || repository.target_sha !== job.base_sha) return reply(409, 'Consumer repository must be rescanned');
  const { data: source, error: sourceError } = await database.from('api_contract_sources')
    .select('id,repository_id,paused').eq('id', evidence.sourceId)
    .eq('workspace_id', body.workspaceId).maybeSingle();
  if (sourceError || !source || source.paused) return reply(409, 'API source is unavailable');
  const { data: binding, error: bindingError } = await database.from('api_contract_consumers')
    .select('id,paused').eq('workspace_id', body.workspaceId).eq('source_id', source.id)
    .eq('repository_id', repository.id).maybeSingle();
  if (bindingError || !binding || binding.paused) return reply(409, 'Consumer binding is unavailable');
  const { data: sourceRepository, error: sourceRepoError } = await database.from('monitored_repositories')
    .select('head_sha,target_sha,paused').eq('id', source.repository_id)
    .eq('workspace_id', body.workspaceId).maybeSingle();
  if (sourceRepoError || !sourceRepository || sourceRepository.paused || !sourceRepository.head_sha
    || sourceRepository.head_sha !== sourceRepository.target_sha) return reply(409, 'API contract scan is stale');
  const { data: version, error: versionError } = await database.from('api_contract_versions')
    .select('document,content_sha256').eq('source_id', source.id)
    .eq('head_sha', sourceRepository.head_sha).maybeSingle();
  if (versionError || !version || version.content_sha256 !== job.contract_sha256)
    return reply(409, 'API contract has changed since the repair was prepared');

  try {
    const config = { appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_APP_PRIVATE_KEY };
    const readToken = await installationToken(config, Number(repository.github_installation_id),
      Number(repository.github_repo_id));
    const repo = repository.full_name.split('/').map(encodeURIComponent).join('/');
    const base = await fetch(`https://api.github.com/repos/${repo}/branches/${encodeURIComponent(repository.branch)}`, {
      headers: { ...githubHeaders, Authorization: `Bearer ${readToken}` },
      redirect: 'manual', signal: AbortSignal.timeout(15_000),
    });
    if (!base.ok) throw new Error('Could not verify the current consumer branch');
    const branch = await base.json() as { commit?: { sha?: string } };
    if (branch.commit?.sha !== job.base_sha) return reply(409, 'Consumer branch moved; rescan before publishing');
    const path = job.file_path.split('/').map(encodeURIComponent).join('/');
    const response = await fetch(`https://api.github.com/repos/${repo}/contents/${path}?ref=${job.base_sha}`, {
      headers: { ...githubHeaders, Authorization: `Bearer ${readToken}` },
      redirect: 'manual', signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error('Could not read the pinned consumer file');
    const file = await response.json() as { type?: unknown; encoding?: unknown; size?: unknown; content?: unknown; sha?: unknown };
    if (file.type !== 'file' || file.encoding !== 'base64' || typeof file.size !== 'number'
      || file.size > 64_000 || typeof file.content !== 'string' || typeof file.sha !== 'string' || !sha.test(file.sha))
      return reply(409, 'Consumer file is unsupported');
    const bytes = Uint8Array.from(atob(file.content.replace(/\s/g, '')), char => char.charCodeAt(0));
    if (bytes.byteLength !== file.size) return reply(409, 'Consumer file is incomplete');
    const sourceText = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const proposal = proposeRequestFieldRepair({ source: sourceText, evidence: call,
      contract: version.document, missing: evidence.missing });
    if (await sha256(sourceText) !== job.source_sha256
      || await sha256(proposal.afterSource) !== job.patched_sha256
      || proposal.file !== job.file_path || proposal.line !== job.line_number
      || proposal.oldField !== job.old_field || proposal.newField !== job.new_field
      || proposal.before !== job.before_snippet || proposal.after !== job.after_snippet)
      return reply(409, 'Saved repair does not match the pinned source');
    let writeToken: string;
    try { writeToken = await installationToken(config, Number(repository.github_installation_id),
      Number(repository.github_repo_id), 'repair-write'); }
    catch { return reply(503, 'GitHub App needs Contents and Pull requests write access for this repository'); }
    const claimTime = new Date().toISOString();
    const { data: claimed, error: claimError } = await database.from('repair_jobs')
      .update({ status: 'publishing', publish_started_at: claimTime, updated_at: claimTime })
      .eq('id', job.id).eq('workspace_id', body.workspaceId).eq('status', 'proposed')
      .select('id').maybeSingle();
    if (claimError) return reply(502, 'Could not reserve the repair job');
    if (!claimed) return reply(409, 'Another repair publication is in progress');
    try {
      const published = await publishDraftRepair({ token: writeToken, fullName: repository.full_name,
        baseBranch: repository.branch, baseSha: job.base_sha, jobId: job.id, file: job.file_path,
        source: sourceText, patchedSource: proposal.afterSource, sourceSha256: job.source_sha256,
        patchedSha256: job.patched_sha256, blobSha: file.sha });
      const { data: saved, error: savedError } = await database.from('repair_jobs')
        .update({ status: 'proof_pending', publish_started_at: null,
          pr_number: published.prNumber, pr_url: published.prUrl,
          patch_branch: published.patchBranch, patch_sha: published.patchSha,
          updated_at: new Date().toISOString() })
        .eq('id', job.id).eq('workspace_id', body.workspaceId).eq('status', 'publishing')
        .eq('publish_started_at', claimTime).select('id').maybeSingle();
      if (savedError || !saved) throw new Error('Draft PR opened but the repair job could not be updated; retry to reconcile');
      return Response.json({ status: 'proof_pending', prUrl: published.prUrl,
        prNumber: published.prNumber, patchSha: published.patchSha, runtimeVerified: false },
        { headers: noStore });
    } catch (error) {
      await database.from('repair_jobs')
        .update({ status: 'proposed', publish_started_at: null, updated_at: new Date().toISOString() })
        .eq('id', job.id).eq('workspace_id', body.workspaceId).eq('status', 'publishing')
        .eq('publish_started_at', claimTime);
      throw error;
    }
  } catch (error) {
    return reply(502, error instanceof Error ? error.message : 'Could not open repair pull request');
  }
}
