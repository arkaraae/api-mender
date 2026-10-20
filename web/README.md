# API Mender web app

This directory is the deployable Cloudflare Workers app. It contains the public homepage, `/demo`, the Supabase-backed `/live` workspace, and the public and live API routes. The repository-root Node/SQLite prototype and GitHub Actions monitor stay separate.

## Develop and verify

Use Node.js 24 or newer:

```bash
cd web
npm ci
npm run typecheck
npm run build
npm run dev
```

The `.env.production` file and `wrangler.jsonc` contain only the Supabase **publishable** key and URL. They are intentionally public browser configuration. Do not add a service-role key, OpenAI key, GitHub token, or other secret to either file.

The public repository scanner accepts an optional `GITHUB_READ_TOKEN` **Worker secret** to avoid GitHub's shared unauthenticated API limit. Create a fine-grained GitHub token restricted to `arkaraae/api-mender` with repository **Contents: read** (Metadata: read is included), then add it to the `apimender-site` Worker in Cloudflare **Settings → Variables and Secrets** as type **Secret**. Do not add it to GitHub Actions secrets, public environment files, or chat. The token is sent only to `api.github.com`; source files still come from the public raw host. A 403 may have another cause, so rerun the scan after deployment and read the more specific error before changing permissions.

## Team publishing

The apimender.com Worker is named `apimender-site`. Merge a reviewed web change to `main` to run the GitHub workflow: it checks, builds, and deploys from this `web/` directory. The Cloudflare account owner supplies a scoped deployment token as Actions secrets. No developer needs the original ChatGPT Site editor. The `web-check.yml` workflow runs typecheck, tests, and build on pull requests.

The Supabase project remains the database and authentication provider. Before using a new Cloudflare hostname for email signup, add `https://<cloudflare-host>/live` to Supabase Auth redirect URLs. Set the default Site URL to the Cloudflare hostname only after the new sign-in flow has been verified. Do not remove the ChatGPT Site redirect until existing links have expired.

The managed Quote API monitor and consumer tests default to `https://apimender.com`. Override this with the GitHub Actions repository variable `MENDER_TEST_API_URL` only when testing another deployment. `OPENAI_API_KEY` remains an Actions repository secret and is never shipped to the web app.

## Mender in this app

- `/check` compares two versions of an API description in the browser: every change in plain words, whether old callers can be kept working, and the fix for a caller's code. Large descriptions on other sites are read through `/api/mender/fetch`.
- `/watch` keeps an eye on an API description someone depends on: Mender keeps a copy, checks the address again every day (an hourly cron in `worker/index.ts` takes the watches not checked for a day), keeps each changed version, and can post to a Slack or Discord webhook. `/watch/<id>` is the private page; each change opens on `/check`. Watches live in the `MENDER_WATCH` KV namespace; `id` in `wrangler.jsonc` is a placeholder until the namespace is created in the account that deploys.
- `/mender/v1/api/managed/quotes` (and `/api/testbed/…`) is the gateway: it keeps callers of an older version working by translating their calls to the newest published contract. `/mender` shows the rules, the proof, a real request sent both ways, and who still calls an old version; `/api/mender/status` gives the same as JSON.
- `/check` also gives each change an error, warning or info level with a rule name, offers a TypeScript client for the new version (`lib/mender/sdk.js`), and can create a test server for it: `/mock/<id>/…` answers from the description's examples or generated samples and rejects requests that don't match (`lib/mender/mock.js`, kept 30 days in `MENDER_WATCH`). On apimender.com, every old-version call through the gateway is saved in the D1 database `MENDER_DB` (`migrations/`; apply with `npx wrangler d1 migrations apply apimender --remote --env apimender`).
- `/pricing` lists the plans. `.github/actions/mender-check/` is the free GitHub check: it comments the same plain-words report on pull requests that change an API description (see its README); `tests/github-check.test.mjs` runs it against a throwaway repository.
- `/live` can inventory public TypeScript repositories for Stripe calls and AWS S3 `PutObjectCommand`/`GetObjectCommand` calls at a pinned GitHub commit. It reads a root or nested package manifest for the SDK version and links to each detected call site. The Supabase `check-aws-sdk` Edge Function records the official AWS SDK v3 release baseline. A later release creates informational review items only for repositories with scanned S3 calls. This is release detection, not proof of a breaking change or a tested fix. Deploy the versioned function source in `../supabase/functions/check-aws-sdk/` separately from the Cloudflare Worker after verifying it in a non-production Supabase environment.
- The engine lives in `mender/src/` at the repository root and is copied into `lib/mender/` by `node mender/tools/sync-web.mjs`. `npm test` fails if the copy is out of date and runs every engine suite. `lib/mender/gateway.js` and `lib/mender/report.js` belong to this app; `lib/mender-site.ts` registers the site's APIs with the gateway.
- `npm run dev` caps the Workers compatibility date at what the installed runtime supports (see `vite.config.ts`); builds and deploys keep the date in `wrangler.jsonc`.

## Publishing to apimender.com

apimender.com is served from its own Cloudflare account, as the Worker `apimender-site`, using the `apimender` environment in `wrangler.jsonc` (its account, the apimender.com and www.apimender.com custom domains, the `MENDER_WATCH` KV namespace and the hourly cron). The default environment stays as it was for the team's Workers Builds, without the watch list.

After the site branch is merged into `main`, `.github/workflows/web-check.yml` will run typecheck, tests, and a build for each web change. A passing push to `main` then builds for the `apimender` environment and deploys `apimender-site`. The Cloudflare account owner must add `CLOUDFLARE_ACCOUNT_ID` and a narrowly scoped `CLOUDFLARE_API_TOKEN` as GitHub Actions repository secrets before that first push. Scope the token to the apimender.com Cloudflare account and the Worker deployment permissions described in [Cloudflare's GitHub Actions guide](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/). The workflow verifies the generated Worker name, account, and domain before deploying. Do not put the token in source or a Wrangler file.

Cloudflare D1 migrations are not applied by this deployment workflow. Apply and verify any new migration separately before merging code that depends on it. If Cloudflare Workers Builds is also connected to this Worker, disable its production build trigger so the two systems do not race to deploy different commits.

Once, in that account: `npx wrangler login`, then `npx wrangler kv namespace create MENDER_WATCH --env apimender`, and put the id it prints in `env.apimender.kv_namespaces` (done for apimender.com: `743c7ff4…`).

Each release, from `web/`:

```bash
CLOUDFLARE_ENV=apimender npm run build
npx wrangler deploy --config dist/server/wrangler.json
```

For local development with the watch list, run `CLOUDFLARE_ENV=apimender npm run dev`. Sign-up emails from `/live` need `https://apimender.com/live` in the Supabase Auth redirect URLs.
