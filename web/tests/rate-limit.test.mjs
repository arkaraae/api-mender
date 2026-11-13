import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clientAddress, limits, rateLimit } from '../lib/rate-limit.ts';

const db = answer => ({ calls: [], async rpc(name, args) { this.calls.push([name, args]); return typeof answer === 'function' ? answer() : answer; } });

test('over the limit answers 429 with Retry-After; within it, nothing', async () => {
  const within = db({ data: true, error: null });
  assert.equal(await rateLimit(within, limits.publicScan, 'user-1'), null);
  assert.deepEqual(within.calls[0], ['hit_rate_limit', { p_bucket: 'scan-public:user-1', p_limit: 20, p_window_seconds: 3600 }]);
  const over = await rateLimit(db({ data: false, error: null }), limits.publicScan, 'user-1');
  assert.equal(over.status, 429);
  assert.equal(over.headers.get('retry-after'), '3600');
});

test('a limiter outage never blocks requests', async () => {
  assert.equal(await rateLimit(db({ data: null, error: { message: 'down' } }), limits.publish, 'u'), null);
  assert.equal(await rateLimit(db(() => { throw new Error('network'); }), limits.publish, 'u'), null);
});

test('the caller address comes from Cloudflare', () => {
  assert.equal(clientAddress(new Request('https://x', { headers: { 'cf-connecting-ip': '203.0.113.9' } })), '203.0.113.9');
  assert.equal(clientAddress(new Request('https://x')), 'unknown');
});
