// GET → one kept version of the watched description, exactly as it was downloaded.
import { noWatchStore, watchStore } from '@/lib/watch-store';
import { readSnapshot } from '@/lib/mender/watch.js';

export async function GET(_request: Request, context: { params: Promise<{ id: string; n: string }> }) {
  const kv = watchStore();
  if (!kv) return noWatchStore();
  const { id, n } = await context.params;
  const text = await readSnapshot(kv, id, n);
  if (text === null) return Response.json({ error: 'That version is not kept.' }, { status: 404 });
  return new Response(text, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'private, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' } });
}
