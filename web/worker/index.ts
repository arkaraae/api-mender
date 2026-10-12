// The Worker: vinext serves the site; every hour, the API descriptions people watch that were
// not checked for a day are downloaded again and compared (see lib/mender/watch.js).
import handler from 'vinext/server/fetch-handler';
import { runDue } from '../lib/mender/watch.js';

export default {
  fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext) {
    return handler.fetch(request, env, ctx);
  },
  async scheduled(_controller: ScheduledController, env: Cloudflare.Env, ctx: ExecutionContext) {
    ctx.waitUntil(runDue(env.MENDER_WATCH, { origin: env.SITE_ORIGIN ?? 'https://apimender.com' }));
  },
};
