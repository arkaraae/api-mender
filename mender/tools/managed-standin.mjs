// Serves a local copy of the site's managed Quote API, so the gateway can be tried against a
// version that has not been published yet.
//
//   node mender/tools/managed-standin.mjs 4188 customerId accountId
//
// means: listen on port 4188; version 1 takes customerId, version 2 takes accountId.
import { createServer } from 'node:http';
import { makeManaged } from '../tests/managed.fixture.js';

const port = Number(process.argv[2] || 4188);
const fields = process.argv.slice(3).length ? process.argv.slice(3) : ['customerId', 'accountId'];
const api = makeManaged(fields);

createServer(async (incoming, outgoing) => {
  const chunks = [];
  for await (const chunk of incoming) chunks.push(chunk);
  const bodyless = incoming.method === 'GET' || incoming.method === 'HEAD';
  const request = new Request(`http://127.0.0.1:${port}${incoming.url}`, { method: incoming.method, headers: incoming.headers, body: bodyless ? undefined : Buffer.concat(chunks) });
  const response = await api(request);
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  outgoing.end(Buffer.from(await response.arrayBuffer()));
}).listen(port, '127.0.0.1', () => console.log(`Managed Quote API stand-in on http://127.0.0.1:${port} (versions: ${fields.map((f, i) => `v${i + 1} ${f}`).join(', ')})`));
