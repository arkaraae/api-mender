// Gateway test suite. Run with `node --test model-service/`.
//
// Every test puts a fake upstream (node:http, ephemeral port) behind a real
// gateway instance and talks to the gateway over real sockets.

import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  ConfigError,
  DENIED_UPSTREAM_SUFFIXES,
  buildUpstreamRequest,
  createGateway,
  deniedUpstreamReason,
  loadConfig,
} from './server.mjs';
import { hashToken, newToken, tokenEntry } from './token.mjs';
import { createStandin, STANDIN_MODEL_ID } from '../standin/server.mjs';

const SERVER_PATH = fileURLToPath(new URL('./server.mjs', import.meta.url));
const TOKEN_CLI_PATH = fileURLToPath(new URL('./token.mjs', import.meta.url));

const TOKEN = 'mnd_test-token-for-worker';
const OTHER_TOKEN = 'mnd_test-token-for-cli';
const MODEL = 'test/coder-model';
const LOG_KEYS = [
  'latency_ms',
  'model',
  'request_bytes',
  'request_id',
  'response_bytes',
  'status',
  'token',
  'ts',
  'upstream_status',
];

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['decision', 'reason', 'edits'],
  properties: {
    decision: { type: 'string', enum: ['patch', 'abstain'] },
    reason: { type: 'string' },
    edits: { type: 'array' },
  },
};

function validBody(overrides = {}) {
  return {
    model: MODEL,
    messages: [
      { role: 'system', content: 'You propose minimal patches.' },
      { role: 'user', content: '{"contract_change":{}}' },
    ],
    response_format: { type: 'json_schema', json_schema: { name: 'mender_patch', strict: true, schema: SCHEMA } },
    temperature: 0,
    stream: false,
    ...overrides,
  };
}

function completion(content = '{"decision":"abstain","reason":"r","edits":[]}', extra = {}) {
  return {
    id: 'chatcmpl-upstream-1',
    object: 'chat.completion',
    created: 1,
    model: 'whatever-the-server-calls-itself',
    system_fingerprint: 'fp_should_be_dropped',
    choices: [{ index: 0, finish_reason: 'stop', logprobs: null, message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18, extra_detail: 'dropped' },
    ...extra,
  };
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function closeServer(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

/** Fake inference server. `handler(req, res, body)` defaults to a valid completion. */
async function startUpstream(t, handler) {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const entry = { method: req.method, url: req.url, headers: req.headers, raw };
      try {
        entry.body = JSON.parse(raw);
      } catch {
        entry.body = undefined;
      }
      received.push(entry);
      if (handler) handler(req, res, entry);
      else json(res, 200, completion());
    });
  });
  const origin = await listen(server);
  t.after(() => closeServer(server));
  return { origin, url: `${origin}/v1`, received };
}

function json(res, status, payload, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(payload));
}

function env(upstreamUrl, overrides = {}) {
  return {
    MENDER_UPSTREAM_URL: upstreamUrl,
    MENDER_GATEWAY_TOKENS_SHA256: `worker:${hashToken(TOKEN)}, cli:${hashToken(OTHER_TOKEN)}`,
    MENDER_ALLOWED_MODELS: `${MODEL},second-model`,
    ...overrides,
  };
}

async function startGateway(t, upstreamUrl, overrides = {}, options = {}) {
  const logs = [];
  const server = createGateway(loadConfig(env(upstreamUrl, overrides)), {
    log: (line) => logs.push(line),
    ...options,
  });
  const origin = await listen(server);
  t.after(() => closeServer(server));
  return { origin, logs, server };
}

function post(gateway, body, { token = TOKEN, headers = {}, path = '/v1/chat/completions' } = {}) {
  return fetch(`${gateway.origin}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...headers,
    },
    body: typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body),
  });
}

/** Log lines are written when the response closes, slightly after the client sees it. */
async function waitForLogs(gateway, count) {
  for (let i = 0; i < 200 && gateway.logs.length < count; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(gateway.logs.length >= count, `expected ${count} log lines, got ${gateway.logs.length}`);
  return gateway.logs.map((line) => JSON.parse(line));
}

async function assertError(response, status, code) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
  const body = await response.json();
  assert.deepEqual(Object.keys(body), ['error']);
  if (code) assert.equal(body.error.code, code);
  return body;
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

test('happy path: upstream receives exactly the rebuilt request, client gets the minimal response', async (t) => {
  const upstream = await startUpstream(t, (_req, res) =>
    json(res, 200, completion(), { 'x-upstream-secret': 'internal-host-7', 'set-cookie': 'sid=1' }),
  );
  const gateway = await startGateway(t, upstream.url, { MENDER_UPSTREAM_API_KEY: 'upstream-key' });

  const response = await post(
    gateway,
    validBody({
      temperature: 1.5,
      max_tokens: 999999,
      // Fields a client might add; none may reach the inference server.
      seed: 42,
      user: 'tenant-123',
      top_p: 0.9,
      logit_bias: { 1: 100 },
      stop: ['x'],
      extra_body: { guided_json: {} },
      cache_prompt: true,
      n: 1,
      logprobs: false,
      messages: [
        { role: 'system', content: 'sys', name: 'dropped' },
        { role: 'user', content: 'usr', cache_control: { type: 'ephemeral' } },
      ],
      response_format: {
        type: 'json_schema',
        extra: 'dropped',
        json_schema: { name: 'mender_patch', strict: true, schema: SCHEMA, description: 'dropped' },
      },
    }),
  );

  assert.equal(response.status, 200);
  assert.equal(upstream.received.length, 1);
  const seen = upstream.received[0];
  assert.equal(seen.method, 'POST');
  assert.equal(seen.url, '/v1/chat/completions');
  assert.equal(seen.headers.authorization, 'Bearer upstream-key');
  assert.deepEqual(seen.body, {
    model: MODEL,
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'usr' },
    ],
    response_format: { type: 'json_schema', json_schema: { name: 'mender_patch', strict: true, schema: SCHEMA } },
    temperature: 0.2,
    max_tokens: 1024,
    stream: false,
  });

  assert.deepEqual(await response.json(), {
    id: 'chatcmpl-upstream-1',
    model: MODEL,
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content: '{"decision":"abstain","reason":"r","edits":[]}' },
      },
    ],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
  assert.equal(response.headers.get('x-upstream-secret'), null);
  assert.equal(response.headers.get('set-cookie'), null);
});

test('the client bearer token is never forwarded upstream', async (t) => {
  const upstream = await startUpstream(t);
  const gateway = await startGateway(t, upstream.url);
  assert.equal((await post(gateway, validBody())).status, 200);
  assert.equal(upstream.received[0].headers.authorization, undefined);
  assert.ok(!JSON.stringify(upstream.received[0].headers).includes(TOKEN));
});

test('defaults and clamps: temperature, max_tokens, max_completion_tokens alias, strict omitted', async (t) => {
  const upstream = await startUpstream(t);
  const gateway = await startGateway(t, upstream.url, { MENDER_MAX_OUTPUT_TOKENS: '700' });

  const minimal = validBody();
  delete minimal.temperature;
  delete minimal.stream;
  minimal.response_format = { type: 'json_schema', json_schema: { name: 'p', schema: SCHEMA } };
  assert.equal((await post(gateway, minimal)).status, 200);
  assert.equal((await post(gateway, validBody({ temperature: -3, max_tokens: 50 }))).status, 200);
  assert.equal((await post(gateway, validBody({ temperature: 0.1, max_completion_tokens: 5000 }))).status, 200);

  const [a, b, c] = upstream.received.map((r) => r.body);
  assert.equal(a.temperature, 0);
  assert.equal(a.max_tokens, 700);
  assert.equal(a.stream, false);
  assert.deepEqual(a.response_format.json_schema, { name: 'p', schema: SCHEMA });
  assert.equal(b.temperature, 0);
  assert.equal(b.max_tokens, 50);
  assert.equal(c.temperature, 0.1);
  assert.equal(c.max_tokens, 700);
  assert.ok(!('max_completion_tokens' in c));
});

test('a second allow-listed model and a second token both work', async (t) => {
  const upstream = await startUpstream(t);
  const gateway = await startGateway(t, upstream.url);
  const response = await post(gateway, validBody({ model: 'second-model' }), { token: OTHER_TOKEN });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).model, 'second-model');
  const [line] = await waitForLogs(gateway, 1);
  assert.equal(line.token, 'cli');
  assert.equal(line.model, 'second-model');
});

// ---------------------------------------------------------------------------
// Request rejections
// ---------------------------------------------------------------------------

const big = (n) => 'x'.repeat(n);

const REJECTIONS = [
  ['tools', validBody({ tools: [{ type: 'function', function: { name: 'run' } }] })],
  ['empty tools array', validBody({ tools: [] })],
  ['tool_choice', validBody({ tool_choice: 'auto' })],
  ['tool_choice none', validBody({ tool_choice: 'none' })],
  ['functions', validBody({ functions: [{ name: 'run' }] })],
  ['function_call', validBody({ function_call: 'auto' })],
  ['stream true', validBody({ stream: true })],
  ['stream truthy string', validBody({ stream: 'yes' })],
  ['n > 1', validBody({ n: 2 })],
  ['logprobs', validBody({ logprobs: true })],
  ['top_logprobs', validBody({ top_logprobs: 5 })],
  ['assistant message', validBody({ messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: '{' }, { role: 'user', content: 'b' }] })],
  ['tool message', validBody({ messages: [{ role: 'tool', content: 'a', tool_call_id: '1' }, { role: 'user', content: 'b' }] })],
  ['developer role', validBody({ messages: [{ role: 'developer', content: 'a' }, { role: 'user', content: 'b' }] })],
  ['last message not user', validBody({ messages: [{ role: 'user', content: 'a' }, { role: 'system', content: 'b' }] })],
  ['no messages', validBody({ messages: [] })],
  ['messages missing', validBody({ messages: undefined })],
  ['messages not an array', validBody({ messages: { role: 'user', content: 'a' } })],
  ['five messages', validBody({ messages: Array.from({ length: 5 }, () => ({ role: 'user', content: 'a' })) })],
  ['array content parts', validBody({ messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }] }] })],
  ['null message', validBody({ messages: [null] })],
  ['messages over the char cap', validBody({ messages: [{ role: 'system', content: big(30000) }, { role: 'user', content: big(30000) }] })],
  ['model not allow-listed', validBody({ model: 'gpt-4o' })],
  ['model missing', validBody({ model: undefined })],
  ['model not a string', validBody({ model: [MODEL] })],
  ['response_format missing', validBody({ response_format: undefined })],
  ['response_format json_object', validBody({ response_format: { type: 'json_object' } })],
  ['response_format text', validBody({ response_format: { type: 'text' } })],
  ['json_schema missing', validBody({ response_format: { type: 'json_schema' } })],
  ['schema name missing', validBody({ response_format: { type: 'json_schema', json_schema: { schema: SCHEMA } } })],
  ['schema name invalid', validBody({ response_format: { type: 'json_schema', json_schema: { name: 'a b', schema: SCHEMA } } })],
  ['strict not boolean', validBody({ response_format: { type: 'json_schema', json_schema: { name: 'p', strict: 'yes', schema: SCHEMA } } })],
  ['schema not an object', validBody({ response_format: { type: 'json_schema', json_schema: { name: 'p', schema: [] } } })],
  ['schema over 8 KB', validBody({ response_format: { type: 'json_schema', json_schema: { name: 'p', schema: { description: big(8200) } } } })],
  ['temperature not a number', validBody({ temperature: 'hot' })],
  ['max_tokens zero', validBody({ max_tokens: 0 })],
  ['max_tokens fractional', validBody({ max_tokens: 1.5 })],
  ['max_tokens string', validBody({ max_tokens: '100' })],
  ['body is an array', [validBody()]],
  ['body is a string', '"hello"'],
  ['body is not JSON', '{not json'],
  ['body is empty', ''],
  ['body is invalid UTF-8', Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x3a, 0x31, 0x7d])],
];

test('rejects (400) every request outside the protocol, and never calls upstream', async (t) => {
  const upstream = await startUpstream(t);
  const gateway = await startGateway(t, upstream.url, { MENDER_RATE_LIMIT_PER_MINUTE: '1000' });
  for (const [name, body] of REJECTIONS) {
    await t.test(name, async () => {
      await assertError(await post(gateway, body), 400);
    });
  }
  assert.equal(upstream.received.length, 0);
  const lines = await waitForLogs(gateway, REJECTIONS.length);
  // Invalid requests are never attributed to a model, even an allow-listed one.
  assert.ok(lines.every((line) => line.model === null && line.upstream_status === null));
});

test('error messages do not echo the rejected model name', async (t) => {
  const upstream = await startUpstream(t);
  const gateway = await startGateway(t, upstream.url);
  const response = await post(gateway, validBody({ model: 'SECRET_MODEL_PROBE' }));
  const text = await response.text();
  assert.equal(response.status, 400);
  assert.ok(!text.includes('SECRET_MODEL_PROBE'));
  assert.ok(!text.includes(MODEL), 'must not disclose the allow-list');
});

test('requires content-type application/json (415)', async (t) => {
  const upstream = await startUpstream(t);
  const gateway = await startGateway(t, upstream.url);
  const body = JSON.stringify(validBody());
  await assertError(await post(gateway, body, { headers: { 'content-type': 'text/plain' } }), 415);
  await assertError(await post(gateway, body, { headers: { 'content-type': 'application/x-www-form-urlencoded' } }), 415);
  const ok = await post(gateway, body, { headers: { 'content-type': 'Application/JSON; charset=utf-8' } });
  assert.equal(ok.status, 200);
  assert.equal(upstream.received.length, 1);
});

test('routing: unknown paths 404, wrong methods 405', async (t) => {
  const upstream = await startUpstream(t);
  const gateway = await startGateway(t, upstream.url);
  const auth = { authorization: `Bearer ${TOKEN}` };

  for (const path of ['/', '/v1', '/v1/models', '/v1/completions', '/v1/embeddings', '/v1/chat/completions/', '/metrics', '/healthz/x']) {
    await assertError(await fetch(`${gateway.origin}${path}`, { headers: auth }), 404, 'not_found');
    await assertError(await post(gateway, validBody(), { path }), 404, 'not_found');
  }
  for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
    const response = await fetch(`${gateway.origin}/v1/chat/completions`, { method, headers: auth });
    await assertError(response, 405, 'method_not_allowed');
    assert.equal(response.headers.get('allow'), 'POST');
  }
  const health = await fetch(`${gateway.origin}/healthz`, { method: 'POST', body: '{}' });
  await assertError(health, 405, 'method_not_allowed');
  assert.equal(health.headers.get('allow'), 'GET');
  assert.equal(upstream.received.length, 0);
});

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

test('auth failures are 401, identical for every cause, and happen before the body is considered', async (t) => {
  const upstream = await startUpstream(t);
  const gateway = await startGateway(t, upstream.url);
  const hash = hashToken(TOKEN);
  const cases = {
    'missing header': { token: null },
    'wrong token': { token: 'mnd_wrong' },
    'token prefix': { token: TOKEN.slice(0, -1) },
    'token with suffix': { token: `${TOKEN}x` },
    'the stored hash itself': { token: hash },
    'token name': { token: 'worker' },
    'basic scheme': { token: null, headers: { authorization: `Basic ${Buffer.from(`worker:${TOKEN}`).toString('base64')}` } },
    'bare token': { token: null, headers: { authorization: TOKEN } },
    'empty bearer': { token: null, headers: { authorization: 'Bearer ' } },
    'oversized token': { token: 'a'.repeat(4000) },
    'token in x-api-key only': { token: null, headers: { 'x-api-key': TOKEN } },
  };
  const bodies = new Set();
  for (const [name, options] of Object.entries(cases)) {
    await t.test(name, async () => {
      // An invalid body proves auth is decided first: it would otherwise be a 400.
      const response = await post(gateway, '{not json', options);
      assert.equal(response.status, 401);
      assert.equal(response.headers.get('www-authenticate'), 'Bearer');
      bodies.add(JSON.stringify(await response.json()));
    });
  }
  assert.equal(bodies.size, 1, 'every auth failure must return the same body');
  assert.equal(upstream.received.length, 0);
  const lines = await waitForLogs(gateway, Object.keys(cases).length);
  assert.ok(lines.every((line) => line.status === 401 && line.token === null));
});

test('auth is checked before an oversized body is read', async (t) => {
  const upstream = await startUpstream(t);
  const gateway = await startGateway(t, upstream.url);
  const response = await post(gateway, big(200000), { token: 'mnd_wrong' });
  assert.equal(response.status, 401);
});

test('bearer scheme is case-insensitive', async (t) => {
  const upstream = await startUpstream(t);
  const gateway = await startGateway(t, upstream.url);
  const response = await post(gateway, validBody(), { token: null, headers: { authorization: `bearer ${TOKEN}` } });
  assert.equal(response.status, 200);
});

// ---------------------------------------------------------------------------
// Body cap
// ---------------------------------------------------------------------------

test('body cap: declared content-length over the limit is 413', async (t) => {
  const upstream = await startUpstream(t);
  const gateway = await startGateway(t, upstream.url);
  const response = await post(gateway, validBody({ messages: [{ role: 'user', content: big(70000) }] }));
  await assertError(response, 413, 'request_too_large');
  assert.equal(upstream.received.length, 0);
});

test('body cap: chunked body without content-length is cut off at the limit (413)', async (t) => {
  const upstream = await startUpstream(t);
  const gateway = await startGateway(t, upstream.url, { MENDER_MAX_BODY_BYTES: '2048' });
  const { port } = gateway.server.address();
  const status = await new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` } },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      },
    );
    req.on('error', reject);
    for (let i = 0; i < 8; i += 1) req.write(big(1024));
    req.end();
  });
  assert.equal(status, 413);
  assert.equal(upstream.received.length, 0);
});

test('body cap: a body exactly at the limit is accepted', async (t) => {
  const upstream = await startUpstream(t);
  const gateway = await startGateway(t, upstream.url, { MENDER_MAX_BODY_BYTES: '4096' });
  const base = JSON.stringify(validBody({ messages: [{ role: 'user', content: '' }] }));
  const body = JSON.stringify(validBody({ messages: [{ role: 'user', content: big(4096 - base.length) }] }));
  assert.equal(Buffer.byteLength(body), 4096);
  assert.equal((await post(gateway, body)).status, 200);
  assert.equal((await post(gateway, `${body} `)).status, 413);
});

// ---------------------------------------------------------------------------
// Rate limit and concurrency
// ---------------------------------------------------------------------------

test('rate limit is per token, returns 429 with Retry-After, and resets after the window', async (t) => {
  const upstream = await startUpstream(t);
  let clock = 1_000_000;
  const gateway = await startGateway(t, upstream.url, { MENDER_RATE_LIMIT_PER_MINUTE: '3' }, { now: () => clock });

  for (let i = 0; i < 3; i += 1) assert.equal((await post(gateway, validBody())).status, 200);
  clock += 20_000;
  const limited = await post(gateway, validBody());
  await assertError(limited, 429, 'rate_limited');
  assert.equal(limited.headers.get('retry-after'), '40');

  // Another token has its own budget.
  assert.equal((await post(gateway, validBody(), { token: OTHER_TOKEN })).status, 200);
  // Unauthenticated traffic does not consume anyone's budget.
  assert.equal((await post(gateway, validBody(), { token: 'mnd_wrong' })).status, 401);

  clock += 40_000;
  assert.equal((await post(gateway, validBody())).status, 200);
  assert.equal(upstream.received.length, 5);
});

test('concurrency cap: requests over the limit get 429 with Retry-After, capacity is released afterwards', async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const upstream = await startUpstream(t, async (_req, res) => {
    await gate;
    json(res, 200, completion());
  });
  const gateway = await startGateway(t, upstream.url, { MENDER_MAX_CONCURRENCY: '2' });

  const held = [post(gateway, validBody()), post(gateway, validBody())];
  while (upstream.received.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));

  const rejected = await post(gateway, validBody());
  await assertError(rejected, 429, 'too_many_concurrent_requests');
  assert.equal(rejected.headers.get('retry-after'), '1');

  release();
  for (const response of await Promise.all(held)) assert.equal(response.status, 200);
  assert.equal((await post(gateway, validBody())).status, 200);
});

test('capacity is released after failed requests too', async (t) => {
  const upstream = await startUpstream(t, (_req, res) => json(res, 500, { error: 'boom' }));
  const gateway = await startGateway(t, upstream.url, { MENDER_MAX_CONCURRENCY: '1' });
  for (let i = 0; i < 3; i += 1) assert.equal((await post(gateway, validBody())).status, 502);
  for (let i = 0; i < 3; i += 1) assert.equal((await post(gateway, '{bad')).status, 400);
  assert.equal((await post(gateway, validBody())).status, 502);
});

// ---------------------------------------------------------------------------
// Upstream failures
// ---------------------------------------------------------------------------

test('upstream 500 becomes 502 without echoing the upstream body', async (t) => {
  const upstream = await startUpstream(t, (_req, res) =>
    json(res, 500, { error: { message: 'CUDA OOM on gpu-node-17 UPSTREAM_BODY_MARKER' } }),
  );
  const gateway = await startGateway(t, upstream.url);
  const response = await post(gateway, validBody());
  const text = await response.text();
  assert.equal(response.status, 502);
  assert.ok(!text.includes('UPSTREAM_BODY_MARKER'));
  assert.ok(!text.includes('gpu-node-17'));
  const [line] = await waitForLogs(gateway, 1);
  assert.equal(line.status, 502);
  assert.equal(line.upstream_status, 500);
  assert.ok(!gateway.logs.join('\n').includes('UPSTREAM_BODY_MARKER'));
});

test('upstream 401/404/429 all become 502', async (t) => {
  let status = 401;
  const upstream = await startUpstream(t, (_req, res) => json(res, status, { error: 'nope' }));
  const gateway = await startGateway(t, upstream.url);
  for (status of [401, 404, 429]) {
    await assertError(await post(gateway, validBody()), 502, 'upstream_error');
  }
});

test('upstream timeout becomes 504', async (t) => {
  const upstream = await startUpstream(t, () => {
    /* never answers */
  });
  const gateway = await startGateway(t, upstream.url, { MENDER_REQUEST_TIMEOUT_MS: '150' });
  const started = Date.now();
  await assertError(await post(gateway, validBody()), 504, 'upstream_timeout');
  assert.ok(Date.now() - started < 5000);
});

test('upstream that stalls mid-body also times out (504)', async (t) => {
  const upstream = await startUpstream(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"id":"x","choices":[');
  });
  const gateway = await startGateway(t, upstream.url, { MENDER_REQUEST_TIMEOUT_MS: '150' });
  await assertError(await post(gateway, validBody()), 504, 'upstream_timeout');
});

test('upstream redirect is refused (502) and never followed', async (t) => {
  const elsewhere = await startUpstream(t);
  for (const code of [301, 302, 307, 308]) {
    const upstream = await startUpstream(t, (_req, res) => {
      res.writeHead(code, { location: `${elsewhere.url}/chat/completions` });
      res.end();
    });
    const gateway = await startGateway(t, upstream.url);
    await assertError(await post(gateway, validBody()), 502);
  }
  assert.equal(elsewhere.received.length, 0, 'the prompt must not follow a redirect');
});

test('unreachable upstream becomes 502 without leaking the address', async (t) => {
  const dead = http.createServer();
  const origin = await listen(dead);
  await closeServer(dead);
  const gateway = await startGateway(t, `${origin}/v1`);
  const response = await post(gateway, validBody());
  const text = await response.text();
  assert.equal(response.status, 502);
  assert.ok(!text.includes(new URL(origin).port));
  assert.ok(!/ECONNREFUSED|127\.0\.0\.1/.test(text));
});

const BAD_UPSTREAM_RESPONSES = {
  'non-JSON body': (res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html>login</html>');
  },
  'JSON that is not an object': (res) => json(res, 200, ['x']),
  'no choices': (res) => json(res, 200, { id: 'x', choices: [] }),
  'content over 64 KB': (res) => json(res, 200, completion(big(65537))),
  'null content': (res) => json(res, 200, completion(null)),
  'array content': (res) => json(res, 200, completion([{ type: 'text', text: 'x' }])),
  'tool calls': (res) =>
    json(res, 200, {
      choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: '', tool_calls: [{ id: '1', type: 'function', function: { name: 'sh', arguments: '{}' } }] } }],
    }),
  'tool calls with finish_reason stop': (res) =>
    json(res, 200, {
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{}', tool_calls: [{ id: '1' }] } }],
    }),
  'legacy function_call': (res) =>
    json(res, 200, { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{}', function_call: { name: 'sh' } } }] }),
  'non-assistant role': (res) => json(res, 200, { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'tool', content: '{}' } }] }),
  'unknown finish_reason': (res) => json(res, 200, { choices: [{ index: 0, finish_reason: 'eos', message: { role: 'assistant', content: '{}' } }] }),
  'response over the read cap': (res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ padding: big(1100000), ...completion() }));
  },
  'connection dropped mid-response': (res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': '500' });
    res.write('{"id":');
    res.destroy();
  },
};

test('unexpected upstream responses fail closed as 502', async (t) => {
  for (const [name, respond] of Object.entries(BAD_UPSTREAM_RESPONSES)) {
    await t.test(name, async (t2) => {
      const upstream = await startUpstream(t2, (_req, res) => respond(res));
      const gateway = await startGateway(t2, upstream.url);
      const response = await post(gateway, validBody());
      const body = await assertError(response, 502);
      assert.ok(JSON.stringify(body).length < 300);
    });
  }
});

test('content exactly 64 KB is accepted; odd ids and usage are normalised', async (t) => {
  const upstream = await startUpstream(t, (_req, res) =>
    json(res, 200, {
      id: 'weird id with spaces <script>',
      choices: [{ index: 3, finish_reason: 'length', message: { content: big(65536), reasoning_content: 'dropped' } }],
      usage: { prompt_tokens: 'many' },
    }),
  );
  const gateway = await startGateway(t, upstream.url);
  const response = await post(gateway, validBody());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.match(body.id, /^chatcmpl-[0-9a-f-]{36}$/);
  assert.equal(body.id, `chatcmpl-${response.headers.get('x-request-id')}`);
  assert.deepEqual(Object.keys(body), ['id', 'model', 'choices', 'usage']);
  assert.deepEqual(Object.keys(body.choices[0]), ['index', 'finish_reason', 'message']);
  assert.deepEqual(Object.keys(body.choices[0].message), ['role', 'content']);
  assert.equal(body.choices[0].index, 0);
  assert.equal(body.choices[0].finish_reason, 'length');
  assert.equal(body.choices[0].message.content.length, 65536);
  assert.equal(body.usage, null);
});

// ---------------------------------------------------------------------------
// Startup configuration
// ---------------------------------------------------------------------------

const DENIED_HOSTS = [
  ...DENIED_UPSTREAM_SUFFIXES.flatMap((suffix) => [
    suffix,
    `api.${suffix}`,
    `eu.api.${suffix}`,
    `API.${suffix.toUpperCase()}`,
    `${suffix}.`,
  ]),
  'my-resource.openai.azure.com',
  'us-central1-aiplatform.googleapis.com',
  'bedrock-runtime.us-east-1.amazonaws.com',
  'bedrock.eu-west-1.amazonaws.com',
  'Bedrock-Runtime.US-East-1.AmazonAWS.com',
  'bedrock-runtime-fips.us-gov-west-1.amazonaws.com',
  'vpce-0abc-xyz.bedrock-runtime.us-east-1.vpce.amazonaws.com',
];

test('deny-listed upstream hosts refuse startup', async (t) => {
  const required = [
    'openai.com', 'anthropic.com', 'generativelanguage.googleapis.com', 'aiplatform.googleapis.com',
    'openai.azure.com', 'mistral.ai', 'cohere.com', 'cohere.ai', 'groq.com', 'together.xyz', 'together.ai',
    'fireworks.ai', 'openrouter.ai', 'deepseek.com', 'x.ai', 'perplexity.ai', 'replicate.com',
    'huggingface.co', 'deepinfra.com', 'cerebras.ai', 'sambanova.ai',
  ];
  for (const suffix of required) assert.ok(DENIED_UPSTREAM_SUFFIXES.includes(suffix), `${suffix} must be deny-listed`);

  for (const host of DENIED_HOSTS) {
    await t.test(host, () => {
      for (const url of [`https://${host}/v1`, `http://${host}:8443/v1/`, `https://${host}`]) {
        assert.throws(
          () => loadConfig(env(url)),
          (error) => error instanceof ConfigError && /hosted AI provider/.test(error.message),
        );
      }
      assert.notEqual(deniedUpstreamReason(host), null);
    });
  }
});

test('hosts you operate are not deny-listed (suffix match is on DNS labels)', () => {
  for (const host of [
    'inference', 'localhost', '127.0.0.1', '10.0.4.7', '[::1]', 'gpu-1.internal.example.com',
    'notopenai.com', 'openai.com.internal.example', 'max.ai', 'myx.ai', 'relax.ai',
    'my-alb-123.us-east-1.elb.amazonaws.com', 'ec2-1-2-3-4.compute-1.amazonaws.com', 'ollama.tailnet.ts.net',
  ]) {
    assert.equal(deniedUpstreamReason(host), null, host);
    assert.doesNotThrow(() => loadConfig(env(`http://${host}:8000/v1`)), host);
  }
});

test('loadConfig: defaults and normalisation', () => {
  const config = loadConfig(env('http://inference:8000/v1/'));
  assert.deepEqual(config.listen, { host: '127.0.0.1', port: 8787 });
  assert.equal(config.upstreamUrl, 'http://inference:8000/v1');
  assert.equal(config.upstreamApiKey, null);
  assert.deepEqual(config.allowedModels, [MODEL, 'second-model']);
  assert.deepEqual(config.tokens.map((token) => token.name), ['worker', 'cli']);
  assert.equal(config.maxBodyBytes, 65536);
  assert.equal(config.maxOutputTokens, 1024);
  assert.equal(config.requestTimeoutMs, 120000);
  assert.equal(config.rateLimitPerMinute, 60);
  assert.equal(config.maxConcurrency, 4);
  assert.deepEqual(loadConfig(env('http://h/v1', { MENDER_GATEWAY_LISTEN: '[::1]:9000' })).listen, { host: '::1', port: 9000 });
});

test('loadConfig fails closed with clear errors', async (t) => {
  const plaintext = 'mnd_PLAINTEXT_PASTED_BY_MISTAKE';
  const cases = {
    'no upstream': [{ MENDER_UPSTREAM_URL: undefined }, /MENDER_UPSTREAM_URL is required/],
    'upstream not a URL': [{ MENDER_UPSTREAM_URL: 'inference:8000' }, /MENDER_UPSTREAM_URL/],
    'upstream file scheme': [{ MENDER_UPSTREAM_URL: 'file:///etc/passwd' }, /http or https/],
    'upstream ws scheme': [{ MENDER_UPSTREAM_URL: 'ws://inference/v1' }, /http or https/],
    'upstream with credentials': [{ MENDER_UPSTREAM_URL: 'http://user:pw@inference/v1' }, /must not embed credentials/],
    'upstream with query': [{ MENDER_UPSTREAM_URL: 'http://inference/v1?key=1' }, /query string/],
    'no tokens': [{ MENDER_GATEWAY_TOKENS_SHA256: undefined }, /never runs unauthenticated/],
    'blank tokens': [{ MENDER_GATEWAY_TOKENS_SHA256: ' , ' }, /MENDER_GATEWAY_TOKENS_SHA256 is required/],
    'plaintext token instead of a hash': [{ MENDER_GATEWAY_TOKENS_SHA256: `worker:${plaintext}` }, /64 hex characters/],
    'token without a name': [{ MENDER_GATEWAY_TOKENS_SHA256: hashToken('a') }, /name:sha256hex/],
    'duplicate token names': [{ MENDER_GATEWAY_TOKENS_SHA256: `a:${hashToken('1')},a:${hashToken('2')}` }, /duplicate token name/],
    'no models': [{ MENDER_ALLOWED_MODELS: '' }, /MENDER_ALLOWED_MODELS is required/],
    'bad model name': [{ MENDER_ALLOWED_MODELS: 'ok,bad model' }, /not a valid model name/],
    'bad listen': [{ MENDER_GATEWAY_LISTEN: '8787' }, /MENDER_GATEWAY_LISTEN/],
    'listen port out of range': [{ MENDER_GATEWAY_LISTEN: '127.0.0.1:70000' }, /MENDER_GATEWAY_LISTEN/],
    'non-numeric limit': [{ MENDER_MAX_BODY_BYTES: '64k' }, /MENDER_MAX_BODY_BYTES/],
    'zero concurrency': [{ MENDER_MAX_CONCURRENCY: '0' }, /MENDER_MAX_CONCURRENCY/],
    'negative rate limit': [{ MENDER_RATE_LIMIT_PER_MINUTE: '-1' }, /MENDER_RATE_LIMIT_PER_MINUTE/],
    'absurd output tokens': [{ MENDER_MAX_OUTPUT_TOKENS: '1000000' }, /MENDER_MAX_OUTPUT_TOKENS/],
    'zero timeout': [{ MENDER_REQUEST_TIMEOUT_MS: '0' }, /MENDER_REQUEST_TIMEOUT_MS/],
  };
  for (const [name, [overrides, pattern]] of Object.entries(cases)) {
    await t.test(name, () => {
      assert.throws(
        () => loadConfig(env('http://inference:8000/v1', overrides)),
        (error) => {
          assert.ok(error instanceof ConfigError);
          assert.match(error.message, pattern);
          assert.ok(!error.message.includes(plaintext), 'startup errors must not echo token material');
          return true;
        },
      );
    });
  }
});

test('loadConfig reports every problem at once', () => {
  assert.throws(
    () => loadConfig({}),
    (error) => error instanceof ConfigError && error.problems.length === 3,
  );
});

test('buildUpstreamRequest returns only allow-listed keys', () => {
  const config = loadConfig(env('http://inference:8000/v1'));
  const built = buildUpstreamRequest(validBody({ seed: 1, metadata: { a: 1 } }), config);
  assert.deepEqual(Object.keys(built), ['model', 'messages', 'response_format', 'temperature', 'max_tokens', 'stream']);
});

// ---------------------------------------------------------------------------
// Health, logging, persistence
// ---------------------------------------------------------------------------

test('healthz is unauthenticated and returns only {ok, model}', async (t) => {
  const upstream = await startUpstream(t);
  const gateway = await startGateway(t, upstream.url, { MENDER_UPSTREAM_API_KEY: 'upstream-key-HEALTH' });
  const response = await fetch(`${gateway.origin}/healthz`);
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.deepEqual(JSON.parse(text), { ok: true, model: MODEL });
  assert.equal(response.headers.get('cache-control'), 'no-store');

  const everything = text + JSON.stringify([...response.headers]);
  const upstreamUrl = new URL(upstream.url);
  for (const secret of [upstreamUrl.port, upstreamUrl.host, 'upstream-key-HEALTH', 'second-model', 'worker', hashToken(TOKEN)]) {
    assert.ok(!everything.includes(secret), `healthz leaked ${secret}`);
  }
  assert.equal(upstream.received.length, 0, 'healthz must not probe the upstream');
});

test('healthz stays the same when the upstream is down', async (t) => {
  const dead = http.createServer();
  const origin = await listen(dead);
  await closeServer(dead);
  const gateway = await startGateway(t, `${origin}/v1`);
  const response = await fetch(`${gateway.origin}/healthz?verbose=1`);
  assert.deepEqual(await response.json(), { ok: true, model: MODEL });
});

test('log hygiene: one JSON line per request with fixed keys; no prompt, completion, token or header content', async (t) => {
  const PROMPT_MARKER = 'PROMPT_MARKER_7f3a9c';
  const COMPLETION_MARKER = 'COMPLETION_MARKER_b81d2e';
  const FIELD_MARKER = 'FIELD_MARKER_55aa01';
  const UPSTREAM_KEY = 'upstream-key-LOGTEST';
  const upstream = await startUpstream(t, (_req, res, entry) => {
    if (entry.body.messages.at(-1).content.includes('fail')) {
      json(res, 500, { error: `${COMPLETION_MARKER} ${entry.body.messages.at(-1).content}` });
    } else {
      json(res, 200, completion(`{"reason":"${COMPLETION_MARKER}"}`, { id: COMPLETION_MARKER }));
    }
  });
  const gateway = await startGateway(t, upstream.url, { MENDER_UPSTREAM_API_KEY: UPSTREAM_KEY });

  const prompt = (text) => validBody({ messages: [{ role: 'system', content: PROMPT_MARKER }, { role: 'user', content: `${PROMPT_MARKER} ${text}` }] });
  const requests = [
    post(gateway, prompt('ok')), // 200
    post(gateway, prompt('fail')), // 502
    post(gateway, prompt('ok'), { token: `wrong-${FIELD_MARKER}` }), // 401
    post(gateway, { ...prompt('ok'), model: FIELD_MARKER }), // 400, marker as model
    post(gateway, { ...prompt('ok'), tools: [{ name: FIELD_MARKER }] }), // 400
    post(gateway, `{"broken": "${PROMPT_MARKER}`), // 400 parse error
    post(gateway, prompt(big(70000))), // 413
    post(gateway, prompt('ok'), { path: `/v1/${FIELD_MARKER}?q=${PROMPT_MARKER}` }), // 404
    post(gateway, prompt('ok'), { headers: { 'x-custom': FIELD_MARKER, 'user-agent': FIELD_MARKER } }), // 200
    fetch(`${gateway.origin}/healthz`),
  ];
  const statuses = (await Promise.all(requests)).map((response) => response.status);
  assert.deepEqual(statuses, [200, 502, 401, 400, 400, 400, 413, 404, 200, 200]);

  const lines = await waitForLogs(gateway, requests.length);
  assert.equal(lines.length, requests.length, 'exactly one line per request');
  const captured = gateway.logs.join('\n');
  for (const forbidden of [PROMPT_MARKER, COMPLETION_MARKER, FIELD_MARKER, TOKEN, hashToken(TOKEN), UPSTREAM_KEY, 'Bearer', 'authorization']) {
    assert.ok(!captured.includes(forbidden), `log output contains ${forbidden}`);
  }

  for (const line of lines) {
    assert.deepEqual(Object.keys(line).sort(), LOG_KEYS);
    assert.match(line.ts, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    assert.match(line.request_id, /^[0-9a-f-]{36}$/);
    assert.ok(line.token === null || line.token === 'worker');
    assert.ok(line.model === null || line.model === MODEL);
    for (const key of ['request_bytes', 'response_bytes', 'status', 'latency_ms']) assert.equal(typeof line[key], 'number');
    assert.ok(line.upstream_status === null || Number.isInteger(line.upstream_status));
  }
  assert.equal(new Set(lines.map((line) => line.request_id)).size, lines.length);

  const ok = lines.find((line) => line.status === 200 && line.model === MODEL);
  assert.equal(ok.token, 'worker');
  assert.equal(ok.upstream_status, 200);
  assert.ok(ok.request_bytes > 0 && ok.response_bytes > 0);
  assert.equal(lines.find((line) => line.status === 502).upstream_status, 500);
});

test('the gateway source contains no way to write to disk', () => {
  const source = readFileSync(SERVER_PATH, 'utf8');
  const fsImports = [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'node:fs(?:\/promises)?'/g)].map((m) => m[1].trim());
  assert.deepEqual(fsImports, ['realpathSync'], 'only realpathSync (entry-point detection) may be imported from node:fs');
  for (const api of ['writeFile', 'appendFile', 'createWriteStream', 'openSync', 'mkdir', 'node:sqlite', 'child_process', 'console.']) {
    assert.ok(!source.includes(api), `server.mjs must not use ${api}`);
  }
  assert.ok(!/^import .* from '(?!node:)/m.test(source), 'zero dependencies: node: built-ins only');
});

// ---------------------------------------------------------------------------
// Token helper
// ---------------------------------------------------------------------------

test('token helper: minted tokens authenticate; only the hash is configured', async (t) => {
  const token = newToken();
  assert.match(token, /^mnd_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(newToken(), token);
  const entry = tokenEntry('ci', token);
  assert.equal(entry, `ci:${hashToken(token)}`);
  assert.ok(!entry.includes(token));
  assert.throws(() => tokenEntry('bad name', token));

  const upstream = await startUpstream(t);
  const gateway = await startGateway(t, upstream.url, { MENDER_GATEWAY_TOKENS_SHA256: entry });
  assert.equal((await post(gateway, validBody(), { token })).status, 200);
  // Revocation is removal from configuration: the previous tokens are gone.
  assert.equal((await post(gateway, validBody(), { token: TOKEN })).status, 401);
});

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], ...options });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    child.stdin.end(options.input ?? '');
  });
}

test('token CLI: `new` prints a token and a matching entry; `hash` reproduces it; bad usage exits 2', async () => {
  const minted = await run(process.execPath, [TOKEN_CLI_PATH, 'new', 'worker-prod']);
  assert.equal(minted.code, 0);
  const token = /^\s+(mnd_\S+)$/m.exec(minted.stdout)[1];
  const entry = /^\s+(worker-prod:[0-9a-f]{64})$/m.exec(minted.stdout)[1];
  assert.equal(entry, tokenEntry('worker-prod', token));

  const hashed = await run(process.execPath, [TOKEN_CLI_PATH, 'hash', 'worker-prod'], { input: `${token}\n` });
  assert.equal(hashed.stdout.trim(), entry);
  assert.ok(!hashed.stdout.includes(token));

  assert.equal((await run(process.execPath, [TOKEN_CLI_PATH])).code, 2);
  assert.equal((await run(process.execPath, [TOKEN_CLI_PATH, 'new', 'bad name'])).code, 2);
});

// ---------------------------------------------------------------------------
// The real process: startup, stdout hygiene, SIGTERM
// ---------------------------------------------------------------------------

/** A clean environment so nothing from the developer's shell configures the child. */
function childEnv(extra) {
  return { PATH: process.env.PATH, ...extra };
}

test('process: serves, logs only fixed fields to stdout, and exits 0 on SIGTERM', async (t) => {
  const MARKER = 'PROCESS_MARKER_c0ffee';
  const upstream = await startUpstream(t, (_req, res) => json(res, 200, completion(`{"reason":"${MARKER}"}`)));
  const child = spawn(process.execPath, [SERVER_PATH], {
    env: childEnv(env(upstream.url, { MENDER_GATEWAY_LISTEN: '127.0.0.1:0', MENDER_UPSTREAM_API_KEY: 'upstream-key-PROC' })),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGKILL'));
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));

  let port;
  for (let i = 0; i < 400 && !port; i += 1) {
    port = /listening on 127\.0\.0\.1:(\d+)/.exec(stderr)?.[1];
    if (!port) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(port, `gateway did not start: ${stderr}`);
  const gateway = { origin: `http://127.0.0.1:${port}` };

  const ok = await post(gateway, validBody({ messages: [{ role: 'user', content: MARKER }] }));
  assert.equal(ok.status, 200);
  assert.ok((await ok.text()).includes(MARKER));
  assert.equal((await post(gateway, validBody(), { token: `bad-${MARKER}` })).status, 401);
  assert.equal((await fetch(`${gateway.origin}/healthz`)).status, 200);

  child.kill('SIGTERM');
  const [code, signal] = await once(child, 'close');
  assert.equal(code, 0, `expected a clean exit, got code=${code} signal=${signal}`);

  const lines = stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((line) => line.status), [200, 401, 200]);
  for (const line of lines) assert.deepEqual(Object.keys(line).sort(), LOG_KEYS);
  for (const forbidden of [MARKER, TOKEN, 'upstream-key-PROC', hashToken(TOKEN)]) {
    assert.ok(!stdout.includes(forbidden) && !stderr.includes(forbidden), `process output contains ${forbidden}`);
  }
  await assert.rejects(fetch(`${gateway.origin}/healthz`), 'the listener must be closed after SIGTERM');
});

test('process: SIGTERM waits for an in-flight request to finish', async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const upstream = await startUpstream(t, async (_req, res) => {
    await gate;
    json(res, 200, completion());
  });
  const child = spawn(process.execPath, [SERVER_PATH], {
    env: childEnv(env(upstream.url, { MENDER_GATEWAY_LISTEN: '127.0.0.1:0' })),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  t.after(() => child.kill('SIGKILL'));
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  let port;
  for (let i = 0; i < 400 && !port; i += 1) {
    port = /listening on 127\.0\.0\.1:(\d+)/.exec(stderr)?.[1];
    if (!port) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(port, `gateway did not start: ${stderr}`);

  const pending = post({ origin: `http://127.0.0.1:${port}` }, validBody());
  while (upstream.received.length < 1) await new Promise((resolve) => setTimeout(resolve, 5));
  child.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(child.exitCode, null, 'must not exit while a request is in flight');
  release();
  assert.equal((await pending).status, 200);
  const [code] = await once(child, 'close');
  assert.equal(code, 0);
});

test('process: refuses to start with a hosted provider upstream, without tokens, or with no configuration', async () => {
  const hosted = await run(process.execPath, [SERVER_PATH], { env: childEnv(env('https://api.openai.com/v1')) });
  assert.equal(hosted.code, 1);
  assert.match(hosted.stderr, /hosted AI provider \(openai\.com\)/);
  assert.equal(hosted.stdout, '');

  const noTokens = await run(process.execPath, [SERVER_PATH], {
    env: childEnv(env('http://127.0.0.1:1/v1', { MENDER_GATEWAY_TOKENS_SHA256: '' })),
  });
  assert.equal(noTokens.code, 1);
  assert.match(noTokens.stderr, /never runs unauthenticated/);

  const empty = await run(process.execPath, [SERVER_PATH], { env: childEnv({}) });
  assert.equal(empty.code, 1);
  assert.match(empty.stderr, /MENDER_UPSTREAM_URL is required/);
  assert.match(empty.stderr, /MENDER_ALLOWED_MODELS is required/);
});

// ---------------------------------------------------------------------------
// Gateway in front of the test double (how other packages wire it up)
// ---------------------------------------------------------------------------

test('integration: gateway in front of the stand-in test double', async (t) => {
  const standin = createStandin();
  const standinOrigin = await listen(standin);
  t.after(() => closeServer(standin));
  const gateway = await startGateway(t, `${standinOrigin}/v1`, { MENDER_ALLOWED_MODELS: STANDIN_MODEL_ID });

  const task = {
    contract_change: {
      kind: 'request-property-removed',
      fields: ['customer'],
      before: { customer: { type: 'string' } },
      after: { customer: null, customers: { type: 'array', items: { type: 'string' } } },
    },
    editable_lines: { start: 10, end: 12 },
    source_excerpt: [
      { line: 10, text: 'const body = {' },
      { line: 11, text: '  customer: order.customerId,' },
      { line: 12, text: '};' },
    ],
  };
  const response = await post(
    gateway,
    validBody({ model: STANDIN_MODEL_ID, messages: [{ role: 'system', content: 's' }, { role: 'user', content: JSON.stringify(task) }] }),
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.model, STANDIN_MODEL_ID);
  assert.deepEqual(JSON.parse(body.choices[0].message.content).edits, [
    { start_line: 11, end_line: 11, replacement: '  customers: [order.customerId],' },
  ]);
  assert.equal(standin.requests.length, 1);
  assert.deepEqual(Object.keys(standin.requests[0]), ['model', 'messages', 'response_format', 'temperature', 'max_tokens', 'stream']);
});
