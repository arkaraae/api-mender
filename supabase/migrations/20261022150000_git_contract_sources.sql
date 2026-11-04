-- A customer-owned OpenAPI JSON file in an installed GitHub repository can be
-- watched with the same signed webhook and durable scan job as source code.
create unique index monitored_repositories_id_workspace_idx on public.monitored_repositories(id, workspace_id);
create table public.api_contract_sources (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  repository_id uuid not null,
  path text not null check (char_length(path) between 1 and 256 and path ~ '^[A-Za-z0-9_./-]+\.json$'
    and path !~ '(^|/)\.\.?(/|$)' and left(path, 1) <> '/'),
  paused boolean not null default false,
  created_at timestamptz not null default now(),
  unique (repository_id, path),
  unique (id, workspace_id),
  foreign key (repository_id, workspace_id) references public.monitored_repositories(id, workspace_id) on delete cascade
);
create index api_contract_sources_workspace_idx on public.api_contract_sources(workspace_id);

create table public.api_contract_versions (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null,
  workspace_id uuid not null,
  head_sha text not null check (head_sha ~ '^[a-f0-9]{40}$'),
  content_sha256 text not null check (content_sha256 ~ '^[a-f0-9]{64}$'),
  document jsonb not null check (jsonb_typeof(document) = 'object'),
  created_at timestamptz not null default now(),
  unique (source_id, head_sha),
  foreign key (source_id, workspace_id) references public.api_contract_sources(id, workspace_id) on delete cascade
);
create index api_contract_versions_latest_idx on public.api_contract_versions(source_id, created_at desc);

alter table public.api_contract_sources enable row level security;
alter table public.api_contract_versions enable row level security;
revoke all on public.api_contract_sources, public.api_contract_versions from anon, authenticated;
grant select, insert, update, delete on public.api_contract_sources to authenticated;
grant select on public.api_contract_versions to authenticated;
grant select, insert, update, delete on public.api_contract_sources, public.api_contract_versions to service_role;

create policy api_contract_sources_read on public.api_contract_sources for select to authenticated
  using (private.is_workspace_member(workspace_id));
create policy api_contract_sources_insert on public.api_contract_sources for insert to authenticated
  with check (private.can_edit_workspace(workspace_id) and exists (
    select 1 from public.monitored_repositories r where r.id = repository_id and r.workspace_id = api_contract_sources.workspace_id
      and r.github_installation_id is not null));
create policy api_contract_sources_update on public.api_contract_sources for update to authenticated
  using (private.can_edit_workspace(workspace_id)) with check (private.can_edit_workspace(workspace_id));
create policy api_contract_sources_delete on public.api_contract_sources for delete to authenticated
  using (private.can_edit_workspace(workspace_id));
create policy api_contract_versions_read on public.api_contract_versions for select to authenticated
  using (private.is_workspace_member(workspace_id));

create function private.keep_contract_source_identity() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.workspace_id is distinct from old.workspace_id or
     new.repository_id is distinct from old.repository_id or
     new.path is distinct from old.path then
    raise exception 'Contract source identity cannot change; add a new source instead';
  end if;
  return new;
end;
$$;
create trigger contract_source_identity before update on public.api_contract_sources
for each row execute function private.keep_contract_source_identity();
revoke all on function private.keep_contract_source_identity() from public, anon, authenticated;

-- Registering a source after the repository's last scan makes that pinned SHA
-- due again. A failed/dead job is never silently retried forever.
create function public.enqueue_due_contract_source_scans(p_limit integer default 20)
returns integer language plpgsql security definer set search_path = '' as $$
declare queued_count integer;
begin
  if p_limit < 1 or p_limit > 100 then raise exception 'Invalid source batch size'; end if;
  with due as (
    select distinct r.id as repository_id, r.workspace_id, r.target_sha
    from public.api_contract_sources s
    join public.monitored_repositories r on r.id = s.repository_id
    left join lateral (
      select v.head_sha from public.api_contract_versions v
      where v.source_id = s.id order by v.created_at desc, v.id desc limit 1
    ) latest on true
    where not s.paused and not r.paused and r.github_installation_id is not null
      and r.target_sha is not null and latest.head_sha is distinct from r.target_sha
    limit p_limit
  ), reset as (
    update public.repository_scan_jobs j
      set status = 'queued', attempts = 0, available_at = now(),
          lease_token = null, leased_until = null, finished_at = null, last_error = null
    from due where j.repository_id = due.repository_id and j.head_sha = due.target_sha
      and j.status = 'succeeded'
    returning j.id
  ), inserted as (
    insert into public.repository_scan_jobs(workspace_id, repository_id, head_sha)
    select workspace_id, repository_id, target_sha from due
    on conflict (repository_id, head_sha) do nothing
    returning id
  )
  select (select count(*) from reset) + (select count(*) from inserted) into queued_count;
  return queued_count;
end;
$$;
revoke all on function public.enqueue_due_contract_source_scans(integer) from public, anon, authenticated;
grant execute on function public.enqueue_due_contract_source_scans(integer) to service_role;
