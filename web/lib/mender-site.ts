// The APIs this site publishes, as the Mender gateway sees them.
//
// The gateway calls the site's own route handlers directly instead of going back out over the
// network, so it works the same on Cloudflare Workers, in `vinext dev`, and in preview builds.
import { NextRequest } from 'next/server';
import { registerApi, serveInProcess } from '@/lib/mender/gateway.js';
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

export { apiNames, check, describe, explain, handle, oldVersionCalls, titleOf } from '@/lib/mender/gateway.js';
