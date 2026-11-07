// Tests for "Contact sales" (lib/mender/sales.js): what is accepted, what is saved, what is sent.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { notifySales, readSalesRequest, saveSalesRequest } from '../lib/mender/sales.js';
import { memoryD1 } from './d1.mjs';

const good = { name: '  Ada   Lovelace ', email: 'Ada@Example.com', company: 'Analytical Engines', apis: '6–20', message: 'We run 12 APIs.' };

test('a complete request is tidied and saved', async () => {
  const { request, robot } = readSalesRequest(good);
  assert.equal(robot, false);
  assert.deepEqual(request, { name: 'Ada Lovelace', email: 'ada@example.com', company: 'Analytical Engines', apis: '6–20', message: 'We run 12 APIs.' });
  const db = memoryD1();
  await saveSalesRequest(db, request, { now: Date.parse('2026-10-13T12:00:00Z') });
  assert.deepEqual(db.rows('SELECT created_at, email, apis FROM sales_requests'), [{ created_at: '2026-10-13T12:00:00.000Z', email: 'ada@example.com', apis: '6–20' }]);
});

test('missing or odd fields are named, one problem per field', () => {
  assert.deepEqual(readSalesRequest(null).problems.map((p) => p.field), ['name', 'email', 'company', 'apis']);
  assert.deepEqual(readSalesRequest({ ...good, email: 'not an email' }).problems.map((p) => p.field), ['email']);
  assert.deepEqual(readSalesRequest({ ...good, email: 'a@b' }).problems.map((p) => p.field), ['email']);
  assert.deepEqual(readSalesRequest({ ...good, apis: '1000' }).problems.map((p) => p.field), ['apis']);
  assert.deepEqual(readSalesRequest({ ...good, name: 42 }).problems.map((p) => p.field), ['name']);
  assert.equal(readSalesRequest({ ...good, message: 'x'.repeat(5000) }).request.message.length, 2000);
  assert.equal(readSalesRequest({ ...good, message: undefined }).request.message, '');
});

test('a filled hidden field marks a robot, and the team message works for Slack and Discord', async () => {
  assert.equal(readSalesRequest({ ...good, website: 'https://spam.example' }).robot, true);
  const sent = [];
  await notifySales('https://hooks.slack.com/services/x', readSalesRequest(good).request, async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return new Response('ok'); });
  assert.equal(sent[0].body.text, sent[0].body.content);
  assert.match(sent[0].body.text, /^New sales request: Ada Lovelace <ada@example.com> at Analytical Engines \(6–20 APIs\)\n> We run 12 APIs\.$/);
});
