import { env } from 'cloudflare:workers';
import { limits, rateLimit } from '@/lib/rate-limit';
import { authenticatedEditor, onboardingDatabase, sha256, uuid } from '@/lib/github-onboarding';
import { installationToken, readBoundedBody } from '@/lib/github-app';
import { readPinnedFile, StaleBranchError } from '@/lib/github-pinned-file';
import { publishDraftRepair } from '@/lib/repair-pr';
import { loadProviderRepairContext, pullRequestDetails, recheckSavedEdits, RepairConflict } from '@/lib/provider-repair';

const noStore = { 'Cache-Control': 'no-store' };
const reply = (status: number, body: object) => Response.json(body, { status, headers: noStore });
const publishingOrigins = new Set([
  'https://api-mender-staging.amorales8.workers.dev',
  'https://api-mender-owner-preview.amorales8.workers.dev',
  'https://api-mender-live.amorales8.workers.dev',
  'https://apimender.com',
]);

/**
 * Opens a DRAFT pull request for a saved provider repair. The saved edits are
 * re-applied to the pinned file and must pass every policy gate again and
 * reproduce the saved patched hash. Never merges; customer CI proves it.
 */
export async function POST(request: Request) {
  if (!publishingOrigins.has(env.SITE_ORIGIN ?? '')) return reply(404, { error: 'Repair publishing is not enabled here' });
  let body: { workspaceId?: unknown; jobId?: unknown } | null;
  try { body = JSON.parse(new TextDecoder().decode(await readBoundedBody(request, 2048))); }
  catch { return reply(400, { error: 'Invalid request' }); }
  if (!body || Object.keys(body).sort().join(',') !== 'jobId,workspaceId'
    || typeof body.workspaceId !== 'string' || !uuid.test(body.workspaceId)
    || typeof body.jobId !== 'string' || !uuid.test(body.jobId)) return reply(400, { error: 'Invalid repair job' });
  const identity = await authenticatedEditor(request, body.workspaceId);
  if (!identity) return reply(403, { error: 'Workspace editor sign-in required' });
  const limited = await rateLimit(onboardingDatabase(), limits.publish, identity.user.id);
  if (limited) return limited;
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) return reply(503, { error: 'GitHub App is not configured' });
  const database = onboardingDatabase();
  const { data: job, error: jobError } = await database.from('repair_jobs')
    .select('id,finding_id,repository_id,base_sha,contract_sha256,file_path,source_sha256,patched_sha256,status,pr_url,pr_number,patch_sha,generation_method,model_id,patch_edits,policy_checks,uncertainty')
    .eq('id', body.jobId).eq('workspace_id', body.workspaceId).maybeSingle();
  if (jobError) return reply(502, { error: 'Could not load repair job' });
  if (!job || !Array.isArray(job.patch_edits)) return reply(404, { error: 'Provider repair job not found' });
  if (job.status !== 'proposed')
    return job.pr_url ? reply(200, { status: job.status, prUrl: job.pr_url, prNumber: job.pr_number, patchSha: job.patch_sha })
      : reply(409, { error: 'Repair job is not ready for publishing' });
  try {
    const context = await loadProviderRepairContext(database, body.workspaceId, job.finding_id);
    const { repository, finding } = context;
    if (repository.id !== job.repository_id || repository.head_sha !== job.base_sha
      || finding.change.newSha256 !== job.contract_sha256 || finding.location.file !== job.file_path)
      return reply(409, { error: 'Repair evidence is no longer current' });
    const config = { appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_APP_PRIVATE_KEY };
    const readToken = await installationToken(config, Number(repository.github_installation_id), Number(repository.github_repo_id));
    const { source, blobSha } = await readPinnedFile({ token: readToken, fullName: repository.full_name,
      branch: repository.branch, baseSha: job.base_sha, file: job.file_path });
    if (await sha256(source) !== job.source_sha256) return reply(409, { error: 'The pinned file changed' });
    const { afterSource, checks } = recheckSavedEdits(context, source, job.patch_edits);
    if (await sha256(afterSource) !== job.patched_sha256) return reply(409, { error: 'Saved repair does not reproduce its patch' });
    let writeToken: string;
    try { writeToken = await installationToken(config, Number(repository.github_installation_id), Number(repository.github_repo_id), 'repair-write'); }
    catch { return reply(503, { error: 'GitHub App needs Contents and Pull requests write access for this repository' }); }
    const claimTime = new Date().toISOString();
    const { data: claimed } = await database.from('repair_jobs')
      .update({ status: 'publishing', publish_started_at: claimTime, updated_at: claimTime })
      .eq('id', job.id).eq('workspace_id', body.workspaceId).eq('status', 'proposed').select('id').maybeSingle();
    if (!claimed) return reply(409, { error: 'Another repair publication is in progress' });
    try {
      const published = await publishDraftRepair({ token: writeToken, fullName: repository.full_name,
        baseBranch: repository.branch, baseSha: job.base_sha, jobId: job.id, file: job.file_path, source,
        patchedSource: afterSource, sourceSha256: job.source_sha256, patchedSha256: job.patched_sha256, blobSha,
        generationMethod: job.generation_method, modelId: job.model_id,
        details: pullRequestDetails(context, checks, job.uncertainty ?? []) });
      const { data: saved } = await database.from('repair_jobs')
        .update({ status: 'proof_pending', publish_started_at: null, pr_number: published.prNumber, pr_url: published.prUrl,
          patch_branch: published.patchBranch, patch_sha: published.patchSha, updated_at: new Date().toISOString() })
        .eq('id', job.id).eq('workspace_id', body.workspaceId).eq('status', 'publishing')
        .eq('publish_started_at', claimTime).select('id').maybeSingle();
      if (!saved) throw new Error('Draft PR opened but the repair job could not be updated; retry to reconcile');
      await database.from('audit_events').insert({ workspace_id: body.workspaceId, actor_type: 'user', actor_id: identity.user.id,
        action: 'repair.draft_pr_opened', target: job.id, detail: { prNumber: published.prNumber, patchSha: published.patchSha } });
      return reply(200, { status: 'proof_pending', prUrl: published.prUrl, prNumber: published.prNumber,
        patchSha: published.patchSha, runtimeVerified: false });
    } catch (error) {
      await database.from('repair_jobs').update({ status: 'proposed', publish_started_at: null, updated_at: new Date().toISOString() })
        .eq('id', job.id).eq('workspace_id', body.workspaceId).eq('status', 'publishing').eq('publish_started_at', claimTime);
      throw error;
    }
  } catch (error) {
    if (error instanceof RepairConflict || error instanceof StaleBranchError) return reply(409, { error: error.message });
    return reply(502, { error: error instanceof Error ? error.message : 'Could not open repair pull request' });
  }
}
