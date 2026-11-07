// Edge cases against a running copy of the site: every public page and API, with good input,
// bad input and odd input. Nothing here needs an account; it creates a few watches and test
// servers, which expire or stay harmless.
//
//   node scripts/edge-cases.mjs https://apimender.com
//   node scripts/edge-cases.mjs http://localhost:3200

const BASE = (process.argv[2] ?? 'http://localhost:3200').replace(/\/$/, '');
const SPEC = 'https://raw.githubusercontent.com/arkaraae/api-mender/mender-demo/mender/sandbox/quotes/openapi-v2.json';
const OLD = { customerId: 'acct_fixture_1', amountCents: 2500 };
const NEW = { accountId: 'acct_fixture_1', amountCents: 2500 };

const results = [];
const json = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function call(path, init = {}) {
  const started = Date.now();
  const response = await fetch(`${BASE}${path}`, { redirect: 'manual', ...init });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, headers: response.headers, body, text, ms: Date.now() - started };
}

async function check(name, run) {
  try {
    const problem = await run();
    results.push({ name, ok: !problem, problem: problem || '' });
  } catch (error) {
    results.push({ name, ok: false, problem: `threw: ${error.message}` });
  }
}

const expectStatus = (r, ...codes) => (codes.includes(r.status) ? '' : `answered ${r.status}, expected ${codes.join(' or ')}: ${String(r.text).slice(0, 160)}`);

// ---------- pages ----------
for (const page of ['/', '/check', '/watch', '/pricing', '/mender', '/demo', '/live']) {
  await check(`page ${page} loads`, async () => {
    const r = await call(page);
    return expectStatus(r, 200) || (/<html/i.test(r.text) ? '' : 'not an HTML page');
  });
}
await check('an unknown page is a 404, not an error', async () => expectStatus(await call('/no-such-page-here'), 404));
if (BASE.startsWith('https://apimender.com')) {
  await check('www redirects to apimender.com', async () => {
    const r = await fetch('https://www.apimender.com/check', { redirect: 'manual' });
    return r.status === 301 && r.headers.get('location') === 'https://apimender.com/check' ? '' : `answered ${r.status} → ${r.headers.get('location')}`;
  });
}

// ---------- the gateway ----------
await check('gateway: an old-style call is translated and works', async () => {
  const r = await call('/mender/v1/api/testbed/quotes', { ...json(OLD), headers: { 'content-type': 'application/json', 'x-consumer': 'edge-cases' } });
  return expectStatus(r, 200) || (r.headers.get('mender-status') === 'translated' && r.body.identity === 'acct_fixture_1' ? '' : `status header ${r.headers.get('mender-status')}`);
});
await check('gateway: a new-style call on the newest version passes straight through', async () => {
  const r = await call('/mender/v2/api/testbed/quotes', json(NEW));
  return expectStatus(r, 200) || (r.headers.get('mender-status') === 'current-version' ? '' : `status header ${r.headers.get('mender-status')}`);
});
await check('gateway: an old-style call claiming the newest version gets the API\'s own 422', async () => expectStatus(await call('/mender/v2/api/testbed/quotes', json(OLD)), 422));
await check('gateway: an unknown version is refused clearly', async () => {
  const r = await call('/mender/v9/api/testbed/quotes', json(OLD));
  return expectStatus(r, 400) || (r.body?.error?.type === 'unknown_version' ? '' : 'no unknown_version error');
});
await check('gateway: a version that is not a number is refused', async () => expectStatus(await call('/mender/latest/api/testbed/quotes', json(OLD)), 400));
await check('gateway: a very long version is refused', async () => expectStatus(await call('/mender/v99999/api/testbed/quotes', json(OLD)), 400));
await check('gateway: paths it does not front are 404', async () => expectStatus(await call('/mender/v1/api/live/scan', json({})), 404));
await check('gateway: broken JSON reaches the API, which answers 400', async () => expectStatus(await call('/mender/v1/api/testbed/quotes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"customerId": ' }), 400));
await check('gateway: a non-JSON content type gets the API\'s own 415', async () => expectStatus(await call('/mender/v1/api/testbed/quotes', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'hello' }), 415));
await check('gateway: an oversized body gets the API\'s own 413', async () => expectStatus(await call('/mender/v1/api/testbed/quotes', json({ ...OLD, note: 'x'.repeat(6000) })), 413));
await check('gateway: GET on a POST-only endpoint is refused, not a crash', async () => expectStatus(await call('/mender/v1/api/testbed/quotes'), 405));
await check('gateway: HEAD is answered without a crash', async () => { const r = await call('/mender/v1/api/testbed/quotes', { method: 'HEAD' }); return r.status < 500 ? '' : `answered ${r.status}`; });
await check('gateway: a CORS preflight is answered without a crash', async () => { const r = await call('/mender/v1/api/managed/quotes', { method: 'OPTIONS', headers: { origin: 'https://example.com', 'access-control-request-method': 'POST' } }); return r.status < 500 ? '' : `answered ${r.status}`; });
await check('gateway: unicode in the request survives translation', async () => {
  const r = await call('/mender/v1/api/testbed/quotes', json({ customerId: 'acct_ünï_1', amountCents: 2500 }));
  return r.status === 422 || r.status === 200 ? '' : `answered ${r.status}`;
});
await check('gateway: the managed API (database-backed) answers through Mender', async () => expectStatus(await call('/mender/v1/api/managed/quotes', json({ customerId: 'customer_1', sku: 'WIDGET-1' })), 200));
await check('gateway: an unknown product gets the API\'s own 404', async () => expectStatus(await call('/mender/v1/api/managed/quotes', json({ customerId: 'customer_1', sku: 'NOPE-9' })), 404));

// ---------- status and explain ----------
await check('status: lists both APIs', async () => {
  const r = await call('/api/mender/status');
  return expectStatus(r, 200) || (r.body.apis?.length === 2 ? '' : `apis: ${r.body.apis?.length}`);
});
await check('status: the real check shows the rescue (422 direct, 200 through Mender)', async () => {
  const r = await call('/api/mender/status?check=1');
  const testbed = r.body.apis?.find((api) => api.name === 'testbed');
  return expectStatus(r, 200) || (testbed?.check?.direct?.status === 422 && testbed?.check?.throughMender?.status === 200 ? '' : JSON.stringify(testbed?.check ?? testbed?.error).slice(0, 160));
});
await check('explain: example records give the rule', async () => {
  const r = await call('/api/mender/explain', json({ pairs: [{ old: { amount: 12.5 }, new: { amount_cents: 1250 } }] }));
  return expectStatus(r, 200) || (r.body.rules?.[0]?.op === 'scale' ? '' : JSON.stringify(r.body).slice(0, 120));
});
await check('explain: broken JSON is a 400', async () => expectStatus(await call('/api/mender/explain', { method: 'POST', body: '{' }), 400));
await check('explain: an empty request is a 400', async () => expectStatus(await call('/api/mender/explain', json({})), 400));
await check('explain: more than 1 MB is a 413', async () => expectStatus(await call('/api/mender/explain', { method: 'POST', body: 'x'.repeat(1_100_000) }), 413));
await check('explain: GET is refused', async () => { const r = await call('/api/mender/explain'); return r.status === 405 || r.status === 404 ? '' : `answered ${r.status}`; });

// ---------- reading descriptions for /check ----------
const fetchVia = (url) => call(`/api/mender/fetch?url=${encodeURIComponent(url)}`);
await check('fetch: a public description is read', async () => expectStatus(await fetchVia(SPEC), 200));
await check('fetch: http is refused', async () => expectStatus(await fetchVia('http://example.com/openapi.json'), 400));
await check('fetch: localhost is refused', async () => expectStatus(await fetchVia('https://localhost/openapi.json'), 400));
await check('fetch: a private IP is refused', async () => expectStatus(await fetchVia('https://10.0.0.1/openapi.json'), 400));
await check('fetch: the site itself is refused', async () => expectStatus(await fetchVia(`${BASE.replace('http://', 'https://')}/api/testbed/openapi.json`), 400));
await check('fetch: a page that is not a description is refused', async () => expectStatus(await fetchVia('https://example.com/'), 422));
await check('fetch: no address is a 400', async () => expectStatus(await call('/api/mender/fetch'), 400));

// ---------- watching ----------
let watchId = '';
await check('watch: a public description can be watched', async () => {
  const r = await call('/api/mender/watch', json({ url: SPEC }));
  watchId = r.body?.id ?? '';
  return expectStatus(r, 201) || (watchId ? '' : 'no id');
});
await check('watch: the public view hides the webhook and the hash', async () => {
  const r = await call(`/api/mender/watch/${watchId}`);
  return expectStatus(r, 200) || ('webhook' in r.body || 'hash' in r.body ? 'leaks webhook or hash' : '');
});
await check('watch: checking again right away is limited', async () => expectStatus(await call(`/api/mender/watch/${watchId}/check`, { method: 'POST' }), 429));
await check('watch: the kept copy can be read', async () => expectStatus(await call(`/api/mender/watch/${watchId}/snapshot/0`), 200));
await check('watch: a version that is not kept is a 404', async () => expectStatus(await call(`/api/mender/watch/${watchId}/snapshot/999`), 404));
await check('watch: a version that is not a number is a 404', async () => expectStatus(await call(`/api/mender/watch/${watchId}/snapshot/abc`), 404));
await check('watch: the private page loads', async () => expectStatus(await call(`/watch/${watchId}`), 200));
await check('watch: an unknown link is a 404', async () => expectStatus(await call('/api/mender/watch/AAAAAAAAAAAAAAAAAAAAAA'), 404));
await check('watch: a malformed link is a 404', async () => expectStatus(await call('/api/mender/watch/..%2F..%2Fetc'), 404));
await check('watch: broken JSON is a 400', async () => expectStatus(await call('/api/mender/watch', { method: 'POST', body: '{' }), 400));
await check('watch: an http address is refused', async () => expectStatus(await call('/api/mender/watch', json({ url: 'http://example.com/openapi.json' })), 422));
await check('watch: an http webhook is refused', async () => expectStatus(await call('/api/mender/watch', json({ url: SPEC, webhook: 'http://hooks.example.com/x' })), 422));
await check('watch: a page that is not a description is refused', async () => expectStatus(await call('/api/mender/watch', json({ url: 'https://example.com/' })), 422));
await check('watch: it can be stopped, which removes it', async () => {
  const r = await call(`/api/mender/watch/${watchId}`, { method: 'DELETE' });
  const after = await call(`/api/mender/watch/${watchId}`);
  return expectStatus(r, 200) || expectStatus(after, 404);
});
await check('watch: stopping it twice is a 404, not an error', async () => expectStatus(await call(`/api/mender/watch/${watchId}`, { method: 'DELETE' }), 404));
await check('watch: stopping a malformed link is a 404', async () => expectStatus(await call('/api/mender/watch/..%2F..%2Fetc', { method: 'DELETE' }), 404));

// ---------- test servers ----------
let mockBase = '';
const quotesSpec = await (await fetch(SPEC)).text();
await check('test server: can be created from a description', async () => {
  const r = await call('/api/mender/mock', { method: 'POST', body: quotesSpec });
  mockBase = r.body?.base ? r.body.base.replace(/^https?:\/\/[^/]+/, '') : '';
  return expectStatus(r, 201) || (mockBase ? '' : 'no address');
});
await check('test server: a matching request is answered', async () => expectStatus(await call(`${mockBase}/api/testbed/quotes`, json(NEW)), 201, 200));
await check('test server: an old-style request is refused with the problem named', async () => {
  const r = await call(`${mockBase}/api/testbed/quotes`, json(OLD));
  return expectStatus(r, 422) || (r.body.problems?.some((p) => p.path === 'body.accountId') ? '' : JSON.stringify(r.body).slice(0, 120));
});
await check('test server: an unknown endpoint is a 404 listing the real ones', async () => {
  const r = await call(`${mockBase}/api/nothing`);
  return expectStatus(r, 404) || (r.body.endpoints?.length ? '' : 'no endpoint list');
});
await check('test server: a wrong method is a 405', async () => expectStatus(await call(`${mockBase}/api/testbed/quotes`), 405));
await check('test server: a CORS preflight is allowed', async () => {
  const r = await call(`${mockBase}/api/testbed/quotes`, { method: 'OPTIONS' });
  return expectStatus(r, 204) || (r.headers.get('access-control-allow-origin') === '*' ? '' : 'no CORS header');
});
await check('test server: something that is not a description is refused', async () => expectStatus(await call('/api/mender/mock', { method: 'POST', body: '<html>hi</html>' }), 422));
await check('test server: an unknown one is a 404', async () => expectStatus(await call('/mock/AAAAAAAAAAAAAAAAAAAAAA/x'), 404));
await check('test server: the same description again shares storage and still works', async () => {
  const r = await call('/api/mender/mock', { method: 'POST', body: quotesSpec });
  const base = r.body?.base ? r.body.base.replace(/^https?:\/\/[^/]+/, '') : '';
  return expectStatus(r, 201) || (base && base !== mockBase ? expectStatus(await call(`${base}/api/testbed/quotes`, json(NEW)), 201, 200) : 'no new address');
});

// ---------- pricing and contact sales ----------
const SALES = { name: 'Edge Case', email: 'edge-cases@example.com', company: 'Test', apis: '1', message: '' };
await check('pricing: three plans, $28.98 and contact sales', async () => {
  const r = await call('/pricing');
  return expectStatus(r, 200) || (['Free', 'Pro', 'Enterprise', '$28.98', 'Contact sales'].every((text) => r.text.includes(text)) ? '' : 'a plan or price is missing');
});
await check('sales: a missing email is refused and named', async () => {
  const r = await call('/api/sales', json({ ...SALES, email: '' }));
  return expectStatus(r, 422) || (r.body.problems?.[0]?.field === 'email' ? '' : JSON.stringify(r.body));
});
await check('sales: an empty form lists every missing field', async () => {
  const r = await call('/api/sales', json({}));
  return expectStatus(r, 422) || (r.body.problems?.length === 4 ? '' : JSON.stringify(r.body));
});
await check('sales: a made-up API count is refused', async () => expectStatus(await call('/api/sales', json({ ...SALES, apis: '9000' })), 422));
await check('sales: broken JSON is a 400', async () => expectStatus(await call('/api/sales', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' }), 400));
await check('sales: a huge request is a 413', async () => expectStatus(await call('/api/sales', json({ ...SALES, message: 'x'.repeat(20_000) })), 413));
await check('sales: a robot filling the hidden field is answered but nothing is saved', async () => expectStatus(await call('/api/sales', json({ ...SALES, website: 'https://spam.example' })), 201));
await check('sales: GET is refused', async () => { const r = await call('/api/sales'); return r.status === 405 || r.status === 404 ? '' : `answered ${r.status}`; });

// ---------- the team's APIs ----------
await check('managed API: its contract is served', async () => expectStatus(await call('/api/managed/openapi.json'), 200));
await check('managed API: a version that is not a number is a 400', async () => expectStatus(await call('/api/managed/openapi.json?version=abc'), 400));
await check('managed API: a version that does not exist is not a crash', async () => { const r = await call('/api/managed/openapi.json?version=999'); return r.status < 500 || r.status === 503 ? '' : `answered ${r.status}`; });
await check('testbed: its contract is served', async () => expectStatus(await call('/api/testbed/openapi.json'), 200));

// ---------- report ----------
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n      ${r.problem}`}`);
console.log(`\n${results.length - failed.length} of ${results.length} passed against ${BASE}`);
process.exit(failed.length ? 1 : 0);
