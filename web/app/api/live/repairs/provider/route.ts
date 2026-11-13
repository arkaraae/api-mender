import { env } from 'cloudflare:workers';
import { limits, rateLimit } from '@/lib/rate-limit';
import { authenticatedEditor, onboardingDatabase, uuid } from '@/lib/github-onboarding';
import { installationToken, readBoundedBody } from '@/lib/github-app';
import { readPinnedFile, StaleBranchError } from '@/lib/github-pinned-file';
import { hostedModel } from '@/lib/hosted-model';
import { proposeRepair } from '@/lib/engine/repair/index';
import { loadProviderRepairContext, recheckSavedEdits, RepairConflict, repairJobColumns } from '@/lib/provider-repair';

const noStore = { 'Cache-Control': 'no-store' };
const reply = (status: number, body: object) => Response.json(body, { status, headers: noStore });
const JOB_COLUMNS = 'id,status,pr_url,file_path,line_number,source_sha256,patched_sha256,generation_method,model_id,patch_edits,proposed_diff,policy_checks,uncertainty';

/**
 * Provider findings. Without `action`, returns the saved repair (re-checked
 * against the current pinned file) or `{ repairJob: null }`. With
 * `action: 'prepare'`, generates one: rules first, then Mender's self-hosted
 * model with only the call excerpt and the contract change. Never a hosted AI
 * provider; never a write to GitHub (publishing is a separate route).
 */
export async function POST(request: Request) {
  let body: { workspaceId?: unknown; findingId?: unknown; action?: unknown } | null;
  try { body = JSON.parse(new TextDecoder().decode(await readBoundedBody(request, 2048))); }
  catch { return reply(400, { error: 'Invalid request' }); }
  if (!body || typeof body.workspaceId !== 'string' || !uuid.test(body.workspaceId)
    || typeof body.findingId !== 'string' || !uuid.test(body.findingId)
    || (body.action !== undefined && body.action !== 'prepare')
    || Object.keys(body).some(key => !['workspaceId', 'findingId', 'action'].includes(key)))
    return reply(400, { error: 'Invalid repair request' });
  const identity = await authenticatedEditor(request, body.workspaceId);
  if (!identity) return reply(403, { error: 'Workspace editor sign-in required' });
  const limited = await rateLimit(onboardingDatabase(), limits.modelRepair, identity.user.id);
  if (limited) return limited;
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) return reply(503, { error: 'GitHub App is not configured' });
  const database = onboardingDatabase();
  try {
    const context = await loadProviderRepairContext(database, body.workspaceId, body.findingId);
    const { finding, repository } = context;
    const token = await installationToken({ appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_APP_PRIVATE_KEY },
      Number(repository.github_installation_id), Number(repository.github_repo_id));
    const { source } = await readPinnedFile({ token, fullName: repository.full_name, branch: repository.branch,
      baseSha: repository.head_sha, file: finding.location.file });
    const { data: existing, error: existingError } = await database.from('repair_jobs').select(JOB_COLUMNS)
      .eq('finding_id', context.findingRowId).eq('workspace_id', body.workspaceId)
      .eq('base_sha', repository.head_sha).eq('contract_sha256', finding.change.newSha256).maybeSingle();
    if (existingError) throw new Error('Could not read the repair job');
    const view = (job: NonNullable<typeof existing>, diff: string) => ({
      findingId: context.findingRowId, file: job.file_path, line: job.line_number, diff,
      generationMethod: job.generation_method, modelId: job.model_id ?? undefined,
      policyChecks: job.policy_checks, uncertainty: job.uncertainty, prUrl: job.pr_url ?? undefined,
      repairJob: { id: job.id, status: job.status }, validation: 'static_only', runtimeVerified: false,
    });
    if (existing) {
      // Saved edits are re-checked on every read, so a stale job is reported, not shown as current.
      const { diff } = recheckSavedEdits(context, source, existing.patch_edits ?? []);
      return reply(200, view(existing, diff));
    }
    if (body.action !== 'prepare') return reply(200, { findingId: context.findingRowId, repairJob: null });

    let model;
    try { model = hostedModel(env) ?? undefined; }
    catch { return reply(503, { error: 'The self-hosted model endpoint is misconfigured' }); }
    if (model) {
      const { data: allowed, error: budgetError } = await database.rpc('claim_ai_repair_budget', { p_workspace_id: body.workspaceId });
      if (budgetError) throw new Error('Could not check the repair budget');
      if (!allowed) return reply(429, { error: 'Repair model daily limit reached' });
    }
    const result = await proposeRepair({ finding, source, contract: context.contract, model });
    await database.from('audit_events').insert({ workspace_id: body.workspaceId, actor_type: 'user', actor_id: identity.user.id,
      action: 'abstained' in result ? 'repair.abstained' : 'repair.proposed', target: context.findingRowId,
      detail: 'abstained' in result ? { stage: result.stage } : { method: result.method, model: result.model,
        patchedSha256: result.patchedSha256, gates: result.policy.length } });
    if ('abstained' in result)
      return reply(422, { error: `Mender did not propose a patch (${result.stage}): ${result.reason}`,
        stage: result.stage, policyChecks: result.policy?.map(check => ({ name: check.name, passed: check.passed })) });
    const { afterSource } = recheckSavedEdits(context, source, result.edits);
    const { error: insertError } = await database.from('repair_jobs').insert({
      workspace_id: body.workspaceId, finding_id: context.findingRowId, repository_id: repository.id,
      created_by: identity.user.id, base_sha: repository.head_sha, ...repairJobColumns(context, result, source, afterSource),
    });
    if (insertError && insertError.code !== '23505') return reply(502, { error: 'Could not save the repair job' });
    const { data: saved } = await database.from('repair_jobs').select(JOB_COLUMNS)
      .eq('finding_id', context.findingRowId).eq('workspace_id', body.workspaceId)
      .eq('base_sha', repository.head_sha).eq('contract_sha256', finding.change.newSha256).maybeSingle();
    if (!saved) return reply(502, { error: 'Could not read the repair job' });
    return reply(200, view(saved, result.diff));
  } catch (error) {
    if (error instanceof RepairConflict || error instanceof StaleBranchError) return reply(409, { error: error.message });
    return reply(422, { error: error instanceof Error ? error.message : 'Could not prepare repair' });
  }
}
