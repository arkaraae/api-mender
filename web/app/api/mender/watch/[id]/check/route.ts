// POST → checks the watched description now instead of waiting for the daily check.
import { noWatchStore, watchStore } from '@/lib/watch-store';
import { CHECK_AGAIN_AFTER, checkWatch, publicView, readWatch } from '@/lib/mender/watch.js';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const kv = watchStore();
  if (!kv) return noWatchStore();
  const { id } = await context.params;
  const watch = await readWatch(kv, id);
  if (!watch) return Response.json({ error: 'There is no watch at this link.' }, { status: 404 });
  const wait = CHECK_AGAIN_AFTER - (Date.now() - watch.lastCheckedAt);
  if (wait > 0) return Response.json({ error: `Checked a moment ago. Try again in ${Math.ceil(wait / 1000)} seconds.` }, { status: 429 });
  const result = await checkWatch(kv, id, { origin: new URL(request.url).origin });
  return Response.json({ changed: result?.changed ?? false, watch: result ? publicView(result.watch) : null }, { headers: { 'cache-control': 'no-store' } });
}
