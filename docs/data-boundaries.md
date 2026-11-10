# What data crosses each boundary

API Mender runs in two modes. This page says exactly what leaves the customer's
code in each mode, where it goes, and how long it stays. It describes the code
on this branch; each row names the file that enforces it.

**No mode sends customer source code, prompts containing source, patches, or
test output to OpenAI, Anthropic, or any other hosted AI provider.** Model
calls go only to an OpenAI-compatible endpoint the operator configures, and
`web/lib/engine/repair/model-client.ts` refuses known hosted AI providers
before any request is made. The model service refuses to start if its
upstream is one (`model-service/gateway/server.mjs`). The deny-list is defence
in depth: the real control is that only Mender's or the customer's own
endpoint is ever configured.

## Hosted mode (GitHub App)

Mender reads the repository through the GitHub App and runs inference on
infrastructure API Mender controls. **In this mode a bounded source excerpt
does leave the customer's GitHub repository and reaches Mender-controlled
infrastructure.** It never reaches a third-party AI provider.

| From → to | What | Bound | Kept |
|---|---|---|---|
| GitHub → Mender Worker | JS/TS source files at one pinned commit, read with a short-lived token scoped to the one repository (`web/lib/public-scan.ts`) | ≤ 80 files, ≤ 300 KB each, ≤ 5 MB total | In memory for the scan only. **Not stored.** |
| Worker → database | Call-site inventory: file path, line, method, URL template, origin, literal request **key names**, literal header values (e.g. `x-github-api-version`) | ≤ 200 calls | Until the repository or workspace is deleted (cascade) |
| Worker → database | Findings: provider, operation, contract change, file path and line, evidence sentences, contract hashes (`web/lib/provider-findings.ts`) | ≤ 50 per scan | Until the repository or workspace is deleted |
| GitHub → Worker (repair) | The one file holding the affected call, at the pinned commit (`web/lib/github-pinned-file.ts`) | 1 file, ≤ 300 KB | In memory for the request only |
| Worker → **Mender model service** | System prompt + one JSON message: the contract change (provider schemas for the changed fields) and the **source excerpt**: the call's lines plus 2 lines of context (`web/lib/engine/repair/task.ts`, `prompt.ts`) | ≤ 60 lines, ≤ 4 KB excerpt; no other part of the file; excerpts that look like they contain a secret are not sent | Gateway: none, and it logs no content (`model-service/`). The inference server must be run with request logging off (see `model-service/README.md`) |
| Model service → Worker | A JSON decision: abstain, or ≤ 3 whole-line edits inside the call | ≤ 32 KB | Not kept. The edits are kept only if they pass every gate (next row) |
| Worker → database | Repair job: line edits, unified diff of the call, file and patched-file SHA-256, gate results, uncertainty notes (`web/lib/provider-repair.ts`) | edits ≤ 8 KB, diff ≤ 16 KB | Until the finding, repository or workspace is deleted |
| Worker → GitHub | A branch `mender/repair-<id>` with one commit to one file, and a **draft** PR (`web/lib/repair-pr.ts`) | 1 file | In the customer's repository; Mender never merges |
| Customer CI → Worker | Check-run status and URL for the draft PR (`web/lib/repair-proof-worker.ts`) | — | On the repair job |
| Everyone → audit log | Who did what: ids, hashes, counts, gate names. Never content | ≤ 4 KB per event | 400 days (`apply_retention`), or workspace deletion (a tombstone remains) |

Field-name-only repairs (the older single-field rename path,
`web/app/api/live/repairs/preview/route.ts`) send only the operation and field
**names** to the model service: no source and no values.

Validation in hosted mode runs in the customer's own CI on the draft PR
(`.github/actions/mender-repair-proof`). Mender reports the check name, status
and URL. A passing check shows the tests passed; it does not prove the
behavior is correct.

## Customer-managed mode (Mender CLI)

The CLI, model inference, patch generation and the checks all run on the
customer's machine or CI runner (`cli/`). Model requests go to the endpoint
the customer configures. In this mode the endpoint must be on loopback or a
private network unless the operator passes `--allow-remote-model`, and hosted
AI providers are refused either way.

| From → to | What | Kept |
|---|---|---|
| Public internet → CLI | Official provider contracts, downloaded from the URL named in the provider adapter (e.g. `raw.githubusercontent.com/github/rest-api-description/...`). Never from a URL found in repository content | Local cache (`~/.cache/mender/contracts`) |
| CLI → customer's model server | Same narrow task as in hosted mode: contract change + ≤ 4 KB excerpt | The customer's server |
| CLI → isolated runner | A private copy of the work tree, patched; the checks from `mender.config.json` (argv arrays, never a shell). No network, scrubbed environment, CPU/memory/PID/time limits (`cli/src/runner/`) | Copy deleted after the run |
| CLI → local disk | `.mender/report.json` (full findings, diffs), `.mender/patches/*.patch`, `.mender/logs/*.log` (check output, redacted), `.mender/metadata-report.json` | The customer's disk |
| **CLI → API Mender** | **Nothing by default.** Only if `report.upload: true` is in `mender.config.json` **and** the operator passes `--upload` with `MENDER_REPORT_URL` and `MENDER_REPORT_TOKEN`: the metadata report below | 90 days, then deleted by `apply_retention` |

The metadata report is the **only** thing the CLI can send to API Mender. Its
shape is fixed by `web/lib/engine/boundary.ts`, and the same validator runs
before sending (CLI) and on receipt (`web/app/api/cli/reports/route.ts`).
Unknown keys, disabled groups and malformed values are rejected, not dropped.
Each token is limited to the groups it was created with.

| Field group | Contains | Never contains |
|---|---|---|
| (always) | schema version, CLI version, a repository **label** the customer chooses, commit SHA, timestamp, enabled groups | repository contents |
| `providers` | catalog provider id and name, provider origin, contract operation **templates** (`POST /repos/{owner}/{repo}/issues`), call count, pinned API versions, a count of unrecognised hosts | literal request paths (they can hold org or repo names), unrecognised host names, file names |
| `findingStatus` | finding id (a hash), provider, operation template, change kind, provider field names, versions, confidence, verification, applicability, failure mode, status, repair method | titles or prose, source, diffs, model output |
| `filePaths` | file path and line of the affected call | file contents |
| `hashes` | SHA-256 of the file before and after the patch and of the diff | the file, the patch or the diff |
| `validation` | runner backend, network mode, whether the patch applied, per-check name, phase, pass/fail, exit code, timeout | check commands, check output, environment |

Without upload, nothing about the repository reaches API Mender. The CLI's
only outbound requests are the contract downloads (skippable with local files
or `--offline`) and the customer's own model endpoint.

## Deletion

- **Repository removed from a workspace:** its inventory, findings, repair
  jobs and CI proof records are deleted (database cascades). Draft PRs and
  branches already in GitHub stay there; close them in GitHub.
- **Workspace deleted:** everything above plus CLI tokens, CLI reports and the
  workspace's audit events are deleted. One `workspace.deleted` audit
  tombstone holding only the workspace id remains.
- **CLI token revoked:** later uploads with it are refused. Reports already
  received stay until they expire (90 days) or the workspace is deleted.
- **Full repositories are never stored** in the product database in either mode.
