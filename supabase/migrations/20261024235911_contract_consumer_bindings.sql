-- Explicitly associate an upstream OpenAPI source with a different installed
-- repository that calls it. Both sides must belong to the same workspace.
create table public.api_contract_consumers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  source_id uuid not null,
  repository_id uuid not null,
  paused boolean not null default false,
  created_at timestamptz not null default now(),
  unique (source_id, repository_id),
  foreign key (source_id, workspace_id) references public.api_contract_sources(id, workspace_id) on delete cascade,
  foreign key (repository_id, workspace_id) references public.monitored_repositories(id, workspace_id) on delete cascade
);
create index api_contract_consumers_source_workspace_idx on public.api_contract_consumers(source_id, workspace_id);
create index api_contract_consumers_repository_workspace_idx on public.api_contract_consumers(repository_id, workspace_id);
create index api_contract_consumers_workspace_idx on public.api_contract_consumers(workspace_id);

alter table public.api_contract_consumers enable row level security;
revoke all on public.api_contract_consumers from anon, authenticated;
grant select, insert, update, delete on public.api_contract_consumers to authenticated;
grant select, insert, update, delete on public.api_contract_consumers to service_role;

create policy api_contract_consumers_read on public.api_contract_consumers for select to authenticated
  using (private.is_workspace_member(workspace_id));
create policy api_contract_consumers_insert on public.api_contract_consumers for insert to authenticated
  with check (private.can_edit_workspace(workspace_id) and exists (
    select 1 from public.api_contract_sources s where s.id = source_id
      and s.workspace_id = api_contract_consumers.workspace_id and not s.paused
      and s.repository_id <> api_contract_consumers.repository_id
  ) and exists (
    select 1 from public.monitored_repositories r where r.id = repository_id
      and r.workspace_id = api_contract_consumers.workspace_id and not r.paused
      and r.github_installation_id is not null
  ));
create policy api_contract_consumers_update on public.api_contract_consumers for update to authenticated
  using (private.can_edit_workspace(workspace_id)) with check (private.can_edit_workspace(workspace_id));
create policy api_contract_consumers_delete on public.api_contract_consumers for delete to authenticated
  using (private.can_edit_workspace(workspace_id));

create function private.keep_contract_consumer_identity() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.workspace_id is distinct from old.workspace_id or
     new.source_id is distinct from old.source_id or
     new.repository_id is distinct from old.repository_id then
    raise exception 'Contract consumer identity cannot change; add a new binding instead';
  end if;
  return new;
end;
$$;
create trigger contract_consumer_identity before update on public.api_contract_consumers
for each row execute function private.keep_contract_consumer_identity();
revoke all on function private.keep_contract_consumer_identity() from public, anon, authenticated;
