// Parcel adapter: 2026-03-01 → 2026-09-01 (first draft, fails replay)
// Kept on purpose: this is the kind of confident mistake an AI writer makes.
// Replay catches two bugs before any customer sees them:
//   1. status 'succeeded' is never renamed back to 'paid'
//   2. created is returned in milliseconds instead of seconds

export default {
  from: '2026-03-01',
  to: '2026-09-01',
  changes: [
    "customer_name was renamed to full_name",
    "amount (dollars) and currency became total { amount_cents, currency }",
    "created (Unix seconds) became created_at (ISO 8601 text)",
    "GET /orders/{id}/label was removed; labels moved to the Labels API",
  ],

  upgradeRequest(req) {
    if (req.method === 'POST' && req.path === '/orders' && req.body) {
      const { customer_name, amount, currency, ...rest } = req.body;
      req.body = { ...rest, full_name: customer_name };
      req.body.total = { amount_cents: Math.round(amount * 100), currency: String(currency ?? 'usd').toUpperCase() };
    }
    return req;
  },

  downgradeResponse(res) {
    const body = res.body;
    if (body?.object === 'order') res.body = toOldOrder(body);
    if (body?.object === 'list') body.data = body.data.map(toOldOrder);
    return res;
  },

  untranslatable: [
    {
      method: 'GET',
      path: /^\/orders\/[^/]+\/label$/,
      reason: 'Shipping labels moved to the Labels API in 2026-09-01. This call needs a code change.',
      guide: 'https://docs.parcel.example/migrate/2026-09-01#labels',
    },
  ],
};

function toOldOrder({ full_name, total, created_at, ...rest }) {
  return {
    ...rest,
    customer_name: full_name,
    amount: total.amount_cents / 100,
    currency: total.currency.toLowerCase(),
    created: Date.parse(created_at),
  };
}
