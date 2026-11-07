// A test server for any API description, like the mock servers API teams already use (Stoplight
// Prism): it answers each endpoint with the description's own example, or a sample generated
// from the schema, and turns away requests that don't match the description with the problems
// listed. Callers can build against a new version before it exists.
//
// Descriptions are kept for 14 days in anything with the Workers KV methods, once per distinct
// description: a test server is a pointer to it, so the same example used by many people is
// stored once.

import yaml from 'js-yaml';
import { operationsOf, sampleOf, validate } from './openapi.js';
import { newId } from './watch.js';

const MAX_BYTES = 15 * 1024 * 1024;
const DAY_SECONDS = 24 * 60 * 60;
const KEEP_SECONDS = 14 * DAY_SECONDS;
const SPEC_KEY = /^spec:[0-9a-f]{64}$/;
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization, accept',
};

const answer = (status, body, extra = {}) => new Response(body === undefined ? null : JSON.stringify(body, null, 2), {
  status,
  headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), 'cache-control': 'no-store', 'mender-mock': 'true', ...CORS, ...extra },
});

export function parseDescription(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) throw new Error('The description is empty.');
  const value = /^[{[]/.test(trimmed) ? JSON.parse(trimmed) : yaml.load(trimmed);
  if (!value || typeof value !== 'object' || !value.paths) throw new Error('That is not an OpenAPI or Swagger description (there is no "paths" section).');
  return value;
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Every endpoint as a pattern, fixed addresses before ones with parameters.
function routesOf(spec) {
  return [...operationsOf(spec).values()]
    .map((op) => ({ op, params: (op.path.match(/\{[^}]+\}/g) ?? []).length, pattern: new RegExp(`^${op.path.split(/\{[^}]+\}/).map(escape).join('[^/]+')}/?$`) }))
    .sort((a, b) => a.params - b.params);
}

// Parsed descriptions, by storage key, so a busy test server isn't read and parsed on every call.
const parsed = new Map();

function load(key, text) {
  const spec = parseDescription(text);
  const value = { spec, routes: routesOf(spec) };
  if (parsed.size >= 8) parsed.delete(parsed.keys().next().value);
  parsed.set(key, value);
  return value;
}

async function sha256(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// createMock(kv, text, { beforeStoring }) → { id, title, version, endpoints }.
// beforeStoring({ newBytes }) runs once the description is known to be good, and may throw to
// refuse it; newBytes is 0 when the same description is already stored.
/**
 * @param {any} kv
 * @param {string} text
 * @param {{ now?: number, beforeStoring?: (cost: { newBytes: number }) => Promise<void> }} [options]
 */
export async function createMock(kv, text, options = {}) {
  const { beforeStoring, now = Date.now() } = options;
  const source = String(text ?? '');
  const bytes = new TextEncoder().encode(source);
  if (bytes.byteLength > MAX_BYTES) throw new Error('The description is larger than 15 MB.');
  const spec = parseDescription(source);
  const endpoints = operationsOf(spec).size;
  if (!endpoints) throw new Error('The description has no endpoints.');
  const key = `spec:${await sha256(bytes)}`;
  // Listing shows a key's metadata without downloading the description.
  const stored = (await kv.list({ prefix: key, limit: 1 })).keys.find((entry) => entry.name === key);
  if (beforeStoring) await beforeStoring({ newBytes: stored ? 0 : bytes.byteLength });
  // The description outlives every test server pointing at it: it is stored again (same key,
  // no more room) when the copy is more than a day old.
  if (!stored || now - (stored.metadata?.storedAt ?? 0) > DAY_SECONDS * 1000) {
    await kv.put(key, source, { expirationTtl: KEEP_SECONDS + DAY_SECONDS, metadata: { storedAt: now } });
  }
  const id = newId();
  const label = { title: spec.info?.title ?? null, version: spec.info?.version ?? null };
  await kv.put(`mock:${id}`, key, { expirationTtl: KEEP_SECONDS, metadata: label });
  return { id, ...label, endpoints };
}

// The example the description gives for an answer, if any.
function exampleOf(spec, op) {
  const raw = spec.paths?.[op.path]?.[op.method.toLowerCase()]?.responses?.[String(op.response?.status)] ?? spec.paths?.[op.path]?.[op.method.toLowerCase()]?.responses?.['200'];
  const media = raw?.content?.[op.response?.contentType] ?? raw?.examples?.['application/json'];
  if (media?.example !== undefined) return media.example;
  const first = media?.examples && Object.values(media.examples)[0];
  if (first && typeof first === 'object' && 'value' in first) return first.value;
  return undefined;
}

// answerMock(kv, id, request, path) → the test server's answer for `path` (the part after /mock/<id>).
export async function answerMock(kv, id, request, path) {
  if (!/^[A-Za-z0-9_-]{16,32}$/.test(String(id))) return answer(404, { error: 'There is no test server at this address.' });
  const expired = () => answer(404, { error: 'This test server has expired (they last 14 days) or never existed.' });
  const pointer = await kv.get(`mock:${id}`, 'text');
  if (pointer === null) return expired();
  if (request.method === 'OPTIONS') return answer(204);
  // Test servers made before descriptions were shared hold the description itself.
  const key = SPEC_KEY.test(pointer) ? pointer : `mock:${id}`;
  let loaded = parsed.get(key);
  if (!loaded) {
    const text = key === pointer ? await kv.get(key, 'text') : pointer;
    if (text === null) return expired();
    try { loaded = load(key, text); } catch (error) { return answer(500, { error: `The stored description can't be read: ${error.message}` }); }
  }
  const { spec, routes } = loaded;
  const route = routes.find((r) => r.op.method === request.method && r.pattern.test(path));
  if (!route) {
    const sameAddress = routes.filter((r) => r.pattern.test(path)).map((r) => r.op.method);
    if (sameAddress.length) return answer(405, { error: `${request.method} is not described for ${path}.`, allowed: sameAddress }, { allow: sameAddress.join(', ') });
    return answer(404, { error: `${path} is not in this description.`, endpoints: routes.slice(0, 20).map((r) => `${r.op.method} ${r.op.path}`) });
  }
  const { op } = route;

  // Check the request the way the real API would: required query parameters, then the body.
  const url = new URL(request.url);
  const problems = op.query.filter((p) => p.required && !url.searchParams.has(p.name)).map((p) => ({ path: `query.${p.name}`, message: 'is required and missing' }));
  if (op.request?.schema && /json/i.test(op.request.contentType)) {
    const raw = await request.text();
    if (raw.trim()) {
      let body;
      try { body = JSON.parse(raw); } catch { return answer(400, { error: 'The body is not valid JSON.' }); }
      problems.push(...validate(body, op.request.schema, spec, { where: 'request' }).map((p) => ({ path: `body.${p.path}`, message: p.message })));
    } else if (spec.paths?.[op.path]?.[op.method.toLowerCase()]?.requestBody?.required) {
      problems.push({ path: 'body', message: 'is required and missing' });
    }
  }
  if (problems.length) return answer(422, { error: 'The request does not match the API description.', problems: problems.slice(0, 20) });

  const status = op.response?.status ?? (op.method === 'POST' ? 201 : 200);
  if (!op.response?.schema || status === 204 || request.method === 'HEAD') return answer(status === 200 && !op.response ? 204 : status);
  const example = exampleOf(spec, op);
  return answer(status, example !== undefined ? example : sampleOf(op.response.schema, spec, { where: 'response' }));
}
