-- Fixed-window request limits for expensive or public routes (scans, model
-- repairs, publishing, forms). Counters are keyed by route and caller (user
-- ID, CLI token or IP) and only the Worker's service role touches them.
create table if not exists public.api_rate_limits (
  bucket text not null check (char_length(bucket) <= 200),
  window_start timestamptz not null,
  hits integer not null default 1 check (hits >= 0),
  primary key (bucket, window_start)
);
alter table public.api_rate_limits enable row level security;
revoke all on public.api_rate_limits from public, anon, authenticated;
grant select, insert, update, delete on public.api_rate_limits to service_role;

-- Counts one request; true when it is within the limit.
create or replace function public.hit_rate_limit(p_bucket text, p_limit integer, p_window_seconds integer)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_window timestamptz := to_timestamp(floor(extract(epoch from now()) / greatest(p_window_seconds, 1)) * greatest(p_window_seconds, 1));
  v_hits integer;
begin
  if p_bucket is null or char_length(p_bucket) > 200 or p_limit < 1 then return false; end if;
  insert into public.api_rate_limits (bucket, window_start, hits) values (p_bucket, v_window, 1)
  on conflict (bucket, window_start) do update set hits = public.api_rate_limits.hits + 1
  returning hits into v_hits;
  -- Old windows are cleared now and then, so the table stays small.
  if random() < 0.01 then delete from public.api_rate_limits where window_start < now() - interval '2 days'; end if;
  return v_hits <= p_limit;
end;
$$;
revoke all on function public.hit_rate_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.hit_rate_limit(text, integer, integer) to service_role;
