// GET → a watch: the address, when it was last checked, and every version kept so far.
import { env } from 'cloudflare:workers';
import { publicView, readWatch } from '@/lib/mender/watch.js';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const watch = await readWatch(env.MENDER_WATCH, id);
  if (!watch) return Response.json({ error: 'There is no watch at this link.' }, { status: 404 });
  return Response.json(publicView(watch), { headers: { 'cache-control': 'no-store' } });
}
