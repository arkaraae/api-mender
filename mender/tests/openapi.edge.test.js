// Edge cases for reading rules out of two API descriptions (OpenAPI 3.x and Swagger 2).

import { flattenSchema, operationsOf, proveWithSchemas, rulesFromOpenApi, samplesFor, validate } from '../src/openapi.js';
import { compileRules, verifyRules } from '../src/rules.js';
import { assert, same } from './helpers.js';

// ---------- small builders so each test shows only what changed ----------

const str = { type: 'string' };
const int = { type: 'integer' };
const num = { type: 'number' };
const obj = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required });
const body = (schema, type = 'application/json') => ({ required: true, content: { [type]: { schema } } });
const ok = (schema) => ({ 200: { description: 'ok', content: { 'application/json': { schema } } } });
const doc = (paths, schemas) => ({ openapi: '3.0.3', info: { title: 'Test API', version: '1' }, paths, ...(schemas ? { components: { schemas } } : {}) });
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });

// One endpoint that takes and returns the same record.
const single = (schema, path = '/orders') => doc({ [path]: { post: { requestBody: body(schema), responses: ok(schema) } } });
const rulesBetween = (before, after) => rulesFromOpenApi(single(before), single(after));
const codes = (found) => found.notes.map((n) => n.code);

export const reading = [
  ['Identical specs need no rules and raise no notes', () => {
    const spec = single(obj({ id: str, amount: num }));
    same(rulesFromOpenApi(spec, structuredClone(spec)), { rules: [], notes: [], operations: [{ endpoint: 'POST /orders', status: 'kept', to: 'POST /orders' }] });
  }],

  ['A field renamed in a shared schema becomes one rule for every endpoint and both directions', () => {
    const paths = {
      '/orders': { post: { requestBody: body(ref('Order')), responses: ok(ref('Order')) } },
      '/orders/{id}': { get: { responses: ok(ref('Order')) } },
    };
    const found = rulesFromOpenApi(doc(paths, { Order: obj({ id: str, customer_name: str }) }), doc(paths, { Order: obj({ id: str, full_name: str }) }));
    same(found.rules, [{ op: 'rename', old: 'customer_name', new: 'full_name' }]);
    assert(proveWithSchemas(doc(paths, { Order: obj({ id: str, customer_name: str }) }), doc(paths, { Order: obj({ id: str, full_name: str }) }), found.rules).ok, 'proof failed');
  }],

  ['Money that moved to cents, and cents that moved to whole units, are read from the names', () => {
    same(rulesBetween(obj({ amount: num }), obj({ amount_cents: int })).rules, [{ op: 'scale', factor: 100, old: 'amount', new: 'amount_cents' }]);
    same(rulesBetween(obj({ price_cents: int }), obj({ price: num })).rules, [{ op: 'scale', factor: 0.01, old: 'price_cents', new: 'price' }]);
    same(rulesBetween(obj({ timeout: num }), obj({ timeout_ms: int })).rules, [{ op: 'scale', factor: 1000, old: 'timeout', new: 'timeout_ms' }]);
  }],

  ['Time fields: seconds to ISO text, in place or renamed, and milliseconds', () => {
    const iso = { type: 'string', format: 'date-time' };
    const found = rulesBetween(obj({ created: int, updated_at: int, expires_ms: int }), obj({ created_at: iso, updated_at: iso, expires_at: iso }));
    same(found.rules, [
      { op: 'time', oldFormat: 'unix_seconds', newFormat: 'iso8601', old: 'updated_at', new: 'updated_at' },
      { op: 'time', oldFormat: 'unix_seconds', newFormat: 'iso8601', old: 'created', new: 'created_at' },
      { op: 'time', oldFormat: 'unix_ms', newFormat: 'iso8601', old: 'expires_ms', new: 'expires_at' },
    ]);
  }],

  ['Allowed values: one renamed, all upper-cased, one added, one removed', () => {
    const e = (...values) => ({ type: 'string', enum: values });
    same(rulesBetween(obj({ status: e('paid', 'pending', 'failed') }), obj({ status: e('succeeded', 'pending', 'failed') })).rules, [{ op: 'values', map: { paid: 'succeeded' }, old: 'status', new: 'status' }]);
    same(rulesBetween(obj({ currency: e('usd', 'eur') }), obj({ currency: e('USD', 'EUR') })).rules, [{ op: 'case', oldCase: 'lower', newCase: 'upper', old: 'currency', new: 'currency' }]);
    const added = rulesBetween(obj({ status: e('a', 'b') }), obj({ status: e('a', 'b', 'c') }));
    assert(added.rules.length === 0 && codes(added).includes('enum_added'), JSON.stringify(added));
    const removed = rulesBetween(obj({ status: e('a', 'b', 'c') }), obj({ status: e('a', 'b') }));
    assert(removed.rules.length === 0 && codes(removed).includes('enum_removed'), JSON.stringify(removed));
  }],

  ['Several renamed values are paired by resemblance', () => {
    const e = (...values) => ({ type: 'string', enum: values });
    const found = rulesBetween(obj({ state: e('in_progress', 'done', 'cancelled') }), obj({ state: e('IN_PROGRESS_V2', 'DONE', 'canceled') }));
    same(found.rules[0].map, { in_progress: 'IN_PROGRESS_V2', done: 'DONE', cancelled: 'canceled' });
  }],

  ['A number that became text is a type change', () => {
    same(rulesBetween(obj({ id: int }), obj({ id: str })).rules, [{ op: 'type', oldType: 'number', newType: 'string', old: 'id', new: 'id' }]);
    same(rulesBetween(obj({ live: { type: 'boolean' } }), obj({ live: str })).rules, [{ op: 'type', oldType: 'boolean', newType: 'string', old: 'live', new: 'live' }]);
  }],

  ['Fields that moved into a nested object are matched by name', () => {
    const found = rulesBetween(obj({ amount: num, currency: str }), obj({ total: obj({ amount_cents: int, currency: str }) }));
    same(found.rules, [
      { op: 'rename', old: 'currency', new: 'total.currency' },
      { op: 'scale', factor: 100, old: 'amount', new: 'total.amount_cents' },
    ]);
  }],

  ['A scalar that became an object with an id is matched', () => {
    same(rulesBetween(obj({ customer: str }), obj({ customer: obj({ id: str }) })).rules, [{ op: 'rename', old: 'customer', new: 'customer.id' }]);
  }],

  ['Fields inside list items, and lists of plain values, are followed', () => {
    const item = (key) => ({ type: 'array', items: obj({ sku: str, [key]: int }) });
    same(rulesBetween(obj({ items: item('qty') }), obj({ items: item('quantity') })).rules, [{ op: 'rename', old: 'items[].qty', new: 'items[].quantity' }]);
    const tags = (...values) => ({ type: 'array', items: { type: 'string', enum: values } });
    same(rulesBetween(obj({ tags: tags('a', 'b') }), obj({ tags: tags('A', 'B') })).rules, [{ op: 'case', oldCase: 'lower', newCase: 'upper', old: 'tags[]', new: 'tags[]' }]);
  }],

  ['A list answer wrapped in "data" gets its own rule next to the single-record rule', () => {
    const paths = (order) => ({
      '/orders': { get: { responses: ok(obj({ data: { type: 'array', items: order }, has_more: { type: 'boolean' } })) } },
      '/orders/{id}': { get: { responses: ok(order) } },
    });
    const before = doc(paths(obj({ customer_name: str })));
    const after = doc(paths(obj({ full_name: str })));
    const found = rulesFromOpenApi(before, after);
    same(found.rules, [{ op: 'rename', old: 'data[].customer_name', new: 'data[].full_name', in: 'response' }, { op: 'rename', old: 'customer_name', new: 'full_name', in: 'response' }]);
    assert(proveWithSchemas(before, after, found.rules).ok, 'proof failed');
  }],

  ['A bare list answer is read record by record; switching to an envelope is flagged', () => {
    const list = (order) => doc({ '/orders': { get: { responses: ok({ type: 'array', items: order }) } } });
    same(rulesFromOpenApi(list(obj({ customer_name: str })), list(obj({ full_name: str }))).rules, [{ op: 'rename', old: 'customer_name', new: 'full_name', in: 'response' }]);
    const wrapped = doc({ '/orders': { get: { responses: ok(obj({ data: { type: 'array', items: obj({ customer_name: str }) } })) } } });
    const found = rulesFromOpenApi(list(obj({ customer_name: str })), wrapped);
    assert(found.rules.length === 0 && codes(found).includes('list_shape'), JSON.stringify(found));
  }],
];

export const endpoints = [
  ['A removed endpoint, a moved endpoint and a changed method are all recognised', () => {
    const before = doc({
      '/orders/{id}/label': { get: { operationId: 'getLabel', responses: ok(obj({ url: str })) } },
      '/orders/{id}': { put: { operationId: 'updateOrder', requestBody: body(obj({ note: str })), responses: ok(obj({ note: str })) } },
      '/legacy/export': { get: { operationId: 'export', responses: ok(obj({ url: str })) } },
    });
    const after = doc({
      '/labels/{order_id}': { get: { operationId: 'getLabel', responses: ok(obj({ url: str })) } },
      '/orders/{id}': { patch: { operationId: 'updateOrder', requestBody: body(obj({ note: str })), responses: ok(obj({ note: str })) } },
    });
    const found = rulesFromOpenApi(before, after);
    same(found.rules, [
      { op: 'endpoint_moved', method: 'GET', old: '/orders/{id}/label', new: '/labels/{id}' },
      { op: 'endpoint_moved', method: 'PUT', old: '/orders/{id}', new: '/orders/{id}', newMethod: 'PATCH' },
      { op: 'endpoint_removed', method: 'GET', path: '/legacy/export' },
    ]);
    const proof = proveWithSchemas(before, after, found.rules);
    same(proof.checks.map((c) => [c.endpoint, c.status]), [['GET /orders/{id}/label', 'passed'], ['PUT /orders/{id}', 'passed'], ['GET /legacy/export', 'removed']]);
  }],

  ['Renaming only the id in a path changes nothing; endpoints that are new are ignored', () => {
    const before = doc({ '/orders/{id}': { get: { responses: ok(obj({ id: str })) } } });
    const after = doc({ '/orders/{order_id}': { get: { responses: ok(obj({ id: str })) } }, '/refunds': { post: { requestBody: body(obj({ id: str })), responses: ok(obj({ id: str })) } } });
    same(rulesFromOpenApi(before, after).rules, []);
  }],

  ['A moved endpoint whose fields also changed still proves out', () => {
    const before = doc({ '/v1/orders/{id}': { put: { operationId: 'update', requestBody: body(obj({ customer_name: str })), responses: ok(obj({ customer_name: str })) } } });
    const after = doc({ '/v2/orders/{id}': { put: { operationId: 'update', requestBody: body(obj({ full_name: str })), responses: ok(obj({ full_name: str })) } } });
    const found = rulesFromOpenApi(before, after);
    same(found.rules, [{ op: 'endpoint_moved', method: 'PUT', old: '/v1/orders/{id}', new: '/v2/orders/{id}' }, { op: 'rename', old: 'customer_name', new: 'full_name' }]);
    assert(proveWithSchemas(before, after, found.rules).ok, 'proof failed');
    const adapter = compileRules({ from: '1', to: '2', rules: found.rules });
    same(adapter.upgradeRequest({ method: 'PUT', path: '/v1/orders/7', body: { customer_name: 'A' } }), { method: 'PUT', path: '/v2/orders/7', body: { full_name: 'A' } });
  }],

  ['A rule that holds on one endpoint only stays limited to it', () => {
    const paths = (userField) => ({
      '/users': { post: { requestBody: body(obj({ [userField]: str })), responses: ok(obj({ id: str })) } },
      '/pets': { post: { requestBody: body(obj({ name: str })), responses: ok(obj({ id: str })) } },
    });
    same(rulesFromOpenApi(doc(paths('name')), doc(paths('full_name'))).rules, [{ op: 'rename', old: 'name', new: 'full_name', in: 'request', endpoint: 'POST /users' }]);
  }],

  ['A renamed query parameter becomes a query rule; a new required one is flagged', () => {
    const get = (...parameters) => doc({ '/orders': { get: { parameters, responses: ok(obj({ id: str })) } } });
    const q = (name, required = false) => ({ name, in: 'query', required, schema: str });
    const found = rulesFromOpenApi(get(q('customer'), q('limit')), get(q('customer_id'), q('limit'), q('region', true)));
    same(found.rules, [{ op: 'rename', old: 'customer', new: 'customer_id', in: 'query', endpoint: 'GET /orders' }]);
    assert(codes(found).includes('needs_default'), 'the new required parameter was not flagged');
  }],
];

export const judgement = [
  ['A newly required field with a declared default gets it; without one it is flagged and the proof fails', () => {
    const before = single(obj({ amount: int }));
    const withDefault = single(obj({ amount: int, capture_method: { type: 'string', default: 'automatic' } }));
    const found = rulesFromOpenApi(before, withDefault);
    assert(found.rules.some((r) => r.op === 'add' && r.new === 'capture_method' && r.value === 'automatic' && r.in === 'request'), JSON.stringify(found.rules));
    assert(proveWithSchemas(before, withDefault, found.rules).ok, 'proof failed with a default');
    const noDefault = single(obj({ amount: int, capture_method: str }));
    const flagged = rulesFromOpenApi(before, noDefault);
    assert(codes(flagged).includes('needs_default') && !proveWithSchemas(before, noDefault, flagged.rules).ok, JSON.stringify(flagged));
  }],

  ['A field added to answers is hidden from old callers; a required field removed from answers fails the proof', () => {
    const answering = (schema) => doc({ '/orders': { post: { requestBody: body(obj({ id: str })), responses: ok(schema) } } });
    const added = [answering(obj({ id: str })), answering(obj({ id: str, risk_score: num }))];
    const found = rulesFromOpenApi(...added);
    assert(found.rules.some((r) => r.op === 'add' && r.new === 'risk_score' && !('value' in r)), JSON.stringify(found.rules));
    assert(proveWithSchemas(...added, found.rules).ok, 'proof failed for an added answer field');
    const removed = [answering(obj({ id: str, legacy_code: str })), answering(obj({ id: str }))];
    const lost = rulesFromOpenApi(...removed);
    assert(codes(lost).includes('removed'), 'the removed field was not flagged');
    const proof = proveWithSchemas(...removed, lost.rules);
    assert(!proof.ok && proof.checks[0].failures.some((f) => f.where === 'response' && f.path === 'legacy_code'), JSON.stringify(proof.checks[0].failures));
  }],

  ['A provider hint ("x-mender-from") settles what the names cannot', () => {
    const found = rulesBetween(obj({ note: str, other: str }), obj({ memo: { type: 'string', 'x-mender-from': 'note' }, other: str }));
    same([found.rules, found.notes], [[{ op: 'rename', old: 'note', new: 'memo' }], []]);
  }],

  ['One unrelated field out and one in is a flagged guess; two and two is not guessed at all', () => {
    const one = rulesBetween(obj({ alpha: str, n: int }), obj({ zeta: str, n: int }));
    assert(one.rules.some((r) => r.op === 'rename' && r.old === 'alpha' && r.new === 'zeta') && codes(one).includes('weak_match'), JSON.stringify(one));
    const two = rulesBetween(obj({ alpha: str, beta: str }), obj({ gamma: str, delta: str }));
    assert(!two.rules.some((r) => r.op === 'rename') && codes(two).includes('needs_default'), JSON.stringify(two));
  }],

  ['A field that merely became required is never filled from an unrelated field', () => {
    const before = single({ type: 'object', properties: { name: str, email: str }, required: ['name'] });
    const after = single({ type: 'object', properties: { name: str, email: str }, required: ['email'] });
    const found = rulesFromOpenApi(before, after);
    assert(!found.rules.some((r) => r.op === 'rename') && codes(found).includes('needs_default'), JSON.stringify(found));
  }],

  ['The spec proof checks structure; only real records catch a wrong number', () => {
    const before = single(obj({ amount: num }));
    const after = single(obj({ amount_cents: int }));
    const wrongField = [{ op: 'scale', factor: 100, old: 'amount', new: 'total_cents' }];
    assert(!proveWithSchemas(before, after, wrongField).ok, 'a rule writing the wrong field passed');
    const wrongFactor = [{ op: 'scale', factor: 10, old: 'amount', new: 'amount_cents' }];
    assert(proveWithSchemas(before, after, wrongFactor).ok, 'the spec proof is expected to accept a wrong factor');
    const [real] = verifyRules(wrongFactor, [{ old: { amount: 12.5 }, new: { amount_cents: 1250 } }]);
    assert(real.upDiffs.length === 1 && real.downDiffs.length === 1, 'real records did not catch the wrong factor');
  }],

  ['A field with several shapes is flagged only when a shape Mender did not read changed, however deep', () => {
    // "customer" is an id or the whole customer. Mender reads the id; the change is two levels inside the other shape.
    const paths = { '/charges/{id}': { get: { responses: ok(obj({ id: str, customer: { anyOf: [str, ref('Customer')] } })) } } };
    const schemas = (city) => ({ Customer: obj({ id: str, address: ref('Address') }), Address: obj({ [city]: str }) });
    same(rulesFromOpenApi(doc(paths, schemas('city')), doc(paths, schemas('city'))).notes, []);
    const found = rulesFromOpenApi(doc(paths, schemas('city')), doc(paths, schemas('town')));
    same([found.rules, found.notes.map((n) => [n.code, n.path])], [[], [['one_of', 'customer']]]);
    same(found.notes[0].message, 'GET /charges/{id} response: Address changed, and it belongs to a shape Mender does not read: some fields here can take several shapes (oneOf/anyOf) and Mender translates only the first. Check the other shapes with real records. Fields: customer.');
    // A reworded description is not a change of shape.
    const reworded = { Customer: { ...obj({ id: str, address: ref('Address') }), description: 'A buyer.' }, Address: obj({ city: { type: 'string', description: 'Town or city.' } }) };
    same(rulesFromOpenApi(doc(paths, schemas('city')), doc(paths, reworded)).notes, []);
  }],

  ['The same finding on many endpoints is reported once, with the endpoints named', () => {
    const things = () => Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`/things${i}`, { get: { responses: ok(ref('Thing')) } }]));
    const found = rulesFromOpenApi(doc(things(), { Thing: obj({ id: str, legacy_code: str }) }), doc(things(), { Thing: obj({ id: str }) }));
    same(found.rules, [{ op: 'remove', old: 'legacy_code', in: 'response' }]);
    same(found.notes, [{
      code: 'removed', path: 'legacy_code',
      message: 'Response: legacy_code is no longer returned, so old callers stop receiving it. (6 endpoints: GET /things0, GET /things1, GET /things2 and 3 more)',
      endpoints: ['GET /things0', 'GET /things1', 'GET /things2', 'GET /things3', 'GET /things4', 'GET /things5'],
    }]);
    // Endpoints that describe no answer at all are one note, not one each.
    const bare = doc({ '/a': { get: { responses: { 200: { description: 'ok' } } } }, '/b': { get: { responses: { 200: { description: 'ok' } } } } });
    same(rulesFromOpenApi(bare, structuredClone(bare)).notes.map((n) => n.message),
      ['Neither version describes its answer, so changes to the answer can\'t be read from the specs. Check them with real records. (2 endpoints: GET /a, GET /b)']);
  }],

  ['A large description with one change gives one rule and nothing else to check', () => {
    // 200 endpoints, each answering with 40 fields that can be an id or a whole record.
    const expandable = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`link_${i}`, { anyOf: [str, ref('Other')] }]));
    const paths = (field) => ({
      ...Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`/records${i}`, { get: { responses: ok(ref('Record')) } }])),
      '/payments': { post: { requestBody: body(obj({ [field]: str })), responses: ok(ref('Record')) } },
    });
    const schemas = { Record: obj({ id: str, ...expandable }), Other: obj({ id: str, name: str }) };
    const started = Date.now();
    const found = rulesFromOpenApi(doc(paths('capture_method'), schemas), doc(paths('capture_mode'), schemas));
    same([found.rules, found.notes], [[{ op: 'rename', old: 'capture_method', new: 'capture_mode', in: 'request' }], []]);
    // The record every one of those fields can expand into changes: still one thing to check, not 8,000.
    const renamed = { ...schemas, Other: obj({ id: str, label: str }) };
    const wide = rulesFromOpenApi(doc(paths('capture_method'), schemas), doc(paths('capture_method'), renamed));
    same([wide.rules, wide.notes.length, wide.notes[0].endpoints.length], [[], 1, 201]);
    assert(/^Response: Other changed, .* Fields: link_0, link_1, link_2 and 37 more\. \(201 endpoints: /.test(wide.notes[0].message), wide.notes[0].message);
    assert(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
  }],
];

export const formats = [
  ['Schemas built with allOf are merged; oneOf is read and flagged; nullable is honoured', () => {
    const merged = (key) => single({ allOf: [obj({ id: str }), { type: 'object', properties: { [key]: str }, required: [key] }] });
    same(rulesFromOpenApi(merged('customer_name'), merged('full_name')).rules, [{ op: 'rename', old: 'customer_name', new: 'full_name' }]);
    const poly = (second) => single({ oneOf: [obj({ card: str }), obj(second)] });
    same(rulesFromOpenApi(poly({ iban: str }), poly({ iban: str })).notes, []);
    assert(codes(rulesFromOpenApi(poly({ iban: str }), poly({ account_number: str }))).includes('one_of'), 'a change in a shape Mender does not read was not flagged');
    const spec = single(obj({ a: { type: 'string', nullable: true }, b: { type: ['string', 'null'] }, c: { anyOf: [str, { type: 'null' }] }, d: str }));
    const schema = spec.paths['/orders'].post.requestBody.content['application/json'].schema;
    same(validate({ a: null, b: null, c: null, d: null }, schema, spec).map((e) => e.path), ['d']);
  }],

  ['Swagger 2.0 specs are read: body schemas, definitions and form fields', () => {
    const swagger = (field) => ({
      swagger: '2.0', info: { title: 't', version: '1' },
      paths: {
        '/orders': { post: { parameters: [{ in: 'body', name: 'body', required: true, schema: { $ref: '#/definitions/Order' } }], responses: { 200: { description: 'ok', schema: { $ref: '#/definitions/Order' } } } } },
        '/charges': { post: { consumes: ['application/x-www-form-urlencoded'], parameters: [{ in: 'formData', name: field, type: 'string', required: true }], responses: { 200: { description: 'ok' } } } },
      },
      definitions: { Order: obj({ id: str, [field]: str }) },
    });
    const found = rulesFromOpenApi(swagger('customer_name'), swagger('full_name'));
    same(found.rules, [{ op: 'rename', old: 'customer_name', new: 'full_name' }]);
    same(operationsOf(swagger('x')).get('POST /charges').request.contentType, 'application/x-www-form-urlencoded');
  }],

  ['Form-encoded request bodies are read like JSON ones; a change of format is flagged', () => {
    const form = (schema, type = 'application/x-www-form-urlencoded') => doc({ '/v1/payment_intents': { post: { requestBody: body(schema, type), responses: ok(obj({ id: str })) } } });
    same(rulesFromOpenApi(form(obj({ amount: int, capture_method: str })), form(obj({ amount: int, capture_mode: str }))).rules,
      [{ op: 'rename', old: 'capture_method', new: 'capture_mode', in: 'request' }]);
    assert(codes(rulesFromOpenApi(form(obj({ amount: int })), form(obj({ amount: int }), 'application/json'))).includes('content_type'), 'format change was not flagged');
  }],

  ['Read-only fields are not expected in requests', () => {
    const order = { type: 'object', required: ['id', 'name'], properties: { id: { type: 'string', readOnly: true }, name: str, secret: { type: 'string', writeOnly: true } } };
    const spec = single(order);
    same([...flattenSchema(order, spec, 'request').leaves.keys()], ['name', 'secret']);
    same([...flattenSchema(order, spec, 'response').leaves.keys()], ['id', 'name']);
    assert(proveWithSchemas(spec, structuredClone(spec), []).ok, 'a read-only field was demanded in a request');
  }],

  ['A schema that refers to itself does not hang', () => {
    const schemas = { Category: { type: 'object', required: ['name'], properties: { name: str, parent: { $ref: '#/components/schemas/Category' }, children: { type: 'array', items: { $ref: '#/components/schemas/Category' } } } } };
    const spec = doc({ '/categories': { post: { requestBody: body(ref('Category')), responses: ok(ref('Category')) } } }, schemas);
    const started = Date.now();
    const found = rulesFromOpenApi(spec, structuredClone(spec));
    const proof = proveWithSchemas(spec, structuredClone(spec), found.rules);
    assert(found.rules.length === 0 && proof.ok && Date.now() - started < 3000, `took ${Date.now() - started} ms`);
    const loop = doc({ '/x': { post: { requestBody: body({ $ref: '#/components/schemas/A' }), responses: ok(str) } } }, { A: { $ref: '#/components/schemas/B' }, B: { $ref: '#/components/schemas/A' } });
    same(rulesFromOpenApi(loop, loop).rules, []);
    // Eight links back to itself would mean 8^12 paths if each were followed blindly.
    const node = { type: 'object', required: ['name'], properties: { name: str, ...Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`link_${i}`, { $ref: '#/components/schemas/Node' }])) } };
    const web = doc({ '/nodes': { post: { requestBody: body(ref('Node')), responses: ok(ref('Node')) } } }, { Node: node });
    const begun = Date.now();
    assert(proveWithSchemas(web, structuredClone(web), rulesFromOpenApi(web, structuredClone(web)).rules).ok && Date.now() - begun < 2000, `heavily self-referential schema took ${Date.now() - begun} ms`);
  }],

  ['Empty and malformed specs give an empty result instead of an error', () => {
    for (const spec of [{}, { paths: null }, { paths: { '/x': 'oops' } }, { paths: { '/x': { get: null, post: {} } } }, { openapi: '3.0.3', paths: { '/x': { get: { responses: { 200: {} } } } } }]) {
      const found = rulesFromOpenApi(spec, spec);
      assert(Array.isArray(found.rules) && found.rules.length === 0, `failed on ${JSON.stringify(spec)}`);
      assert(proveWithSchemas(spec, spec, []).ok, 'proof failed on a malformed spec');
    }
  }],

  ['Samples cover every allowed value, required-only requests, and declared examples', () => {
    const schema = obj({ status: { type: 'string', enum: ['a', 'b', 'c'] }, amount: { type: 'integer', minimum: 50, example: 75 }, note: str, at: { type: 'string', format: 'date-time' } }, ['status', 'amount']);
    const samples = samplesFor(schema, {}, 'request');
    same(samples.map((s) => s.status), ['a', 'a', 'b', 'c']);
    // Two fields with different numbers of allowed values share the same few samples.
    const two = samplesFor(obj({ kind: { type: 'string', enum: ['x', 'y'] }, size: { type: 'string', enum: ['s', 'm', 'l', 'xl'] } }), {}, 'request');
    same(two.map((s) => `${s.kind}${s.size}`), ['xs', 'ym', 'xl', 'yxl']);
    same(samples[1], { status: 'a', amount: 75 });
    assert(samples[0].at === '2026-01-03T15:00:00Z' && samples[0].note === 'sample-note', JSON.stringify(samples[0]));
    for (const sample of samples) same(validate(sample, schema, {}, { strict: true }), []);
  }],

  ['Validation names exactly what is wrong', () => {
    const schema = obj({ id: str, amount: { type: 'integer', minimum: 1 }, when: { type: 'string', format: 'date-time' }, status: { type: 'string', enum: ['a', 'b'] }, tags: { type: 'array', items: str }, nested: obj({ x: num }) });
    const good = { id: 'o1', amount: 5, when: '2026-01-03T15:00:00Z', status: 'a', tags: ['x'], nested: { x: 1.5 } };
    same(validate(good, schema, {}, { strict: true }), []);
    const bad = { id: 7, amount: 0.5, when: 'yesterday', status: 'z', tags: ['x', 3], nested: {}, extra: true };
    const errors = validate(bad, schema, {}, { strict: true }).map((e) => `${e.path} ${e.message}`);
    for (const fragment of ['id should be text', 'amount should be a whole number', 'amount is below the minimum', 'when should be a date and time', 'status is "z"', 'tags[1] should be text', 'nested.x is required and missing', 'extra is not a field']) {
      assert(errors.some((e) => e.includes(fragment)), `missing "${fragment}" in ${JSON.stringify(errors)}`);
    }
    same(validate(bad, schema, {}).some((e) => e.path === 'extra'), false);
  }],

  ['A spec with 150 endpoints and 4,500 fields is compared in good time', () => {
    const build = (suffix) => doc(Object.fromEntries(Array.from({ length: 150 }, (_, i) => {
      const fields = Object.fromEntries(Array.from({ length: 30 }, (_, j) => [j < 3 ? `field_${j}${suffix}` : `field_${j}`, j % 2 ? str : int]));
      return [`/resource_${i}/{id}`, { put: { requestBody: body(obj(fields)), responses: ok(obj(fields)) } }];
    })));
    const before = build('');
    const after = build('_v2');
    const started = Date.now();
    const found = rulesFromOpenApi(before, after);
    const proof = proveWithSchemas(before, after, found.rules);
    const took = Date.now() - started;
    same(found.rules.map((r) => `${r.old}>${r.new}`).sort(), ['field_0>field_0_v2', 'field_1>field_1_v2', 'field_2>field_2_v2']);
    assert(proof.ok && proof.samples === 150 * 2 && took < 6000, `ok ${proof.ok}, samples ${proof.samples}, took ${took} ms`);
  }],
];
