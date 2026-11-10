-- Provider-independent pipeline, self-hosted model repairs, CLI metadata
-- reports, audit trail and retention.
--
-- Apply to STAGING first. Nothing here stores customer source code: the
-- largest customer-derived values are a bounded line-edit list and a bounded
-- unified diff for one repair proposal.

-- 1. Provider contract catalog -------------------------------------------------
-- Public provider data, not tenant data, written only by the provider sync job
-- (web/scripts/sync-provider-contracts.mjs). Whole documents are tens of
-- megabytes, so the job diffs every operation offline and keeps:
--   * every operation key per version (to match calls to the right operation)
--   * slices of only the operations whose request contract changed
-- The job therefore needs no signal about which operations customers call.
create table public.provider_contract_versions (
  provider_id text not null check (provider_id ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  version text not null check (char_length(version) between 1 and 64),
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  source_url text not null check (source_url ~ '^https://' and char_length(source_url) <= 1024),
  operation_keys text[] not null check (cardinality(operation_keys) <= 5000),
  fetched_at timestamptz not null default now(),
  primary key (provider_id, version)
);

-- One row is one operation cut out of one provider contract version.
create table public.provider_contract_slices (
  provider_id text not null,
  version text not null,
  operation text not null check (operation ~ '^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) /' and char_length(operation) <= 512),
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  document jsonb not null check (jsonb_typeof(document) = 'object' and pg_column_size(document) <= 262144),
  source_url text not null check (source_url ~ '^https://' and char_length(source_url) <= 1024),
  fetched_at timestamptz not null default now(),
  primary key (provider_id, version, operation),
  foreign key (provider_id, version) references public.provider_contract_versions(provider_id, version) on delete cascade
);

alter table public.provider_contract_versions enable row level security;
alter table public.provider_contract_slices enable row level security;
revoke all on public.provider_contract_versions, public.provider_contract_slices from public, anon, authenticated;
grant select on public.provider_contract_versions, public.provider_contract_slices to authenticated;
grant select, insert, update, delete on public.provider_contract_versions, public.provider_contract_slices to service_role;
create policy provider_contract_versions_read on public.provider_contract_versions
  for select to authenticated using (true);
create policy provider_contract_slices_read on public.provider_contract_slices
  for select to authenticated using (true);

-- 2. Repair jobs: patches written by the self-hosted model ----------------------
-- 'ai_assisted' rows predate this migration (a hosted provider chose a field
-- name). New model repairs are always 'self_hosted_model'.
-- Drop whichever check constraint guards generation_method today (it was
-- created inline, so its name is generated) before adding the wider one.
do $$
declare v_name text;
begin
  for v_name in
    select con.conname from pg_constraint con
    where con.conrelid = 'public.repair_jobs'::regclass and con.contype = 'c'
      and pg_get_constraintdef(con.oid) like '%generation_method%'
  loop
    execute format('alter table public.repair_jobs drop constraint %I', v_name);
  end loop;
end $$;
alter table public.repair_jobs add constraint repair_jobs_generation_method_check
  check (generation_method in ('deterministic', 'ai_assisted', 'self_hosted_model'));
alter table public.repair_jobs
  -- Whole-line replacements inside the call expression; reapplied to the
  -- pinned file and re-checked by every policy gate before publishing.
  add column if not exists patch_edits jsonb
    check (patch_edits is null or (jsonb_typeof(patch_edits) = 'array' and pg_column_size(patch_edits) <= 8192)),
  add column if not exists proposed_diff text check (proposed_diff is null or char_length(proposed_diff) <= 16000),
  add column if not exists policy_checks jsonb
    check (policy_checks is null or (jsonb_typeof(policy_checks) = 'array' and pg_column_size(policy_checks) <= 8192)),
  add column if not exists uncertainty jsonb
    check (uncertainty is null or (jsonb_typeof(uncertainty) = 'array' and pg_column_size(uncertainty) <= 4096));

-- 3. CLI tokens and metadata-only reports ---------------------------------------
-- Customer-managed mode: the CLI, model and tests run in the customer's
-- environment. A report is uploaded only when the customer enables it, and
-- holds only the field groups the token allows.
create table public.cli_tokens (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  -- SHA-256 of the token. The token itself is shown once and never stored.
  token_sha256 text not null unique check (token_sha256 ~ '^[a-f0-9]{64}$'),
  allowed_fields text[] not null default '{}'
    check (allowed_fields <@ array['providers', 'findingStatus', 'filePaths', 'hashes', 'validation']::text[]),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index cli_tokens_workspace_idx on public.cli_tokens(workspace_id, created_at desc);

create table public.cli_reports (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  token_id uuid references public.cli_tokens(id) on delete set null,
  -- A label the customer chooses; not required to be the real repository name.
  repository_label text not null check (char_length(repository_label) between 1 and 200),
  commit_sha text check (commit_sha is null or commit_sha ~ '^[a-f0-9]{40}$'),
  cli_version text not null check (char_length(cli_version) <= 32),
  report jsonb not null check (jsonb_typeof(report) = 'object' and pg_column_size(report) <= 65536),
  received_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '90 days')
);
create index cli_reports_workspace_idx on public.cli_reports(workspace_id, received_at desc);
create index cli_reports_expiry_idx on public.cli_reports(expires_at);

alter table public.cli_tokens enable row level security;
alter table public.cli_reports enable row level security;
revoke all on public.cli_tokens, public.cli_reports from public, anon, authenticated;
-- Members can list tokens (never the token value: only its hash is stored, and
-- the hash column is not granted) and read reports. All writes go through the
-- Worker with the service role.
grant select (id, workspace_id, name, allowed_fields, created_at, last_used_at, revoked_at)
  on public.cli_tokens to authenticated;
grant select on public.cli_reports to authenticated;
grant select, insert, update, delete on public.cli_tokens, public.cli_reports to service_role;
create policy cli_tokens_member_read on public.cli_tokens for select to authenticated
  using (private.is_workspace_member(workspace_id));
create policy cli_reports_member_read on public.cli_reports for select to authenticated
  using (private.is_workspace_member(workspace_id));

-- 4. Audit trail ----------------------------------------------------------------
-- Append-only. `detail` is metadata (ids, hashes, counts, gate names); callers
-- must never put source text, diffs, prompts or test output in it.
create table public.audit_events (
  id bigint generated always as identity primary key,
  workspace_id uuid references public.workspaces(id) on delete cascade,
  actor_type text not null check (actor_type in ('user', 'cli_token', 'system')),
  actor_id text check (actor_id is null or char_length(actor_id) <= 80),
  action text not null check (action ~ '^[a-z][a-z0-9_.]{1,63}$'),
  target text check (target is null or char_length(target) <= 300),
  detail jsonb not null default '{}'::jsonb
    check (jsonb_typeof(detail) = 'object' and pg_column_size(detail) <= 4096),
  created_at timestamptz not null default now()
);
create index audit_events_workspace_idx on public.audit_events(workspace_id, created_at desc);

alter table public.audit_events enable row level security;
revoke all on public.audit_events from public, anon, authenticated;
grant select on public.audit_events to authenticated;
-- No update or delete grant for the service role: rows leave only through
-- retention (security definer) or a workspace deletion cascade.
grant select, insert on public.audit_events to service_role;
create policy audit_events_member_read on public.audit_events for select to authenticated
  using (workspace_id is not null and private.is_workspace_member(workspace_id));

-- Deleting a workspace cascades to its repositories, findings, repair jobs,
-- CLI tokens, reports and audit events. One tombstone remains so the deletion
-- itself is auditable; it names only the workspace id.
create function private.record_workspace_deletion() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.audit_events (workspace_id, actor_type, action, target)
  values (null, 'system', 'workspace.deleted', old.id::text);
  return old;
end;
$$;
revoke all on function private.record_workspace_deletion() from public, anon, authenticated;
create trigger workspace_deletion_audit after delete on public.workspaces
for each row execute function private.record_workspace_deletion();

-- 5. Retention ------------------------------------------------------------------
-- Called by the Worker cron. Bounds only the tables added here plus rows that
-- are pure operational exhaust; findings and repair jobs stay until their
-- workspace or repository is deleted.
create function public.apply_retention() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_reports integer;
  v_audit integer;
  v_usage integer;
begin
  delete from public.cli_reports where expires_at < now();
  get diagnostics v_reports = row_count;
  delete from public.audit_events where created_at < now() - interval '400 days';
  get diagnostics v_audit = row_count;
  delete from public.ai_repair_usage where day_utc < (now() at time zone 'UTC')::date - 90;
  get diagnostics v_usage = row_count;
  return jsonb_build_object('cli_reports', v_reports, 'audit_events', v_audit,
    'ai_repair_usage', v_usage);
end;
$$;
revoke all on function public.apply_retention() from public, anon, authenticated;
grant execute on function public.apply_retention() to service_role;
