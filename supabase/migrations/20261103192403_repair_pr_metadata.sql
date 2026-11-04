-- A draft pull request remains unverified until the customer's CI checks pass.
alter table public.repair_jobs drop constraint repair_jobs_status_check;
alter table public.repair_jobs add constraint repair_jobs_status_check check
  (status in ('proposed', 'publishing', 'proof_pending', 'proof_failed', 'validated', 'pr_opened'));
alter table public.repair_jobs
  add column pr_number integer check (pr_number > 0),
  add column pr_url text check (pr_url ~ '^https://github[.]com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/pull/[0-9]+$' and char_length(pr_url) <= 500),
  add column patch_branch text check (patch_branch ~ '^mender/repair-[a-f0-9-]{36}$'),
  add column patch_sha text check (patch_sha ~ '^[a-f0-9]{40}$'),
  add column publish_started_at timestamptz,
  add constraint repair_jobs_pr_metadata_complete check (
    (pr_number is null and pr_url is null and patch_branch is null and patch_sha is null)
    or (pr_number is not null and pr_url is not null and patch_branch is not null and patch_sha is not null)
  ),
  add constraint repair_jobs_proof_status_has_pr check (
    status in ('proposed', 'publishing') or (pr_number is not null and pr_url is not null and patch_branch is not null and patch_sha is not null)
  ),
  add constraint repair_jobs_publish_lease check (
    (status = 'publishing') = (publish_started_at is not null)
  );
