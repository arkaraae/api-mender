import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readInterestRequest, saveInterestRequest } from '../lib/mender/interest.js';
import { memoryD1 } from './d1.mjs';

test('name and email alone are enough, and a repeat signup keeps one contact', async () => {
  const first = readInterestRequest({ name: '  Ada   Lovelace ', email: 'Ada@Example.com', interest: 'feedback', message: 'Great demo.' });
  assert.deepEqual(first.request, { name: 'Ada Lovelace', email: 'ada@example.com', interest: 'feedback', message: 'Great demo.' });
  const db = memoryD1();
  await saveInterestRequest(db, first.request, { now: Date.parse('2026-10-19T12:00:00Z') });
  const second = readInterestRequest({ name: 'Ada', email: 'ada@example.com' });
  await saveInterestRequest(db, second.request, { now: Date.parse('2026-10-20T12:00:00Z') });
  assert.deepEqual(db.rows('SELECT name, email, interest, message FROM interest_contacts'), [
    { name: 'Ada', email: 'ada@example.com', interest: 'feedback', message: 'Great demo.' },
  ]);
});

test('bad contact details are refused and a hidden spam field is detected', () => {
  assert.deepEqual(readInterestRequest({}).problems.map((problem) => problem.field), ['name', 'email']);
  assert.deepEqual(readInterestRequest({ name: 'Ada', email: 'not-an-email' }).problems.map((problem) => problem.field), ['email']);
  assert.deepEqual(readInterestRequest({ name: 'Ada', email: 'ada@example.com', interest: 'unknown' }).problems.map((problem) => problem.field), ['interest']);
  assert.equal(readInterestRequest({ name: 'Ada', email: 'ada@example.com', website: 'spam' }).robot, true);
});
