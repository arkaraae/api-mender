# Live deployment

The `api-mender-live` Cloudflare Worker serves `apimender.com` and `www.apimender.com`. Cloudflare Builds is connected to `arkaraae/api-mender` with `main` as its production branch and `web` as its root directory. A push to `main` builds with `CLOUDFLARE_ENV=owner_live npm run build -- --mode owner_live` and deploys with `npx wrangler deploy --config dist/server/wrangler.json`.

The custom Vite mode `owner_live` loads public browser configuration from `.env.owner_live`. That file contains only the Supabase URL and publishable key. Production server credentials stay encrypted in Cloudflare Worker settings; do not put them in Git. Preview builds are disabled.

Schema migrations and GitHub App permission changes require separate review before a code release that depends on them. After a production build, check that the new version has 100% traffic in Cloudflare Deployments and verify the public `/`, `/live`, and `/api/mender/status?check=1` endpoints.

The initial connection selected the existing Cloudflare Builds credential. Replace it with a dedicated credential scoped to this Worker and the `apimender.com` route when Cloudflare exposes that credential to the Builds selector. The separately created `API Mender live builds` external-CI token does not appear in that selector.
