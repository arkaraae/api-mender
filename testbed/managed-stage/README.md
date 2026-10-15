# Isolated API repair staging ground

This is a separate API and SQLite database on `127.0.0.1`. It uses the same contract endpoint, consumer repository, and repair monitor as the managed Quote API, but it never reads or changes production Supabase, Cloudflare, or the public site. No credentials or customer data are in the staging database.

## One-command rehearsal

From the repository root, with Node.js 24:

```bash
node testbed/managed-stage/rehearse.mjs
```

The rehearsal creates a temporary database, checks that the old client passes against contract v1, publishes v2 in that database, observes the old client's HTTP 422 failure, and requires a proposed patch to pass the same consumer test. The report and proposed client are written to `artifacts/managed-api/` and are ignored by Git. The default run makes no model API call.

To spend one Claude API call on this same flow, set `ANTHROPIC_API_KEY` in your shell and run:

```bash
node testbed/managed-stage/rehearse.mjs --claude
```

The `--claude` option forces the model path even though Mender can solve this simple rename with rules. It is allowed only for this loopback staging API. Claude returns a structured replacement client; the test runner checks it before declaring success. The report records input and output token counts. A model response is never merged or deployed by this command.

Do not paste an API key into chat, source, or a `.env` file that could be committed. For team use, add `ANTHROPIC_API_KEY` as a GitHub Actions repository secret and manually run **Rehearse API repair without production**. Leave `use_claude` off for a free check; turn it on for one model call. The workflow has read-only repository permissions, saves the evidence as an artifact, and cannot deploy or open a PR.

## Update the database yourself

For an interactive run, choose a SQLite path outside Git and start the API:

```bash
MENDER_STAGE_DB=/tmp/api-mender-stage.sqlite PORT=4179 node testbed/managed-stage/server.mjs
```

From another terminal, the version update is a database write:

```bash
MENDER_STAGE_DB=/tmp/api-mender-stage.sqlite node testbed/managed-stage/publish.mjs v2
```

The server reads the latest version on every request, so the next OpenAPI fetch and Quote request see v2 immediately. You may also inspect or edit the SQLite database with a SQLite client. Use the one-command rehearsal for the full break-and-repair proof, since it creates a fresh database each time.

This proves the repair pipeline on an isolated API. A hosted customer beta still needs a staging Cloudflare Worker and a separate Supabase project or branch before we test arbitrary customer integrations remotely.
