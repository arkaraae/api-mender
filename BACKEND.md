# Customer backend rollout

The customer data plane is Supabase. `workspaces`, `workspace_members`,
`monitored_repositories`, `github_installations`, `github_webhook_deliveries`,
`repository_scan_jobs`, `source_snapshots`, and `findings` live there. The
Cloudflare Worker receives GitHub events and processes repository scan jobs.
The separate D1/KV watch and SQLite testbed are not part of this customer path.

## Deploy order

1. Apply `supabase/migrations/20261022120000_backend_foundation.sql` to a
   non-production database and verify the ownership, editor, and unrelated-user
   access cases. The migration adds team membership and server-only GitHub and
   job tables. Back up production, then apply it there before shipping the
   Worker code. The Worker code depends on its RPC functions.
2. Register a GitHub App owned by the API Mender team. Give it repository
   **Contents: read** and **Metadata: read**; subscribe to `push`,
   `installation`, and `installation_repositories`. Set its webhook URL to
   `https://apimender.com/api/github/webhook` and configure a random webhook
   secret. Install it only on repositories a customer selects. No write access
   or pull-request permission is needed for this scanning stage.
3. In the production Cloudflare Worker secret store set `SUPABASE_SECRET_KEY`,
   `GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_ID`, and `GITHUB_APP_PRIVATE_KEY`.
   Keep these out of `wrangler.jsonc`, GitHub source, and browser variables.
   Rotate them if exposed. The Worker cron claims at most two jobs each minute.
4. Deploy the Worker after the migration and secrets are in place. Verify
   signed webhook receipt, one default-branch push, one saved scan, a duplicate
   delivery, and a failed job retry before inviting a customer.

## Connect a beta customer's repository

The installation setup URL's `installation_id` can be spoofed, so this stage
uses an operator command instead of binding a workspace from that URL. After
the customer installs the App on a selected repository, run:

```bash
cd web
node scripts/provision-github-installation.mjs WORKSPACE_UUID owner/repo
```

The command requires the four Worker secrets above and
`NEXT_PUBLIC_SUPABASE_URL` in its local environment. It verifies the App is
installed on that repository, obtains a repository-scoped read token, checks
the repository metadata, and binds the installation to exactly one workspace.
Do not run it for a repository without the customer's authorization. A
self-service connection must verify the installing GitHub user before replacing
this operator step.

## What a scan means

An authenticated GitHub push to the connected default branch is recorded once
per delivery and queued once per repository/commit SHA. The worker claims a
leased job, obtains a short-lived installation token limited to that
repository, reads up to 80 source/manifest files (5 MB total) at the exact
commit, and saves possible Stripe or AWS S3 call sites. It retries failures up
to five times. Only the newest pushed SHA replaces the displayed inventory.

This is **call-site inventory**, not proof that an upstream API change breaks
the code. A release update still yields only an informational finding. No
customer fix is generated or published by this pipeline yet. Contract diff,
version applicability, bounded patch generation, failing-before/passing-after
validation, and draft PR creation are separate release gates.

## Operations

Query `repository_scan_jobs` for `status='dead'`, oldest `queued` age, retry
counts, and running leases older than ten minutes. Alert when a connected
repository has not scanned after a default-branch push. Review GitHub webhook
delivery failures and Supabase errors. The webhook returns 503 on enqueue
failure so GitHub can redeliver; duplicate delivery IDs do not create jobs.

For local code checks run `cd web && npm run typecheck && npm test && npm run
build`. The SQL migration has also been applied to a temporary local PostgreSQL
instance with stub Supabase roles to check its syntax, RLS path, webhook
idempotency, job claim, and completion. This is not a Supabase staging rollout.
