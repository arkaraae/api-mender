import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { toOpenApi } from './openapi.mjs';

const contractFile = resolve(process.env.MENDER_CONTRACT_FILE || new URL('./contract.json', import.meta.url).pathname);
const port = Number(process.env.PORT || 4178);

async function contract() {
  const value = JSON.parse(await readFile(contractFile, 'utf8'));
  const identity = value.version === 1 ? 'customerId' : value.version === 2 ? 'accountId' : null;
  if (!identity || value.operation !== 'POST /api/testbed/quotes' || value.acceptedIdentityField !== identity) throw new Error('Invalid Quotes contract');
  return value;
}

function send(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

const server = createServer(async (request, response) => {
  try {
    const active = await contract();
    if (request.method === 'GET' && request.url === '/api/testbed/openapi.json') {
      return send(response, 200, toOpenApi(active));
    }
    if (request.method !== 'POST' || request.url !== '/api/testbed/quotes') return send(response, 404, { error: 'Not found' });
    let text = '';
    for await (const chunk of request) {
      text += chunk;
      if (text.length > 4096) return send(response, 413, { error: 'Request too large' });
    }
    let body;
    try { body = JSON.parse(text); } catch { return send(response, 400, { error: 'Invalid JSON' }); }
    const identity = body?.[active.acceptedIdentityField];
    if (typeof identity !== 'string' || !Number.isInteger(body?.amountCents) || body.amountCents < 1) return send(response, 422, { error: 'Request does not satisfy the active contract', required: active.requiredRequestFields, version: active.version });
    return send(response, 200, { id: `quote_test_${crypto.randomUUID()}`, identity, amountCents: body.amountCents, contractVersion: active.version });
  } catch { return send(response, 502, { error: 'Quotes contract unavailable' }); }
});

server.listen(port, '127.0.0.1', () => console.log(`Quotes test API listening on http://127.0.0.1:${port}`));
