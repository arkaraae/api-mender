-- Scans stop sending status on upsert, so a new finding takes this default and a
-- rescan cannot undo a dismissal. Apply before deploying the Worker that relies on it.
alter table public.findings
  alter column status set default 'Action required',
  add column if not exists dismissed_at timestamptz,
  add column if not exists dismissed_by uuid references auth.users(id) on delete set null;
