-- Customer-declared links between an API request field and a Postgres column.
-- A link is evidence of intent, not proof of a runtime database dependency.
create table public.api_database_mappings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  source_id uuid not null,
  repository_id uuid not null,
  endpoint text not null check (char_length(endpoint) between 3 and 256),
  request_field text not null check (char_length(request_field) between 1 and 128),
  schema_label text not null check (char_length(schema_label) between 1 and 80),
  table_name text not null check (char_length(table_name) between 1 and 128),
  column_name text not null check (char_length(column_name) between 1 and 128),
  created_at timestamptz not null default now(),
  unique (workspace_id, source_id, repository_id, endpoint, request_field, schema_label, table_name, column_name),
  foreign key (source_id, repository_id) references public.api_contract_consumers(source_id, repository_id) on delete cascade
);
create index api_database_mappings_binding_idx
  on public.api_database_mappings(workspace_id, source_id, repository_id);

alter table public.api_database_mappings enable row level security;
revoke all on public.api_database_mappings from anon, authenticated;
grant select, insert, delete on public.api_database_mappings to authenticated;
grant select, insert, delete on public.api_database_mappings to service_role;

create policy api_database_mappings_read on public.api_database_mappings for select to authenticated
  using (private.is_workspace_member(workspace_id));
create policy api_database_mappings_insert on public.api_database_mappings for insert to authenticated
  with check (private.can_edit_workspace(workspace_id) and exists (
    select 1 from public.api_contract_consumers binding
    where binding.source_id = api_database_mappings.source_id
      and binding.repository_id = api_database_mappings.repository_id
      and binding.workspace_id = api_database_mappings.workspace_id
      and not binding.paused
  ));
create policy api_database_mappings_delete on public.api_database_mappings for delete to authenticated
  using (private.can_edit_workspace(workspace_id));
