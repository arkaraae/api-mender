// GET → a watch: the address, when it was last checked, and every version kept so far.
// DELETE → stops it: nothing more is checked or sent, and the kept copies are removed.
import { noWatchStore, watchStore } from '@/lib/watch-store';
import { deleteWatch, publicView, readWatch } from '@/lib/mender/watch.js';

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  const kv = watchStore();
  if (!kv) return noWatchStore();
  const { id } = await context.params;
  const watch = await readWatch(kv, id);
  if (!watch) return Response.json({ error: 'There is no watch at this link.' }, { status: 404 });
  return Response.json(publicView(watch), { headers: { 'cache-control': 'no-store' } });
}

export async function DELETE(_request: Request, context: Context) {
  const kv = watchStore();
  if (!kv) return noWatchStore();
  const { id } = await context.params;
  if (!(await deleteWatch(kv, id))) return Response.json({ error: 'There is no watch at this link.' }, { status: 404 });
  return Response.json({ stopped: true }, { headers: { 'cache-control': 'no-store' } });
}
