// A copy of the site's managed Quote API for trying versions the owner has not published yet.
// It answers like the deployed API at /api/managed/*: the same contract shape and the same
// errors (checked against the deployed API on 2026-10-01). Each entry of `identityFields` is
// one published version: ['customerId', 'accountId'] means v1 takes customerId and v2 accountId.
//
// createQuote is the consumer from examples/quote-api-consumer/src/client.mjs, copied unchanged.

const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const PRODUCTS = { 'WIDGET-1': { product: 'Widget', amountCents: 2500 }, 'GADGET-2': { product: 'Gadget', amountCents: 4999 } };

export function managedContract(version, identityField, note) {
  return {
    openapi: '3.0.3',
    info: { title: 'API Mender Managed Quote API', version: `${version}.0.0`, description: note ?? (version === 1 ? 'Initial public contract' : `The identity field is now ${identityField}`) },
    paths: {
      '/api/managed/quotes': {
        post: {
          operationId: 'createManagedQuote',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: [identityField, 'sku'], properties: { [identityField]: { type: 'string' }, sku: { type: 'string' } } } } } },
          responses: {
            200: { description: 'Quote created', content: { 'application/json': { schema: { type: 'object', required: ['id', 'sku', 'amountCents', 'contractVersion'], properties: { id: { type: 'string' }, sku: { type: 'string' }, amountCents: { type: 'integer' }, contractVersion: { type: 'integer' } } } } } },
            404: { description: 'Product not found' },
            422: { description: 'Request does not match the published contract' },
          },
        },
      },
    },
  };
}

export function makeManaged(identityFields) {
  const latest = identityFields.length;
  return async function managed(request) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/api/managed/openapi.json') {
      const asked = url.searchParams.get('version');
      const version = asked === null ? latest : Number(asked);
      if (!Number.isInteger(version) || version < 1) return reply(400, { error: 'Invalid version' });
      if (version > latest) return reply(503, { error: 'Published API version is unavailable' });
      return reply(200, managedContract(version, identityFields[version - 1]));
    }
    if (request.method !== 'POST' || url.pathname !== '/api/managed/quotes') return reply(404, { error: 'Not found' });
    let body;
    try { body = JSON.parse(await request.text()); } catch { return reply(400, { error: 'Invalid JSON object' }); }
    const field = identityFields[latest - 1];
    if (!body || typeof body !== 'object' || typeof body[field] !== 'string' || typeof body.sku !== 'string') {
      return reply(422, { error: 'Request does not match the published contract', required: [field, 'sku'], version: latest });
    }
    const product = PRODUCTS[body.sku];
    if (!product) return reply(404, { error: 'Product not found' });
    return reply(200, { id: `quote_${crypto.randomUUID()}`, sku: body.sku, ...product, contractVersion: latest });
  };
}

// ---- copied unchanged from examples/quote-api-consumer/src/client.mjs ----
/** A separate application using the public, database-backed Quote API. */
export async function createQuote(apiBaseUrl, customerId, sku) {
  const response = await fetch(`${apiBaseUrl}/api/managed/quotes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ customerId, sku }),
  });
  if (!response.ok) throw new Error(`Quote API returned ${response.status}: ${await response.text()}`);
  return response.json();
}
// --------------------------------------------------------------------------
