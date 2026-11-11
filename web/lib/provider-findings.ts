// Hosted pipeline step after a repository scan: check the calls the scan found
// against the provider catalog (written by scripts/sync-provider-contracts.mjs)
// and save evidence-backed findings. Deterministic; no model, no repository
// code executed, and only catalog rows (public provider data) are read besides
// the scan's own call list.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ApiCall, ContractChange, Finding, OperationSlice } from './engine/types.ts';
import { diffOperation, diffRemovedOperation } from './engine/contract-diff.ts';
import { analyzeImpact } from './engine/impact.ts';
import { matchOperationKey } from './engine/openapi-slice.ts';
import { contractEndpoint, providerForOrigin } from './engine/providers/registry.ts';

type Repository = { id: string; workspace_id: string; full_name: string; target_sha: string | null };
type SliceRow = { provider_id: string; version: string; operation: string; sha256: string; document: object; source_url: string };

const toSlice = (row: SliceRow): OperationSlice => ({ providerId: row.provider_id, version: row.version,
  operation: row.operation, document: row.document, sha256: row.sha256, sourceUrl: row.source_url });

// The finding table's coarse scale. 'confirmed' is reserved for test proof.
const confidence = (finding: Finding) => finding.confidence === 'low' ? 'informational' : 'probable';
const severity = (finding: Finding) => finding.evidence.applicability === 'active' && finding.impact.failureMode === 'request-rejected'
  ? 'high' : finding.evidence.applicability === 'unknown' || finding.confidence === 'low' ? 'low' : 'medium';

/** Narrow scanner output (or stored call_sites JSON) to well-formed calls. */
export function asApiCalls(raw: unknown): ApiCall[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 500).filter((call): call is ApiCall => !!call && typeof call === 'object'
    && typeof call.file === 'string' && Number.isSafeInteger(call.line) && typeof call.symbol === 'string'
    && typeof call.endpoint === 'string' && typeof call.origin === 'string'
    && Array.isArray(call.fields) && call.fields.every((field: unknown) => typeof field === 'string')
    && typeof call.fieldsComplete === 'boolean'
    && (call.headers === undefined || (!!call.headers && typeof call.headers === 'object'
      && Object.values(call.headers).every(value => typeof value === 'string'))));
}

/** Pure: decide which (provider, from, to, operation) pairs the calls need. */
export function plannedComparisons(calls: ApiCall[], versionsByProvider: Map<string, { version: string; operationKeys: string[]; sourceUrl?: string }[]>) {
  const plans = new Map<string, { providerId: string; from: string; to: string; operation: string; calls: ApiCall[] }>();
  for (const call of calls) {
    const provider = providerForOrigin(call.origin);
    const versions = provider && versionsByProvider.get(provider.id);
    if (!provider || !versions?.length) continue;
    const ordered = [...versions].sort((a, b) => a.version.localeCompare(b.version));
    const newest = ordered.at(-1)!;
    // Dated-header providers: the version the call pins (or the default).
    // Snapshot providers: the baseline Mend started watching from, so every
    // change since then is checked against the code as it is now.
    const pinned = provider.versionHeader ? call.headers?.[provider.versionHeader] : undefined;
    const from = provider.versioning === 'snapshot' ? ordered[0].version : pinned ?? provider.defaultVersion;
    const fromRow = versions.find(row => row.version === from);
    if (!from || !fromRow || from >= newest.version) continue;
    const operation = matchOperationKey(fromRow.operationKeys, contractEndpoint(provider, call.endpoint));
    if (!operation) continue;
    const key = `${provider.id}\0${from}\0${operation}`;
    const plan = plans.get(key) ?? { providerId: provider.id, from, to: newest.version, operation, calls: [] };
    plan.calls.push(call);
    plans.set(key, plan);
  }
  return [...plans.values()];
}

export async function processProviderFindings(database: SupabaseClient, repository: Repository, head: string, calls: ApiCall[]) {
  if (repository.target_sha !== head) return { findings: 0 };
  const catalogCalls = calls.filter(call => providerForOrigin(call.origin)).slice(0, 200);
  if (!catalogCalls.length) return { findings: 0 };
  const providerIds = [...new Set(catalogCalls.map(call => providerForOrigin(call.origin)!.id))];
  const { data: versionRows, error } = await database.from('provider_contract_versions')
    .select('provider_id,version,operation_keys,source_url').in('provider_id', providerIds).order('version', { ascending: false }).limit(200);
  if (error) throw error;
  const versions = new Map<string, { version: string; operationKeys: string[]; sourceUrl?: string }[]>();
  for (const row of versionRows ?? [])
    versions.set(row.provider_id, [...(versions.get(row.provider_id) ?? []), { version: row.version, operationKeys: row.operation_keys, sourceUrl: row.source_url }]);

  let saved = 0;
  for (const plan of plannedComparisons(catalogCalls, versions).slice(0, 50)) {
    // Only operations whose request contract changed have slices.
    const { data: rows, error: sliceError } = await database.from('provider_contract_slices')
      .select('provider_id,version,operation,sha256,document,source_url')
      .eq('provider_id', plan.providerId).eq('operation', plan.operation).in('version', [plan.from, plan.to]);
    if (sliceError) throw sliceError;
    const before = rows?.find(row => row.version === plan.from);
    if (!before) continue;
    const after = rows?.find(row => row.version === plan.to);
    const provider = providerForOrigin(plan.calls[0].origin)!;
    const newKeys = versions.get(plan.providerId)?.find(row => row.version === plan.to)?.operationKeys ?? [];
    const toUrl = provider.contractSources.find(source => source.version === plan.to)
      ?? { url: versions.get(plan.providerId)?.find(row => row.version === plan.to)?.sourceUrl ?? '', changelogUrl: provider.contractSources.at(-1)?.changelogUrl };
    const options = { providerName: provider.name, changelogUrl: toUrl?.changelogUrl };
    const changes: ContractChange[] = after ? diffOperation(toSlice(before), toSlice(after), options)
      : newKeys.includes(plan.operation) ? []
        : [diffRemovedOperation(toSlice(before), { version: plan.to, sourceUrl: toUrl?.url ?? '' }, options)];
    if (!changes.length) continue;
    const fromKeys = versions.get(plan.providerId)!.find(row => row.version === plan.from)!.operationKeys;
    for (const finding of await analyzeImpact({ provider, changes, calls: plan.calls, operationKeys: fromKeys })) {
      const codeUrl = `https://github.com/${repository.full_name}/blob/${head}/${finding.location.file}#L${finding.location.bodyLine ?? finding.location.line}`;
      const row = {
        workspace_id: repository.workspace_id, repository_id: repository.id, fingerprint: finding.id,
        title: finding.title, description: `${finding.change.summary} ${finding.impact.summary}`.slice(0, 2000),
        severity: severity(finding), confidence: confidence(finding), base_sha: head, updated_at: new Date().toISOString(),
        evidence: { kind: 'provider-change', codeUrl, finding },
      };
      // Insert once, then update only scan-owned fields, so a rescan never
      // resets a customer's dismissal (same rule as contract-worker.ts).
      const { error: insertError } = await database.from('findings').upsert(row,
        { onConflict: 'repository_id,fingerprint', ignoreDuplicates: true, defaultToNull: false });
      if (insertError) throw insertError;
      const { workspace_id, repository_id, fingerprint, ...scanFields } = row;
      const { error: updateError } = await database.from('findings').update(scanFields)
        .eq('workspace_id', workspace_id).eq('repository_id', repository_id).eq('fingerprint', fingerprint);
      if (updateError) throw updateError;
      saved++;
    }
  }
  return { findings: saved };
}
