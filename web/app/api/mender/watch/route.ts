// POST { url, webhook? } → starts watching an API description and returns its private link.
import { env } from 'cloudflare:workers';
import { createWatch, publicView } from '@/lib/mender/watch.js';

export async function POST(request: Request) {
  let input: { url?: string; webhook?: string };
  try { input = await request.json(); } catch { return Response.json({ error: 'Send JSON: { "url": "https://…" }' }, { status: 400 }); }
  try {
    const watch = await createWatch(env.MENDER_WATCH, input);
    return Response.json(publicView(watch), { status: 201, headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 422 });
  }
}
