// GET → a watch: the address, when it was last checked, and every version kept so far.
import { noWatchStore, watchStore } from '@/lib/watch-store';
import { publicView, readWatch } from '@/lib/mender/watch.js';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const kv = watchStore();
  if (!kv) return noWatchStore();
  const { id } = await context.params;
  const watch = await readWatch(kv, id);
  if (!watch) return Response.json({ error: 'There is no watch at this link.' }, { status: 404 });
  return Response.json(publicView(watch), { headers: { 'cache-control': 'no-store' } });
}
