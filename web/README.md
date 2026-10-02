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
