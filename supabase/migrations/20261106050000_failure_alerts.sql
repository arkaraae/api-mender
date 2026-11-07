-- Limits operator failure alerts to one per task per hour, across Worker isolates.
create table if not exists public.failure_alerts (
  task text primary key check (char_length(task) <= 100),
  last_sent_at timestamptz not null
);

alter table public.failure_alerts enable row level security;
revoke all on public.failure_alerts from public, anon, authenticated;
grant select, insert, update on public.failure_alerts to service_role;

create or replace function public.claim_failure_alert(p_task text)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_claimed text;
begin
  insert into public.failure_alerts (task, last_sent_at) values (p_task, now())
  on conflict (task) do update set last_sent_at = now()
    where public.failure_alerts.last_sent_at < now() - interval '1 hour'
  returning task into v_claimed;
  return v_claimed is not null;
end;
$$;

revoke all on function public.claim_failure_alert(text) from public, anon, authenticated;
grant execute on function public.claim_failure_alert(text) to service_role;
