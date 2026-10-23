// The Worker: vinext serves the site; every hour, the API descriptions people watch that were
// not checked for a day are downloaded again and compared (see lib/mender/watch.js), and old
// daily-limit counts are removed (lib/mender/limits.js).
import handler from 'vinext/server/fetch-handler';
import { forgetOldCounts } from '../lib/mender/limits.js';
import { runDue } from '../lib/mender/watch.js';
import { processRepositoryScanJobs } from '../lib/repository-scan-worker';

export default {
  fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext) {
    // One address for the site: www.apimender.com → apimender.com.
    const url = new URL(request.url);
    if (url.hostname.startsWith('www.')) {
      url.hostname = url.hostname.slice(4);
      return Response.redirect(url.href, 301);
    }
    return handler.fetch(request, env, ctx);
  },
  async scheduled(controller: ScheduledController, env: Cloudflare.Env, ctx: ExecutionContext) {
    if (env.SUPABASE_SECRET_KEY && env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY)
      ctx.waitUntil(processRepositoryScanJobs(env));
    if (controller.cron === '17 * * * *') {
      if (env.MENDER_WATCH) ctx.waitUntil(runDue(env.MENDER_WATCH, { origin: env.SITE_ORIGIN ?? 'https://apimender.com' }));
      if (env.MENDER_DB) ctx.waitUntil(forgetOldCounts(env.MENDER_DB));
    }
  },
};
