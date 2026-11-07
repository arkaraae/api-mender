-- New findings take this default. The scanner uses insert-on-conflict-ignore
-- followed by an update of scan-owned fields to preserve dismissal state.
alter table public.findings
  alter column status set default 'Action required',
  add column if not exists dismissed_at timestamptz,
  add column if not exists dismissed_by uuid references auth.users(id) on delete set null;
