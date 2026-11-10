// Bindings this app's Worker may have (see wrangler.jsonc). The watch list and test servers need
// MENDER_WATCH and MENDER_DB, which only the apimender environment has. SALES_WEBHOOK is an
// optional secret: a Slack or Discord address that gets each "Contact sales" request.
// SUPABASE_SECRET_KEY is a server-only Worker secret for the public interest form.
// ALERT_WEBHOOK is an optional secret: a Slack or Discord address for operator failure alerts.
declare namespace Cloudflare {
  interface Env {
    NEXT_PUBLIC_SUPABASE_URL?: string;
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?: string;
    MENDER_WATCH?: KVNamespace;
    MENDER_DB?: D1Database;
    SITE_ORIGIN?: string;
    SALES_WEBHOOK?: string;
    ALERT_WEBHOOK?: string;
    SUPABASE_SECRET_KEY?: string;
    GITHUB_WEBHOOK_SECRET?: string;
    GITHUB_APP_ID?: string;
    GITHUB_APP_PRIVATE_KEY?: string;
    // Private, authenticated endpoint of Mender's open-weight model service
    // (model-service/). Secrets. No hosted AI provider is ever configured.
    MENDER_MODEL_ENDPOINT?: string;
    MENDER_MODEL_NAME?: string;
    MENDER_MODEL_API_KEY?: string;
    GITHUB_APP_CLIENT_ID?: string;
    GITHUB_APP_CLIENT_SECRET?: string;
    GITHUB_APP_SLUG?: string;
  }
}
