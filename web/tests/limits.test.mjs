// Tests for the daily limits (lib/mender/limits.js) on a real SQLite database with the site's migrations.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { forgetOldCounts, spend } from '../lib/mender/limits.js';
import { memoryD1 } from './d1.mjs';

const from = (address) => new Request('https://apimender.com/api/mender/watch', { method: 'POST', headers: { 'cf-connecting-ip': address } });
const NOON = Date.parse('2026-10-13T12:00:00Z');
const limits = { watch: { visitor: 2, site: 3 }, mockBytes: { site: 100 } };

test('each visitor gets their own daily allowance, and the whole site has one too', async () => {
  const db = memoryD1();
  assert.equal(await spend(db, from('203.0.113.1'), 'watch', { now: NOON, limits }), null);
  assert.equal(await spend(db, from('203.0.113.1'), 'watch', { now: NOON, limits }), null);
  const mine = await spend(db, from('203.0.113.1'), 'watch', { now: NOON, limits });
  assert.equal(mine.status, 429);
  assert.match((await mine.json()).error, /^You have reached today's limit of 2 watches started/);
  assert.equal(mine.headers.get('retry-after'), String(12 * 60 * 60));
  // The third visitor is within their own allowance, but the site has now used 4 of 3.
  const site = await spend(db, from('198.51.100.7'), 'watch', { now: NOON, limits });
  assert.equal(site.status, 429);
  assert.match((await site.json()).error, /^API Mender has reached today's limit/);
});

test('counts start again the next day, and addresses are never stored', async () => {
  const db = memoryD1();
  for (let i = 0; i < 3; i += 1) await spend(db, from('203.0.113.1'), 'watch', { now: NOON, limits });
  assert.equal(await spend(db, from('203.0.113.1'), 'watch', { now: NOON + 86_400_000, limits }), null);
  const buckets = db.rows('SELECT day, bucket FROM daily_counts').map((row) => `${row.day} ${row.bucket}`);
  assert.ok(buckets.every((bucket) => !bucket.includes('203.0.113.1')));
  assert.equal(new Set(buckets.filter((b) => b.includes('watch:')).map((b) => b.split(':')[1])).size, 2, 'the same address is a different visitor each day');
  await forgetOldCounts(db, NOON + 3 * 86_400_000);
  assert.deepEqual(db.rows('SELECT DISTINCT day FROM daily_counts'), [{ day: '2026-10-14' }]);
});

test('a byte budget counts amounts, and with no database or a broken one nothing is refused', async () => {
  const db = memoryD1();
  assert.equal(await spend(db, from('203.0.113.1'), 'mockBytes', { amount: 60, now: NOON, limits }), null);
  assert.equal((await spend(db, from('203.0.113.1'), 'mockBytes', { amount: 60, now: NOON, limits })).status, 429);
  assert.equal(await spend(null, from('203.0.113.1'), 'watch', { now: NOON, limits }), null);
  const broken = { prepare: () => ({ bind: () => ({}) }), batch: async () => { throw new Error('no such table'); } };
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args);
  try { assert.equal(await spend(broken, from('203.0.113.1'), 'watch', { now: NOON, limits }), null); } finally { console.error = original; }
  assert.equal(errors.length, 1);
});
