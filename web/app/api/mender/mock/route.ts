// POST an API description (JSON or YAML) → a test server that answers like that API would.
import { createMock } from '@/lib/mender/mock.js';
import { noWatchStore, watchStore } from '@/lib/watch-store';

export async function POST(request: Request) {
  const kv = watchStore();
  if (!kv) return noWatchStore();
  try {
    const mock = await createMock(kv, await request.text());
    const base = `${new URL(request.url).origin}/mock/${mock.id}`;
    return Response.json({ ...mock, base }, { status: 201, headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 422 });
  }
}
