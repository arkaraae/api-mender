-- Automatic API discovery. Every external API origin a scan finds is queued
-- here; the catalog job (scripts/discover-api-contracts.mjs) looks for its
-- published OpenAPI description and, when found, watches it as provider
-- `auto:<host>` in the existing catalog tables.
--
-- Origins come from tenants' code, so this table is service-only: one
-- workspace never learns which APIs another workspace calls. Members read
-- the status of their own APIs through workspace_api_watch_status().

create table if not exists public.api_hosts (
  origin text primary key check (char_length(origin) <= 300 and origin ~ '^https://[a-z0-9.-]+$'),
  provider_id text not null unique check (provider_id ~ '^auto:[a-z0-9.-]+$'),
  status text not null default 'pending' check (status in ('pending', 'watching', 'not-found', 'failed')),
  name text check (name is null or char_length(name) <= 80),
  spec_url text check (spec_url is null or (char_length(spec_url) <= 600 and spec_url ~ '^https://')),
  spec_source text check (spec_source is null or spec_source in ('apis.guru', 'well-known')),
  base_path text check (base_path is null or (char_length(base_path) <= 200 and base_path ~ '^(/[A-Za-z0-9._~-]+)*$')),
  -- Called endpoints (METHOD /path, dynamic segments as {}), to choose among descriptions.
  sample_endpoints jsonb not null default '[]'::jsonb check (jsonb_typeof(sample_endpoints) = 'array' and jsonb_array_length(sample_endpoints) <= 50),
  detail text check (detail is null or char_length(detail) <= 300),
  attempts integer not null default 0 check (attempts between 0 and 1000),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  checked_at timestamptz,
  next_check_at timestamptz not null default now()
);
create index if not exists api_hosts_due on public.api_hosts (next_check_at);
alter table public.api_hosts enable row level security;
revoke all on public.api_hosts from public, anon, authenticated;
grant select, insert, update, delete on public.api_hosts to service_role;

-- Queue origins from a scan. New origins are checked soon; known ones only
-- refresh their sample and last-seen time. Unwatched hosts are re-checked on
-- the schedule the catalog job sets.
create or replace function public.record_api_hosts(p_hosts jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_count integer := 0;
  v_host jsonb;
begin
  if jsonb_typeof(p_hosts) <> 'array' then return 0; end if;
  for v_host in select * from jsonb_array_elements(p_hosts) limit 100 loop
    if jsonb_typeof(v_host->'origin') <> 'string' or (v_host->>'origin') !~ '^https://[a-z0-9.-]+$' or char_length(v_host->>'origin') > 300 then continue; end if;
    insert into public.api_hosts (origin, provider_id, sample_endpoints)
    values (v_host->>'origin', 'auto:' || substr(v_host->>'origin', 9),
      coalesce((select jsonb_agg(e) from (select e from jsonb_array_elements(coalesce(v_host->'endpoints', '[]'::jsonb)) e
        where jsonb_typeof(e) = 'string' and char_length(e #>> '{}') <= 300 limit 50) s), '[]'::jsonb))
    on conflict (origin) do update set last_seen_at = now(),
      sample_endpoints = (select coalesce(jsonb_agg(distinct e), '[]'::jsonb) from (
        select e from jsonb_array_elements(public.api_hosts.sample_endpoints || excluded.sample_endpoints) e limit 50) s);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;
revoke all on function public.record_api_hosts(jsonb) from public, anon, authenticated;
grant execute on function public.record_api_hosts(jsonb) to service_role;

-- Watch status of the APIs this workspace's repositories call. Members only.
create or replace function public.workspace_api_watch_status(p_workspace uuid)
returns table (origin text, status text, name text, spec_source text, checked_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select h.origin, h.status, h.name, h.spec_source, h.checked_at
  from public.api_hosts h
  where private.is_workspace_member(p_workspace)
    and exists (select 1 from public.monitored_repositories r, jsonb_array_elements(r.call_sites) c
      where r.workspace_id = p_workspace and c->>'origin' = h.origin);
$$;
revoke all on function public.workspace_api_watch_status(uuid) from public, anon;
grant execute on function public.workspace_api_watch_status(uuid) to authenticated, service_role;
