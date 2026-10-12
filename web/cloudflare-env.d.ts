// Bindings this app's Worker has (see wrangler.jsonc).
declare namespace Cloudflare {
  interface Env {
    MENDER_WATCH: KVNamespace;
    SITE_ORIGIN?: string;
  }
}
