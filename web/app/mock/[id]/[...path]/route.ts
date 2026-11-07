// A test server: /mock/<id>/<path of the API> answers from the stored API description.
import { answerMock } from '@/lib/mender/mock.js';
import { noWatchStore, watchStore } from '@/lib/watch-store';

type Context = { params: Promise<{ id: string; path: string[] }> };

async function route(request: Request, context: Context) {
  const kv = watchStore();
  if (!kv) return noWatchStore();
  const { id, path } = await context.params;
  return answerMock(kv, id, request, `/${path.join('/')}`);
}

export { route as GET, route as POST, route as PUT, route as PATCH, route as DELETE, route as HEAD, route as OPTIONS };
