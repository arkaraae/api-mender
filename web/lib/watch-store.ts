// The storage for watched APIs, when this deployment has it (wrangler.jsonc, env "apimender").
import { env } from 'cloudflare:workers';

export const watchStore = () => env.MENDER_WATCH ?? null;

export const noWatchStore = () => Response.json({ error: 'Watching APIs is not set up on this deployment.' }, { status: 503, headers: { 'cache-control': 'no-store' } });
