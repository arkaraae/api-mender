// What Mender knows about each published API: its versions, the rules between them, whether
// those rules are proven, and who still calls an old version. Add ?check=1 to also send one real
// old-style request, directly and through the gateway.
import { apiNames, check, describe, oldVersionCalls, titleOf } from '@/lib/mender-site';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const withCheck = url.searchParams.get('check') === '1';
  const apis = await Promise.all(apiNames().map(async (name: string) => {
    try {
      const api = await describe(name, url.origin);
      return withCheck ? { ...api, check: await check(name, url.origin) } : api;
    } catch (error) {
      return { name, title: titleOf(name), error: error instanceof Error ? error.message : String(error) };
    }
  }));
  return Response.json({ apis, oldVersionCalls: oldVersionCalls() }, { headers: { 'cache-control': 'no-store' } });
}
