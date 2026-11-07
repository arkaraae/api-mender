// Edge cases for the Mender runtime: the part that sits in front of a live API. It has to cope
// with every kind of request and answer, not only tidy JSON, and it must never make things worse.

import { encodeForm, parseForm, withMender } from '../src/mender.js';
import { compileRules } from '../src/rules.js';
import { assert, same } from './helpers.js';

const ORIGIN = 'https://api.example.test';
const RENAME = compileRules({ from: '1', to: '2', rules: [{ op: 'rename', old: 'customerId', new: 'accountId' }] });

// A stand-in API that answers with what it received, so a test can see exactly what reached it.
function echo(log = [], answer) {
  return async (request) => {
    const bytes = new Uint8Array(await request.arrayBuffer());
    const text = new TextDecoder().decode(bytes);
    const url = new URL(request.url);
    let json;
    try { json = JSON.parse(text); } catch { json = undefined; }
    const seen = { request, method: request.method, path: url.pathname, search: url.search, headers: Object.fromEntries(request.headers), text, bytes, json };
    log.push(seen);
    if (answer) return answer(seen);
    return new Response(JSON.stringify(json === undefined ? { received: text } : json), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

const mender = (handler, extra = {}) => withMender(handler, { latest: '2', adapters: [RENAME], ...extra });
const send = (handler, { method = 'POST', path = '/quotes', headers = {}, body } = {}) => handler(new Request(ORIGIN + path, { method, headers, body }));
const old = (headers = {}) => ({ 'api-version': '1', 'content-type': 'application/json', ...headers });
const json = (value) => JSON.stringify(value);

export const versions = [
  ['A caller on the newest version reaches the API untouched, with no notice headers', async () => {
    const log = [];
    const handler = mender(echo(log));
    const request = new Request(`${ORIGIN}/quotes`, { method: 'POST', headers: { 'api-version': '2', 'content-type': 'application/json' }, body: json({ customerId: 'c' }) });
    const response = await handler(request);
    assert(log[0].request === request, 'the request was rebuilt');
    same(await response.json(), { customerId: 'c' });
    assert(!response.headers.get('deprecation') && !response.headers.get('sunset'), 'newest callers got deprecation headers');
  }],

  ['An unknown version gets a clear 400 and never reaches the API', async () => {
    const log = [];
    const response = await send(mender(echo(log)), { headers: old({ 'api-version': '0.9' }), body: json({}) });
    const body = await response.json();
    assert(response.status === 400 && body.error.type === 'unknown_version' && body.error.message.includes('1, 2'), JSON.stringify(body));
    assert(log.length === 0, 'the API was called');
  }],

  ['A caller that names no version is treated as newest, unless a default says otherwise', async () => {
    const body = json({ customerId: 'c' });
    const log = [];
    await send(mender(echo(log)), { headers: { 'content-type': 'application/json' }, body });
    const defaulted = await send(mender(echo(log), { defaultVersion: '1' }), { headers: { 'content-type': 'application/json' }, body });
    same(log.map((seen) => seen.json), [{ customerId: 'c' }, { accountId: 'c' }]);
    same(await defaulted.json(), { customerId: 'c' });
    assert(defaulted.headers.get('api-version') === '1', 'the caller was not told which version it is on');
  }],

  ['The version can come from anywhere, such as the API key', async () => {
    const version = (request) => (request.headers.get('authorization') === 'Bearer legacy-key' ? '1' : '2');
    const log = [];
    const handler = mender(echo(log), { version });
    const headers = { 'content-type': 'application/json' };
    await send(handler, { headers: { ...headers, authorization: 'Bearer legacy-key' }, body: json({ customerId: 'c' }) });
    await send(handler, { headers: { ...headers, authorization: 'Bearer new-key' }, body: json({ customerId: 'c' }) });
    const broken = mender(echo(log), { version: () => { throw new Error('lookup failed'); } });
    await send(broken, { headers, body: json({ customerId: 'c' }) });
    same(log.map((seen) => seen.json), [{ accountId: 'c' }, { customerId: 'c' }, { customerId: 'c' }]);
  }],

  ['Versions named v2 and v10 are followed by their links, not sorted as text', async () => {
    const adapter = compileRules({ from: 'v2', to: 'v10', rules: [{ op: 'rename', old: 'a', new: 'b' }] });
    const handler = withMender(echo(), { latest: 'v10', adapters: [adapter] });
    same(await (await send(handler, { headers: old({ 'api-version': 'v2' }), body: json({ a: 1 }) })).json(), { a: 1 });
  }],

  ['A caller three versions back passes through every step, there and back', async () => {
    const log = [];
    const adapters = [
      compileRules({ from: '1', to: '2', rules: [{ op: 'rename', old: 'a', new: 'b' }] }),
      compileRules({ from: '2', to: '3', rules: [{ op: 'scale', old: 'b', new: 'c', factor: 100 }] }),
      compileRules({ from: '3', to: '4', rules: [{ op: 'rename', old: 'c', new: 'deep.d' }] }),
    ];
    const handler = withMender(echo(log), { latest: '4', adapters });
    same(await (await send(handler, { headers: old({ 'api-version': '1' }), body: json({ a: 1.5 }) })).json(), { a: 1.5 });
    same(log[0].json, { deep: { d: 150 } });
    same(await (await send(handler, { headers: old({ 'api-version': '3' }), body: json({ c: 7 }) })).json(), { c: 7 });
    same(log[1].json, { deep: { d: 7 } });
  }],

  ['Adapters that point at each other in a circle end in a 400, not an endless loop', async () => {
    const adapters = [compileRules({ from: '1', to: '2', rules: [] }), compileRules({ from: '2', to: '1', rules: [] })];
    const response = await send(withMender(echo(), { latest: '3', adapters }), { headers: old(), body: json({}) });
    assert(response.status === 400, `got ${response.status}`);
  }],

  ['The API is told the newest version and the caller is told its own', async () => {
    const log = [];
    const response = await send(mender(echo(log), { versionHeader: 'Parcel-Version' }), { headers: { 'parcel-version': '1', 'content-type': 'application/json', authorization: 'Bearer k', 'x-request-id': 'r1' }, body: json({}) });
    assert(log[0].headers['parcel-version'] === '2' && response.headers.get('parcel-version') === '1', 'version headers are wrong');
    assert(log[0].headers.authorization === 'Bearer k' && log[0].headers['x-request-id'] === 'r1', 'caller headers were dropped');
  }],

  ['Notice headers: a date version gets Deprecation, Sunset and Link; a named version gets no fake date', async () => {
    const dated = withMender(echo(), { latest: '2026-09-01', adapters: [compileRules({ from: '2026-03-01', to: '2026-09-01', rules: [] })], sunset: '2027-03-01', guide: 'https://docs.example.test/migrate' });
    const a = await send(dated, { headers: old({ 'api-version': '2026-03-01' }), body: json({}) });
    same([a.headers.get('deprecation'), a.headers.get('sunset'), a.headers.get('link')], ['@1788220800', 'Mon, 01 Mar 2027 00:00:00 GMT', '<https://docs.example.test/migrate>; rel="deprecation"; type="text/html"']);
    const named = await send(mender(echo(), { sunset: 'not a date' }), { headers: old(), body: json({}) });
    assert(named.headers.get('deprecation') === null && named.headers.get('sunset') === null, 'invented a date');
  }],
];

export const requests = [
  ['Every flavour of JSON content type is translated', async () => {
    for (const type of ['application/json', 'application/json; charset=utf-8', 'application/vnd.api+json', 'application/problem+json', 'APPLICATION/JSON']) {
      const response = await send(mender(echo()), { headers: old({ 'content-type': type }), body: json({ customerId: 'c' }) });
      same(await response.json(), { customerId: 'c' }, `not translated for ${type}`);
    }
  }],

  ['JSON sent without a JSON content type is still recognised', async () => {
    const log = [];
    const handler = mender(echo(log));
    await send(handler, { headers: { 'api-version': '1' }, body: json({ customerId: 'c' }) });
    await send(handler, { headers: { 'api-version': '1', 'content-type': 'text/plain' }, body: `  ${json({ customerId: 'c' })}` });
    same(log.map((seen) => seen.json), [{ accountId: 'c' }, { accountId: 'c' }]);
  }],

  ['Broken JSON is forwarded exactly as sent, so the API can reject it itself', async () => {
    const log = [];
    await send(mender(echo(log)), { headers: old(), body: '{"customerId": ' });
    assert(log[0].text === '{"customerId": ', `the API received: ${log[0].text}`);
  }],

  ['A file upload reaches the API byte for byte', async () => {
    const log = [];
    const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x80, 0x7b, 0x22, 0xc3, 0x28, 0x0a, 0x0d, 0x00]);
    await send(mender(echo(log)), { headers: { 'api-version': '1', 'content-type': 'application/octet-stream' }, body: bytes });
    same([...log[0].bytes], [...bytes]);
    assert(log[0].headers['content-type'] === 'application/octet-stream', 'content type changed');
  }],

  ['A form-encoded request is translated and stays form-encoded', async () => {
    const log = [];
    await send(mender(echo(log)), { headers: { 'api-version': '1', 'content-type': 'application/x-www-form-urlencoded' }, body: 'customerId=c+1&amountCents=2500' });
    same(Object.fromEntries(new URLSearchParams(log[0].text)), { accountId: 'c 1', amountCents: '2500' });
    assert(log[0].headers['content-type'] === 'application/x-www-form-urlencoded', 'content type changed');
  }],

  ['Form fields move into nested names, convert, and lists keep their style', async () => {
    const log = [];
    const adapter = compileRules({ from: '1', to: '2', rules: [
      { op: 'scale', old: 'amount', new: 'total.amount_cents', factor: 100 },
      { op: 'rename', old: 'items[].qty', new: 'items[].quantity' },
    ] });
    const handler = withMender(echo(log), { latest: '2', adapters: [adapter] });
    await send(handler, { headers: { 'api-version': '1', 'content-type': 'application/x-www-form-urlencoded' }, body: 'amount=12.5&items[0][sku]=a&items[0][qty]=2&expand[]=customer&tag=x&tag=y' });
    const form = [...new URLSearchParams(log[0].text)];
    same(form.sort(), [['expand[]', 'customer'], ['items[0][quantity]', '2'], ['items[0][sku]', 'a'], ['tag', 'x'], ['tag', 'y'], ['total[amount_cents]', '1250']].sort());
  }],

  ['A form too ambiguous to read safely is forwarded exactly as sent', async () => {
    const log = [];
    const text = 'items[][sku]=a&items[][qty]=1&customerId=c';
    await send(mender(echo(log)), { headers: { 'api-version': '1', 'content-type': 'application/x-www-form-urlencoded' }, body: text });
    assert(log[0].text === text, `the API received: ${log[0].text}`);
  }],

  ['A request with no body, and JSON bodies that are not records, pass through', async () => {
    const log = [];
    const handler = mender(echo(log));
    await send(handler, { headers: old() });
    await send(handler, { headers: old(), body: 'null' });
    await send(handler, { headers: old(), body: '"just text"' });
    await send(handler, { headers: old(), body: '[{"customerId":"a"},{"customerId":"b"}]' });
    same(log.map((seen) => seen.text), ['', 'null', '"just text"', '[{"accountId":"a"},{"accountId":"b"}]']);
  }],

  ['A query string is passed on exactly, including repeated keys', async () => {
    const log = [];
    await send(mender(echo(log)), { method: 'GET', path: '/orders?tag=a&tag=b&limit=5&q=a%20b', headers: { 'api-version': '1' } });
    assert(log[0].search === '?tag=a&tag=b&limit=5&q=a%20b', `the API received: ${log[0].search}`);
  }],

  ['A query string rule renames a parameter', async () => {
    const log = [];
    const adapter = compileRules({ from: '1', to: '2', rules: [{ op: 'rename', old: 'customer', new: 'customer_id', in: 'query' }] });
    await send(withMender(echo(log), { latest: '2', adapters: [adapter] }), { method: 'GET', path: '/orders?customer=c1&limit=5', headers: { 'api-version': '1' } });
    same(Object.fromEntries(new URLSearchParams(log[0].search)), { customer_id: 'c1', limit: '5' });
  }],

  ['A moved endpoint changes address and method, and scoped rules still match the old address', async () => {
    const log = [];
    const adapter = compileRules({ from: '1', to: '2', rules: [
      { op: 'endpoint_moved', method: 'PUT', old: '/orders/{id}', new: '/v2/orders/{id}', newMethod: 'PATCH' },
      { op: 'rename', old: 'name', new: 'full_name', endpoint: 'PUT /orders/{id}' },
    ] });
    const handler = withMender(echo(log), { latest: '2', adapters: [adapter] });
    const response = await send(handler, { method: 'PUT', path: '/orders/ord_1', headers: old(), body: json({ name: 'Ann' }) });
    same([log[0].method, log[0].path, log[0].json], ['PATCH', '/v2/orders/ord_1', { full_name: 'Ann' }]);
    same(await response.json(), { name: 'Ann' });
  }],

  ['HEAD requests and CORS preflight requests go straight through', async () => {
    const log = [];
    const handler = mender(echo(log, () => new Response(null, { status: 200, headers: { 'content-type': 'application/json', allow: 'POST' } })));
    const head = await send(handler, { method: 'HEAD', headers: { 'api-version': '1' } });
    const options = await send(handler, { method: 'OPTIONS', headers: { 'api-version': '1' } });
    assert(head.status === 200 && options.status === 200 && log.length === 2, 'a request was lost');
  }],

  ['A 1 MB request with 5,000 records is translated correctly and quickly', async () => {
    const log = [];
    const records = Array.from({ length: 5000 }, (_, i) => ({ customerId: `c_${i}`, note: 'x'.repeat(180) }));
    const started = Date.now();
    await send(mender(echo(log)), { headers: old(), body: json(records) });
    assert(log[0].json.length === 5000 && log[0].json[4999].accountId === 'c_4999' && !('customerId' in log[0].json[0]), 'wrong translation');
    assert(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
  }],

  ['Fifty requests at once each get their own answer', async () => {
    const handler = mender(echo());
    const answers = await Promise.all(Array.from({ length: 50 }, (_, i) => send(handler, { headers: old(), body: json({ customerId: `c_${i}` }) }).then((r) => r.json())));
    same(answers, Array.from({ length: 50 }, (_, i) => ({ customerId: `c_${i}` })));
  }],
];

export const answers = [
  ['An empty 204 answer does not crash and still carries the notice', async () => {
    const response = await send(mender(echo([], () => new Response(null, { status: 204 })), { sunset: '2027-03-01' }), { method: 'DELETE', headers: old() });
    assert(response.status === 204 && (await response.text()) === '' && response.headers.get('sunset'), 'bad 204 answer');
  }],

  ['A file download comes back byte for byte', async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0xff, 0x00, 0xfe, 0x80]);
    const api = echo([], () => new Response(bytes, { status: 200, headers: { 'content-type': 'application/pdf', 'content-length': '8' } }));
    const response = await send(mender(api), { method: 'GET', path: '/orders/1/label', headers: { 'api-version': '1' } });
    same([...new Uint8Array(await response.arrayBuffer())], [...bytes]);
    assert(response.headers.get('content-type') === 'application/pdf' && response.headers.get('api-version') === '1', 'headers are wrong');
  }],

  ['A translated answer never keeps a stale Content-Length', async () => {
    const adapter = compileRules({ from: '1', to: '2', rules: [{ op: 'rename', old: 'id', new: 'identifier_with_a_much_longer_name' }] });
    const body = json({ identifier_with_a_much_longer_name: 1 });
    const api = echo([], () => new Response(body, { status: 200, headers: { 'content-type': 'application/json', 'content-length': String(body.length), 'content-encoding': 'identity' } }));
    const response = await send(withMender(api, { latest: '2', adapters: [adapter] }), { method: 'GET', headers: { 'api-version': '1' } });
    const text = await response.text();
    const length = response.headers.get('content-length');
    assert(text === '{"id":1}' && (length === null || Number(length) === text.length), `body ${text}, content-length ${length}`);
  }],

  ['An error answer keeps its status and is not reshaped', async () => {
    const adapter = compileRules({ from: '1', to: '2', rules: [{ op: 'values', field: 'status', map: { paid: 'succeeded' } }] });
    const api = echo([], () => new Response(json({ status: 'succeeded', error: 'Request does not satisfy the active contract' }), { status: 422, headers: { 'content-type': 'application/json' } }));
    const response = await send(withMender(api, { latest: '2', adapters: [adapter] }), { headers: old(), body: json({}) });
    assert(response.status === 422, `status ${response.status}`);
    same(await response.json(), { status: 'succeeded', error: 'Request does not satisfy the active contract' });
  }],

  ['An answer that claims to be JSON but is not comes back as it was', async () => {
    const api = echo([], () => new Response('<html>Bad gateway</html>', { status: 502, headers: { 'content-type': 'application/json' } }));
    const response = await send(mender(api), { headers: old(), body: json({}) });
    assert(response.status === 502 && (await response.text()) === '<html>Bad gateway</html>', 'the body was changed');
  }],

  ['A list answer and a bare-array answer are translated record by record', async () => {
    const api = echo([], (seen) => new Response(json(seen.path === '/list' ? { data: [{ accountId: 'a' }, { accountId: 'b' }], has_more: false } : [{ accountId: 'a' }]), { headers: { 'content-type': 'application/json' } }));
    const handler = mender(api);
    same(await (await send(handler, { method: 'GET', path: '/list', headers: { 'api-version': '1' } })).json(), { data: [{ customerId: 'a' }, { customerId: 'b' }], has_more: false });
    same(await (await send(handler, { method: 'GET', path: '/bare', headers: { 'api-version': '1' } })).json(), [{ customerId: 'a' }]);
  }],
];

const failing = (where) => ({ from: '1', to: '2', [where]() { throw new Error('adapter bug'); } });

export const failures = [
  ['If an adapter crashes on the request, nothing is sent to the API and the caller gets a clear 500', async () => {
    const log = [];
    const events = [];
    const handler = withMender(echo(log), { latest: '2', adapters: [failing('upgradeRequest')], onCall: (event) => events.push(event) });
    const response = await send(handler, { headers: old(), body: json({ customerId: 'c' }) });
    const body = await response.json();
    assert(response.status === 500 && body.error.type === 'adapter_error' && log.length === 0, 'a half-translated request was sent');
    assert(events[0].outcome === 'adapter_error' && events[0].error.includes('adapter bug'), 'the failure was not reported');
  }],

  ['If an adapter crashes on the answer, the caller still gets the API\'s answer, marked untranslated', async () => {
    const events = [];
    const handler = withMender(echo(), { latest: '2', adapters: [failing('downgradeResponse')], onCall: (event) => events.push(event) });
    const response = await send(handler, { headers: old(), body: json({ accountId: 'c' }) });
    assert(response.status === 200 && response.headers.get('mender-warning') === 'response-not-translated', 'no warning header');
    same(await response.json(), { accountId: 'c' });
    assert(events[0].outcome === 'adapter_error', 'the failure was not reported');
  }],

  ['A reporting hook or caller lookup that crashes never breaks the request', async () => {
    const handler = mender(echo(), { onCall: () => { throw new Error('metrics down'); }, identify: () => { throw new Error('lookup down'); } });
    const response = await send(handler, { headers: old(), body: json({ customerId: 'c' }) });
    same(await response.json(), { customerId: 'c' });
  }],

  ['If the API itself throws, the error is not swallowed', async () => {
    const handler = mender(async () => { throw new Error('database down'); });
    let message = '';
    try { await send(handler, { headers: old(), body: json({}) }); } catch (error) { message = error.message; }
    assert(message === 'database down', `got "${message}"`);
  }],

  ['Each translated call is reported with who made it; newest-version calls are not', async () => {
    const events = [];
    const handler = mender(echo(), { identify: (request) => request.headers.get('authorization')?.slice(7), onCall: (event) => events.push(event) });
    await send(handler, { path: '/quotes?x=1', headers: old({ authorization: 'Bearer acme' }), body: json({}) });
    await send(handler, { headers: { 'api-version': '2', 'content-type': 'application/json', authorization: 'Bearer bloom' }, body: json({}) });
    same(events.map((e) => [e.customer, e.version, e.method, e.path, e.outcome, e.status]), [['acme', '1', 'POST', '/quotes', 'translated', 200]]);
  }],

  ['An endpoint removed two versions later is caught after an earlier version moved it', async () => {
    const adapters = [
      compileRules({ from: '1', to: '2', rules: [{ op: 'endpoint_moved', method: 'GET', old: '/labels/{id}', new: '/orders/{id}/label' }] }),
      compileRules({ from: '2', to: '3', rules: [{ op: 'endpoint_removed', method: 'GET', path: '/orders/{id}/label', guide: 'https://docs.example.test/labels' }] }),
    ];
    const log = [];
    const response = await send(withMender(echo(log), { latest: '3', adapters }), { method: 'GET', path: '/labels/7', headers: { 'api-version': '1' } });
    const body = await response.json();
    assert(response.status === 410 && body.error.doc_url === 'https://docs.example.test/labels' && log.length === 0, JSON.stringify(body));
  }],
];

export const forms = [
  ['Forms round-trip through nested names, lists and repeated keys', () => {
    const repeated = new Set();
    const text = 'a=1&b[c]=2&b[d][e]=3&items[0][sku]=x&items[1][sku]=y&expand[]=p&expand[]=q&tag=m&tag=n&empty=';
    const parsed = parseForm(text, repeated);
    same(parsed, { a: '1', b: { c: '2', d: { e: '3' } }, items: [{ sku: 'x' }, { sku: 'y' }], expand: ['p', 'q'], tag: ['m', 'n'], empty: '' });
    same([...new URLSearchParams(encodeForm(parsed, repeated))], [...new URLSearchParams(text)]);
  }],

  ['Forms that could tamper with the runtime, or cannot be read safely, are refused', () => {
    for (const text of ['__proto__[polluted]=1', 'a[constructor][prototype][x]=1', 'a[b=1', '[x]=1', 'items[][sku]=a', 'items[5000]=a', 'a=1&a[b]=2&a=3']) {
      assert(parseForm(text) === null, `"${text}" was accepted`);
    }
    assert(({}).polluted === undefined, 'Object.prototype was polluted');
  }],

  ['Special characters survive a form round trip', () => {
    const value = { note: 'a&b=c d+e/é 🚀', nested: { 'k y': '100%' } };
    same(parseForm(encodeForm(value)), value);
  }],
];
