// Hosted repairs for provider findings (evidence.kind 'provider-change').
// Both the prepare and publish routes go through here, so a patch is always
// re-derived from the pinned file and re-checked by every policy gate before
// anything is written to GitHub.
import { installationBelongsTo } from './installation-guard.ts';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Finding, LineEdit, RepairProposal } from './engine/types.ts';
import { parseApiCalls } from './engine/inventory.ts';
import { repairContractFor } from './engine/repair/contract.ts';
import { buildRepairTask } from './engine/repair/task.ts';
import { evaluatePatch } from './engine/repair/policy.ts';
import type { RepairContract } from './engine/repair/task.ts';

const uuid = /^[a-f0-9-]{36}$/i;

export type ProviderRepairContext = {
  finding: Finding; findingRowId: string;
  repository: { id: string; full_name: string; branch: string; github_repo_id: number; github_installation_id: number; head_sha: string };
  contract: RepairContract;
};

export class RepairConflict extends Error {}

/** Load and cross-check everything a provider repair depends on. Throws RepairConflict on stale state. */
export async function loadProviderRepairContext(database: SupabaseClient, workspaceId: string, findingId: string): Promise<ProviderRepairContext> {
  if (!uuid.test(workspaceId) || !uuid.test(findingId)) throw new RepairConflict('Invalid finding');
  const { data: row, error } = await database.from('findings')
    .select('id,workspace_id,repository_id,base_sha,evidence,status').eq('id', findingId).eq('workspace_id', workspaceId).maybeSingle();
  if (error) throw new Error('Could not load finding');
  const finding = (row?.evidence as { kind?: string; finding?: Finding } | undefined)?.finding;
  if (!row || (row.evidence as { kind?: string }).kind !== 'provider-change' || !finding || row.status === 'Dismissed')
    throw new RepairConflict('This finding cannot produce a provider repair');
  if (!finding.repairable) throw new RepairConflict('Mender has no bounded repair for this change');
  const { data: repository, error: repoError } = await database.from('monitored_repositories')
    .select('id,workspace_id,full_name,branch,github_repo_id,github_installation_id,head_sha,target_sha,paused')
    .eq('id', row.repository_id).eq('workspace_id', workspaceId).maybeSingle();
  if (repoError || !repository || repository.paused || !repository.github_installation_id || !repository.github_repo_id
    || !repository.head_sha || repository.head_sha !== repository.target_sha || row.base_sha !== repository.head_sha)
    throw new RepairConflict('The repository scan is stale; scan the current commit first');
  if (!await installationBelongsTo(database, repository.github_installation_id, workspaceId))
    throw new RepairConflict('The GitHub installation for this repository is not connected to this workspace');
  const { data: slice, error: sliceError } = await database.from('provider_contract_slices')
    .select('provider_id,version,operation,sha256,document,source_url')
    .eq('provider_id', finding.provider.id).eq('version', finding.change.toVersion).eq('operation', finding.change.operation).maybeSingle();
  if (sliceError) throw new Error('Could not load the provider contract');
  if (slice && slice.sha256 !== finding.change.newSha256) throw new RepairConflict('The provider contract changed since this finding; rescan first');
  const contract = repairContractFor(finding.change, slice ? { providerId: slice.provider_id, version: slice.version,
    operation: slice.operation, document: slice.document, sha256: slice.sha256, sourceUrl: slice.source_url } : null);
  return { finding, findingRowId: row.id, repository, contract };
}

/** Re-run every gate on saved edits against the pinned source. */
export function recheckSavedEdits(context: ProviderRepairContext, source: string, edits: LineEdit[]) {
  const task = buildRepairTask(context.finding, source, context.contract);
  if (!task.supported) throw new RepairConflict(`The source no longer supports this repair: ${task.reason}`);
  const result = evaluatePatch({ finding: context.finding, task, contract: context.contract, source, edits });
  if (!result.passed || result.afterSource === undefined || result.diff === undefined)
    throw new RepairConflict(`Saved repair no longer passes: ${result.checks.filter(check => !check.passed).map(check => check.name).join(', ')}`);
  return { afterSource: result.afterSource, diff: result.diff, checks: result.checks };
}

/** Columns for repair_jobs. Snippets and field names are derived by the engine, not by the model. */
export function repairJobColumns(context: ProviderRepairContext, proposal: RepairProposal, source: string, afterSource: string) {
  const { finding } = context;
  const fieldsAt = (text: string) => parseApiCalls(finding.location.file, text)
    .find(call => call.line === finding.location.line && call.origin === finding.evidence.call.origin)?.fields ?? [];
  const before = fieldsAt(source);
  const added = fieldsAt(afterSource).filter(field => !before.includes(field));
  const oldField = finding.change.fields[0] ?? 'request';
  const line = (prefix: '-' | '+') => proposal.diff.split('\n')
    .find(text => text.startsWith(prefix) && !text.startsWith(`${prefix}${prefix}${prefix}`))?.slice(1).trim().slice(0, 256) || '(empty line)';
  return {
    file_path: proposal.file, line_number: finding.location.line,
    source_sha256: proposal.sourceSha256, patched_sha256: proposal.patchedSha256,
    contract_sha256: finding.change.newSha256,
    old_field: oldField.slice(0, 128), new_field: (added[0] ?? oldField).slice(0, 128),
    before_snippet: line('-'), after_snippet: line('+'),
    generation_method: proposal.method === 'deterministic' ? 'deterministic' : 'self_hosted_model',
    model_id: proposal.model, patch_edits: proposal.edits, proposed_diff: proposal.diff.slice(0, 16_000),
    policy_checks: proposal.policy.map(check => ({ name: check.name, passed: check.passed })),
    uncertainty: proposal.uncertainty.slice(0, 10),
  };
}

/** Markdown evidence for the draft PR, built only from engine-generated text. */
export function pullRequestDetails(context: ProviderRepairContext, checks: { name: string; passed: boolean }[], uncertainty: string[]) {
  const { finding } = context;
  return [
    `**Upstream change:** ${finding.change.summary}`,
    `**Affected call:** \`${finding.location.file}:${finding.location.line}\` (${finding.change.operation}).`,
    `**Impact:** ${finding.impact.summary}`,
    `**Evidence:** confidence ${finding.confidence}; applicability ${finding.evidence.applicability}; ${finding.verification}. Contract SHA-256 ${finding.change.oldSha256.slice(0, 12)} → ${finding.change.newSha256.slice(0, 12)}.`,
    `**Patch checks passed:** ${checks.map(check => check.name).join(', ')}.`,
    ...uncertainty.map(item => `- ${item}`),
  ].join('\n\n');
}
