// The team's Quotes test API and its consumer, for running the whole loop in memory.
//
// makeQuotes follows testbed/quotes-api/server.mjs on main line for line: version 1 accepts
// `customerId`, version 2 accepts `accountId`, anything else is a 422.
// createQuote is the consumer from testbed/quotes-consumer/src/client.mjs, copied unchanged.

import { compileRules } from '../src/rules.js';
import { withMender } from '../src/mender.js';

export const QUOTES_ORIGIN = 'https://quotes.example.test';
export const LIVE_QUOTES = 'https://api-mender.aom31905.chatgpt.site';

const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export function makeQuotes(version, spec) {
  const identityField = version === 1 ? 'customerId' : 'accountId';
  return async function quotes(request) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/api/testbed/openapi.json') return reply(200, spec);
    if (request.method !== 'POST' || url.pathname !== '/api/testbed/quotes') return reply(404, { error: 'Not found' });
    const text = await request.text();
    if (text.length > 4096) return reply(413, { error: 'Request too large' });
    let body;
    try { body = JSON.parse(text); } catch { return reply(400, { error: 'Invalid JSON' }); }
    const identity = body?.[identityField];
    if (typeof identity !== 'string' || !Number.isInteger(body?.amountCents) || body.amountCents < 1) {
      return reply(422, { error: 'Request does not satisfy the active contract', required: [identityField, 'amountCents'], version });
    }
    return reply(200, { id: `quote_test_${crypto.randomUUID()}`, identity, amountCents: body.amountCents, contractVersion: version });
  };
}

// ---- copied unchanged from testbed/quotes-consumer/src/client.mjs ----
export async function createQuote(apiBaseUrl, customerId, amountCents) {
  const response = await fetch(`${apiBaseUrl}/api/testbed/quotes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ customerId, amountCents }),
  });
  if (!response.ok) throw new Error(`Quotes API returned ${response.status}: ${await response.text()}`);
  return response.json();
}
// ----------------------------------------------------------------------

// The consumer calls the global fetch. This points it at a handler for the length of one test.
export async function withFetch(handler, run) {
  const real = globalThis.fetch;
  globalThis.fetch = (input, init) => handler(new Request(input, init));
  try { return await run(); } finally { globalThis.fetch = real; }
}

// Mender in front of a Quotes API. The old consumer sends no version, so callers that say
// nothing are treated as version 1.
export function quotesGateway(api, rules, extra = {}) {
  return withMender(api, {
    latest: '2',
    adapters: [compileRules({ from: '1', to: '2', rules })],
    versionHeader: 'Quotes-Version',
    defaultVersion: '1',
    ...extra,
  });
}
