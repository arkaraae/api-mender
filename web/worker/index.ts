// The Worker: vinext serves the site; every hour, the API descriptions people watch that were
// not checked for a day are downloaded again and compared (see lib/mender/watch.js), and old
// daily-limit counts are removed (lib/mender/limits.js).
import handler from 'vinext/server/fetch-handler';
import { forgetOldCounts } from '../lib/mender/limits.js';
import { runDue } from '../lib/mender/watch.js';
import { processRepositoryScanJobs } from '../lib/repository-scan-worker';
import { processRepairProofJobs } from '../lib/repair-proof-worker';
import { reportFailure } from '../lib/failure-alert';

export default {
  async fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext) {
    // One address for the site: www.apimender.com → apimender.com.
    const url = new URL(request.url);
    if (url.hostname.startsWith('www.')) {
      url.hostname = url.hostname.slice(4);
      return Response.redirect(url.href, 301);
    }
    try {
      const response = await handler.fetch(request, env, ctx);
      // The path only: query strings can carry tokens and OAuth codes.
      if (response.status >= 500) ctx.waitUntil(reportFailure(env, 'site-5xx',
        new Error(`${request.method} ${url.pathname} returned ${response.status}`)));
      return response;
    } catch (error) {
      ctx.waitUntil(reportFailure(env, 'site-exception', error));
      throw error;
    }
  },
  async scheduled(controller: ScheduledController, env: Cloudflare.Env, ctx: ExecutionContext) {
    const background = (task: string, work: Promise<unknown>) =>
      ctx.waitUntil(work.catch(error => reportFailure(env, task, error)));
    if (env.SUPABASE_SECRET_KEY && env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY) {
      background('repository-scan-cron', processRepositoryScanJobs(env));
      background('repair-proof-cron', processRepairProofJobs(env));
    }
    if (controller.cron === '17 * * * *') {
      if (env.MENDER_WATCH) background('watch-cron', runDue(env.MENDER_WATCH, { origin: env.SITE_ORIGIN ?? 'https://apimender.com' }));
      if (env.MENDER_DB) background('limits-cleanup-cron', forgetOldCounts(env.MENDER_DB));
    }
  },
};
