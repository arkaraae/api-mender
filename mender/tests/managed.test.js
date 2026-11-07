// The site's managed Quote API: versions are published one after another, each with its own
// contract at /api/managed/openapi.json?version=N. Mender reads consecutive contracts, proves
// the rules between them, and keeps a consumer written for version 1 working on any later one.

import { proveWithSchemas, rulesFromOpenApi } from '../src/openapi.js';
import { compileRules } from '../src/rules.js';
import { withMender } from '../src/mender.js';
import { createQuote, makeManaged, managedContract } from './managed.fixture.js';
import { withFetch } from './quotes.fixture.js';
import { assert, same } from './helpers.js';

const ORIGIN = 'https://managed.example.test';
const outcome = (run) => run().then(() => 'passed', (error) => error.message);

// Builds the gateway the way the site does: read every published contract, turn each step into
// an adapter, and treat the caller as being on `pinned`.
async function gatewayFor(api, pinned) {
  const read = async (query) => (await api(new Request(`${ORIGIN}/api/managed/openapi.json${query}`))).json();
  const latest = await read('');
  const newest = Number.parseInt(latest.info.version, 10);
  const contracts = [];
  for (let v = 1; v < newest; v++) contracts.push(await read(`?version=${v}`));
  contracts.push(latest);
  const steps = contracts.slice(1).map((spec, i) => ({ from: String(i + 1), to: String(i + 2), rules: rulesFromOpenApi(contracts[i], spec).rules, proof: proveWithSchemas(contracts[i], spec, rulesFromOpenApi(contracts[i], spec).rules) }));
  const gateway = withMender(api, { latest: String(newest), adapters: steps.map((s) => compileRules(s)), version: () => pinned });
  return { gateway, steps };
}

export const managed = [
  ['The published contracts alone show that customerId became accountId', () => {
    const found = rulesFromOpenApi(managedContract(1, 'customerId'), managedContract(2, 'accountId'));
    same(found.rules, [{ op: 'rename', old: 'customerId', new: 'accountId', in: 'request' }]);
    assert(proveWithSchemas(managedContract(1, 'customerId'), managedContract(2, 'accountId'), found.rules).ok, 'proof failed');
  }],

  ['The consumer written for version 1 fails on version 2, and passes through Mender', async () => {
    const api = makeManaged(['customerId', 'accountId']);
    assert(/Quote API returned 422/.test(await withFetch(api, () => outcome(() => createQuote(ORIGIN, 'customer_1', 'WIDGET-1')))), 'version 2 accepted the old consumer');
    const { gateway } = await gatewayFor(api, '1');
    const quote = await withFetch(gateway, () => createQuote(ORIGIN, 'customer_1', 'WIDGET-1'));
    same([quote.sku, quote.amountCents, typeof quote.id, quote.contractVersion], ['WIDGET-1', 2500, 'string', 2]);
  }],

  ['After three published versions the version 1 consumer still works, through two steps', async () => {
    const api = makeManaged(['customerId', 'accountId', 'clientId']);
    const { gateway, steps } = await gatewayFor(api, '1');
    same(steps.map((s) => [s.from, s.to, s.rules[0].old, s.rules[0].new, s.proof.ok]), [['1', '2', 'customerId', 'accountId', true], ['2', '3', 'accountId', 'clientId', true]]);
    const quote = await withFetch(gateway, () => createQuote(ORIGIN, 'customer_1', 'GADGET-2'));
    same([quote.sku, quote.amountCents, quote.contractVersion], ['GADGET-2', 4999, 3]);
  }],

  ['A caller on the middle version is translated by the last step only', async () => {
    const api = makeManaged(['customerId', 'accountId', 'clientId']);
    const { gateway } = await gatewayFor(api, '2');
    const send = (body) => gateway(new Request(`${ORIGIN}/api/managed/quotes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    same((await send({ accountId: 'a', sku: 'WIDGET-1' })).status, 200);
    same((await send({ customerId: 'a', sku: 'WIDGET-1' })).status, 422);
  }],

  ['The API\'s own errors come back unchanged: unknown product, broken JSON, unknown version', async () => {
    const api = makeManaged(['customerId', 'accountId']);
    const { gateway } = await gatewayFor(api, '1');
    const send = (body, raw) => gateway(new Request(`${ORIGIN}/api/managed/quotes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw ?? JSON.stringify(body) }));
    const missing = await send({ customerId: 'a', sku: 'NOPE-9' });
    same([missing.status, await missing.json()], [404, { error: 'Product not found' }]);
    const broken = await send(null, '{"customerId":');
    same([broken.status, await broken.json()], [400, { error: 'Invalid JSON object' }]);
    const future = await (await gatewayFor(api, '7')).gateway(new Request(`${ORIGIN}/api/managed/quotes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
    assert(future.status === 400 && (await future.json()).error.type === 'unknown_version', 'an unpublished version was accepted');
  }],
];
