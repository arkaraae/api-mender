// Bindings this app's Worker may have (see wrangler.jsonc). The watch list and test servers need
// MENDER_WATCH and MENDER_DB, which only the apimender environment has. SALES_WEBHOOK is an
// optional secret: a Slack or Discord address that gets each "Contact sales" request.
// SUPABASE_SECRET_KEY is a server-only Worker secret for the public interest form.
declare namespace Cloudflare {
  interface Env {
    MENDER_WATCH?: KVNamespace;
    MENDER_DB?: D1Database;
    SITE_ORIGIN?: string;
    SALES_WEBHOOK?: string;
    NEXT_PUBLIC_SUPABASE_URL?: string;
    SUPABASE_SECRET_KEY?: string;
  }
}
