// The storage for watched APIs and test servers (KV) and the site's database (D1, for daily
// limits and sales requests), when this deployment has them (wrangler.jsonc, env "apimender").
import { env } from 'cloudflare:workers';

export const watchStore = () => env.MENDER_WATCH ?? null;

export const siteDatabase = () => env.MENDER_DB ?? null;

export const noWatchStore = () => Response.json({ error: 'Watching APIs is not set up on this deployment.' }, { status: 503, headers: { 'cache-control': 'no-store' } });

// Thrown from a beforeStoring hook to refuse with a ready answer (a 429 from the daily limits).
export class Refused extends Error {
  constructor(readonly response: Response) { super('refused'); }
}
