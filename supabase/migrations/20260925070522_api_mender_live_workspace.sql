-- API Mender live workspace. Apply with the Supabase migration API.
create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  created_at timestamptz not null default now(),
  unique (owner_id, name)
);

create table public.monitored_repositories (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  full_name text not null check (full_name ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
  branch text not null default 'main' check (char_length(branch) between 1 and 120),
  visibility text not null default 'public' check (visibility in ('public', 'private')),
  github_installation_id bigint,
  head_sha text check (head_sha is null or head_sha ~ '^[a-f0-9]{40}$'),
  sdk_version text,
  api_version text,
  call_sites jsonb not null default '[]'::jsonb check (jsonb_typeof(call_sites) = 'array'),
  limitations jsonb not null default '[]'::jsonb check (jsonb_typeof(limitations) = 'array'),
  scanned_at timestamptz,
  paused boolean not null default false,
  created_at timestamptz not null default now(),
  unique (workspace_id, full_name, branch)
);

create table public.source_snapshots (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  provider text not null,
  source_url text not null,
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  retrieved_at timestamptz not null default now(),
  simulated boolean not null default false,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  unique (workspace_id, source_url, sha256)
);

create table public.findings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  repository_id uuid not null references public.monitored_repositories(id) on delete cascade,
  source_id uuid references public.source_snapshots(id) on delete set null,
  fingerprint text not null check (fingerprint ~ '^[a-f0-9]{64}$'),
  title text not null,
  description text not null,
  severity text not null check (severity in ('low', 'medium', 'high')),
  confidence text not null check (confidence in ('informational', 'probable', 'confirmed')),
  status text not null default 'Detected' check (status in ('Detected', 'Analyzing', 'Action required', 'Patching', 'Validating', 'PR opened', 'Resolved', 'Failed', 'Dismissed', 'Superseded')),
  evidence jsonb not null default '{}'::jsonb check (jsonb_typeof(evidence) = 'object'),
  base_sha text check (base_sha is null or base_sha ~ '^[a-f0-9]{40}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (repository_id, fingerprint)
);

create index monitored_repositories_workspace_idx on public.monitored_repositories(workspace_id);
create index source_snapshots_workspace_retrieved_idx on public.source_snapshots(workspace_id, retrieved_at desc);
create index findings_workspace_status_idx on public.findings(workspace_id, status, created_at desc);
create index findings_repository_idx on public.findings(repository_id);

alter table public.workspaces enable row level security;
alter table public.monitored_repositories enable row level security;
alter table public.source_snapshots enable row level security;
alter table public.findings enable row level security;

revoke all on public.workspaces, public.monitored_repositories, public.source_snapshots, public.findings from anon, authenticated;
grant select, insert, update, delete on public.workspaces, public.monitored_repositories to authenticated;
grant select on public.source_snapshots, public.findings to authenticated;

create policy workspaces_select on public.workspaces for select to authenticated
  using (owner_id = (select auth.uid()));
create policy workspaces_insert on public.workspaces for insert to authenticated
  with check (owner_id = (select auth.uid()));
create policy workspaces_update on public.workspaces for update to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy workspaces_delete on public.workspaces for delete to authenticated
  using (owner_id = (select auth.uid()));

create policy repositories_select on public.monitored_repositories for select to authenticated
  using (exists (select 1 from public.workspaces w where w.id = workspace_id and w.owner_id = (select auth.uid())));
create policy repositories_insert on public.monitored_repositories for insert to authenticated
  with check (exists (select 1 from public.workspaces w where w.id = workspace_id and w.owner_id = (select auth.uid())));
create policy repositories_update on public.monitored_repositories for update to authenticated
  using (exists (select 1 from public.workspaces w where w.id = workspace_id and w.owner_id = (select auth.uid())))
  with check (exists (select 1 from public.workspaces w where w.id = workspace_id and w.owner_id = (select auth.uid())));
create policy repositories_delete on public.monitored_repositories for delete to authenticated
  using (exists (select 1 from public.workspaces w where w.id = workspace_id and w.owner_id = (select auth.uid())));

create policy snapshots_select on public.source_snapshots for select to authenticated
  using (exists (select 1 from public.workspaces w where w.id = workspace_id and w.owner_id = (select auth.uid())));
create policy findings_select on public.findings for select to authenticated
  using (exists (select 1 from public.workspaces w where w.id = workspace_id and w.owner_id = (select auth.uid())));
