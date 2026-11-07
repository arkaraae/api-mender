// What Mender knows about each published API: its versions, the rules between them, whether
// those rules are proven, and who still calls an old version. Add ?check=1 to also send one
// real old-style request, directly and through the gateway.
import { APIS, check, describe, oldVersionCalls, upstreamFor } from '@/lib/mender-gateway.js';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  const upstream = upstreamFor(request);
  const url = new URL(request.url);
  const withCheck = url.searchParams.get('check') === '1';
  const apis = await Promise.all(Object.keys(APIS).map(async (name) => {
    try {
      const api = await describe(name, upstream);
      return withCheck ? { ...api, check: await check(name, upstream, url.origin) } : api;
    } catch (error) {
      return { name, title: APIS[name].title, error: String(error.message ?? error) };
    }
  }));
  return Response.json({ upstream, apis, oldVersionCalls: oldVersionCalls() }, { headers: { 'cache-control': 'no-store' } });
}
