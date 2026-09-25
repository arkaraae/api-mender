# API Mender: API change monitor

API Mender connects code to upstream API evidence and prepares reviewable fixes. It now includes a **live Supabase Auth workspace and public GitHub repository inventory** at `/live`, plus the original **simulated Stripe vertical slice** at `/`. The demo never represents its fixture as a live Stripe change or its local PR artifact as a GitHub pull request.

## Live Supabase and GitHub path

The Supabase project is `eeejqyvtdvahofwoiicv` (`API Mender`). Its applied migration is [`supabase/migrations/20260925070522_api_mender_live_workspace.sql`](supabase/migrations/20260925070522_api_mender_live_workspace.sql). All four exposed tables have row level security. Anonymous access has no table grants; authenticated users can access only workspaces they own and their repositories. The Supabase security advisor reported no findings after migration.

Copy `.env.example` to `.env.local`, run `npm ci` and `npm run dev`, then open `http://localhost:3000/live`. Create an account or sign in, create a workspace, register a public `owner/repo`, and select **Scan now**. The server checks the Supabase user token, reads only bounded files from that public repository at a specific GitHub commit, runs static Stripe call discovery, and saves the inventory in Supabase. No GitHub token is needed for public scans. **Check Stripe sources** calls the deployed `check-stripe` Edge Function with the signed-in user's JWT. It records the current official Stripe Node release and OpenAPI file as a baseline, then creates informational review items on later source changes for scanned Stripe repositories. Source: [arkaraae/api-mender](https://github.com/arkaraae/api-mender).

The live path inventories code and tracks changes to two official source artifacts. Its findings say only that an official source changed; it does **not** yet prove a breaking change, version applicability, code impact, or a safe patch. `source_snapshots` and `findings` are written only by the authenticated Edge Function using a server secret; browser clients have read access only. Private repositories and PR publishing require installation and credentials for a GitHub App. The existing `/connect` and `/api/v1/*` routes remain a separate SQLite-backed GitHub App prototype and do not share live Supabase workspace data. Do not use that prototype as a production worker. The public scanner and source check are manually triggered; they need durable rate limiting and scheduling before multi-user deployment.

## Run the reproducible demo

Requires Node.js 24+, npm, and Git. The checked-in lockfile pins dependencies.

```bash
npm ci
npm run demo
npm run dev
```

Open `http://localhost:3000`. The dashboard is in clearly labeled demo mode by default. The demo command can be rerun: snapshots, findings, and job keys are deduplicated. Generated review artifacts are in [`artifacts/`](artifacts/): `demo.patch`, `demo-pr.md`, and before/after validation reports. The fixture contract is deliberately invented; Stripe has **not** announced that `capture_method` became required.

The workflow is real inside the fixture: the parser diffs two JSON contracts, the TypeScript AST identifies `stripe.paymentIntents.create`, a scoped patch adds `capture_method: "automatic"` and a new regression test, the test fails before the code fix, and isolated validation passes afterward. `git apply --check ../../artifacts/demo.patch` succeeds from `fixtures/sample-repo`.

```bash
npm test
npm run typecheck
npm run build
```

## Product boundary

The initial user is an engineer responsible for TypeScript/Node Stripe integrations. The supported change shape is a newly required JSON request field on a statically recognized PaymentIntent create call. The user sees source evidence, applicability, affected code, failure mode, confidence, validation, and a local PR artifact. Findings with unknown API-version applicability remain review items. The platform never merges or deploys code.

**Works now:** fixture workflow and responsive dashboard; SQLite persistence; AST discovery of static PaymentIntent calls; source snapshot hashing; narrow OpenAPI diff; durable job records with retries, leases, cancellation, four-job concurrency cap, and per-repository exclusion; tenant-scoped API routes; GitHub App signature verification; bounded GitHub repository import and guarded PR creation code.

**Simulated:** the breaking Stripe contract, applicability, patch recipe, and dashboard data. The local PR artifact is not a GitHub PR. The sample Stripe SDK version is from its fixture manifest.

**Unsupported or unverified:** live Stripe change detection for `$ref`, form-encoded parameters, response schemas, auth, deprecations, and behavioral changelogs; semantic mapping of all SDK methods; automatically proving API-version applicability; production-grade code execution isolation; real GitHub App onboarding and PR creation against a configured account (no credentials were available to test); live AI patch validation beyond the narrow fixture; automatic worker cleanup; SSO and an automated production tenant dashboard. These gaps prevent autonomous production remediation without further work.

The current Next.js build succeeds without Turbopack file-tracing warnings. The `.env.local` file is absent from the generated server trace. Set `DEMO_MODE=0` for any non-demo deployment; the legacy SQLite endpoints still require separate isolation and review.

The official [Stripe OpenAPI repository](https://github.com/stripe/openapi) recommends `latest/openapi.spec3.json` for generally available v1 and v2 endpoints. The monitor also snapshots [stripe-node releases](https://github.com/stripe/stripe-node/releases) and the [Stripe changelog](https://docs.stripe.com/changelog). A changed release or changelog source produces an informational item only; interpreting the page as a breaking change needs additional analysis. One specification cannot capture every provider behavior change.

## Architecture

```text
GitHub App installation → bounded repository snapshot → TypeScript inventory
Official source fetch → hashed snapshot → narrow contract diff → finding
Finding + repository context → deterministic fixture recipe / optional model adapter
Disposable copy → syntax + contract + fixture tests → review artifact
Guarded GitHub operations → PR only after passing validation and remote-base check
```

The dashboard and API use Next.js/TypeScript. `lib/core.ts` defines provider adapters, source ingestion, diffing, inventory, finding, patch, validation, and job operations. `lib/github.ts` holds privileged GitHub App functions outside the repository execution workspace. SQLite (`node:sqlite`) makes the fixture self-contained; it is a development substitution for the requested PostgreSQL default. For production, move the schema to PostgreSQL, use tenant-scoped queries or row-level security, and put job claims behind `FOR UPDATE SKIP LOCKED`. Run monitoring, AI generation, and validation as separate services with durable queue leases and resource limits. The current Node permission flag restricts the fixture test process's filesystem reads and denies its child processes, but it is **not** a container boundary or a substitute for CPU, memory, and network isolation.

### Data model

| Record | Purpose and provenance |
| --- | --- |
| `tenants`, `repositories` | Tenant ownership, selected branch, GitHub installation, remote head, pause and patch controls. |
| `sources` | Provider, source type and URL, retrieval timestamp, SHA-256, exact body, simulation flag. |
| `inventories` | SDK and API versions stored separately, recognized calls, fields, files, tests, gaps. |
| `findings` | Deduplicated semantic fingerprint, affected code, evidence, confidence, status, base commit. |
| `validations`, `patches` | Checks, source hash, model/version, validation configuration, local artifact or PR URL. |
| `jobs` | Idempotency key, attempts, run time, lease, cancellation, error, terminal state. |
| `audit` | Actor, action, detail, timestamp for scans, transitions, patches, validations, controls, external actions. |

Lifecycle: `Detected → Analyzing → Action required / Patching → Validating → PR opened → Resolved`; `Failed`, `Dismissed`, and `Superseded` require a reason. The fixture ends at **Action required** because it creates a local artifact, not a live PR. A GitHub PR is only marked opened after the GitHub API succeeds.

### Security and operations

Tenant APIs require a bearer token mapped to exactly one tenant. Repository queries and mutations include the tenant key. The demo page is public only for synthetic data; set `DEMO_MODE=0` outside local demonstration. GitHub App JWTs and installation tokens are created server side from environment secrets. Webhooks use `X-Hub-Signature-256` with constant-time comparison. GitHub permissions should be Metadata read, Contents read/write, and Pull requests read/write, granted only to selected repositories. The model receives a single bounded file, and a heuristic secret check blocks obvious embedded keys. This is not sufficient secret detection for production use; keep `OPENAI_API_KEY` unset until a reviewed redaction boundary exists.

| Threat | MVP mitigation | Remaining production work |
| --- | --- | --- |
| Cross-tenant data access | Bearer mapping and tenant predicates on API and persistence reads | SSO, rotation, RLS, authorization tests across all future routes |
| Forged GitHub events | HMAC verification of raw webhook body | Delivery replay protection and event handling |
| Prompt injection or secret exfiltration | Untrusted data instruction to model, file limit, obvious-key blocker | Strong secret scanning, policy engine, model egress audit |
| Malicious repository code | No repository scripts except the known fixture test path; Node permission flags | Container/microVM worker with CPU, memory, time, filesystem and egress policies |
| Stale or duplicate PRs | Remote head and file-content checks; deterministic branch and open-PR lookup | Recovery for partial GitHub API failures and branch races |
| Upstream outages/rate limits | Bounded fetch timeout and durable exponential job retries | Respect `Retry-After`, source health alerts, circuit breaker |

Local repository snapshots live under `data/current/repositories/` until `DELETE /api/v1/repositories?id=...`; that operation removes the imported copy and associated findings, validations, and patches while retaining a tombstone audit event. Disposable validation copies are removed by successful demo and test runs. A crash can leave copies in `data/current/workers/`; operators must remove them after review. Local review artifacts remain under `artifacts/` until manually removed. A production deployment needs configured retention periods, encrypted storage, and deletion verification.

## Live configuration and operations

Copy `.env.example` to `.env.local` and set unique tenant tokens and GitHub App values. Keep secrets in a secret manager for deployment. The app never stores installation tokens. `TENANT_TOKENS` uses comma-separated `tenant_id:token` pairs; run `npm run tenant -- tenant_yourteam "Your team"` before onboarding (the fixture creates `tenant_demo`). An administrator must also map each approved installation to a tenant in `TENANT_INSTALLATIONS`, such as `tenant_yourteam:12345`, before the onboarding form accepts it.

For GitHub, configure the App webhook to `/api/github/webhook`, grant the permissions above, install it on selected repositories, then open `/connect`. Supply the GitHub installation ID, `owner/repo`, branch, and tenant token. The API fetches a bounded code snapshot and records the remote commit. Repository import rejects truncated trees, skips symlinks, and rejects more than 250 eligible files or 5 MB total source. It does not run repository scripts.

```bash
# Tenant-scoped API examples (replace values with your own)
curl -H "Authorization: Bearer $RELAY_TOKEN" http://localhost:3000/api/v1/repositories
curl -H "Authorization: Bearer $RELAY_TOKEN" http://localhost:3000/api/v1/findings
curl -H "Authorization: Bearer $RELAY_TOKEN" http://localhost:3000/api/v1/jobs
curl -X PATCH -H "Authorization: Bearer $RELAY_TOKEN" -H 'Content-Type: application/json' \
  -d '{"id":"repo_id","field":"paused","value":true}' http://localhost:3000/api/v1/repositories
```

Run `npm run schedule` from cron hourly, then run `npm run worker` repeatedly from a supervised worker process. The first source fetch establishes a baseline. Later fetches compare snapshots. Monitoring jobs store errors, retry at most three times, and recover expired leases. `/api/v1/jobs` supports tenant-scoped inspection and cancellation. `/api/v1/findings/<id>` provides evidence and allows a reviewed `Resolved`, `Dismissed`, or `Superseded` transition with an explicit reason. The live source parser intentionally makes no ready-for-review patch from an uncertain change.

`npm run publish -- <tenantId> <findingId>` is a guarded GitHub operation for a **previously validated** patch associated with an installed repository. It rechecks the remote branch SHA and each original file, uses a stable `relay/<findingId>` branch, and avoids duplicate open PRs. It cannot publish the local fixture's artifact unless that fixture is separately installed in GitHub and given the matching remote base; the demo does not take that step. This command has not been tested against a real GitHub installation in this environment.

## Next production steps

Implement version-specific Stripe applicability and `$ref`/form-encoded contract comparison, then add a hardened validation worker. Move persistence to PostgreSQL and authenticate the production dashboard. Add provider-specific adapters for Twilio and AWS only after the Stripe slice is verified with live integration tests.
