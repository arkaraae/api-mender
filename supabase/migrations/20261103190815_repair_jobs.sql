-- Staging repair proposals are immutable evidence until a separate validation
-- worker records customer CI results. Never store the full customer source here.
create unique index findings_repair_scope_idx
  on public.findings(id, workspace_id, repository_id);

create table public.repair_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  finding_id uuid not null,
  repository_id uuid not null,
  created_by uuid references auth.users(id) on delete set null,
  base_sha text not null check (base_sha ~ '^[a-f0-9]{40}$'),
  contract_sha256 text not null check (contract_sha256 ~ '^[a-f0-9]{64}$'),
  file_path text not null check (char_length(file_path) between 1 and 512),
  line_number integer not null check (line_number > 0),
  source_sha256 text not null check (source_sha256 ~ '^[a-f0-9]{64}$'),
  patched_sha256 text not null check (patched_sha256 ~ '^[a-f0-9]{64}$'),
  old_field text not null check (char_length(old_field) between 1 and 128),
  new_field text not null check (char_length(new_field) between 1 and 128),
  before_snippet text not null check (char_length(before_snippet) between 1 and 256),
  after_snippet text not null check (char_length(after_snippet) between 1 and 256),
  status text not null default 'proposed' check
    (status in ('proposed', 'proof_pending', 'proof_failed', 'validated', 'pr_opened')),
  proof jsonb not null default '{}'::jsonb check (jsonb_typeof(proof) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (finding_id, base_sha, contract_sha256),
  foreign key (finding_id, workspace_id, repository_id)
    references public.findings(id, workspace_id, repository_id) on delete cascade,
  foreign key (repository_id, workspace_id)
    references public.monitored_repositories(id, workspace_id) on delete cascade
);
create index repair_jobs_workspace_created_idx
  on public.repair_jobs(workspace_id, created_at desc);

alter table public.repair_jobs enable row level security;
revoke all on public.repair_jobs from public, anon, authenticated;
grant select on public.repair_jobs to authenticated;
grant select, insert, update, delete on public.repair_jobs to service_role;
create policy repair_jobs_member_read on public.repair_jobs for select to authenticated
  using (private.is_workspace_member(workspace_id));
