// Tests for the inference TEST DOUBLE (not a model).

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { createStandin, decide, STANDIN_MODEL_ID } from './server.mjs';

const SERVER_PATH = fileURLToPath(new URL('./server.mjs', import.meta.url));
const SCRIPT_PATH = fileURLToPath(new URL('./fixtures/script.example.json', import.meta.url));

const ABSTAIN = { decision: 'abstain', reason: 'test double: no rule for this change', edits: [] };

function task(overrides = {}) {
  return {
    contract_change: {
      kind: 'request-property-removed',
      fields: ['customer'],
      before: { customer: { type: 'string' } },
      after: { customer: null, customers: { type: 'array' } },
      ...overrides.contract_change,
    },
    editable_lines: overrides.editable_lines ?? { start: 3, end: 6 },
    source_excerpt: overrides.source_excerpt ?? [
      { line: 1, text: 'export async function charge(order) {' },
      { line: 2, text: '  return client.post("/v1/charges", {' },
      { line: 3, text: '    amount: order.amount,' },
      { line: 4, text: '    customer: order.customer.id,' },
      { line: 5, text: '    currency: "usd",' },
      { line: 6, text: '  });' },
      { line: 7, text: '}' },
    ],
  };
}

async function start(t, options) {
  const server = createStandin(options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { server, url: `http://127.0.0.1:${server.address().port}/v1` };
}

async function complete(url, userContent) {
  const response = await fetch(`${url}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'anything',
      messages: [
        { role: 'system', content: 'ignored' },
        { role: 'user', content: typeof userContent === 'string' ? userContent : JSON.stringify(userContent) },
      ],
    }),
  });
  return { response, body: await response.json() };
}

test('decide: rewrites `F: expr` to `Fs: [expr]` on the single matching editable line', () => {
  assert.deepEqual(decide(task()), {
    decision: 'patch',
    reason: 'test double: "customer" was removed; send "customers" as an array instead',
    edits: [{ start_line: 4, end_line: 4, replacement: '    customers: [order.customer.id],' }],
  });
});

test('decide: handles inline object literals, simple identifiers and a JSON-Schema style `after`', () => {
  const inline = decide(
    task({
      editable_lines: { start: 1, end: 1 },
      source_excerpt: [{ line: 1, text: 'await api.send({ id, customer : customerId })' }],
    }),
  );
  assert.equal(inline.edits[0].replacement, 'await api.send({ id, customers : [customerId] })');

  const nested = decide(task({ contract_change: { after: { type: 'object', properties: { customers: { type: 'array' } } } } }));
  assert.equal(nested.decision, 'patch');
});

test('decide: abstains in every other case', async (t) => {
  const cases = {
    'different change kind': task({ contract_change: { kind: 'request-property-required' } }),
    'two removed fields': task({ contract_change: { fields: ['customer', 'amount'] } }),
    'no removed field': task({ contract_change: { fields: [] } }),
    'field is not an identifier': task({ contract_change: { fields: ['customer.*'] } }),
    'no plural replacement': task({ contract_change: { after: { customer: null } } }),
    'plural is not an array': task({ contract_change: { after: { customers: { type: 'string' } } } }),
    'plural schema is null': task({ contract_change: { after: { customers: null } } }),
    'match outside editable lines': task({ editable_lines: { start: 5, end: 6 } }),
    'two matching lines': task({
      source_excerpt: [
        { line: 3, text: '  customer: a,' },
        { line: 4, text: '  customer: b,' },
      ],
    }),
    'two entries on one line': task({ source_excerpt: [{ line: 4, text: 'f({ customer: a }, { customer: b })' }] }),
    'value is a call expression': task({ source_excerpt: [{ line: 4, text: '  customer: getCustomer(order),' }] }),
    'value is a string literal': task({ source_excerpt: [{ line: 4, text: '  customer: "cus_123",' }] }),
    'longer property name': task({ source_excerpt: [{ line: 4, text: '  default_customer: id,' }] }),
    'member access, not an entry': task({ source_excerpt: [{ line: 4, text: '  x = order.customer' }] }),
    'ternary else branch': task({ source_excerpt: [{ line: 4, text: '  const c = ok ? customer : fallback;' }] }),
    'no excerpt': { ...task(), source_excerpt: undefined },
    'no editable lines': { ...task(), editable_lines: undefined },
    'not an object': 'hello',
    'null': null,
  };
  for (const [name, input] of Object.entries(cases)) {
    await t.test(name, () => assert.deepEqual(decide(input), ABSTAIN));
  }
});

test('HTTP: chat completions returns the decision as JSON content and identifies itself as a test double', async (t) => {
  const { server, url } = await start(t);
  const { response, body } = await complete(url, task());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-mender-test-double'), 'true');
  assert.equal(body.model, STANDIN_MODEL_ID);
  assert.equal(body.object, 'chat.completion');
  assert.equal(body.choices.length, 1);
  assert.equal(body.choices[0].finish_reason, 'stop');
  assert.equal(body.choices[0].message.role, 'assistant');
  assert.equal(JSON.parse(body.choices[0].message.content).decision, 'patch');

  const garbage = await complete(url, 'this is not JSON');
  assert.deepEqual(JSON.parse(garbage.body.choices[0].message.content), ABSTAIN);
  assert.equal(server.requests.length, 2);
  assert.equal(server.requests[0].messages[0].content, 'ignored');
});

test('HTTP: /v1/models lists only mender-test-double; other routes 404; bad bodies 400', async (t) => {
  const { url } = await start(t);
  const models = await (await fetch(`${url}/models`)).json();
  assert.deepEqual(models.data.map((m) => m.id), ['mender-test-double']);
  assert.match(models.data[0].owned_by, /not-a-model/);

  assert.equal((await fetch(`${url}/embeddings`, { method: 'POST', body: '{}' })).status, 404);
  assert.equal((await fetch(`${url}/chat/completions`)).status, 404);
  assert.equal((await fetch(`${url}/chat/completions`, { method: 'POST', body: '{nope' })).status, 400);
  assert.equal((await fetch(`${url}/chat/completions`, { method: 'POST', body: '{"model":"x"}' })).status, 400);
});

test('script: canned contents are returned verbatim, in order, then it abstains', async (t) => {
  const script = ['not json at all', '{"decision":"patch","reason":"x","edits":[{"start_line":1,"end_line":9999,"replacement":"rm -rf /"}]}'];
  const { url } = await start(t, { script });
  const replies = [];
  for (let i = 0; i < 3; i += 1) replies.push((await complete(url, task())).body.choices[0].message.content);
  assert.deepEqual(replies, [script[0], script[1], JSON.stringify(ABSTAIN)]);
  assert.equal(script.length, 2, 'the caller\'s array is not mutated');
});

test('script: loads from a file (scriptPath / STANDIN_SCRIPT) and rejects malformed scripts', async (t) => {
  const { url } = await start(t, { scriptPath: SCRIPT_PATH });
  const first = (await complete(url, task())).body.choices[0].message.content;
  assert.equal(typeof first, 'string');
  assert.notDeepEqual(first, JSON.stringify(decide(task())), 'a script overrides the rule');

  assert.throws(() => createStandin({ script: [{ decision: 'patch' }] }), /array of strings/);
  assert.throws(() => createStandin({ script: 'abstain' }), /array of strings/);
  assert.throws(() => createStandin({ scriptPath: `${SCRIPT_PATH}.missing` }));
});

test('process: binds 127.0.0.1 on STANDIN_PORT, replays STANDIN_SCRIPT, and announces that it is not a model', async (t) => {
  const child = spawn(process.execPath, [SERVER_PATH], {
    env: { PATH: process.env.PATH, STANDIN_PORT: '0', STANDIN_SCRIPT: SCRIPT_PATH },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGKILL'));
  let stdout = '';
  child.stdout.on('data', (d) => (stdout += d));
  let url;
  for (let i = 0; i < 400 && !url; i += 1) {
    url = /listening on (http:\/\/127\.0\.0\.1:\d+\/v1)/.exec(stdout)?.[1];
    if (!url) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(url, 'stand-in did not start');
  assert.match(stdout, /NOT A MODEL/);
  assert.match(stdout, /mender-test-double/);

  const { body } = await complete(url, task());
  assert.equal(body.model, 'mender-test-double');

  child.kill('SIGTERM');
  const [code] = await once(child, 'close');
  assert.equal(code, 0);
});

test('the source file says loudly that it is not a model', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(SERVER_PATH, 'utf8');
  assert.match(source.split('\n').slice(0, 3).join('\n'), /THIS IS NOT A MODEL/);
});
