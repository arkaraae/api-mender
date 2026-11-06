import type { SupabaseClient } from '@supabase/supabase-js';

type Change = { workspaceId: string; findingId: string; userId: string; dismissed: boolean };

/** Hide or restore one workspace finding, recording who dismissed it. Returns the saved status, or null if not found. */
export async function setFindingDismissed(database: SupabaseClient, change: Change) {
  const now = new Date().toISOString();
  const values = change.dismissed
    ? { status: 'Dismissed', dismissed_at: now, dismissed_by: change.userId, updated_at: now }
    : { status: 'Action required', dismissed_at: null, dismissed_by: null, updated_at: now };
  const query = database.from('findings').update(values)
    .eq('id', change.findingId).eq('workspace_id', change.workspaceId);
  // Restoring must not overwrite a finding that is not currently dismissed.
  const scoped = change.dismissed ? query : query.eq('status', 'Dismissed');
  const { data, error } = await scoped.select('id,status').maybeSingle();
  if (error) throw error;
  return data?.status as string | undefined ?? null;
}
