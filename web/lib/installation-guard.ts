// A repository may only act through a GitHub installation that belongs to the
// same workspace. Every path that mints an App token for a repository row, or
// writes findings for it, checks this first (security review 2026-11-13).
import type { SupabaseClient } from '@supabase/supabase-js';

export async function installationBelongsTo(database: SupabaseClient, installationId: number | string | null | undefined, workspaceId: string) {
  if (!installationId) return false;
  const { data, error } = await database.from('github_installations')
    .select('workspace_id,suspended_at').eq('installation_id', installationId).maybeSingle();
  return !error && !!data && data.workspace_id === workspaceId && !data.suspended_at;
}
