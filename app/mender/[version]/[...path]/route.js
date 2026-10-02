// The Mender gateway: /mender/v1/api/managed/quotes reaches /api/managed/quotes, with requests
// from version 1 callers translated to the newest published contract and answers translated back.
import { handle } from '@/lib/mender-gateway.js';

export const dynamic = 'force-dynamic';

async function route(request, context) {
  const { version, path } = await context.params;
  return handle(request, version, path);
}

export { route as GET, route as POST, route as PUT, route as PATCH, route as DELETE, route as HEAD, route as OPTIONS };
