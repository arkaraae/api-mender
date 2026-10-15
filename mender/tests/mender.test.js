// Tests for the Mender runtime, the Parcel adapter and replay.
// Open tests/index.html through any static server to run them in a browser.

import { makeParcel, V1, V2 } from '../src/parcel.js';
import { withMender } from '../src/mender.js';
import { record, replay, toRequest } from '../src/replay.js';
import { sampleCalls, CUSTOMERS } from '../src/traffic.js';
import adapter from '../src/adapters/2026-09-01.js';
import firstDraft from '../src/adapters/2026-09-01.first-draft.js';
import { verifyRules, compileRules } from '../src/rules.js';
import { inferRules } from '../src/infer.js';

const acme = { customer: 'acme', key: CUSTOMERS[0].key, version: V1 };

function mendered(adapters = [adapter], onCall) {
  return withMender(makeParcel(V2), {
    latest: V2,
    adapters,
    versionHeader: 'Parcel-Version',
    sunset: '2027-03-01',
    guide: 'https://docs.parcel.example/migrate/2026-09-01',
    identify: (request) => request.headers.get('authorization'),
    onCall,
  });
}

async function call(handler, spec) {
  const response = await handler(toRequest(spec));
  return { status: response.status, headers: response.headers, body: await response.json() };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const tests = [
  ['2026-09-01 rejects an old-style order', async () => {
    const res = await call(makeParcel(V2), { ...acme, method: 'POST', path: '/orders', body: { customer_name: 'Jonas Berg', amount: 25.5, currency: 'usd' } });
    assert(res.status === 400, `expected 400, got ${res.status}`);
    assert(res.body.error.param === 'customer_name', 'error should name customer_name');
  }],

  ['Adapter turns an old-style order into a new one and answers in the old shape', async () => {
    const res = await call(mendered(), { ...acme, method: 'POST', path: '/orders', body: { customer_name: 'Jonas Berg', amount: 19.99, currency: 'usd' } });
    assert(res.status === 201, `expected 201, got ${res.status}`);
    assert(res.body.customer_name === 'Jonas Berg', 'customer_name missing');
    assert(res.body.amount === 19.99, `amount should be 19.99, got ${res.body.amount}`);
    assert(res.body.currency === 'usd' && res.body.status === 'pending', 'currency or status wrong');
    assert(!('full_name' in res.body) && !('total' in res.body), 'new fields leaked to an old caller');
  }],

  ['Adapter output for a stored order equals what 2026-03-01 returns', async () => {
    const spec = { ...acme, method: 'GET', path: '/orders/ord_1001' };
    const old = await call(makeParcel(V1), spec);
    const res = await call(mendered(), spec);
    assert(JSON.stringify(sorted(old.body)) === JSON.stringify(sorted(res.body)), `bodies differ: ${JSON.stringify(res.body)}`);
  }],

  ['Adapter translates every order in a list', async () => {
    const spec = { ...acme, method: 'GET', path: '/orders?limit=6' };
    const old = await call(makeParcel(V1), spec);
    const res = await call(mendered(), spec);
    assert(res.body.data.length === 6, 'expected 6 orders');
    assert(JSON.stringify(sorted(old.body)) === JSON.stringify(sorted(res.body)), 'list differs from 2026-03-01');
  }],

  ['Removed endpoint answers 410 with a migration link and is reported', async () => {
    const events = [];
    const res = await call(mendered([adapter], (e) => events.push(e)), { ...acme, method: 'GET', path: '/orders/ord_1002/label' });
    assert(res.status === 410, `expected 410, got ${res.status}`);
    assert(res.body.error.type === 'version_gone' && res.body.error.doc_url.startsWith('https://'), 'missing version_gone error');
    assert(events[0]?.outcome === 'untranslatable', 'call was not reported as untranslatable');
  }],

  ['Old callers get Deprecation, Sunset and Link headers', async () => {
    const res = await call(mendered(), { ...acme, method: 'GET', path: '/orders/ord_1003' });
    assert(res.headers.get('deprecation')?.startsWith('@'), 'Deprecation header missing');
    assert(res.headers.get('sunset')?.includes('2027'), 'Sunset header missing');
    assert(res.headers.get('link')?.includes('rel="deprecation"'), 'Link header missing');
    assert(res.headers.get('parcel-version') === V1, 'version header should echo the pinned version');
  }],

  ['Callers on the newest version pass straight through', async () => {
    const events = [];
    const res = await call(mendered([adapter], (e) => events.push(e)), { ...acme, version: V2, method: 'GET', path: '/orders/ord_1001' });
    assert(res.body.full_name === 'Maya Chen' && res.body.status === 'succeeded', 'new callers should see the new shape');
    assert(!res.headers.get('deprecation') && events.length === 0, 'new callers should not be treated as old');
  }],

  ['Validation errors name the fields the old caller sent', async () => {
    const res = await call(mendered(), { ...acme, method: 'POST', path: '/orders', body: { amount: 10, currency: 'usd' } });
    assert(res.status === 400, `expected 400, got ${res.status}`);
    assert(res.body.error.param === 'customer_name', `param should be customer_name, got ${res.body.error.param}`);
    assert(res.body.error.message.includes("'customer_name'"), 'message should mention customer_name');
  }],

  ['Replay passes the final adapter on 200 recorded calls', async () => {
    const recorded = await record(makeParcel(V1), sampleCalls());
    await sleep(1100);
    const result = await replay({ recorded, baseline: makeParcel(V1), candidate: mendered() });
    assert(result.differed.length === 0, `${result.differed.length} calls differ: ${JSON.stringify(result.differed[0]?.diffs)}`);
    assert(result.untranslatable.length === 4, `expected 4 untranslatable, got ${result.untranslatable.length}`);
    assert(result.matched === 196, `expected 196 matched, got ${result.matched}`);
  }],

  ['Replay catches both bugs in the first draft', async () => {
    const recorded = await record(makeParcel(V1), sampleCalls());
    await sleep(1100);
    const result = await replay({ recorded, baseline: makeParcel(V1), candidate: mendered([firstDraft]) });
    const paths = new Set(result.differed.flatMap((d) => d.diffs.map((x) => x.path.replace(/\[\d+\]/g, '[]'))));
    assert(result.differed.length > 0, 'first draft should fail replay');
    assert([...paths].some((p) => p.endsWith('status')), 'status bug not caught');
    assert([...paths].some((p) => p.endsWith('created')), 'created bug not caught');
  }],
];

const LABELS_GONE = { op: 'endpoint_removed', method: 'GET', path: '/orders/{id}/label', message: 'Shipping labels moved to the Labels API in 2026-09-01. This call needs a code change.', guide: 'https://docs.parcel.example/migrate/2026-09-01#labels' };

async function examplePair(id = 'ord_1001') {
  const spec = { ...acme, method: 'GET', path: `/orders/${id}` };
  return { old: (await call(makeParcel(V1), spec)).body, new: (await call(makeParcel(V2), { ...spec, version: V2 })).body };
}

tests.push(
  ['Rule finder reads every change from one example pair', async () => {
    const rules = inferRules([await examplePair()]);
    const has = (op, from, to) => rules.some((r) => r.op === op && r.old === from && (to === undefined || r.new === to));
    assert(has('rename', 'customer_name', 'full_name'), 'missed customer_name → full_name');
    assert(has('scale', 'amount', 'total.amount_cents') && rules.find((r) => r.op === 'scale').factor === 100, 'missed amount × 100');
    assert(has('case', 'currency', 'total.currency'), 'missed currency case');
    assert(has('time', 'created', 'created_at'), 'missed created → created_at');
    assert(has('values', 'status', 'status') && rules.find((r) => r.op === 'values').map.paid === 'succeeded', 'missed paid → succeeded');
    assert(!rules.some((r) => r.op === 'add' || r.op === 'remove'), `unexpected add/remove: ${JSON.stringify(rules)}`);
  }],

  ['Found rules prove out on their examples in both directions', async () => {
    const pairs = [await examplePair('ord_1001'), await examplePair('ord_1004')];
    const results = verifyRules(inferRules(pairs), pairs);
    for (const r of results) assert(r.upDiffs.length === 0 && r.downDiffs.length === 0, `pair ${r.index}: ${JSON.stringify([...r.upDiffs, ...r.downDiffs])}`);
  }],

  ['Rules found from one example pass replay on all 200 calls', async () => {
    const rules = [...inferRules([await examplePair()]), LABELS_GONE];
    const recorded = await record(makeParcel(V1), sampleCalls());
    await sleep(1100);
    const result = await replay({ recorded, baseline: makeParcel(V1), candidate: mendered([compileRules({ from: V1, to: V2, rules })]) });
    assert(result.differed.length === 0, `${result.differed.length} calls differ: ${JSON.stringify(result.differed[0]?.diffs)}`);
    assert(result.matched === 196 && result.untranslatable.length === 4, `matched ${result.matched}, untranslatable ${result.untranslatable.length}`);
  }],

  ['Compiled rules name the old field in validation errors', async () => {
    const rules = [...inferRules([await examplePair()]), LABELS_GONE];
    const res = await call(mendered([compileRules({ from: V1, to: V2, rules })]), { ...acme, method: 'POST', path: '/orders', body: { amount: 10, currency: 'usd' } });
    assert(res.status === 400 && res.body.error.param === 'customer_name', `got ${res.status} ${JSON.stringify(res.body)}`);
  }],

  ['Unknown rule types are refused', async () => {
    let message = '';
    try { compileRules({ from: V1, to: V2, rules: [{ op: 'teleport', old: 'a', new: 'b' }] }); } catch (error) { message = error.message; }
    assert(message.includes('Unknown rule type'), 'bad rule was accepted');
  }],
);

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sorted(value[k])]));
  return value;
}

export async function run(report) {
  let failed = 0;
  for (const [name, test] of tests) {
    try {
      await test();
      report({ name, ok: true });
    } catch (error) {
      failed += 1;
      report({ name, ok: false, error: error.message });
    }
  }
  return { total: tests.length, failed };
}
