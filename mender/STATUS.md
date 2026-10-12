# API Mender: where things stand

Read this first when picking the project up again, in a new Claude Code session or as a new
teammate. Last updated 2026-10-12.

## What is live

https://apimender.com runs from the `web/` app on Kane's Cloudflare account (Worker
`apimender-site`, custom domains apimender.com and www.apimender.com).

| Page | What it does |
| --- | --- |
| `/check` | Compare two API versions: verdict, every change with an error/warning/info level, the lines a caller's code touches and the fix, a TypeScript client, and a test server for the new version. |
| `/watch` | Watch an API description; checked every hour for ones not checked in a day; Slack or Discord alerts. |
| `/mender` | The gateway: old callers keep working (`/mender/v1/api/...`), with every old-version call saved. |
| `/pricing` | Free for developers who call APIs; $19 per API per month for API companies (free in beta). |
| `/`, `/demo`, `/live` | The team's pages (arkaraae, Jingyi). |

The GitHub check (`.github/actions/mender-check`) comments the same report on pull requests.

## Where the code is

- Branch `mender-demo` of github.com/arkaraae/api-mender. Not merged into `main` yet: open a
  pull request (main ← mender-demo) when the class testing is done.
- Engine: `mender/src/` (copied into `web/lib/mender/` by `node mender/tools/sync-web.mjs`).
- Site features: `web/lib/mender/` (gateway, report, watch, mock, sdk), `web/app/`.

## Run, test, publish

Needs Node.js 24.

```bash
cd web && npm ci && npm test && npm run typecheck
```

```bash
cd web && CLOUDFLARE_ENV=apimender npm run dev
```

Publish to apimender.com (needs `npx wrangler login` once on the machine, approved in a normal
browser; signing in inside Claude's built-in browser fails Cloudflare's robot check):

```bash
cd web && CLOUDFLARE_ENV=apimender npm run build && npx wrangler deploy --config dist/server/wrangler.json
```

Roll back: `npx wrangler versions list --env apimender`, then
`npx wrangler rollback <version id> --env apimender`.

Cloudflare resources (account 54294ccf…): KV `MENDER_WATCH` (743c7ff4…), D1 `apimender`
(54c9bfd1…, apply new files in `web/migrations/` with
`npx wrangler d1 migrations apply apimender --remote --env apimender`), hourly cron.

## Waiting on people

- arkaraae: review and merge the pull request; add `https://apimender.com/live` to the Supabase
  Auth redirect URLs; publish Quote API version 2 (`accountId`) from `/live` so the gateway's
  rescue shows on the managed API too (the testbed already shows it).
- Team: add a LICENSE if the engine should be open source (the repository has none, so the site
  does not say "open source").

## Next, if there is time

- "Which of my apps are affected?": use REA (github.com/morluto/rea) on apps the user owns to
  list the endpoints a shipped app calls, and match them with the changes. Never on other
  companies' software: REA's own rules forbid it.
- Form-encoded request checks in test servers (Stripe-style APIs).
- Email alerts for watches (needs an email service account).
