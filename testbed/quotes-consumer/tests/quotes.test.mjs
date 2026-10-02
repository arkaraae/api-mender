import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createQuote } from '../src/client.mjs';

const apiBaseUrl = process.env.MENDER_TEST_API_URL;
if (!apiBaseUrl) throw new Error('Set MENDER_TEST_API_URL to the Quotes API origin');

test('creates a quote using the deployed API contract', async () => {
  const quote = await createQuote(apiBaseUrl, 'acct_fixture_1', 2500);
  assert.equal(quote.amountCents, 2500);
  assert.equal(quote.identity, 'acct_fixture_1');
  assert.equal(typeof quote.id, 'string');
});
