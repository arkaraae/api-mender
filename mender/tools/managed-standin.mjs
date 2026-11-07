// Serves a local copy of the site's two published APIs, so the gateway can be tried against
// a version that has not been published yet:
//
//   node mender/tools/managed-standin.mjs 4188 customerId accountId
//
// means: listen on port 4188; the managed Quote API has version 1 taking customerId and
// version 2 taking accountId. The Quotes testbed is served at version 2, as it is deployed.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { makeManaged } from '../tests/managed.fixture.js';
import { makeQuotes } from '../tests/quotes.fixture.js';

const port = Number(process.argv[2] || 4188);
const fields = process.argv.slice(3).length ? process.argv.slice(3) : ['customerId', 'accountId'];
const managed = makeManaged(fields);
const testbed = makeQuotes(2, JSON.parse(readFileSync(new URL('../sandbox/quotes/openapi-v2.json', import.meta.url), 'utf8')));

createServer(async (incoming, outgoing) => {
  const chunks = [];
  for await (const chunk of incoming) chunks.push(chunk);
  const bodyless = incoming.method === 'GET' || incoming.method === 'HEAD';
  const request = new Request(`http://127.0.0.1:${port}${incoming.url}`, { method: incoming.method, headers: incoming.headers, body: bodyless ? undefined : Buffer.concat(chunks) });
  const response = await (incoming.url.startsWith('/api/testbed/') ? testbed : managed)(request);
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  outgoing.end(Buffer.from(await response.arrayBuffer()));
}).listen(port, '127.0.0.1', () => console.log(`Quote API stand-in on http://127.0.0.1:${port} (managed: ${fields.map((f, i) => `v${i + 1} ${f}`).join(', ')}; testbed: v2 accountId)`));
