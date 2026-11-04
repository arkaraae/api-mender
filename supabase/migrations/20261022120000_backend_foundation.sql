-- Customer backend foundation. Apply before deploying the GitHub webhook/scan worker.
-- Service-role functions are intentionally not callable with a browser JWT.
create schema if not exists private;
grant usage on schema private to authenticated;

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'editor', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

insert into public.workspace_members (workspace_id, user_id, role)
select id, owner_id, 'owner' from public.workspaces
on conflict do nothing;

create function private.add_workspace_owner_member() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.workspace_members (workspace_id, user_id, role)
  values (new.id, new.owner_id, 'owner');
  return new;
end;
$$;
create trigger workspace_owner_member after insert on public.workspaces
for each row execute function private.add_workspace_owner_member();

create function private.is_workspace_member(target_workspace uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = target_workspace and m.user_id = (select auth.uid())
  );
$$;
create function private.can_edit_workspace(target_workspace uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = target_workspace and m.user_id = (select auth.uid())
      and m.role in ('owner', 'editor')
  );
$$;

revoke all on function private.add_workspace_owner_member() from public, anon, authenticated;
revoke all on function private.is_workspace_member(uuid), private.can_edit_workspace(uuid) from public, anon;
grant execute on function private.is_workspace_member(uuid), private.can_edit_workspace(uuid) to authenticated;

alter table public.monitored_repositories
  add column github_repo_id bigint,
  add column target_sha text check (target_sha is null or target_sha ~ '^[a-f0-9]{40}$');

alter table public.workspace_members enable row level security;
revoke all on public.workspace_members from anon, authenticated;
grant select, insert, update, delete on public.workspace_members to authenticated;
grant select, insert, update, delete on public.workspace_members to service_role;
create policy workspace_members_read on public.workspace_members for select to authenticated
  using (private.is_workspace_member(workspace_id));
create policy workspace_members_owner_insert on public.workspace_members for insert to authenticated
  with check (exists (select 1 from public.workspaces w where w.id = workspace_id and w.owner_id = (select auth.uid())) and role <> 'owner');
create policy workspace_members_owner_update on public.workspace_members for update to authenticated
  using (exists (select 1 from public.workspaces w where w.id = workspace_id and w.owner_id = (select auth.uid())) and role <> 'owner')
  with check (exists (select 1 from public.workspaces w where w.id = workspace_id and w.owner_id = (select auth.uid())) and role <> 'owner');
create policy workspace_members_owner_delete on public.workspace_members for delete to authenticated
  using (exists (select 1 from public.workspaces w where w.id = workspace_id and w.owner_id = (select auth.uid())) and role <> 'owner');

drop policy workspaces_select on public.workspaces;
create policy workspaces_select on public.workspaces for select to authenticated
  using (private.is_workspace_member(id));
drop policy repositories_select on public.monitored_repositories;
create policy repositories_select on public.monitored_repositories for select to authenticated
  using (private.is_workspace_member(workspace_id));
drop policy repositories_insert on public.monitored_repositories;
create policy repositories_insert on public.monitored_repositories for insert to authenticated
  with check (private.can_edit_workspace(workspace_id) and github_installation_id is null
    and github_repo_id is null and target_sha is null and head_sha is null
    and sdk_version is null and api_version is null and scanned_at is null
    and call_sites = '[]'::jsonb and limitations = '[]'::jsonb);
drop policy repositories_update on public.monitored_repositories;
create policy repositories_update on public.monitored_repositories for update to authenticated
  using (private.can_edit_workspace(workspace_id))
  with check (private.can_edit_workspace(workspace_id));
drop policy repositories_delete on public.monitored_repositories;
create policy repositories_delete on public.monitored_repositories for delete to authenticated
  using (private.can_edit_workspace(workspace_id));
drop policy snapshots_select on public.source_snapshots;
create policy snapshots_select on public.source_snapshots for select to authenticated
  using (private.is_workspace_member(workspace_id));
drop policy findings_select on public.findings;
create policy findings_select on public.findings for select to authenticated
  using (private.is_workspace_member(workspace_id));

drop policy managed_apis_owner_read on public.managed_apis;
create policy managed_apis_member_read on public.managed_apis for select to authenticated
  using (private.is_workspace_member(workspace_id));
drop policy managed_apis_owner_insert on public.managed_apis;
create policy managed_apis_editor_insert on public.managed_apis for insert to authenticated
  with check (private.can_edit_workspace(workspace_id));
drop policy managed_apis_owner_update on public.managed_apis;
create policy managed_apis_editor_update on public.managed_apis for update to authenticated
  using (private.can_edit_workspace(workspace_id)) with check (private.can_edit_workspace(workspace_id));
drop policy managed_api_versions_owner_read on public.managed_api_versions;
create policy managed_api_versions_member_read on public.managed_api_versions for select to authenticated
  using (exists (select 1 from public.managed_apis a where a.id = api_id and private.is_workspace_member(a.workspace_id)));
drop policy managed_api_versions_owner_insert on public.managed_api_versions;
create policy managed_api_versions_editor_insert on public.managed_api_versions for insert to authenticated
  with check (published_by = (select auth.uid()) and exists
    (select 1 from public.managed_apis a where a.id = api_id and private.can_edit_workspace(a.workspace_id)));
drop policy managed_api_products_owner_read on public.managed_api_products;
create policy managed_api_products_member_read on public.managed_api_products for select to authenticated
  using (exists (select 1 from public.managed_apis a where a.id = api_id and private.is_workspace_member(a.workspace_id)));
drop policy managed_api_products_owner_insert on public.managed_api_products;
create policy managed_api_products_editor_insert on public.managed_api_products for insert to authenticated
  with check (exists (select 1 from public.managed_apis a where a.id = api_id and private.can_edit_workspace(a.workspace_id)));
drop policy managed_api_products_owner_update on public.managed_api_products;
create policy managed_api_products_editor_update on public.managed_api_products for update to authenticated
  using (exists (select 1 from public.managed_apis a where a.id = api_id and private.can_edit_workspace(a.workspace_id)))
  with check (exists (select 1 from public.managed_apis a where a.id = api_id and private.can_edit_workspace(a.workspace_id)));
drop policy managed_api_products_owner_delete on public.managed_api_products;
create policy managed_api_products_editor_delete on public.managed_api_products for delete to authenticated
  using (exists (select 1 from public.managed_apis a where a.id = api_id and private.can_edit_workspace(a.workspace_id)));

-- The installation binding is established by an operator after verifying the
-- customer and installation. A setup URL's installation_id alone is not proof.
create table public.github_installations (
  installation_id bigint primary key check (installation_id > 0),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  account_login text not null,
  suspended_at timestamptz,
  created_at timestamptz not null default now()
);
create index github_installations_workspace_idx on public.github_installations(workspace_id);
alter table public.github_installations enable row level security;
revoke all on public.github_installations from anon, authenticated;
grant select on public.github_installations to authenticated;
grant select, insert, update, delete on public.github_installations to service_role;
create policy github_installations_read on public.github_installations for select to authenticated
  using (private.is_workspace_member(workspace_id));
create function private.keep_installation_workspace() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.workspace_id is distinct from old.workspace_id then
    raise exception 'GitHub installation workspace cannot change';
  end if;
  return new;
end;
$$;
create trigger github_installation_workspace before update on public.github_installations
for each row execute function private.keep_installation_workspace();
revoke all on function private.keep_installation_workspace() from public, anon, authenticated;

create unique index monitored_repositories_github_id_idx
  on public.monitored_repositories(workspace_id, github_repo_id) where github_repo_id is not null;
alter table public.monitored_repositories add constraint monitored_repositories_installation_fk
  foreign key (github_installation_id) references public.github_installations(installation_id) on delete set null;

create function private.protect_repository_scan_fields() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user = 'authenticated' and (
    new.github_installation_id is distinct from old.github_installation_id or
    new.github_repo_id is distinct from old.github_repo_id or
    new.target_sha is distinct from old.target_sha or
    new.head_sha is distinct from old.head_sha or
    new.sdk_version is distinct from old.sdk_version or
    new.api_version is distinct from old.api_version or
    new.call_sites is distinct from old.call_sites or
    new.limitations is distinct from old.limitations or
    new.scanned_at is distinct from old.scanned_at
  ) then raise exception 'Scan and GitHub fields are server-managed'; end if;
  return new;
end;
$$;
create trigger repository_scan_fields before update on public.monitored_repositories
for each row execute function private.protect_repository_scan_fields();
revoke all on function private.protect_repository_scan_fields() from public, anon, authenticated;

-- The webhook ledger and scan queue are server-only. Each delivery and each
-- repository/SHA pair is idempotent, even when GitHub retries a webhook.
create table public.github_webhook_deliveries (
  delivery_id uuid primary key,
  installation_id bigint not null references public.github_installations(installation_id) on delete cascade,
  repository_id uuid not null references public.monitored_repositories(id) on delete cascade,
  event text not null,
  received_at timestamptz not null default now()
);
create table public.repository_scan_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  repository_id uuid not null references public.monitored_repositories(id) on delete cascade,
  head_sha text not null check (head_sha ~ '^[a-f0-9]{40}$'),
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'dead')),
  attempts integer not null default 0 check (attempts between 0 and 5),
  available_at timestamptz not null default now(),
  lease_token uuid,
  leased_until timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (repository_id, head_sha)
);
create index repository_scan_jobs_claim_idx on public.repository_scan_jobs(status, available_at, leased_until);
create index repository_scan_jobs_workspace_idx on public.repository_scan_jobs(workspace_id, created_at desc);
alter table public.github_webhook_deliveries enable row level security;
alter table public.repository_scan_jobs enable row level security;
revoke all on public.github_webhook_deliveries, public.repository_scan_jobs from anon, authenticated;
grant select on public.repository_scan_jobs to authenticated;
grant select, insert, update, delete on public.github_webhook_deliveries, public.repository_scan_jobs to service_role;
create policy repository_scan_jobs_read on public.repository_scan_jobs for select to authenticated
  using (private.is_workspace_member(workspace_id));

create function public.enqueue_github_scan(
  p_delivery_id uuid, p_installation_id bigint, p_github_repo_id bigint,
  p_head_sha text, p_event text
) returns boolean
language plpgsql security definer set search_path = '' as $$
declare selected_repo public.monitored_repositories%rowtype;
begin
  if p_head_sha !~ '^[a-f0-9]{40}$' or p_event <> 'push' then
    raise exception 'Invalid scan event';
  end if;
  select r.* into selected_repo from public.monitored_repositories r
  join public.github_installations i on i.installation_id = r.github_installation_id
  where i.installation_id = p_installation_id and i.workspace_id = r.workspace_id
    and i.suspended_at is null and r.github_repo_id = p_github_repo_id and not r.paused
  limit 1;
  if not found then return false; end if;
  insert into public.github_webhook_deliveries(delivery_id, installation_id, repository_id, event)
  values (p_delivery_id, p_installation_id, selected_repo.id, p_event)
  on conflict do nothing;
  if not found then return true; end if;
  insert into public.repository_scan_jobs(workspace_id, repository_id, head_sha)
  values (selected_repo.workspace_id, selected_repo.id, p_head_sha)
  on conflict (repository_id, head_sha) do nothing;
  update public.monitored_repositories set target_sha = p_head_sha where id = selected_repo.id;
  return true;
end;
$$;

create function public.claim_repository_scan_jobs(p_limit integer default 2)
returns setof public.repository_scan_jobs
language plpgsql security definer set search_path = '' as $$
begin
  if p_limit < 1 or p_limit > 10 then raise exception 'Invalid batch size'; end if;
  update public.repository_scan_jobs set status = 'dead', leased_until = null,
    lease_token = null, finished_at = now(), last_error = 'Retry limit reached'
  where status = 'running' and leased_until < now() and attempts >= 5;
  return query
  with candidates as (
    select j.id from public.repository_scan_jobs j
    where (j.status = 'queued' and j.available_at <= now())
       or (j.status = 'running' and j.leased_until < now())
    order by j.available_at, j.created_at
    limit p_limit for update skip locked
  )
  update public.repository_scan_jobs j
    set status = 'running', attempts = j.attempts + 1,
        lease_token = gen_random_uuid(), leased_until = now() + interval '3 minutes'
  from candidates c where j.id = c.id and j.attempts < 5
  returning j.*;
end;
$$;

create function public.finish_repository_scan_job(
  p_job_id uuid, p_lease_token uuid, p_succeeded boolean, p_error text default null,
  p_inventory jsonb default null
) returns boolean
language plpgsql security definer set search_path = '' as $$
declare selected_job public.repository_scan_jobs%rowtype;
begin
  select * into selected_job from public.repository_scan_jobs
  where id = p_job_id and lease_token = p_lease_token and status = 'running'
    and leased_until > now() for update;
  if not found then return false; end if;
  if p_succeeded then
    if p_inventory is null or jsonb_typeof(p_inventory->'calls') <> 'array'
      or jsonb_typeof(p_inventory->'limitations') <> 'array' then
      raise exception 'Invalid scan inventory';
    end if;
    -- Only the newest default-branch push replaces the displayed inventory.
    update public.monitored_repositories
      set head_sha = selected_job.head_sha,
          sdk_version = p_inventory->>'sdkVersion',
          api_version = p_inventory->>'apiVersion',
          call_sites = p_inventory->'calls',
          limitations = p_inventory->'limitations',
          scanned_at = now()
      where id = selected_job.repository_id and target_sha = selected_job.head_sha;
    update public.repository_scan_jobs set status = 'succeeded', lease_token = null,
      leased_until = null, finished_at = now(), last_error = null where id = p_job_id;
  else
    update public.repository_scan_jobs
      set status = case when attempts >= 5 then 'dead' else 'queued' end,
          available_at = now() + make_interval(secs => least(3600, 30 * power(2, attempts - 1)::integer)),
          lease_token = null, leased_until = null,
          last_error = left(coalesce(p_error, 'Scan failed'), 200),
          finished_at = case when attempts >= 5 then now() else null end
      where id = p_job_id;
  end if;
  return true;
end;
$$;

revoke all on function public.enqueue_github_scan(uuid,bigint,bigint,text,text),
  public.claim_repository_scan_jobs(integer),
  public.finish_repository_scan_job(uuid,uuid,boolean,text,jsonb)
  from public, anon, authenticated;
grant execute on function public.enqueue_github_scan(uuid,bigint,bigint,text,text),
  public.claim_repository_scan_jobs(integer),
  public.finish_repository_scan_job(uuid,uuid,boolean,text,jsonb) to service_role;
