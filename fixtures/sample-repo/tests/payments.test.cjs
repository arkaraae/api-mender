const { test } = require('node:test');
const { strict: assert } = require('node:assert');

test('creates a USD payment intent for a positive amount', async () => {
  const { createPaymentIntent } = await import('../src/payments.ts');
  let request;
  const result = await createPaymentIntent({ paymentIntents: { create: async value => {
    request = value;
    return { id: 'pi_test' };
  } } }, 2500);
  assert.equal(result.id, 'pi_test');
  assert.equal(request.amount, 2500);
  assert.equal(request.currency, 'usd');
});

test('rejects invalid amounts before calling Stripe', async () => {
  const { createPaymentIntent } = await import('../src/payments.ts');
  await assert.rejects(createPaymentIntent({ paymentIntents: { create: async () => { throw new Error('should not call'); } } }, -1), /Invalid amount/);
});
