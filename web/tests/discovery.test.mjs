import assert from 'node:assert/strict';
import { test } from 'node:test';
import { autoProvider, chooseContract, guruCandidates, isPublicApiOrigin, normalizeOpenApi, registrableDomain, wellKnownUrls } from '../lib/engine/discovery.ts';
import { baselineSlices, diffSnapshotAgainstSlices } from '../lib/engine/provider-sync.ts';
import { apiHostsFrom } from '../lib/api-hosts.ts';
import { processProviderFindings } from '../lib/provider-findings.ts';
import { parseApiCalls } from '../lib/engine/inventory.ts';

const ORIGIN = 'https://api.zoom.us';
// A Swagger 2.0 description in the shape APIs.guru serves for older APIs.
const zoom = (bodyProperties, extraPaths = {}) => ({
  swagger: '2.0', info: { title: 'Zoom API', version: '2.0.0' }, host: 'api.zoom.us', basePath: '/v2', schemes: ['https'],
  paths: {
    '/users/{userId}/meetings': { post: { operationId: 'meetingCreate', parameters: [
      { name: 'userId', in: 'path', required: true, type: 'string' },
      { name: 'body', in: 'body', required: true, schema: { $ref: '#/definitions/Meeting' } }], responses: { 201: { description: 'ok' } } } },
    '/users/me': { get: { responses: { 200: { description: 'ok' } } } },
    ...extraPaths,
  },
  definitions: { Meeting: { type: 'object', properties: bodyProperties } },
});
const before = zoom({ topic: { type: 'string' }, type: { type: 'integer' }, host_video: { type: 'boolean' } });
const after = zoom({ topic: { type: 'string' }, type: { type: 'integer' } });

test('only public https DNS names are ever looked up', () => {
  assert.ok(isPublicApiOrigin('https://api.zoom.us'));
  for (const origin of ['http://api.zoom.us', 'https://10.0.0.5', 'https://localhost', 'https://api.internal', 'https://svc.corp',
    'https://api.zoom.us:8443', 'https://intranet', 'https://api.example', 'https://user:pw@api.zoom.us', 'https://API.zoom.us/x']) {
    assert.ok(!isPublicApiOrigin(origin), origin);
  }
  assert.equal(registrableDomain('api.eu.zoom.us'), 'zoom.us');
  assert.equal(registrableDomain('api.service.co.uk'), 'service.co.uk');
});

test('the APIs.guru directory is searched by host and provider domain', () => {
  const list = {
    'zoom.us': { preferred: '2.0.0', versions: { '2.0.0': { swaggerUrl: 'https://api.apis.guru/v2/specs/zoom.us/2.0.0/swagger.json', info: { title: 'Zoom API' } } } },
    'googleapis.com:drive': { preferred: 'v3', versions: { v3: { swaggerUrl: 'https://api.apis.guru/v2/specs/googleapis.com/drive/v3/openapi.json' } } },
    'evil.zoom.us.attacker.com': { preferred: '1', versions: { 1: { swaggerUrl: 'https://api.apis.guru/x.json' } } },
    'zoom.us:bad': { preferred: '1', versions: { 1: { swaggerUrl: 'https://evil.example/x.json' } } },
  };
  assert.deepEqual(guruCandidates(list, ORIGIN).map(item => item.url), ['https://api.apis.guru/v2/specs/zoom.us/2.0.0/swagger.json']);
  assert.deepEqual(guruCandidates(list, 'https://www.googleapis.com').map(item => item.name), ['googleapis.com:drive']);
  assert.equal(wellKnownUrls(ORIGIN)[0].url, 'https://api.zoom.us/openapi.json');
});

test('Swagger 2 descriptions become OpenAPI 3 request bodies', () => {
  const normalized = normalizeOpenApi(before);
  assert.equal(normalized.openapi, '3.0.0');
  assert.deepEqual(normalized.servers, [{ url: 'https://api.zoom.us/v2' }]);
  const body = normalized.paths['/users/{userId}/meetings'].post.requestBody;
  assert.equal(body.content['application/json'].schema.$ref, '#/components/schemas/Meeting');
  assert.deepEqual(Object.keys(normalized.components.schemas.Meeting.properties), ['topic', 'type', 'host_video']);
});

test('the description that matches the called endpoints is chosen, and one must match', () => {
  const endpoints = ['POST /v2/users/{}/meetings', 'GET /v2/users/me'];
  const other = { openapi: '3.0.0', info: { title: 'Other' }, servers: [{ url: 'https://api.zoom.us/v2' }], paths: { '/webinars': { get: { responses: {} } } } };
  const elsewhere = { ...normalizeOpenApi(before), servers: [{ url: 'https://api.otherhost.com/v2' }] };
  const chosen = chooseContract(ORIGIN, endpoints, [
    { candidate: { url: 'https://api.zoom.us/openapi.json', source: 'well-known' }, document: other },
    { candidate: { url: 'https://api.apis.guru/zoom.json', source: 'apis.guru', name: 'Zoom API' }, document: before },
    { candidate: { url: 'https://api.apis.guru/elsewhere.json', source: 'apis.guru' }, document: elsewhere },
  ]);
  assert.equal(chosen.url, 'https://api.apis.guru/zoom.json');
  assert.equal(chosen.basePath, '/v2');
  assert.equal(chosen.matched, 2);
  assert.equal(chooseContract(ORIGIN, ['DELETE /nothing'], [{ candidate: { url: 'u', source: 'well-known' }, document: before }]), null);
});

test('scans queue every non-built-in public API with a sample of its endpoints', () => {
  const calls = parseApiCalls('src/zoom.ts', "export const m = (id, t) => fetch(`https://api.zoom.us/v2/users/${id}/meetings`, { method: 'POST', body: JSON.stringify({ topic: t, host_video: true }) });\n"
    + "export const g = () => fetch('https://api.github.com/meta');\nexport const i = () => fetch('https://api.internal/x');\n");
  assert.deepEqual(apiHostsFrom(calls), [{ origin: ORIGIN, endpoints: ['POST /v2/users/{}/meetings'] }]);
});

function fakeDatabase(tables) {
  return { tables, from(table) {
    const filters = [];
    let operation = 'select';
    let payload;
    let options;
    const rows = () => (tables[table] ??= []).filter(row => filters.every(test => test(row)));
    const builder = {
      select() { return builder; }, order() { return builder; }, limit() { return builder; },
      eq(column, value) { filters.push(row => row[column] === value); return builder; },
      in(column, values) { filters.push(row => values.includes(row[column])); return builder; },
      upsert(row, opts) { operation = 'upsert'; payload = row; options = opts; return builder; },
      update(row) { operation = 'update'; payload = row; return builder; },
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      then(resolve, reject) {
        const list = (tables[table] ??= []);
        if (operation === 'upsert') {
          if (!(options?.ignoreDuplicates && list.some(row => row.fingerprint === payload.fingerprint))) list.push({ ...payload });
        }
        if (operation === 'update') for (const row of rows()) Object.assign(row, payload);
        return Promise.resolve({ data: operation === 'select' ? rows() : null, error: null }).then(resolve, reject);
      },
    };
    return builder;
  } };
}

test('a change to a discovered API becomes an evidence-backed finding on the calling code', async () => {
  const row = { origin: ORIGIN, provider_id: 'auto:api.zoom.us', name: 'Zoom API', base_path: '/v2', spec_url: 'https://api.apis.guru/zoom.json' };
  const provider = autoProvider(row);
  const baseline = await baselineSlices(provider, '2026-11-11', normalizeOpenApi(before), row.spec_url);
  assert.deepEqual(baseline.keys, ['POST /users/{userId}/meetings', 'GET /users/me']);
  const delta = await diffSnapshotAgainstSlices({ provider, baseline: baseline.slices, baselineKeys: baseline.keys, toVersion: '2026-11-20',
    newDocument: normalizeOpenApi(after), newSha256: 'b'.repeat(64), sourceUrl: row.spec_url });
  assert.deepEqual(delta.changes.map(change => [change.kind, change.operation, change.fields]), [['request-property-removed', 'POST /users/{userId}/meetings', ['host_video']]]);
  assert.deepEqual(delta.slices.map(slice => slice.operation), ['POST /users/{userId}/meetings']);

  const toRows = (version, slices) => slices.map(slice => ({ provider_id: slice.providerId, version, operation: slice.operation, sha256: slice.sha256, document: slice.document, source_url: slice.sourceUrl }));
  const head = 'c'.repeat(40);
  const database = fakeDatabase({
    api_hosts: [{ ...row, status: 'watching' }],
    provider_contract_versions: [
      { provider_id: row.provider_id, version: '2026-11-11', operation_keys: baseline.keys, source_url: row.spec_url },
      { provider_id: row.provider_id, version: '2026-11-20', operation_keys: delta.version.operationKeys, source_url: row.spec_url }],
    provider_contract_slices: [...toRows('2026-11-11', baseline.slices), ...toRows('2026-11-20', delta.slices)],
    findings: [],
  });
  const calls = parseApiCalls('src/zoom.ts', "export const m = (id, t) => fetch(`https://api.zoom.us/v2/users/${id}/meetings`, {\n  method: 'POST',\n  body: JSON.stringify({ topic: t, host_video: true }),\n});\n");
  const repository = { id: 'r1', workspace_id: 'w1', full_name: 'acme/app', target_sha: head };
  assert.deepEqual(await processProviderFindings(database, repository, head, calls), { findings: 1 });
  const [finding] = database.tables.findings;
  assert.match(finding.title, /`host_video` removed from POST \/users\/\{userId\}\/meetings \(Zoom API 2026-11-20\)/);
  assert.equal(finding.evidence.finding.provider.id, 'auto:api.zoom.us');
  assert.equal(finding.evidence.finding.evidence.applicability, 'active');
  assert.equal(finding.evidence.finding.repairable, true);
  // The same API, not yet watched: nothing is claimed.
  database.tables.api_hosts[0].status = 'pending';
  database.tables.findings = [];
  assert.deepEqual(await processProviderFindings(database, repository, head, calls), { findings: 0 });
});
