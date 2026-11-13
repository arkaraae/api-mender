-- Security review 2026-11-13: an editor of two workspaces could move a
-- GitHub-connected repository into the other one, or rename it, through a
-- direct API update. A repository's workspace, name, branch and visibility
-- are now fixed for browser roles; only the server (GitHub connect) changes them.
create or replace function private.protect_repository_scan_fields() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user = 'authenticated' and (
    new.workspace_id is distinct from old.workspace_id or
    new.full_name is distinct from old.full_name or
    new.branch is distinct from old.branch or
    new.visibility is distinct from old.visibility or
    new.github_installation_id is distinct from old.github_installation_id or
    new.github_repo_id is distinct from old.github_repo_id or
    new.target_sha is distinct from old.target_sha or
    new.head_sha is distinct from old.head_sha or
    new.sdk_version is distinct from old.sdk_version or
    new.api_version is distinct from old.api_version or
    new.call_sites is distinct from old.call_sites or
    new.limitations is distinct from old.limitations or
    new.scanned_at is distinct from old.scanned_at
  ) then raise exception 'Repository identity, scan and GitHub fields are server-managed'; end if;
  return new;
end;
$$;
revoke all on function private.protect_repository_scan_fields() from public, anon, authenticated;

-- Security-definer functions resolve names only from explicit schemas.
alter function public.claim_ai_repair_budget(uuid) set search_path = '';
alter function public.apply_retention() set search_path = '';
