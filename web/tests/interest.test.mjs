import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readInterestRequest, saveInterestRequest } from '../lib/mender/interest.js';

test('name and email alone are enough, and the server sends a normalized contact to Supabase', async () => {
  const first = readInterestRequest({ name: '  Ada   Lovelace ', email: 'Ada@Example.com', interest: 'feedback', message: 'Great demo.' });
  assert.deepEqual(first.request, { name: 'Ada Lovelace', email: 'ada@example.com', interest: 'feedback', message: 'Great demo.' });
  let received;
  await saveInterestRequest({ rpc: async (name, args) => { received = { name, args }; return { error: null }; } }, first.request);
  assert.deepEqual(received, { name: 'save_interest_contact', args: { p_name: 'Ada Lovelace', p_email: 'ada@example.com', p_interest: 'feedback', p_message: 'Great demo.' } });
  await assert.rejects(saveInterestRequest({ rpc: async () => ({ error: new Error('database unavailable') }) }, first.request), /database unavailable/);
});

test('bad contact details are refused and a hidden spam field is detected', () => {
  assert.deepEqual(readInterestRequest({}).problems.map((problem) => problem.field), ['name', 'email']);
  assert.deepEqual(readInterestRequest({ name: 'Ada', email: 'not-an-email' }).problems.map((problem) => problem.field), ['email']);
  assert.deepEqual(readInterestRequest({ name: 'Ada', email: 'ada@example.com', interest: 'unknown' }).problems.map((problem) => problem.field), ['interest']);
  assert.equal(readInterestRequest({ name: 'Ada', email: 'ada@example.com', website: 'spam' }).robot, true);
});
