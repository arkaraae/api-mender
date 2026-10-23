-- Customer-attested schema metadata. There is deliberately no database DSN,
-- password, row content, or production connection in API Mender's data plane.
-- Requires 20261022120000_backend_foundation.sql for membership checks.
create table public.database_schema_snapshots (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  label text not null check (char_length(label) between 1 and 80),
  source text not null default 'customer-attested' check (source = 'customer-attested'),
  fingerprint text not null check (fingerprint ~ '^[a-f0-9]{64}$'),
  captured_at timestamptz not null,
  on_replica boolean not null,
  columns jsonb not null check (
    case when jsonb_typeof(columns) = 'array' then jsonb_array_length(columns) <= 5000 else false end
    and octet_length(columns::text) <= 1000000
  ),
  created_at timestamptz not null default now(),
  unique (workspace_id, label, fingerprint)
);
create index database_schema_snapshots_latest_idx
  on public.database_schema_snapshots(workspace_id, label, captured_at desc);

alter table public.database_schema_snapshots enable row level security;
revoke all on public.database_schema_snapshots from anon, authenticated;
grant select on public.database_schema_snapshots to authenticated;
grant select, insert on public.database_schema_snapshots to service_role;
create policy database_schema_snapshots_read on public.database_schema_snapshots
  for select to authenticated using (private.is_workspace_member(workspace_id));
-- Uploads go through the authenticated route's strict parser and editor check.
-- Direct PostgREST inserts from a browser are not granted.
