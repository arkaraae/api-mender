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

## Team publishing

The Cloudflare Worker is named `api-mender` and uses this `web/` directory as its build root. Cloudflare Workers Builds should connect to `arkaraae/api-mender`, use `main` as the production branch, run `npm run build`, then `npx wrangler deploy`. Enable branch previews for pull requests. Merge a reviewed change to `main` to deploy it for everyone; no developer needs the original ChatGPT Site editor. The GitHub workflow `web-check.yml` runs typecheck and build on pull requests.

The Supabase project remains the database and authentication provider. Before using a new Cloudflare hostname for email signup, add `https://<cloudflare-host>/live` to Supabase Auth redirect URLs. Set the default Site URL to the Cloudflare hostname only after the new sign-in flow has been verified. Do not remove the ChatGPT Site redirect until existing links have expired.

After the Cloudflare API is verified, set the GitHub Actions repository variable `MENDER_TEST_API_URL` to the Cloudflare origin so the managed Quote API monitor and consumer tests follow the new deployment. `OPENAI_API_KEY` remains an Actions repository secret and is never shipped to the web app.

## Mender in this app

- `/check` compares two versions of an API description in the browser: every change in plain words, whether old callers can be kept working, and the fix for a caller's code. Large descriptions on other sites are read through `/api/mender/fetch`.
- `/mender/v1/api/managed/quotes` (and `/api/testbed/…`) is the gateway: it keeps callers of an older version working by translating their calls to the newest published contract. `/mender` shows the rules, the proof, a real request sent both ways, and who still calls an old version; `/api/mender/status` gives the same as JSON.
- The engine lives in `mender/src/` at the repository root and is copied into `lib/mender/` by `node mender/tools/sync-web.mjs`. `npm test` fails if the copy is out of date and runs every engine suite. `lib/mender/gateway.js` and `lib/mender/report.js` belong to this app; `lib/mender-site.ts` registers the site's APIs with the gateway.
- `npm run dev` caps the Workers compatibility date at what the installed runtime supports (see `vite.config.ts`); builds and deploys keep the date in `wrangler.jsonc`.
