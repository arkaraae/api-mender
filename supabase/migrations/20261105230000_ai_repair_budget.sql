-- Provider calls are opt-in and capped before any model request is sent.
alter table public.repair_jobs
  add column generation_method text not null default 'deterministic'
    check (generation_method in ('deterministic', 'ai_assisted')),
  add column model_id text;

create table public.ai_repair_usage (
  workspace_id uuid not null,
  day_utc date not null,
  attempts integer not null default 0 check (attempts >= 0),
  primary key (workspace_id, day_utc)
);

alter table public.ai_repair_usage enable row level security;
revoke all on public.ai_repair_usage from public, anon, authenticated;
grant select, insert, update on public.ai_repair_usage to service_role;

create function public.claim_ai_repair_budget(p_workspace_id uuid)
returns boolean language plpgsql security definer set search_path = public
as $$
declare
  v_day date := (now() at time zone 'UTC')::date;
  v_global uuid := '00000000-0000-0000-0000-000000000000';
  v_global_attempts integer;
  v_workspace_attempts integer;
begin
  -- Serialize both counters, so concurrent requests cannot overspend the cap.
  perform pg_advisory_xact_lock(44005231);
  select attempts into v_global_attempts from public.ai_repair_usage
    where workspace_id = v_global and day_utc = v_day;
  select attempts into v_workspace_attempts from public.ai_repair_usage
    where workspace_id = p_workspace_id and day_utc = v_day;
  if coalesce(v_global_attempts, 0) >= 50 or coalesce(v_workspace_attempts, 0) >= 5 then
    return false;
  end if;
  insert into public.ai_repair_usage (workspace_id, day_utc, attempts)
    values (v_global, v_day, 1)
    on conflict (workspace_id, day_utc) do update
      set attempts = public.ai_repair_usage.attempts + 1;
  insert into public.ai_repair_usage (workspace_id, day_utc, attempts)
    values (p_workspace_id, v_day, 1)
    on conflict (workspace_id, day_utc) do update
      set attempts = public.ai_repair_usage.attempts + 1;
  return true;
end;
$$;

revoke all on function public.claim_ai_repair_budget(uuid) from public, anon, authenticated;
grant execute on function public.claim_ai_repair_budget(uuid) to service_role;
