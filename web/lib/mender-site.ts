// The APIs this site publishes, as the Mender gateway sees them.
//
// The gateway calls the site's own route handlers directly instead of going back out over the
// network, so it works the same on Cloudflare Workers, in `vinext dev`, and in preview builds.
import { env, waitUntil } from 'cloudflare:workers';
import { NextRequest } from 'next/server';
import { registerApi, serveInProcess, setCallLog } from '@/lib/mender/gateway.js';
import { quotesOpenApi } from '@/lib/quotes-testbed';
import { GET as managedContract } from '@/app/api/managed/openapi.json/route';
import { OPTIONS as managedOptions, POST as managedQuotes } from '@/app/api/managed/quotes/route';
import { GET as testbedContract } from '@/app/api/testbed/openapi.json/route';
import { POST as testbedQuotes } from '@/app/api/testbed/quotes/route';

type Handler = (request: NextRequest) => Response | Promise<Response>;
type Read = (url: string) => Promise<{ info?: { version?: string } }>;

// One function per path that picks the route's handler for the request method.
function byMethod(handlers: Record<string, Handler>) {
  return (request: Request) => {
    const handler = handlers[request.method];
    return handler ? handler(new NextRequest(request)) : Response.json({ error: 'Method not allowed' }, { status: 405 });
  };
}

const versionOf = (spec: { info?: { version?: string } }) => Number.parseInt(spec.info?.version ?? '', 10);

registerApi('managed', {
  title: 'Managed Quote API',
  endpoint: '/api/managed/quotes',
  owns: (path: string) => path.startsWith('/api/managed/'),
  // Every published version keeps its own contract: ?version=1, ?version=2, …
  async contracts(origin: string, read: Read) {
    const latest = await read(`${origin}/api/managed/openapi.json`);
    const newest = versionOf(latest);
    if (!Number.isInteger(newest) || newest < 1 || newest > 50) throw new Error('The managed API did not report a usable version.');
    const older = await Promise.all(Array.from({ length: newest - 1 }, (_, i) => read(`${origin}/api/managed/openapi.json?version=${i + 1}`)));
    return [...older.map((spec, i) => ({ version: String(i + 1), spec })), { version: String(newest), spec: latest }];
  },
  probe: { method: 'POST', path: '/api/managed/quotes', body: { customerId: 'customer_1', sku: 'WIDGET-1' } },
});

registerApi('testbed', {
  title: 'Quotes testbed',
  endpoint: '/api/testbed/quotes',
  owns: (path: string) => path.startsWith('/api/testbed/'),
  // The testbed only serves its active contract; version 1 is rebuilt with the same function.
  async contracts(origin: string, read: Read) {
    const live = await read(`${origin}/api/testbed/openapi.json`);
    const newest = versionOf(live);
    if (!Number.isInteger(newest) || newest < 1) throw new Error('The testbed did not report a usable version.');
    const first = quotesOpenApi({ version: 1, operation: 'POST /api/testbed/quotes', requiredRequestFields: ['customerId', 'amountCents'], acceptedIdentityField: 'customerId' });
    return newest === 1 ? [{ version: '1', spec: live }] : [{ version: '1', spec: first }, { version: String(newest), spec: live }];
  },
  probe: { method: 'POST', path: '/api/testbed/quotes', body: { customerId: 'acct_fixture_1', amountCents: 2500 } },
});

serveInProcess({
  '/api/managed/openapi.json': byMethod({ GET: managedContract }),
  '/api/managed/quotes': byMethod({ POST: managedQuotes, OPTIONS: managedOptions }),
  '/api/testbed/openapi.json': byMethod({ GET: testbedContract }),
  '/api/testbed/quotes': byMethod({ POST: testbedQuotes }),
});

// Old-version calls are saved in D1 when this deployment has it (wrangler.jsonc, env "apimender").
type CallEntry = { api: string; caller: string; version: string; endpoint: string; outcome: string; lastAt: string };
const database = env.MENDER_DB;
if (database) {
  setCallLog({
    record: (entry: CallEntry) => database
      .prepare('INSERT INTO old_version_calls (api, caller, version, endpoint, outcome, calls, first_at, last_at) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?6) ON CONFLICT (api, caller, version, endpoint, outcome) DO UPDATE SET calls = calls + 1, last_at = excluded.last_at')
      .bind(entry.api, entry.caller, entry.version, entry.endpoint, entry.outcome, entry.lastAt)
      .run(),
    list: async () => (await database
      .prepare('SELECT api, caller, version, endpoint, outcome, calls, first_at AS firstAt, last_at AS lastAt FROM old_version_calls ORDER BY last_at DESC LIMIT 200')
      .all()).results,
    defer: waitUntil,
  });
}

export { apiNames, callers, callsSaved, check, describe, explain, handle, titleOf } from '@/lib/mender/gateway.js';
