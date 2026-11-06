import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectRepairField } from '../lib/anthropic-repair.ts';

const input = { apiKey: 'private-test-key', endpoint: 'POST /api/managed/quotes',
  missingField: 'accountId', candidates: ['customerId', 'metadata'] };

test('provider receives field names only and a high-confidence candidate is accepted', async () => {
  let sent;
  const oldField = await selectRepairField({ ...input, fetcher: async (url, init) => {
    sent = { url, init };
    return Response.json({ stop_reason: 'end_turn', content: [
      { type: 'text', text: JSON.stringify({ oldField: 'customerId', confidence: 'high' }) },
    ] });
  } });
  assert.equal(oldField, 'customerId');
  assert.equal(sent.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(sent.init.redirect, 'manual');
  assert.deepEqual(JSON.parse(sent.init.body).messages[0].content,
    JSON.stringify({ endpoint: input.endpoint, newRequiredField: 'accountId',
      oldCandidateFields: ['customerId', 'metadata'] }));
});

test('provider cannot choose an unapproved field or uncertain mapping', async () => {
  for (const answer of [
    { oldField: 'password', confidence: 'high' },
    { oldField: 'customerId', confidence: 'uncertain' },
  ]) {
    await assert.rejects(selectRepairField({ ...input, fetcher: async () => Response.json({
      stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(answer) }],
    }) }), /could not select/);
  }
});

test('provider errors do not expose credentials', async () => {
  await assert.rejects(selectRepairField({ ...input, fetcher: async () =>
    new Response('private-test-key leaked', { status: 401 }) }), error =>
    !error.message.includes(input.apiKey));
});
