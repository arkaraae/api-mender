import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createQuote } from '../src/client.mjs';

const apiBaseUrl = process.env.MENDER_TEST_API_URL;
if (!apiBaseUrl) throw new Error('MENDER_TEST_API_URL is required');

test('creates a quote from a product in the database', async () => {
  const quote = await createQuote(apiBaseUrl, 'customer_1', 'WIDGET-1');
  assert.equal(quote.sku, 'WIDGET-1');
  assert.ok(Number.isInteger(quote.amountCents) && quote.amountCents > 0);
  assert.equal(typeof quote.id, 'string');
  assert.ok(quote.contractVersion >= 1);
});
