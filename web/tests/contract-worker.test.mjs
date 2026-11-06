import assert from 'node:assert/strict';
import { test } from 'node:test';
import { processBoundContractConsumers, processContractSources } from '../lib/contract-worker.ts';
import { extractCalls } from '../lib/public-scan.ts';

const sourceHead = 'a'.repeat(40);
const consumerHead = 'b'.repeat(40);

function fakeDatabase(saved, overrides = {}) {
  const rows = {
    api_contract_consumers: [{ source_id: 'source-1', workspace_id: 'workspace-1' }],
    api_contract_sources: { id: 'source-1', workspace_id: 'workspace-1',
      repository_id: 'provider-1', path: 'openapi.json', paused: false },
    monitored_repositories: { id: 'provider-1', workspace_id: 'workspace-1',
      full_name: 'acme/upstream-api', head_sha: sourceHead, target_sha: sourceHead, paused: false },
    api_contract_versions: { content_sha256: 'c'.repeat(64), document: {
      openapi: '3.0.3', servers: [{ url: 'https://api.example.test' }],
      paths: { '/quotes': { post: { requestBody: { content: {
        'application/json': { schema: { type: 'object', required: ['accountId', 'sku'] } },
      } } } } },
    } },
    source_snapshots: { id: 'snapshot-1' },
    ...overrides,
  };
  return {
    from(table) {
      const result = { data: rows[table] ?? null, error: null };
      const builder = {
        select() { return this; }, eq() { return this; }, limit() { return this; }, order() { return this; },
        upsert(row, options) { saved.push({ table, row, options, operation: 'upsert' }); return this; },
        update(row) { saved.push({ table, row, operation: 'update' }); return this; },
        single: async () => result,
        maybeSingle: async () => result,
        then(resolve, reject) { return Promise.resolve(result).then(resolve, reject); },
      };
      return builder;
    },
  };
}

test('consumer push checks a different repository against its pinned upstream contract', async () => {
  const saved = [];
  const consumer = { id: 'consumer-1', workspace_id: 'workspace-1',
    full_name: 'acme/checkout', target_sha: consumerHead };
  const calls = [{ file: 'src/quote.ts', line: 9, bodyLine: 12,
    symbol: 'fetch', endpoint: 'POST /quotes', origin: 'https://api.example.test',
    fields: ['customerId', 'sku'], fieldsComplete: true }];
  const result = await processBoundContractConsumers(fakeDatabase(saved), consumer, consumerHead, calls);
  assert.deepEqual(result, { checked: 1, findings: 1 });
  const finding = saved.find(item => item.table === 'findings')?.row;
  assert.equal(finding.repository_id, 'consumer-1');
  assert.equal(finding.base_sha, consumerHead);
  assert.deepEqual(finding.evidence.missing, ['accountId']);
  assert.equal(finding.evidence.contractUrl,
    `https://github.com/acme/upstream-api/blob/${sourceHead}/openapi.json`);
  assert.equal(finding.evidence.codeUrl,
    `https://github.com/acme/checkout/blob/${consumerHead}/src/quote.ts#L12`);
  assert.equal(finding.evidence.runtimeVerified, false);
});

test('a customer-declared database column is attached as possible impact, not runtime proof', async () => {
  const saved = [];
  const capturedAt = new Date().toISOString();
  const database = fakeDatabase(saved, {
    api_database_mappings: [{ endpoint: 'POST /quotes', request_field: 'accountId',
      schema_label: 'orders-prod', table_name: 'quotes', column_name: 'account_id' }],
    database_schema_snapshots: { id: 'schema-1', source: 'customer-attested',
      fingerprint: 'f'.repeat(64), captured_at: capturedAt,
      columns: [{ schema: 'public', table: 'quotes', column: 'account_id', notNull: true }] },
  });
  await processBoundContractConsumers(database, { id: 'consumer-1', workspace_id: 'workspace-1',
    full_name: 'acme/checkout', target_sha: consumerHead }, consumerHead,
  [{ file: 'src/quote.ts', line: 9, symbol: 'fetch', endpoint: 'POST /quotes',
    origin: 'https://api.example.test', fields: ['sku'], fieldsComplete: true }]);
  const impact = saved.find(item => item.table === 'findings').row.evidence.databaseImpact;
  assert.equal(impact.length, 1);
  assert.equal(impact[0].status, 'column-present');
  assert.equal(impact[0].notNull, true);
  assert.equal(impact[0].schemaFingerprint, 'f'.repeat(64));
  assert.equal(impact[0].runtimeVerified, false);
});

test('outdated consumer scan does not create findings', async () => {
  const saved = [];
  const result = await processBoundContractConsumers(fakeDatabase(saved), {
    id: 'consumer-1', workspace_id: 'workspace-1', full_name: 'acme/checkout',
    target_sha: consumerHead,
  }, sourceHead, []);
  assert.deepEqual(result, { checked: 0, findings: 0 });
  assert.deepEqual(saved, []);
});

test('repeat mismatch refreshes the finding to the latest scanned commit', async () => {
  const saved = [];
  const database = fakeDatabase(saved);
  const calls = [{ file: 'src/quote.ts', line: 9, bodyLine: 12,
    symbol: 'fetch', endpoint: 'POST /quotes', origin: 'https://api.example.test',
    fields: ['customerId', 'sku'], fieldsComplete: true }];
  for (const head of [consumerHead, 'd'.repeat(40)]) {
    await processBoundContractConsumers(database, {
      id: 'consumer-1', workspace_id: 'workspace-1', full_name: 'acme/checkout', target_sha: head,
    }, head, calls);
  }
  const findings = saved.filter(item => item.table === 'findings' && item.operation === 'upsert');
  assert.equal(findings.length, 2);
  assert.equal(findings[0].row.fingerprint, findings[1].row.fingerprint);
  assert.equal(findings[1].row.base_sha, 'd'.repeat(40));
  assert.ok(Date.parse(findings[1].row.updated_at) > 0);
  assert.equal(findings[1].options.ignoreDuplicates, true);
  assert.equal(findings[1].options.defaultToNull, false);
  assert.equal(saved.filter(item => item.table === 'findings' && item.operation === 'update').length, 2);
  assert.equal(Object.hasOwn(saved.find(item => item.table === 'findings' && item.operation === 'update').row, 'status'), false);
});

test('upstream push checks a separate connected consumer inventory', async () => {
  const saved = [];
  const document = {
    openapi: '3.0.3', servers: [{ url: 'https://api.example.test' }],
    paths: { '/quotes': { post: { requestBody: { content: {
      'application/json': { schema: { type: 'object', required: ['accountId', 'sku'] } },
    } } } } },
  };
  const encoded = Buffer.from(JSON.stringify(document));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    type: 'file', encoding: 'base64', size: encoded.length, content: encoded.toString('base64'),
  }), { status: 200 });
  const rows = {
    api_contract_sources: [{ id: 'source-1', workspace_id: 'workspace-1', path: 'openapi.json' }],
    api_contract_versions: [],
    api_contract_consumers: [{ repository_id: 'consumer-1', workspace_id: 'workspace-1' }],
    monitored_repositories: [{ id: 'consumer-1', workspace_id: 'workspace-1',
      full_name: 'acme/checkout', head_sha: consumerHead, target_sha: consumerHead, paused: false,
      call_sites: [{ file: 'src/quote.ts', line: 9, bodyLine: 12, symbol: 'fetch',
        endpoint: 'POST /quotes', origin: 'https://api.example.test',
        fields: ['customerId', 'sku'], fieldsComplete: true }] }],
    source_snapshots: { id: 'snapshot-1' },
  };
  const database = { from(table) {
    let result = { data: rows[table], error: null };
    return {
      select() { return this; }, eq() { return this; }, limit() { return this; },
      order() { return this; }, in() { return this; },
      upsert(row) { saved.push({ table, row }); result = { data: null, error: null }; return this; },
      update(row) { saved.push({ table, row }); result = { data: null, error: null }; return this; },
      single: async () => table === 'source_snapshots' ? { data: rows.source_snapshots, error: null } : result,
      then(resolve, reject) { return Promise.resolve(result).then(resolve, reject); },
    };
  } };
  try {
    const result = await processContractSources(database, {
      id: 'provider-1', workspace_id: 'workspace-1', full_name: 'acme/upstream-api',
      target_sha: sourceHead,
    }, sourceHead, 'installation-token', []);
    assert.deepEqual(result, { checked: 1, changed: 0 });
    const finding = saved.find(item => item.table === 'findings')?.row;
    assert.equal(finding.repository_id, 'consumer-1');
    assert.deepEqual(finding.evidence.missing, ['accountId']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('changed response field links to a pinned direct database write candidate', async () => {
  const before = { openapi: '3.0.3', servers: [{ url: 'https://api.example.test' }],
    paths: { '/orders': { get: { responses: { 200: { description: 'ok', content: {
      'application/json': { schema: { type: 'object', required: ['customerId'],
        properties: { customerId: { type: 'string' } } } },
    } } } } } } };
  const after = structuredClone(before);
  after.paths['/orders'].get.responses[200].content['application/json'].schema = {
    type: 'object', required: ['accountId'], properties: { accountId: { type: 'string' } },
  };
  const source = [
    'export async function sync(supabase) {',
    "  const response = await fetch('https://api.example.test/orders');",
    '  const payload = await response.json();',
    "  await supabase.from('orders').insert({ external_id: payload.customerId });",
    '}',
  ].join('\n');
  const calls = extractCalls('src/sync.ts', source);
  const saved = [];
  const encoded = Buffer.from(JSON.stringify(after));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ type: 'file', encoding: 'base64',
    size: encoded.length, content: encoded.toString('base64') });
  const rows = {
    api_contract_sources: [{ id: 'source-1', workspace_id: 'workspace-1', path: 'openapi.json' }],
    api_contract_versions: [{ head_sha: 'd'.repeat(40), content_sha256: 'c'.repeat(64), document: before }],
    api_contract_consumers: [],
    monitored_repositories: [{ id: 'consumer-1', full_name: 'acme/checkout',
      head_sha: consumerHead, target_sha: consumerHead, call_sites: calls }],
    source_snapshots: { id: 'snapshot-1' },
  };
  const database = { from(table) {
    let result = { data: rows[table], error: null };
    return { select() { return this; }, eq() { return this; }, limit() { return this; },
      order() { return this; }, in() { return this; },
      upsert(row) { saved.push({ table, row }); result = { data: null, error: null }; return this; },
      update(row) { saved.push({ table, row }); result = { data: null, error: null }; return this; },
      single: async () => table === 'source_snapshots' ? { data: rows.source_snapshots, error: null } : result,
      then(resolve) { return Promise.resolve(result).then(resolve); },
    };
  } };
  try {
    const result = await processContractSources(database, { id: 'provider-1',
      workspace_id: 'workspace-1', full_name: 'acme/api', target_sha: sourceHead },
    sourceHead, 'installation-token', []);
    assert.equal(result.changed, 1);
    const finding = saved.find(item => item.table === 'findings').row;
    const write = finding.evidence.consumerCandidates[0].databaseWrites[0];
    assert.equal(write.responseField, 'customerId');
    assert.equal(write.column, 'external_id');
    assert.equal(write.writeLine, 4);
    assert.equal(write.sourceUrl,
      `https://github.com/acme/checkout/blob/${consumerHead}/src/sync.ts#L4`);
    assert.match(finding.description, /runtime behavior are not yet verified/);
  } finally { globalThis.fetch = originalFetch; }
});
