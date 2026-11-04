import assert from 'node:assert/strict';
import { test } from 'node:test';
import { traceStaticDatabaseWrites } from '../lib/static-database-flow.ts';
import { extractCalls } from '../lib/public-scan.ts';

const direct = [
  'export async function sync(supabase) {',
  "  const response = await fetch('https://api.example.test/v1/orders');",
  '  const payload = await response.json();',
  "  await supabase.from('orders').insert({ external_id: payload.customerId, total: payload.total });",
  '}',
].join('\n');

test('pins a direct API response field to the Supabase write in the same function', () => {
  const flows = traceStaticDatabaseWrites('src/sync.ts', direct);
  assert.equal(flows.length, 1);
  assert.deepEqual(flows[0].databaseWrites.map(write => [write.responseField, write.table, write.column, write.writeLine]),
    [['customerId', 'orders', 'external_id', 4], ['total', 'orders', 'total', 4]]);
  assert.equal(flows[0].endpoint, 'GET /v1/orders');
  assert.equal(extractCalls('src/sync.ts', direct)[0].databaseWrites[0].evidence, 'direct-static-response-write');
});

test('does not infer flow across branches, helpers, aliases, or dynamic keys', () => {
  const variants = [
    direct.replace("  await supabase.from('orders').insert", "  if (payload) await supabase.from('orders').insert"),
    direct.replace('  const payload = await response.json();', '  const payload = await readResponse(response);'),
    direct.replace("'https://api.example.test/v1/orders'", 'url'),
    direct.replace("  await supabase.from('orders').insert", "  await writeToDatabase"),
    direct.replace("await fetch('https://api.example.test/v1/orders')", "await other(fetch('https://api.example.test/v1/orders'))"),
  ];
  for (const source of variants) assert.deepEqual(traceStaticDatabaseWrites('src/sync.ts', source), []);
  const dynamic = traceStaticDatabaseWrites('src/sync.ts', direct.replace('payload.customerId', 'payload[customerKey]'));
  assert.deepEqual(dynamic[0].databaseWrites.map(write => write.responseField), ['total']);
});
