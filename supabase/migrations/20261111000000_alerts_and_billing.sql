-- Alerts for new findings (Slack, GitHub issues) and plans with Stripe billing.
--
-- Slack webhook URLs are secrets: only their AES-GCM ciphertext (key held by
-- the Worker as MENDER_SETTINGS_KEY) and a short hint are stored, and no
-- browser role can read either; settings are read and written through the
-- Worker's API routes with the service role.

create table if not exists public.workspace_alert_settings (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  slack_webhook_ciphertext text check (slack_webhook_ciphertext is null or char_length(slack_webhook_ciphertext) <= 2048),
  slack_webhook_hint text check (slack_webhook_hint is null or char_length(slack_webhook_hint) <= 80),
  github_issues boolean not null default false,
  min_severity text not null default 'medium' check (min_severity in ('low', 'medium', 'high')),
  -- Findings created before alerts were turned on are not sent (no backlog flood).
  alerts_since timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);
alter table public.workspace_alert_settings enable row level security;
revoke all on public.workspace_alert_settings from public, anon, authenticated;
grant select, insert, update, delete on public.workspace_alert_settings to service_role;

-- One row per finding and channel: makes sending idempotent and auditable.
create table if not exists public.finding_notifications (
  finding_id uuid not null references public.findings(id) on delete cascade,
  channel text not null check (channel in ('slack', 'github-issue')),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  status text not null check (status in ('pending', 'sent', 'failed', 'skipped')),
  detail text check (detail is null or char_length(detail) <= 500),
  url text check (url is null or (char_length(url) <= 500 and url ~ '^https://')),
  attempts integer not null default 1 check (attempts between 1 and 10),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (finding_id, channel)
);
create index if not exists finding_notifications_workspace on public.finding_notifications (workspace_id, created_at desc);
alter table public.finding_notifications enable row level security;
revoke all on public.finding_notifications from public, anon, authenticated;
grant select on public.finding_notifications to authenticated;
grant select, insert, update, delete on public.finding_notifications to service_role;
create policy finding_notifications_member_read on public.finding_notifications for select to authenticated
  using (private.is_workspace_member(workspace_id));

-- Findings due an alert, filtered in SQL so one busy workspace cannot starve
-- the others: per-workspace severity and start time, last 7 days, not
-- dismissed, and not already sent, skipped, retried out or claimed.
create or replace function public.pending_finding_alerts(p_limit integer default 100)
returns table (id uuid, workspace_id uuid, repository_id uuid, title text, description text, severity text, status text,
  created_at timestamptz, dismissed_at timestamptz, evidence jsonb)
language sql stable security definer set search_path = '' as $$
  select f.id, f.workspace_id, f.repository_id, f.title, f.description, f.severity, f.status, f.created_at, f.dismissed_at, f.evidence
  from public.findings f
  join public.workspace_alert_settings s on s.workspace_id = f.workspace_id
  where (s.slack_webhook_ciphertext is not null or s.github_issues)
    and f.dismissed_at is null
    and f.created_at >= greatest(now() - interval '7 days', s.alerts_since)
    and (case f.severity when 'high' then 2 when 'critical' then 3 when 'medium' then 1 else 0 end)
      >= (case s.min_severity when 'high' then 2 when 'medium' then 1 else 0 end)
    and (
      (s.slack_webhook_ciphertext is not null and not exists (select 1 from public.finding_notifications n
        where n.finding_id = f.id and n.channel = 'slack' and (n.status in ('sent', 'skipped') or n.attempts >= 3
          or (n.status = 'pending' and n.updated_at > now() - interval '10 minutes'))))
      or (s.github_issues and not exists (select 1 from public.finding_notifications n
        where n.finding_id = f.id and n.channel = 'github-issue' and (n.status in ('sent', 'skipped') or n.attempts >= 3
          or (n.status = 'pending' and n.updated_at > now() - interval '10 minutes'))))
    )
  order by f.created_at
  limit least(greatest(p_limit, 1), 500);
$$;
revoke all on function public.pending_finding_alerts(integer) from public, anon, authenticated;
grant execute on function public.pending_finding_alerts(integer) to service_role;

-- Claims one (finding, channel) send for this run. Overlapping cron runs
-- cannot both send: only the run whose insert or update succeeds may send.
-- A failed send is retried after two minutes, up to three attempts; a
-- claim abandoned by a killed run is taken over after ten minutes.
create or replace function public.claim_finding_notification(p_finding uuid, p_channel text, p_workspace uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_claimed uuid;
begin
  insert into public.finding_notifications (finding_id, channel, workspace_id, status, attempts)
  values (p_finding, p_channel, p_workspace, 'pending', 1)
  on conflict (finding_id, channel) do update set status = 'pending', attempts = public.finding_notifications.attempts + 1, updated_at = now()
    where public.finding_notifications.attempts < 3 and (
      (public.finding_notifications.status = 'failed' and public.finding_notifications.updated_at < now() - interval '2 minutes')
      or (public.finding_notifications.status = 'pending' and public.finding_notifications.updated_at < now() - interval '10 minutes'))
  returning finding_id into v_claimed;
  return v_claimed is not null;
end;
$$;
revoke all on function public.claim_finding_notification(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.claim_finding_notification(uuid, text, uuid) to service_role;

-- Plans. Limits live here so they can change without a deploy.
create table if not exists public.billing_plans (
  plan text primary key check (plan in ('free', 'pro')),
  repository_limit integer not null check (repository_limit between 1 and 10000)
);
insert into public.billing_plans (plan, repository_limit) values ('free', 3), ('pro', 50)
  on conflict (plan) do nothing;
alter table public.billing_plans enable row level security;
revoke all on public.billing_plans from public, anon, authenticated;
grant select on public.billing_plans to authenticated;
grant select, insert, update on public.billing_plans to service_role;
create policy billing_plans_read on public.billing_plans for select to authenticated using (true);

create table if not exists public.workspace_billing (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  plan text not null default 'free' references public.billing_plans(plan),
  status text not null default 'none' check (status in ('none', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused')),
  stripe_customer_id text unique check (stripe_customer_id is null or stripe_customer_id ~ '^cus_[A-Za-z0-9]+$'),
  stripe_subscription_id text unique check (stripe_subscription_id is null or stripe_subscription_id ~ '^sub_[A-Za-z0-9]+$'),
  current_period_end timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.workspace_billing enable row level security;
revoke all on public.workspace_billing from public, anon, authenticated;
grant select on public.workspace_billing to authenticated;
grant select, insert, update on public.workspace_billing to service_role;
create policy workspace_billing_member_read on public.workspace_billing for select to authenticated
  using (private.is_workspace_member(workspace_id));

-- Stripe retries webhooks; each event is applied once.
create table if not exists public.stripe_events (
  id text primary key check (id ~ '^evt_[A-Za-z0-9]+$'),
  type text not null check (char_length(type) <= 100),
  received_at timestamptz not null default now()
);
alter table public.stripe_events enable row level security;
revoke all on public.stripe_events from public, anon, authenticated;
grant select, insert, delete on public.stripe_events to service_role;

-- The plan a workspace is on now: paid features need an active subscription.
create or replace function private.repository_limit(p_workspace uuid) returns integer
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select p.repository_limit from public.workspace_billing b join public.billing_plans p on p.plan = b.plan
      where b.workspace_id = p_workspace and b.plan <> 'free' and b.status in ('active', 'trialing', 'past_due')),
    (select repository_limit from public.billing_plans where plan = 'free'));
$$;
revoke all on function private.repository_limit(uuid) from public, anon, authenticated;
-- Members only: another workspace's plan is not readable.
create or replace function public.workspace_repository_limit(p_workspace uuid) returns integer
language sql stable security definer set search_path = '' as $$
  select case when coalesce(current_setting('request.jwt.claim.role', true), '') = 'service_role'
      or coalesce((nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'), '') = 'service_role'
      or private.is_workspace_member(p_workspace)
    then private.repository_limit(p_workspace) end;
$$;
revoke all on function public.workspace_repository_limit(uuid) from public, anon;
grant execute on function public.workspace_repository_limit(uuid) to authenticated, service_role;

-- Every insert path (browser, GitHub connect, service role) is held to the plan.
create or replace function private.enforce_repository_limit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_limit integer := private.repository_limit(new.workspace_id);
  v_count integer;
begin
  perform pg_advisory_xact_lock(hashtext(new.workspace_id::text));
  select count(*) into v_count from public.monitored_repositories where workspace_id = new.workspace_id and not paused;
  if v_count >= v_limit then
    raise exception 'repository limit reached: this plan allows % repositories', v_limit using errcode = 'P0001', hint = 'upgrade';
  end if;
  return new;
end;
$$;
drop trigger if exists monitored_repositories_limit on public.monitored_repositories;
create trigger monitored_repositories_limit before insert on public.monitored_repositories
  for each row when (not new.paused) execute function private.enforce_repository_limit();
-- Resuming a paused repository counts as adding one.
drop trigger if exists monitored_repositories_resume_limit on public.monitored_repositories;
create trigger monitored_repositories_resume_limit before update of paused on public.monitored_repositories
  for each row when (old.paused and not new.paused) execute function private.enforce_repository_limit();

-- Notification rows age out with other operational records.
create or replace function public.apply_retention() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_reports integer;
  v_audit integer;
  v_usage integer;
  v_notifications integer;
  v_events integer;
begin
  delete from public.cli_reports where expires_at < now();
  get diagnostics v_reports = row_count;
  delete from public.audit_events where created_at < now() - interval '400 days';
  get diagnostics v_audit = row_count;
  delete from public.ai_repair_usage where day_utc < (now() at time zone 'UTC')::date - 90;
  get diagnostics v_usage = row_count;
  delete from public.finding_notifications where created_at < now() - interval '400 days';
  get diagnostics v_notifications = row_count;
  delete from public.stripe_events where received_at < now() - interval '90 days';
  get diagnostics v_events = row_count;
  return jsonb_build_object('cli_reports', v_reports, 'audit_events', v_audit,
    'ai_repair_usage', v_usage, 'finding_notifications', v_notifications, 'stripe_events', v_events);
end;
$$;
revoke all on function public.apply_retention() from public, anon, authenticated;
grant execute on function public.apply_retention() to service_role;
