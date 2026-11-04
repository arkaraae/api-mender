-- Short-lived, server-only GitHub installation and OAuth correlation.
-- GitHub's setup installation_id is untrusted until verified with a user token.
create table public.github_onboarding_attempts (
  state_hash text primary key check (state_hash ~ '^[a-f0-9]{64}$'),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  installation_id bigint check (installation_id is null or installation_id > 0),
  code_verifier text,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  check ((installation_id is null) = (code_verifier is null))
);
create index github_onboarding_attempts_expires_idx on public.github_onboarding_attempts(expires_at);
alter table public.github_onboarding_attempts enable row level security;
revoke all on public.github_onboarding_attempts from public, anon, authenticated;
grant select, insert, update, delete on public.github_onboarding_attempts to service_role;
