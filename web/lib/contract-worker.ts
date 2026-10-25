import type { SupabaseClient } from '@supabase/supabase-js';
import { checkCurrentContractCalls, compareContracts, matchContractCalls, readGitHubContract } from './contract-source.ts';

async function digest(text: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

type Call = { file: string; line: number; symbol: string; endpoint: string; origin?: string;
  fields?: string[]; fieldsComplete?: boolean; bodyLine?: number };
type Repository = { id: string; workspace_id: string; full_name: string; head_sha?: string | null;
  target_sha?: string | null; call_sites?: Call[] };
type Source = { id: string; workspace_id: string; repository_id?: string; path: string; paused?: boolean };
type Contract = { document: object; sha256: string };

async function saveCurrentRequestFindings(database: SupabaseClient, source: Source,
  sourceRepository: Repository, sourceHead: string, contract: Contract,
  consumer: Repository, consumerHead: string, calls: Call[]) {
  const mismatches = checkCurrentContractCalls(contract.document, calls);
  if (!mismatches.length) return 0;
  const contractUrl = `https://github.com/${sourceRepository.full_name}/blob/${sourceHead}/${source.path}`;
  const { data: snapshot, error: snapshotError } = await database.from('source_snapshots').upsert({
    workspace_id: source.workspace_id, provider: 'github-openapi', source_url: contractUrl,
    sha256: contract.sha256, simulated: false,
    metadata: { sourceId: source.id, path: source.path, head: sourceHead, kind: 'current-contract-check' },
  }, { onConflict: 'workspace_id,source_url,sha256' }).select('id').single();
  if (snapshotError || !snapshot) throw snapshotError || new Error('Contract snapshot was not saved');
  for (const mismatch of mismatches) {
    const { call, missing, required } = mismatch;
    const fingerprint = await digest(`request-schema:${source.id}:${consumer.id}:${call.file}:${call.line}:${call.endpoint}:${contract.sha256}:${missing.join(',')}`);
    const codeUrl = `https://github.com/${consumer.full_name}/blob/${consumerHead}/${call.file}#L${call.bodyLine || call.line}`;
    const { error } = await database.from('findings').upsert({
      workspace_id: source.workspace_id, repository_id: consumer.id, source_id: snapshot.id,
      fingerprint, title: `JSON request is missing ${missing.join(', ')}`,
      description: `A literal JSON request body for ${mismatch.operation} omits ${missing.join(', ')}, which the current connected OpenAPI contract requires. This is static evidence; the request has not been run by this scanner.`,
      severity: 'medium', confidence: 'probable', status: 'Action required', base_sha: consumerHead,
      evidence: { kind: 'request-schema-mismatch', sourceId: source.id, contractUrl, contractSha256: contract.sha256,
        codeUrl, call: { file: call.file, line: call.line, bodyLine: call.bodyLine, endpoint: call.endpoint, origin: call.origin,
          fields: call.fields, fieldsComplete: true }, required, missing, runtimeVerified: false },
    }, { onConflict: 'repository_id,fingerprint', ignoreDuplicates: true });
    if (error) throw error;
  }
  return mismatches.length;
}

// Called on consumer pushes. The source document was already fetched during
// its own installed repository scan; no customer code or cross-repo token is run.
export async function processBoundContractConsumers(database: SupabaseClient,
  consumer: Repository, consumerHead: string, currentCalls: Call[]) {
  if (consumer.target_sha !== consumerHead) return { checked: 0, findings: 0 };
  const { data: bindings, error } = await database.from('api_contract_consumers')
    .select('source_id,workspace_id').eq('repository_id', consumer.id).eq('paused', false).limit(21);
  if (error) throw error;
  if ((bindings || []).length > 20) throw new Error('Repository exceeds the contract consumer limit');
  let checked = 0;
  let findings = 0;
  for (const binding of bindings || []) {
    if (binding.workspace_id !== consumer.workspace_id) throw new Error('Contract consumer workspace mismatch');
    const { data: source, error: sourceError } = await database.from('api_contract_sources')
      .select('id,workspace_id,repository_id,path,paused').eq('id', binding.source_id).single();
    if (sourceError || !source || source.paused || source.workspace_id !== consumer.workspace_id) continue;
    const { data: sourceRepository, error: repositoryError } = await database.from('monitored_repositories')
      .select('id,workspace_id,full_name,head_sha,target_sha,paused')
      .eq('id', source.repository_id).single();
    if (repositoryError || !sourceRepository || sourceRepository.paused
      || sourceRepository.workspace_id !== consumer.workspace_id
      || !sourceRepository.head_sha || sourceRepository.head_sha !== sourceRepository.target_sha) continue;
    const { data: version, error: versionError } = await database.from('api_contract_versions')
      .select('document,content_sha256').eq('source_id', source.id)
      .eq('head_sha', sourceRepository.head_sha).maybeSingle();
    if (versionError) throw versionError;
    if (!version) continue;
    checked++;
    findings += await saveCurrentRequestFindings(database, source, sourceRepository,
      sourceRepository.head_sha, { document: version.document, sha256: version.content_sha256 },
      consumer, consumerHead, currentCalls);
  }
  return { checked, findings };
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
    await saveCurrentRequestFindings(database, source, repository, head, current,
      repository, head, currentCalls);
    const { data: bindings, error: bindingError } = await database.from('api_contract_consumers')
      .select('repository_id,workspace_id').eq('source_id', source.id).eq('paused', false).limit(51);
    if (bindingError) throw bindingError;
    if ((bindings || []).length > 50) throw new Error('Contract source exceeds the consumer limit');
    if (bindings?.length) {
      const ids = bindings.map(binding => binding.repository_id);
      if (bindings.some(binding => binding.workspace_id !== repository.workspace_id))
        throw new Error('Contract consumer workspace mismatch');
      const { data: consumers, error: consumerError } = await database.from('monitored_repositories')
        .select('id,workspace_id,full_name,head_sha,target_sha,call_sites,paused')
        .eq('workspace_id', repository.workspace_id).in('id', ids).limit(50);
      if (consumerError) throw consumerError;
      for (const consumer of consumers || []) {
        if (consumer.paused || !consumer.head_sha || consumer.head_sha !== consumer.target_sha
          || !Array.isArray(consumer.call_sites)) continue;
        await saveCurrentRequestFindings(database, source, repository, head, current,
          consumer, consumer.head_sha, consumer.call_sites);
      }
    }
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
