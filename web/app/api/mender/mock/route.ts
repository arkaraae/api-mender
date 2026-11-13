// POST an API description (JSON or YAML) → a test server that answers like that API would.
import { createMock } from '@/lib/mender/mock.js';
import { readBoundedBody } from '@/lib/github-app';
import { spend } from '@/lib/mender/limits.js';
import { noWatchStore, Refused, siteDatabase, watchStore } from '@/lib/watch-store';

export async function POST(request: Request) {
  const kv = watchStore();
  if (!kv) return noWatchStore();
  let text: string;
  // Bounded before decoding; createMock enforces its own 15 MB limit on the text.
  try { text = new TextDecoder().decode(await readBoundedBody(request, 15 * 1024 * 1024 + 1)); }
  catch { return Response.json({ error: 'The description is larger than 15 MB.' }, { status: 413 }); }
  try {
    const mock = await createMock(kv, text, {
      beforeStoring: async ({ newBytes }: { newBytes: number }) => {
        const refused = await spend(siteDatabase(), request, 'mock') ?? (newBytes ? await spend(siteDatabase(), request, 'mockBytes', { amount: newBytes }) : null);
        if (refused) throw new Refused(refused);
      },
    });
    const base = `${new URL(request.url).origin}/mock/${mock.id}`;
    return Response.json({ ...mock, base }, { status: 201, headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    if (error instanceof Refused) return error.response;
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 422 });
  }
}
