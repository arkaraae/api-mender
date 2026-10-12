// Bindings this app's Worker may have (see wrangler.jsonc). The watch list needs MENDER_WATCH,
// which only the apimender environment has.
declare namespace Cloudflare {
  interface Env {
    MENDER_WATCH?: KVNamespace;
    SITE_ORIGIN?: string;
  }
}
