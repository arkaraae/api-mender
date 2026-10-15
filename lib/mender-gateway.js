// Mender inside the API Mender site.
//
// When a published API version stops accepting what older callers send, the monitor proposes a
// code fix for each consumer. This is the other half: a gateway that keeps those consumers
// working in the meantime. It reads the published contracts, works out the rules between one
// version and the next, proves them, and translates old-style calls on the way through.
//
//   A caller on version 1 uses  /mender/v1/api/managed/quotes  instead of  /api/managed/quotes
//
// Everything here uses web-standard Request and Response only, so it runs wherever the site
// runs. No model is called: the rules come from comparing the two contracts.

import { withMender } from '../mender/src/mender.js';
import { changelog, compileRules, describeRule } from '../mender/src/rules.js';
import { proveWithSchemas, rulesFromOpenApi } from '../mender/src/openapi.js';
import { explainRules } from '../mender/src/infer.js';
import testbedV1 from '../mender/sandbox/quotes/openapi-v1.json';
import { routes as localRoutes } from './mender-local.js';

const TTL_MS = 60_000;
const FORWARDED = ['content-type', 'accept', 'authorization', 'x-consumer', 'idempotency-key'];

// The APIs this site publishes, and where each one keeps its contract.
export const APIS = {
  managed: {
    title: 'Managed Quote API',
    endpoint: '/api/managed/quotes',
    owns: (path) => path.startsWith('/api/managed/'),
    // Every published version keeps its own contract: ?version=1, ?version=2, …
    async contracts(origin, read) {
      const latest = await read(`${origin}/api/managed/openapi.json`);
      const newest = Number.parseInt(latest.info?.version, 10);
      if (!Number.isInteger(newest) || newest < 1 || newest > 50) throw new Error('The managed API did not report a usable version.');
      const older = await Promise.all(Array.from({ length: newest - 1 }, (_, i) => read(`${origin}/api/managed/openapi.json?version=${i + 1}`)));
      return [...older.map((spec, i) => ({ version: String(i + 1), spec })), { version: String(newest), spec: latest }];
    },
    probe: { method: 'POST', path: '/api/managed/quotes', body: { customerId: 'customer_1', sku: 'WIDGET-1' } },
  },
  testbed: {
    title: 'Quotes testbed',
    endpoint: '/api/testbed/quotes',
    owns: (path) => path.startsWith('/api/testbed/'),
    // The testbed only serves its active contract, so version 1 is the copy kept in the repository.
    async contracts(origin, read) {
      const live = await read(`${origin}/api/testbed/openapi.json`);
      const newest = Number.parseInt(live.info?.version, 10);
      if (!Number.isInteger(newest) || newest < 1) throw new Error('The testbed did not report a usable version.');
      return newest === 1 ? [{ version: '1', spec: live }] : [{ version: '1', spec: testbedV1 }, { version: String(newest), spec: live }];
    },
    probe: { method: 'POST', path: '/api/testbed/quotes', body: { customerId: 'acct_fixture_1', amountCents: 2500 } },
  },
};

export const apiFor = (path) => Object.keys(APIS).find((name) => APIS[name].owns(path)) ?? null;

// Where the real API lives. On the deployed site that is the site itself; set
// MENDER_UPSTREAM_URL to point a local copy at another server.
export function upstreamFor(request) {
  const configured = process.env.MENDER_UPSTREAM_URL;
  return (configured || new URL(request.url).origin).replace(/\/$/, '');
}

// The gateway reaches the API over HTTP. A host that does not let a site call itself can hand
// over the site's own handlers instead (see lib/mender-local.js): one function per path, each
// taking a standard Request and returning a Response. Pass null to take a path back out.
const inProcess = new Map();

export function serveInProcess(routes) {
  for (const [path, handler] of Object.entries(routes)) {
    if (typeof handler === 'function') inProcess.set(path, handler);
    else inProcess.delete(path);
  }
}

serveInProcess(localRoutes);

async function reach(url, init) {
  const handler = inProcess.get(new URL(url).pathname);
  return handler ? handler(new Request(url, init)) : fetch(url, { cache: 'no-store', ...init });
}

async function readJson(url) {
  const response = await reach(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`${new URL(url).pathname}${new URL(url).search} answered ${response.status}`);
  return response.json();
}

const cache = new Map();

// Reads an API's contracts and works out, for each step between versions, the rules and
// whether they prove out. Cached for a minute so a busy gateway does not re-read the contracts.
export async function describe(name, upstream) {
  const key = `${name}|${upstream}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const api = APIS[name];
  const contracts = await api.contracts(upstream, readJson);
  const steps = [];
  for (let i = 0; i + 1 < contracts.length; i++) {
    const before = contracts[i];
    const after = contracts[i + 1];
    const found = rulesFromOpenApi(before.spec, after.spec);
    const proof = proveWithSchemas(before.spec, after.spec, found.rules);
    steps.push({
      from: before.version,
      to: after.version,
      rules: found.rules,
      inWords: found.rules.map((rule) => describeRule(rule).replaceAll('`', '')),
      notes: found.notes.map((note) => note.message),
      proof: {
        ok: proof.ok,
        samples: proof.samples,
        failures: proof.checks.flatMap((check) => check.failures.slice(0, 3).map((f) => `${check.endpoint} ${f.where}: ${f.path} ${f.message}`)).slice(0, 10),
      },
      changelog: changelog({ from: before.version, to: after.version, rules: found.rules }),
    });
  }
  const value = {
    name,
    title: api.title,
    endpoint: api.endpoint,
    versions: contracts.map((c) => c.version),
    latest: contracts.at(-1).version,
    // The gateway only translates when every step is proven; otherwise it steps aside.
    proven: steps.every((step) => step.proof.ok),
    steps,
    checkedAt: new Date().toISOString(),
  };
  cache.set(key, { at: Date.now(), value });
  return value;
}

export const forget = () => cache.clear();

// ---------- who still calls an old version ----------

const calls = new Map();

function count(name, event) {
  const key = `${name}|${event.customer}|${event.version}|${event.method} ${event.path}|${event.outcome}`;
  const entry = calls.get(key) ?? { api: name, caller: event.customer, version: event.version, endpoint: `${event.method} ${event.path}`, outcome: event.outcome, calls: 0, lastAt: null };
  entry.calls += 1;
  entry.lastAt = new Date().toISOString();
  if (calls.size < 500 || calls.has(key)) calls.set(key, entry);
}

export const oldVersionCalls = () => [...calls.values()].sort((a, b) => b.calls - a.calls);

// ---------- the gateway ----------

const refuse = (status, type, message) => new Response(JSON.stringify({ error: { type, message } }), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'Mender-Status': type.replaceAll('_', '-') } });

async function forward(request) {
  const headers = new Headers();
  for (const name of FORWARDED) if (request.headers.get(name)) headers.set(name, request.headers.get(name));
  const bodyless = request.method === 'GET' || request.method === 'HEAD';
  try {
    return await reach(request.url, { method: request.method, headers, body: bodyless ? undefined : await request.arrayBuffer(), redirect: 'manual' });
  } catch (error) {
    return refuse(502, 'api_unreachable', `Mender could not reach the API (${error.cause?.code ?? error.message}).`);
  }
}

// Headers that describe the connection to the API rather than the answer itself.
const CONNECTION = ['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive'];

// The answer for the caller, marked with what Mender did.
function answerWith(response, status) {
  const headers = new Headers(response.headers);
  for (const name of CONNECTION) headers.delete(name);
  if (!headers.has('Mender-Status')) headers.set('Mender-Status', status);
  return new Response(response.body, { status: response.status, headers });
}

// Handles /mender/<version>/<path of the real API>.
export async function handle(request, version, segments) {
  const path = `/${segments.join('/')}`;
  const name = apiFor(path);
  if (!name) return refuse(404, 'not_found', 'Mender only fronts this site\'s published APIs: /api/managed/… and /api/testbed/…');
  const pinned = String(version).replace(/^v/i, '');
  if (!/^\d{1,3}$/.test(pinned)) return refuse(400, 'unknown_version', 'Use a version like v1 in the address: /mender/v1/api/managed/quotes');

  const upstream = upstreamFor(request);
  const target = new Request(`${upstream}${path}${new URL(request.url).search}`, {
    method: request.method,
    headers: request.headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer(),
  });

  let api;
  try { api = await describe(name, upstream); } catch (error) {
    return refuse(502, 'contract_unavailable', `Mender could not read the published contract: ${error.message}`);
  }
  // Without proven rules Mender changes nothing: the caller gets exactly what the API says.
  if (!api.proven) return answerWith(await forward(target), 'no-proven-adapter');
  let did = pinned === api.latest ? 'current-version' : api.versions.includes(pinned) ? 'passed-through' : 'unknown-version';
  const gateway = withMender(forward, {
    latest: api.latest,
    adapters: api.steps.map((step) => compileRules({ from: step.from, to: step.to, rules: step.rules })),
    version: () => pinned,
    identify: (incoming) => incoming.headers.get('x-consumer') || 'anonymous',
    onCall: (event) => { did = event.outcome.replaceAll('_', '-'); count(name, event); },
  });
  return answerWith(await gateway(target), did);
}

// ---------- a real check: the old-style request, with and without Mender ----------

export async function check(name, upstream, gatewayOrigin) {
  const { probe } = APIS[name];
  const init = () => ({ method: probe.method, headers: { 'content-type': 'application/json', 'x-consumer': 'mender-status-check' }, body: JSON.stringify(probe.body) });
  const timed = async (send) => {
    const started = Date.now();
    try {
      const response = await send();
      const text = await response.text();
      let body;
      try { body = JSON.parse(text); } catch { body = text.slice(0, 300); }
      return { status: response.status, ms: Date.now() - started, body };
    } catch (error) {
      return { status: 0, ms: Date.now() - started, body: String(error.message ?? error) };
    }
  };
  // The same request twice: once straight to the API, once through the gateway.
  const [direct, throughMender] = await Promise.all([
    timed(() => reach(`${upstream}${probe.path}`, { ...init(), signal: AbortSignal.timeout(15_000) })),
    timed(() => handle(new Request(`${gatewayOrigin}/mender/v1${probe.path}`, init()), 'v1', probe.path.split('/').filter(Boolean))),
  ]);
  return { request: probe, direct, throughMender, keptWorking: throughMender.status >= 200 && throughMender.status < 300 };
}

// ---------- rules on request: the engine behind POST /api/mender/explain ----------

export function explain(input) {
  if (input && typeof input === 'object' && input.oldSpec && input.newSpec) {
    const found = rulesFromOpenApi(input.oldSpec, input.newSpec);
    const proof = proveWithSchemas(input.oldSpec, input.newSpec, found.rules);
    return { from: 'specs', rules: found.rules, inWords: found.rules.map((rule) => describeRule(rule).replaceAll('`', '')), notes: found.notes.map((n) => n.message), operations: found.operations, proof: { ok: proof.ok, samples: proof.samples, checks: proof.checks.map((c) => ({ endpoint: c.endpoint, status: c.status, samples: c.samples, failures: c.failures.slice(0, 5) })) } };
  }
  if (input && typeof input === 'object' && Array.isArray(input.pairs)) {
    const found = explainRules(input.pairs);
    return { from: 'examples', rules: found.rules, inWords: found.rules.map((rule) => describeRule(rule).replaceAll('`', '')), notes: found.notes.map((n) => n.message) };
  }
  return null;
}
