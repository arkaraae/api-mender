# GitHub REST API contract slices

Real operation slices cut from GitHub's official OpenAPI descriptions. They are
test fixtures for `lib/engine`; nothing here is hand-written.

- Source repository: https://github.com/github/rest-api-description
- Commit: `2f8f80e47ea4d3292cf4e37ba9d9b25475e06140`
- Source files:
  - `descriptions/api.github.com/api.github.com.2022-11-28.json`
  - `descriptions/api.github.com/api.github.com.2026-03-10.json`
- License of the source descriptions: MIT (see the source repository).

## Files

`<name>.<version>.json` is one `OperationSlice` (see `lib/engine/types.ts`).

| name | operation | request change in 2026-03-10 |
| --- | --- | --- |
| `issues-create` | `POST /repos/{owner}/{repo}/issues` | `assignee` removed |
| `issues-update` | `PATCH /repos/{owner}/{repo}/issues/{issue_number}` | `assignee` removed |
| `teams-create` | `POST /orgs/{org}/teams` | `permission` removed |
| `orgs-update` | `PATCH /orgs/{org}` | `secret_scanning_push_protection_custom_link_enabled` removed |
| `workflow-dispatch` | `POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches` | `return_run_details` removed |
| `issue-comment-create` | `POST /repos/{owner}/{repo}/issues/{issue_number}/comments` | none (control) |

## Regenerating

Check out the source repository at the commit above, then from `web/`:

```sh
node scripts/build-provider-fixtures.mjs \
  <checkout>/descriptions/api.github.com/api.github.com.2022-11-28.json \
  <checkout>/descriptions/api.github.com/api.github.com.2026-03-10.json
```

The script slices with `sliceOperation` from `lib/engine/openapi-slice.ts`, so
each file is exactly what the pipeline cuts from the full document: `$ref`s
resolved, examples and response bodies dropped, `sha256` over the canonical
JSON of `document`. `tests/engine-find.test.mjs` re-slices the full documents
and compares hashes when they are present on disk.
