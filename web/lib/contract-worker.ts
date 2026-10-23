import type { SupabaseClient } from '@supabase/supabase-js';
import { compareContracts, matchContractCalls, readGitHubContract } from './contract-source';

async function digest(text: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function processContractSources(database: SupabaseClient, repository: {
  id: string; workspace_id: string; full_name: string; target_sha: string | null;
}, head: string, token: string, currentCalls: { file: string; line: number; symbol: string; endpoint: string; origin?: string }[]) {
  if (repository.target_sha !== head) return { checked: 0, changed: 0 };
  const { data: sources, error } = await database.from('api_contract_sources').select('id,workspace_id,path')
    .eq('repository_id', repository.id).eq('paused', false).limit(11);
  if (error) throw error;
  if ((sources || []).length > 10) throw new Error('Repository exceeds the contract source limit');
  let changed = 0;
  for (const source of sources || []) {
    if (source.workspace_id !== repository.workspace_id) throw new Error('Contract source workspace mismatch');
    const current = await readGitHubContract(repository.full_name, head, source.path, token);
    const { data: versions, error: versionError } = await database.from('api_contract_versions')
      .select('id,head_sha,content_sha256,document').eq('source_id', source.id)
      .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(2);
    if (versionError) throw versionError;
    let before = versions?.[0];
    if (before?.head_sha === head) before = versions?.[1];
    const { error: writeError } = await database.from('api_contract_versions').upsert({
      source_id: source.id, workspace_id: repository.workspace_id,
      head_sha: head, content_sha256: current.sha256, document: current.document,
    }, { onConflict: 'source_id,head_sha' });
    if (writeError) throw writeError;
    if (!before || before.content_sha256 === current.sha256) continue;
    const report = compareContracts(before.document, current.document);
    if (report.verdict === 'safe') continue;
    const { data: consumers, error: consumerError } = await database.from('monitored_repositories')
      .select('id,full_name,head_sha,target_sha,call_sites')
      .eq('workspace_id', repository.workspace_id).eq('paused', false).limit(51);
    if (consumerError) throw consumerError;
    const consumerCandidates = (consumers || []).flatMap(consumer => {
      const calls = consumer.id === repository.id && repository.target_sha === head
        ? currentCalls : consumer.head_sha && consumer.head_sha === consumer.target_sha && Array.isArray(consumer.call_sites)
          ? consumer.call_sites : [];
      return matchContractCalls(before.document, report.affectedEndpoints, calls)
        .map(call => ({ repositoryId: consumer.id, repository: consumer.full_name,
          commit: consumer.id === repository.id ? head : consumer.head_sha,
          file: call.file, line: call.line, symbol: call.symbol, endpoint: call.endpoint,
          sourceUrl: `https://github.com/${consumer.full_name}/blob/${consumer.id === repository.id ? head : consumer.head_sha}/${call.file}#L${call.line}` }));
    }).slice(0, 50);
    const sourceUrl = `https://github.com/${repository.full_name}/blob/${head}/${source.path}`;
    const { data: snapshot, error: snapshotError } = await database.from('source_snapshots').upsert({
      workspace_id: repository.workspace_id, provider: 'github-openapi', source_url: sourceUrl,
      sha256: current.sha256, simulated: false,
      metadata: { sourceId: source.id, path: source.path, head, verdict: report.verdict },
    }, { onConflict: 'workspace_id,source_url,sha256' }).select('id').single();
    if (snapshotError || !snapshot) throw snapshotError || new Error('Contract snapshot was not saved');
    const fingerprint = await digest(`${source.id}:${head}:${current.sha256}`);
    const { error: findingError } = await database.from('findings').upsert({
      workspace_id: repository.workspace_id, repository_id: repository.id, source_id: snapshot.id,
      fingerprint, title: report.headline,
      description: 'The connected OpenAPI contract changed. Schema comparison found a possible break. Consumer applicability and runtime behavior are not yet verified.',
      severity: report.verdict === 'breaks' ? 'medium' : 'low', confidence: 'probable',
      status: 'Action required', base_sha: head,
      evidence: { sourceUrl, oldSha256: before.content_sha256, newSha256: current.sha256,
        report, consumerCandidates,
        candidateLimitReached: (consumers || []).length > 50 || consumerCandidates.length === 50,
        note: 'Static HTTP call matches are candidates only. Schema sample checks are not live API tests or proof of consumer impact.' },
    }, { onConflict: 'repository_id,fingerprint' });
    if (findingError) throw findingError;
    changed++;
  }
  return { checked: (sources || []).length, changed };
}
