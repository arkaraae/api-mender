// Tests for the test servers (lib/mender/mock.js): answers from the description's examples or
// generated samples, requests checked against the description, and clear errors otherwise.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answerMock, createMock } from '../lib/mender/mock.js';

function memoryKv() {
  const values = new Map();
  const metadata = new Map();
  return {
    values,
    puts: 0,
    async get(key) { return values.has(key) ? values.get(key) : null; },
    async put(key, value, options = {}) { this.puts += 1; values.set(key, value); metadata.set(key, options.metadata); },
    async list({ prefix = '', limit = 1000 } = {}) {
      const keys = [...values.keys()].filter((key) => key.startsWith(prefix)).sort().slice(0, limit).map((name) => ({ name, metadata: metadata.get(name) }));
      return { keys, list_complete: true };
    },
  };
}

const quotes = {
  openapi: '3.0.3',
  info: { title: 'Quote API', version: '2.0.0' },
  paths: {
    '/quotes': {
      post: {
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['accountId', 'amountCents'], properties: { accountId: { type: 'string' }, amountCents: { type: 'integer', minimum: 1 } } } } } },
        responses: { 201: { description: 'made', content: { 'application/json': { schema: { $ref: '#/components/schemas/Quote' }, example: { id: 'quote_123', amountCents: 2500 } } } } },
      },
      get: {
        parameters: [{ name: 'account', in: 'query', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'ok', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Quote' } } } } } },
      },
    },
    '/quotes/{id}': {
      get: { responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Quote' } } } } } },
      delete: { responses: { 204: { description: 'gone' } } },
    },
  },
  components: { schemas: { Quote: { type: 'object', required: ['id', 'amountCents'], properties: { id: { type: 'string' }, amountCents: { type: 'integer' } } } } },
};

const ask = (kv, id, method, path, body) => answerMock(kv, id, new Request(`https://apimender.com/mock/${id}${path}`, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), path.split('?')[0]);

test('a test server answers with the description\'s own example, or a sample that fits the schema', async () => {
  const kv = memoryKv();
  const mock = await createMock(kv, JSON.stringify(quotes));
  assert.deepEqual([mock.title, mock.version, mock.endpoints], ['Quote API', '2.0.0', 4]);
  const made = await ask(kv, mock.id, 'POST', '/quotes', { accountId: 'acct_1', amountCents: 2500 });
  assert.equal(made.status, 201);
  assert.deepEqual(await made.json(), { id: 'quote_123', amountCents: 2500 });
  assert.equal(made.headers.get('access-control-allow-origin'), '*');
  const one = await ask(kv, mock.id, 'GET', '/quotes/q_9');
  assert.equal(one.status, 200);
  const sample = await one.json();
  assert.equal(typeof sample.id, 'string');
  assert.equal(Number.isInteger(sample.amountCents), true);
  assert.equal((await ask(kv, mock.id, 'DELETE', '/quotes/q_9')).status, 204);
});

test('requests that do not match the description are turned away with the problems listed', async () => {
  const kv = memoryKv();
  const { id } = await createMock(kv, JSON.stringify(quotes));
  const old = await ask(kv, id, 'POST', '/quotes', { customerId: 'acct_1', amountCents: 2500 });
  assert.equal(old.status, 422);
  assert.deepEqual((await old.json()).problems, [{ path: 'body.accountId', message: 'is required and missing' }]);
  const empty = await ask(kv, id, 'POST', '/quotes');
  assert.deepEqual((await empty.json()).problems, [{ path: 'body', message: 'is required and missing' }]);
  const noQuery = await ask(kv, id, 'GET', '/quotes');
  assert.deepEqual((await noQuery.json()).problems, [{ path: 'query.account', message: 'is required and missing' }]);
  assert.equal((await ask(kv, id, 'GET', '/quotes?account=acct_1')).status, 200);
});

test('unknown addresses, wrong methods, preflights and expired servers get clear answers', async () => {
  const kv = memoryKv();
  const { id } = await createMock(kv, JSON.stringify(quotes));
  const missing = await ask(kv, id, 'GET', '/invoices');
  assert.equal(missing.status, 404);
  assert.ok((await missing.json()).endpoints.includes('POST /quotes'));
  const wrong = await ask(kv, id, 'PUT', '/quotes/q_9');
  assert.equal(wrong.status, 405);
  assert.equal(wrong.headers.get('allow'), 'GET, DELETE');
  assert.equal((await ask(kv, id, 'OPTIONS', '/quotes')).status, 204);
  assert.equal((await ask(kv, 'AAAAAAAAAAAAAAAAAAAAAA', 'GET', '/quotes')).status, 404);
  assert.equal((await ask(kv, '../../etc', 'GET', '/quotes')).status, 404);
});

test('YAML descriptions work, and things that are not descriptions are refused', async () => {
  const kv = memoryKv();
  const yaml = 'openapi: 3.0.3\ninfo:\n  title: Pets\n  version: "1"\npaths:\n  /pets:\n    get:\n      responses:\n        "200":\n          description: ok\n          content:\n            application/json:\n              schema:\n                type: array\n                items:\n                  type: string\n';
  const { id, endpoints } = await createMock(kv, yaml);
  assert.equal(endpoints, 1);
  assert.deepEqual(await (await ask(kv, id, 'GET', '/pets')).json(), ['sample-text']);
  await assert.rejects(createMock(kv, '<html>hello</html>'));
  await assert.rejects(createMock(kv, '{"openapi":"3.0.3","paths":{}}'), /no endpoints/);
});

test('the same description is stored once however many test servers use it, and refusals store nothing', async () => {
  const kv = memoryKv();
  const text = JSON.stringify(quotes);
  const seen = [];
  const first = await createMock(kv, text, { beforeStoring: async (cost) => { seen.push(cost.newBytes); } });
  const second = await createMock(kv, text, { beforeStoring: async (cost) => { seen.push(cost.newBytes); } });
  assert.deepEqual(seen, [new TextEncoder().encode(text).byteLength, 0]);
  assert.equal([...kv.values.keys()].filter((key) => key.startsWith('spec:')).length, 1);
  assert.equal(kv.puts, 3, 'one copy of the description and one pointer per test server');
  for (const { id } of [first, second]) assert.equal((await ask(kv, id, 'POST', '/quotes', { accountId: 'acct_1', amountCents: 2500 })).status, 201);
  // A day later the shared copy is stored again so it outlives the newest test server.
  await createMock(kv, text, { now: Date.now() + 2 * 24 * 60 * 60 * 1000 });
  assert.equal(kv.puts, 5);
  const before = kv.values.size;
  await assert.rejects(createMock(kv, text.replace('Quote API', 'Other API'), { beforeStoring: async () => { throw new Error('over the limit'); } }), /over the limit/);
  assert.equal(kv.values.size, before);
});

test('test servers made before descriptions were shared still answer', async () => {
  const kv = memoryKv();
  await kv.put('mock:LEGACYLEGACYLEGACY', JSON.stringify(quotes));
  assert.equal((await ask(kv, 'LEGACYLEGACYLEGACY', 'GET', '/quotes/q_1')).status, 200);
});
