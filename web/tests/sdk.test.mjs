// Tests for the TypeScript client generator (lib/mender/sdk.js): the clients it writes must pass
// TypeScript's strict check, and a generated client must really call an API.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import { makeManaged, managedContract } from '../../mender/tests/managed.fixture.js';
import { generateClient } from '../lib/mender/sdk.js';

const tsc = resolve(import.meta.dirname, '../node_modules/typescript/bin/tsc');

function typecheck(source) {
  const dir = mkdtempSync(join(tmpdir(), 'mender-sdk-'));
  try {
    writeFileSync(join(dir, 'client.ts'), source);
    const run = spawnSync(process.execPath, [tsc, '--noEmit', '--strict', '--target', 'es2022', '--lib', 'es2022,dom', '--skipLibCheck', join(dir, 'client.ts')], { encoding: 'utf8' });
    return run.status === 0 ? '' : run.stdout || run.stderr;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Turns the generated TypeScript into a module we can call.
async function load(source) {
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
}

const str = { type: 'string' };

const rich = {
  openapi: '3.0.3',
  info: { title: 'Shop', version: '7' },
  paths: {
    '/orders/{order-id}': {
      parameters: [{ name: 'order-id', in: 'path', required: true, schema: str }],
      get: { operationId: 'getOrder', parameters: [{ name: 'expand', in: 'query', schema: { type: 'array', items: str } }], responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } } } } },
      delete: { operationId: 'delete', responses: { 204: { description: 'gone' } } },
    },
    '/orders': {
      post: { requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/NewOrder' } } } }, responses: { 201: { description: 'made', content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } } } } },
      get: { operationId: 'getOrder', parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer' } }], responses: { 200: { description: 'ok', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Order' } } } } } } },
    },
  },
  components: {
    schemas: {
      Order: { allOf: [{ $ref: '#/components/schemas/NewOrder' }, { type: 'object', required: ['id', 'status'], properties: { id: str, status: { type: 'string', enum: ['paid', 'shipped'] }, note: { type: 'string', nullable: true }, parent: { $ref: '#/components/schemas/Order' } } }] },
      NewOrder: { type: 'object', required: ['items'], properties: { items: { type: 'array', items: { oneOf: [{ $ref: '#/components/schemas/Item' }, str] } }, metadata: { type: 'object', additionalProperties: str } } },
      Item: { type: 'object', required: ['sku'], properties: { sku: str, 'unit-price': { type: 'number' } } },
      'order-alias': { $ref: '#/components/schemas/Order' },
    },
  },
};

test('a client with references, unions, enums, odd names and duplicate operation names passes the strict TypeScript check', () => {
  const source = generateClient(rich);
  assert.equal(typecheck(source), '');
  assert.match(source, /export type Order = \(NewOrder\) & \(\{ id: string; status: "paid" \| "shipped"; note\?: string \| null; parent\?: Order; \}\);/);
  assert.match(source, /export type OrderAlias = Order;/);
  assert.match(source, /getOrder: \(params: \{ "order-id": string; expand\?: Array<string>; \}\): Promise<Order>/);
  assert.match(source, /getOrderAgain: \(params: \{ limit\?: number; \} = \{\}\): Promise<Array<Order>>/);
  assert.match(source, /callDelete: \(params: \{ "order-id": string; \}\): Promise<void>/);
  assert.match(source, /postOrders: \(params: \{ body: NewOrder; \}\): Promise<Order>/);
});

test('Swagger 2 descriptions get a client too', () => {
  const swagger = {
    swagger: '2.0', info: { title: 'Old', version: '1' },
    paths: { '/pets/{id}': { get: { operationId: 'showPet', parameters: [{ name: 'id', in: 'path', required: true, type: 'integer' }], responses: { 200: { description: 'ok', schema: { $ref: '#/definitions/Pet' } } } } } },
    definitions: { Pet: { type: 'object', required: ['name'], properties: { name: str } } },
  };
  const source = generateClient(swagger);
  assert.equal(typecheck(source), '');
  assert.match(source, /showPet: \(params: \{ id: number; \}\): Promise<Pet>/);
});

test('a generated client really calls the API, and reports its errors', async () => {
  const api = makeManaged(['customerId', 'accountId']);
  const client = (await load(generateClient(managedContract(2, 'accountId')))).createClient({ baseUrl: 'https://site.test', fetch: (url, init) => api(new Request(url, init)) });
  const quote = await client.createManagedQuote({ body: { accountId: 'account_1', sku: 'WIDGET-1' } });
  assert.equal(quote.contractVersion, 2);
  await assert.rejects(client.createManagedQuote({ body: { customerId: 'customer_1', sku: 'WIDGET-1' } }), (error) => error.status === 422 && error.body.required.includes('accountId'));
});
