# Private-AI MVP: provider-independent pipeline

Branch `mender/private-ai-mvp`. Status: **MVP, not production-ready.** The
acceptance test passes end to end through the CLI path with a test double in
place of the model. It has not yet run against a real open-weight model, or
through the hosted GitHub App path on staging. See "Not yet verified".

## 1. Audit of the starting point (main @ 774b6bd)

| Area | State before this work |
|---|---|
| GitHub App connect, installation tokens, push webhook, scan jobs with leases | Real, reused unchanged |
| Static `fetch`/`axios` discovery | Real but literal-URL only: missed `` `https://api.x.com/${id}` ``, which most real clients use |
| Contract source | Only an OpenAPI file in the customer's **own** connected repo; no third-party provider catalog |
| Integrated Services | Listed connected contract files plus hardcoded Stripe/AWS cards, not the external APIs the code calls |
| Findings | Real for "required field missing" against a connected contract; evidence lacked version applicability |
| Repair | Deterministic single-key rename; ambiguous cases went to **Anthropic** (field names only) |
| Managed Quote API workflow | Sent the **full client file and test output to OpenAI** when rules could not settle a change |
| SQLite prototype (`lib/core.ts`) | OpenAI patch generator, active whenever `OPENAI_API_KEY` was set |
| Draft PR + customer CI proof | Real, reused unchanged |
| CLI, model service, isolated runner, audit log, retention, CLI ingest | Did not exist |
| Hardcoded | Quotes pilot URLs in scripts and workflows, Stripe/AWS special cases in the scanner |
| Root `tsc` | Already failing on main (179 errors) because it swept in `web/` |

## 2. Pipeline

```
repository discovery      cli/src/repo-files.mjs · web/lib/public-scan.ts (hosted)
  → API usage inventory   web/lib/engine/inventory.ts (template URLs, version headers)
  → provider ingestion    web/lib/engine/providers/* · web/lib/engine/provider-sync.ts
                          web/scripts/sync-provider-contracts.mjs (scheduled workflow)
  → contract diff         web/lib/engine/openapi-slice.ts · contract-diff.ts
  → impact analysis       web/lib/engine/impact.ts
  → finding               types.ts Finding: what changed, exact location, impact,
                          evidence + confidence, static-inferred vs test-confirmed
  → bounded repair        web/lib/engine/repair/* (rules, then the self-hosted model;
                          11 deterministic gates; abstention is normal)
  → validation            cli/src/runner/* (CLI) · customer CI on the draft PR (hosted)
  → draft PR / CLI patch  web/lib/repair-pr.ts · cli/src/check.mjs
```

Everything under `web/lib/engine/` uses only Web APIs plus `@babel/parser`, so
the same code runs in the Cloudflare Worker, in the CLI and in tests. Adding a
provider means one adapter file and one registry line; nothing else names a
provider.

**First provider and change (authentic):** GitHub REST API, from the official
OpenAPI descriptions in `github/rest-api-description`. Version `2026-03-10`
removes the deprecated request property `assignee` from
`POST /repos/{owner}/{repo}/issues` (and from `PATCH .../issues/{issue_number}`);
`assignees` (an array) remains. Across all 1,272 operations, the sync job finds
exactly 5 request-contract changes between 2022-11-28 and 2026-03-10.

## 3. Private AI

* Hosted: `model-service/` is an authenticated, zero-dependency gateway in
  front of vLLM (GPU profile) or llama.cpp (CPU profile). The inference
  container sits on an internal network with no egress. The gateway accepts
  no tools, logs no content and stores nothing. It is separate from the
  Worker, which reaches it with `MENDER_MODEL_ENDPOINT`, `MENDER_MODEL_NAME`
  and `MENDER_MODEL_API_KEY`.
* Customer-managed: the CLI points at the customer's own server
  (`--model-endpoint`, loopback or private network by default).
* The default model is a configuration choice, not a dependency:
  `Qwen/Qwen2.5-Coder-7B-Instruct` (Apache-2.0) in the examples. Swap it by
  changing two variables, and re-check its licence and fitness before
  deploying.
* The model gets one narrow task: the contract change for the affected
  fields plus at most 60 lines / 4 KB of the call. It answers in a strict
  JSON schema, may abstain, gets one attempt, and its edits must pass every
  gate in `repair/policy.ts`: edits inside the call, nothing else touched,
  parses, same call inventory, body satisfies the new contract, no new calls,
  imports or identifiers, values preserved, no secrets added.

Exact data flows per mode: [data-boundaries.md](data-boundaries.md).

## 4. Running it

```bash
# Customer-managed path, end to end (gateway + test double, or your model):
scripts/acceptance-cli.sh
MENDER_UPSTREAM_URL=http://127.0.0.1:8080/v1 MENDER_MODEL_NAME=qwen2.5-coder-7b scripts/acceptance-cli.sh

# The CLI on any repository:
node cli/bin/mender.mjs scan  --repo path/to/repo
node cli/bin/mender.mjs check --repo path/to/repo --model-endpoint http://127.0.0.1:8080/v1 --model qwen2.5-coder-7b

# Tests
cd web && npm test && npx tsc --noEmit
node --test model-service/
node --test cli/tests/*.test.mjs
npm test && npx tsc --noEmit        # root (legacy prototype)
```

## 5. Staging rollout (before production)

1. Apply `supabase/migrations/20261109210000_provider_pipeline_and_private_ai.sql`
   to the **staging** Supabase project and run its security advisor.
2. Deploy `model-service` (cpu or gpu profile) on Mender-controlled hardware,
   reachable from the Worker only through TLS plus a gateway token (and
   ideally a tunnel or IP allow-list). Mint a token with
   `node model-service/gateway/token.mjs new worker-staging`.
3. `wrangler secret put` the three `MENDER_MODEL_*` secrets for
   `--env staging`.
4. Add `CATALOG_SUPABASE_URL` / `CATALOG_SUPABASE_SECRET_KEY` to the
   `staging` GitHub environment and run the *Provider contract catalog*
   workflow.
5. Install the staging GitHub App on a pilot repository holding
   `examples/github-issues-consumer`, push, and walk the flow: Integrated
   Services → finding → Propose bounded repair → Open draft PR → customer CI.

## 6. What works and what was verified here

| Claim | How it was verified |
|---|---|
| Discovery of the GitHub call, pinned version and template URL | CLI e2e test; hosted pipeline test |
| Authentic contract change ingested and diffed | Sync on the full official documents (5 changes); committed slices are real cuts of them |
| Finding at `src/issues.mjs:3` with evidence, confidence, applicability | CLI e2e test; hosted test asserts the stored row |
| Bounded fix from a self-hosted endpoint; no third-party AI call | CLI e2e records every outbound request: only the local gateway and its upstream. Hosted AI endpoints refused before any request (tests) |
| Patch applies (`git apply --check`) and is validated in an isolated runner | Namespace runner, no network: next-version check fails before and passes after; current-version check passes both |
| Patch + machine-readable report (CLI) | `report.json`, `patches/*.patch`, `metadata-report.json` |
| Metadata report contains no code | Test asserts no source fragments; validator rejects smuggled fields |
| Model service security (auth, no tools, limits, no content logs, deny-listed upstreams) | 268 model-service tests |
| Worker builds with the new routes | `npm run build` in `web/` |

## 7. Not yet verified or not supported

* **A real open-weight model has not been run.** This environment cannot
  download weights, so the e2e runs use `model-service/standin`, a labelled
  test double that applies one hard-coded rule. Repair quality with Qwen (or
  another model) is unmeasured. Run `scripts/acceptance-cli.sh` with
  `MENDER_UPSTREAM_URL` set.
* **The hosted GitHub path has not run on staging.** It needs the staging
  GitHub App, Supabase and model secrets, which were deliberately not
  requested. The routes are covered by unit tests with a fake database and
  by the build; no PR was opened through them.
* Hosted validation is the customer's CI on the draft PR. Mender does not yet
  run customer checks itself in hosted mode.
* Only JS/TS `fetch`/`axios` calls with a literal `https://host` origin are
  discovered. SDK clients (Octokit, Stripe SDK…), other languages and
  dynamic URLs are not. The GitHub REST catalog is the only provider adapter.
* Change kinds: request property removed, newly required, type changed, and
  operation removed are detected. Response, auth and behavioural changes are
  not. Only removed and required request properties can be repaired.
* The namespace runner does not hide the host filesystem from checks (it
  blocks network and bounds resources on a private copy). Use the container
  backend for untrusted repositories.
* Model images in `model-service/.env.example` use `:latest` tags. Pin them
  by digest before deploying.
* The CLI imports engine TypeScript from `web/` and needs Node ≥ 22.18. It is
  not packaged for npm yet.
