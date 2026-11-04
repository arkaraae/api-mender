# Customer backend rollout

## Current staging state (2026-11-03)

The isolated `codex/staging-github-app` branch deploys to
`https://api-mender-staging.amorales8.workers.dev`. It has a team-owned
GitHub App installed on only the two pilot repositories, a separate
Supabase project, signed push ingestion, pinned repository scans, connected
OpenAPI sources and consumer repositories, and static request-schema findings.
The App has repository Contents and pull request write permission plus Checks
read permission, restricted to repositories each installer selects. An existing
installation was synced through GitHub OAuth and its callback completed in
staging. A fresh customer installation still needs an end-to-end check. New
customers choose
repositories during installation. Installed repositories can
request a rate-limited rescan from the workspace.

For one narrow case—a literal `fetch` JSON body with one missing required
field and one unrecognized field—an editor can preview the exact source edit.
The preview checks the current GitHub branch, scanned commit, API contract,
workspace binding, and source shape. An editor can save that proposal as an
idempotent `repair_jobs` record. The record stores commit and source hashes,
the exact key edit, and an explicit `proposed` status; it stores no full file.
It changes no repository code until an editor opens a draft PR. The pilot's
old request returned 422 and the proposed field rename returned 200 against
the live Quote API.

Staging has a draft-PR publisher behind a staging-origin gate. It rechecks the
pinned file, contract, and source hashes, then uses a repository-scoped
installation token to create a draft PR on a deterministic branch. It never
merges. The customer-run GitHub Actions check `mender-repair-proof` reproduced
the old failure and passed the patch in the private consumer pilot. Mender
recorded that exact PR, patch, base, and successful check as validated. The
Worker now refreshes up to two pending CI proofs on each minute's cron, and
the earlier pilot PR became validated without a button click. See
`.github/actions/mender-repair-proof/README.md`.

The staging workspace can check whether a connected consumer repository has
the proof workflow on its default branch. It generates a pinned workflow from
the customer's focused test command and expected old failure, but never writes
the workflow into the customer's repository. The customer commits that file;
Mender then recognizes its structure. This check does not establish test
quality or prove a repair until the customer CI run succeeds on the draft PR.

No customer database is directly connected. Database schema evidence remains
customer-attested. The repair covers one deterministic request-field case and
depends on a customer CI workflow; Mender does not yet generate general AI
repairs or run arbitrary customer tests. Do not promote this staging branch to
`apimender.com` as a complete repair product. The rest of this document
describes the rollout design and includes earlier operator steps retained for
reference.

The customer data plane is Supabase. `workspaces`, `workspace_members`,
`monitored_repositories`, `github_installations`, `github_webhook_deliveries`,
`repository_scan_jobs`, `source_snapshots`, `findings`, and `repair_jobs` live there. The
Cloudflare Worker receives GitHub events and processes repository scan jobs.
The separate D1/KV watch and SQLite testbed are not part of this customer path.

Connected repositories can also register an OpenAPI JSON file through
`POST /api/live/contracts` with a signed-in user's Supabase bearer token:
`{"workspaceId":"…","repositoryId":"…","path":"openapi.json"}`. The
worker reads it at the pushed SHA, keeps each contract version in
`api_contract_versions`, compares it to the prior version, and writes a
possible-break finding when the schema changes. `GET /api/live/contracts` with
`workspaceId` lists registered paths. Only OpenAPI 3.0/3.1 JSON under 512 KB
is supported in this stage; the schema comparison is not a runtime test.

## Deploy order

1. Apply `supabase/migrations/20261022120000_backend_foundation.sql` and then
   `supabase/migrations/20261022150000_git_contract_sources.sql`, then
   `supabase/migrations/20261022170000_database_schema_evidence.sql` to a
   non-production database and verify the ownership, editor, and unrelated-user
   access cases. The migration adds team membership and server-only GitHub and
   job tables. Back up production, then apply it there before shipping the
   Worker code. The Worker code depends on its RPC functions. Apply
   `supabase/migrations/20261103190815_repair_jobs.sql` before enabling saved
   repair proposals, followed by
   `supabase/migrations/20261103192403_repair_pr_metadata.sql` before enabling
   draft PR creation or CI proof refresh.
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
4. Deploy the Worker after both migrations and secrets are in place. Verify
   signed webhook receipt, one default-branch push, one saved scan, a duplicate
   delivery, a contract baseline and change, and a failed job retry before
   inviting a customer.

## Connect a beta customer's repository

The staging workspace offers a self-service GitHub connection. It stores a
short-lived state, sends the customer through installation and GitHub user
authorization, then checks that the returned user can access the exact App
installation and selected repositories before binding them to the workspace.
The setup URL's `installation_id` is never trusted by itself. The existing
pilot installation completed this flow in staging. A fresh installation by a
different customer still needs a live check before this is a launch path.

For an authorized pilot where the callback is unavailable, an operator can
bind a selected repository with:

```bash
cd web
node scripts/provision-github-installation.mjs WORKSPACE_UUID owner/repo
```

The command requires the four Worker secrets above and
`NEXT_PUBLIC_SUPABASE_URL` in its local environment. It verifies the App is
installed on that repository, obtains a repository-scoped read token, checks
the repository metadata, and binds the installation to exactly one workspace.
Do not run it for a repository without the customer's authorization.

## What a scan means

An authenticated GitHub push to the connected default branch is recorded once
per delivery and queued once per repository/commit SHA. The worker claims a
leased job, obtains a short-lived installation token limited to that
repository, reads up to 80 source/manifest files (5 MB total) at the exact
commit, and saves possible Stripe or AWS S3 call sites. It retries failures up
to five times. Only the newest pushed SHA replaces the displayed inventory.

The repository scan is **call-site inventory**. A tracked OpenAPI file is
compared to its prior version and can yield a possible-break finding. Neither
path proves that a customer's running code breaks. A release update still
yields only an informational finding. No customer fix is generated or
published by this pipeline yet. Consumer mapping, version applicability,
bounded patch generation, failing-before/passing-after validation, and draft
PR creation are separate release gates.

The scanner now also records literal HTTPS `fetch` and `axios` calls with a
static method and URL. When a connected OpenAPI contract changes, Mender
compares its old `servers` origin, base path, and affected operations with
these calls in scanned repositories in the same workspace. Matching source
locations are saved as **unverified consumer candidates** in the finding
evidence. Dynamic URLs, other HTTP clients, server variables, ambiguous
methods, and unscanned repositories are not matched. This is a conservative
inventory signal, not consumer breakage proof or a validated repair.

For one bounded JavaScript/TypeScript pattern, the scanner also records a
direct response-to-Supabase-write candidate: consecutive statements in the
same function must assign a literal HTTPS `fetch` response, assign
`response.json()`, and call `supabase.from('table').insert` or `upsert` with a
direct `payload.field` value. When a connected OpenAPI response field changes,
the finding links the pinned API call and database write line. Branches,
aliases, helpers, dynamic fields, and cross-file flow remain unresolved. This
is static code evidence, not a runtime failure or proof of a customer database
schema conflict.

`DATABASE_ACCESS.md` describes the optional customer-run Postgres metadata
probe, authenticated workspace ingestion endpoint, and explicit API-field-to-
column mapping. A current-contract request mismatch can attach a recent schema
snapshot and declared column as **possible database impact**. This does not
trace the consumer's database write, execute its code, or verify a production
failure. No customer production database is accessed by the Cloudflare Worker.

## Operations

Query `repository_scan_jobs` for `status='dead'`, oldest `queued` age, retry
counts, and running leases older than ten minutes. Alert when a connected
repository has not scanned after a default-branch push. Review GitHub webhook
delivery failures and Supabase errors. The webhook returns 503 on enqueue
failure so GitHub can redeliver; duplicate delivery IDs do not create jobs.

For local code checks run `cd web && npm run typecheck && npm test && npm run
build`. Both SQL migrations have also been applied to a temporary local PostgreSQL
instance with stub Supabase roles to check its syntax, RLS path, webhook
idempotency, job claim, and completion. This is not a Supabase staging rollout.
