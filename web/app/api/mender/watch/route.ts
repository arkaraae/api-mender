// POST { url, webhook? } → starts watching an API description and returns its private link.
import { noWatchStore, watchStore } from '@/lib/watch-store';
import { createWatch, publicView } from '@/lib/mender/watch.js';

export async function POST(request: Request) {
  const kv = watchStore();
  if (!kv) return noWatchStore();
  let input: { url?: string; webhook?: string };
  try { input = await request.json(); } catch { return Response.json({ error: 'Send JSON: { "url": "https://…" }' }, { status: 400 }); }
  try {
    const watch = await createWatch(kv, input);
    return Response.json(publicView(watch), { status: 201, headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 422 });
  }
}
