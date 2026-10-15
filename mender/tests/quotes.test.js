// The team's Quotes API, end to end: the API changed (customerId → accountId), the consumer did
// not, and Mender keeps the consumer working. No rule in this file is written by hand.

import v1 from '../sandbox/quotes/openapi-v1.json' with { type: 'json' };
import v2 from '../sandbox/quotes/openapi-v2.json' with { type: 'json' };
import { proveWithSchemas, rulesFromOpenApi } from '../src/openapi.js';
import { inferRules } from '../src/infer.js';
import { changelog } from '../src/rules.js';
import { createQuote, LIVE_QUOTES, makeQuotes, QUOTES_ORIGIN, quotesGateway, withFetch } from './quotes.fixture.js';
import { assert, same } from './helpers.js';

const RULE = { op: 'rename', old: 'customerId', new: 'accountId', in: 'request' };
const post = (handler, body, headers = {}) => handler(new Request(`${QUOTES_ORIGIN}/api/testbed/quotes`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body),
}));

// The three checks in testbed/quotes-consumer/tests/quotes.test.mjs.
function teamAssertions(quote) {
  assert(quote.amountCents === 2500, `amountCents is ${quote.amountCents}`);
  assert(quote.identity === 'acct_fixture_1', `identity is ${quote.identity}`);
  assert(typeof quote.id === 'string', 'id is not text');
}

export const quotes = [
  ['The break is real: version 1 accepts the consumer, version 2 rejects it with a 422', async () => {
    teamAssertions(await withFetch(makeQuotes(1, v1), () => createQuote(QUOTES_ORIGIN, 'acct_fixture_1', 2500)));
    let message = '';
    try { await withFetch(makeQuotes(2, v2), () => createQuote(QUOTES_ORIGIN, 'acct_fixture_1', 2500)); } catch (error) { message = error.message; }
    assert(/Quotes API returned 422/.test(message), `expected a 422, got "${message}"`);
  }],

  ['From the two specs alone, Mender finds that customerId became accountId', () => {
    const found = rulesFromOpenApi(v1, v2);
    same(found.rules, [RULE]);
    assert(found.notes.some((n) => n.code === 'required_swap'), 'the rule should be flagged for confirmation');
    same(found.operations, [{ endpoint: 'POST /api/testbed/quotes', status: 'kept', to: 'POST /api/testbed/quotes' }]);
  }],

  ['The spec proof passes with the rule and fails without it', () => {
    const proof = proveWithSchemas(v1, v2, rulesFromOpenApi(v1, v2).rules);
    assert(proof.ok && proof.samples >= 2, JSON.stringify(proof));
    const bare = proveWithSchemas(v1, v2, []);
    assert(!bare.ok && bare.checks[0].failures.some((f) => f.path === 'accountId' && /required/.test(f.message)), JSON.stringify(bare));
  }],

  ['Through Mender, the unchanged consumer passes the team\'s own checks against version 2', async () => {
    const gateway = quotesGateway(makeQuotes(2, v2), rulesFromOpenApi(v1, v2).rules);
    const quote = await withFetch(gateway, () => createQuote(QUOTES_ORIGIN, 'acct_fixture_1', 2500));
    teamAssertions(quote);
    assert(quote.contractVersion === 2, 'the answer did not come from version 2');
  }],

  ['The same rule is found from one pair of example requests, with no spec at all', () => {
    const rules = inferRules([{ old: { customerId: 'acct_fixture_1', amountCents: 2500 }, new: { accountId: 'acct_fixture_1', amountCents: 2500 } }]);
    same(rules, [{ op: 'rename', old: 'customerId', new: 'accountId' }]);
  }],

  ['A caller that already sends accountId is left alone, even next to a stale customerId', async () => {
    const gateway = quotesGateway(makeQuotes(2, v2), [RULE]);
    same((await (await post(gateway, { accountId: 'acct_new', amountCents: 100 })).json()).identity, 'acct_new');
    same((await (await post(gateway, { accountId: 'acct_new', customerId: 'acct_old', amountCents: 100 })).json()).identity, 'acct_new');
    same((await (await post(gateway, { accountId: 'acct_new', amountCents: 100 }, { 'quotes-version': '2' })).json()).identity, 'acct_new');
  }],

  ['Bad requests still get the API\'s own answers, untouched', async () => {
    const gateway = quotesGateway(makeQuotes(2, v2), [RULE]);
    const missing = await post(gateway, { amountCents: 2500 });
    same([missing.status, await missing.json()], [422, { error: 'Request does not satisfy the active contract', required: ['accountId', 'amountCents'], version: 2 }]);
    const broken = await post(gateway, '{"customerId": ');
    same([broken.status, await broken.json()], [400, { error: 'Invalid JSON' }]);
    const zero = await post(gateway, { customerId: 'a', amountCents: 0 });
    assert(zero.status === 422, `amountCents 0 got ${zero.status}`);
    const huge = await post(gateway, { customerId: 'a', amountCents: 1, note: 'x'.repeat(5000) });
    assert(huge.status === 413, `oversized got ${huge.status}`);
  }],

  ['Other routes pass through Mender, including the spec itself', async () => {
    const gateway = quotesGateway(makeQuotes(2, v2), [RULE]);
    const spec = await gateway(new Request(`${QUOTES_ORIGIN}/api/testbed/openapi.json`));
    same(await spec.json(), v2);
    const nowhere = await gateway(new Request(`${QUOTES_ORIGIN}/api/unknown`));
    assert(nowhere.status === 404, `got ${nowhere.status}`);
  }],

  ['Every old-style call is counted per caller, so the team sees who still sends customerId', async () => {
    const events = [];
    const gateway = quotesGateway(makeQuotes(2, v2), [RULE], { identify: (request) => request.headers.get('x-consumer') ?? 'anonymous', onCall: (event) => events.push(event) });
    await post(gateway, { customerId: 'a', amountCents: 1 }, { 'x-consumer': 'checkout-service' });
    await post(gateway, { customerId: 'b', amountCents: 1 }, { 'x-consumer': 'checkout-service' });
    await post(gateway, { accountId: 'c', amountCents: 1 }, { 'x-consumer': 'billing-service', 'quotes-version': '2' });
    same(events.map((e) => [e.customer, e.version, e.outcome, e.status]), [['checkout-service', '1', 'translated', 200], ['checkout-service', '1', 'translated', 200]]);
  }],

  ['The team\'s CI flow with Mender in it: read the deployed spec, compare, prove, then serve', async () => {
    const deployed = makeQuotes(2, v2);
    const published = await (await deployed(new Request(`${QUOTES_ORIGIN}/api/testbed/openapi.json`))).json();
    const found = rulesFromOpenApi(v1, published);
    assert(proveWithSchemas(v1, published, found.rules).ok, 'the rules did not prove out');
    const before = await withFetch(deployed, () => createQuote(QUOTES_ORIGIN, 'acct_fixture_1', 2500).then(() => 'passed', () => 'failed'));
    const after = await withFetch(quotesGateway(deployed, found.rules), () => createQuote(QUOTES_ORIGIN, 'acct_fixture_1', 2500).then(() => 'passed', () => 'failed'));
    same([before, after], ['failed', 'passed']);
  }],

  ['The rule reads as a changelog line a customer can understand', () => {
    same(changelog({ from: '1', to: '2', rules: [RULE] }), 'Changes from 1 to 2\n\n- customerId is now accountId (in requests)');
  }],
];

// ---------- against the deployed API (opt-in: MENDER_LIVE=1, or ?live in the browser) ----------

const inBrowser = typeof window !== 'undefined';
const realFetch = globalThis.fetch.bind(globalThis);
export const liveEnabled = inBrowser ? new URLSearchParams(window.location.search).has('live') : globalThis.process?.env?.MENDER_LIVE === '1';

// A handler that sends the request to the deployed API. In a browser the call goes through the
// dev server's proxy, because the deployed API does not accept calls from other sites.
async function deployed(request) {
  const url = new URL(request.url);
  const target = LIVE_QUOTES + url.pathname + url.search;
  const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer();
  const headers = { accept: 'application/json' };
  if (body) headers['content-type'] = request.headers.get('content-type') ?? 'application/json';
  return realFetch(inBrowser ? `/__proxy?url=${encodeURIComponent(target)}` : target, { method: request.method, headers, body });
}

export const live = [
  ['The deployed API still serves the version 2 spec these tests were written against', async () => {
    const response = await deployed(new Request(`${QUOTES_ORIGIN}/api/testbed/openapi.json`));
    same(await response.json(), v2, 'the deployed spec has drifted from sandbox/quotes/openapi-v2.json');
  }],

  ['The deployed API rejects the unchanged consumer', async () => {
    const outcome = await withFetch(deployed, () => createQuote(QUOTES_ORIGIN, 'acct_fixture_1', 2500).then(() => 'passed', (error) => error.message));
    assert(/Quotes API returned 422/.test(outcome), `expected a 422, got "${outcome}"`);
  }],

  ['Through Mender, the unchanged consumer gets a quote from the deployed API', async () => {
    const published = await (await deployed(new Request(`${QUOTES_ORIGIN}/api/testbed/openapi.json`))).json();
    const gateway = quotesGateway(deployed, rulesFromOpenApi(v1, published).rules);
    const quote = await withFetch(gateway, () => createQuote(QUOTES_ORIGIN, 'acct_fixture_1', 2500));
    teamAssertions(quote);
    assert(quote.contractVersion === 2 && quote.id.startsWith('quote_test_'), JSON.stringify(quote));
  }],

  ['The deployed API\'s own error comes back through Mender unchanged', async () => {
    const response = await post(quotesGateway(deployed, [RULE]), { amountCents: 2500 });
    same([response.status, await response.json()], [422, { error: 'Request does not satisfy the active contract', required: ['accountId', 'amountCents'], version: 2 }]);
  }],
];
