import assert from 'node:assert/strict';
import { test } from 'node:test';
import { processBoundContractConsumers, processContractSources } from '../lib/contract-worker.ts';

const sourceHead = 'a'.repeat(40);
const consumerHead = 'b'.repeat(40);

function fakeDatabase(saved) {
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
  };
  return {
    from(table) {
      const result = { data: rows[table] ?? null, error: null };
      const builder = {
        select() { return this; }, eq() { return this; }, limit() { return this; },
        upsert(row) { saved.push({ table, row }); return this; },
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

test('outdated consumer scan does not create findings', async () => {
  const saved = [];
  const result = await processBoundContractConsumers(fakeDatabase(saved), {
    id: 'consumer-1', workspace_id: 'workspace-1', full_name: 'acme/checkout',
    target_sha: consumerHead,
  }, sourceHead, []);
  assert.deepEqual(result, { checked: 0, findings: 0 });
  assert.deepEqual(saved, []);
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
