// Hourly: compare every connected repository's saved API calls with the
// current provider catalog, so a newly published provider change is flagged
// without waiting for the customer's next push. Uses only the call inventory
// already stored by the last scan; no GitHub access, no repository content.
import type { SupabaseClient } from '@supabase/supabase-js';
import { asApiCalls, processProviderFindings } from './provider-findings.ts';
import { recordApiHosts } from './api-hosts.ts';

export const RECHECK_BATCH = 200;

type Repository = { id: string; workspace_id: string; full_name: string; head_sha: string | null; target_sha: string | null; call_sites: unknown };

export async function recheckProviderFindings(database: SupabaseClient, now = new Date()) {
  const { data, error } = await database.from('monitored_repositories')
    .select('id,workspace_id,full_name,head_sha,target_sha,call_sites')
    .eq('paused', false).not('head_sha', 'is', null).order('id').limit(RECHECK_BATCH);
  if (error) throw error;
  const perWorkspace = new Map<string, { repositories: number; findings: number }>();
  let failures = 0;
  for (const repository of (data ?? []) as Repository[]) {
    // Only the commit the last scan finished; a scan in flight will run the same step.
    if (!repository.head_sha || repository.head_sha !== repository.target_sha) continue;
    const calls = asApiCalls(repository.call_sites);
    if (!calls.length) continue;
    // Repositories scanned before discovery existed get their APIs queued too.
    await recordApiHosts(database, calls);
    try {
      const { findings } = await processProviderFindings(database, { ...repository, target_sha: repository.target_sha },
        repository.head_sha, calls);
      const tally = perWorkspace.get(repository.workspace_id) ?? { repositories: 0, findings: 0 };
      tally.repositories++; tally.findings += findings;
      perWorkspace.set(repository.workspace_id, tally);
    } catch { failures++; }
  }
  // One audit row per workspace and run: the Activity view counts these as checks.
  const rows = [...perWorkspace].map(([workspace_id, tally]) => ({ workspace_id, actor_type: 'system',
    action: 'provider.recheck', detail: { ...tally, at: now.toISOString() } }));
  if (rows.length) {
    const { error: auditError } = await database.from('audit_events').insert(rows);
    if (auditError) throw auditError;
  }
  return { workspaces: perWorkspace.size, failures };
}
