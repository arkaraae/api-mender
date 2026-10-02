// Parcel adapter: 2026-03-01 → 2026-09-01 (final version, passes replay)
// Written by Claude from Parcel's two API specs, standing in for Mender's adapter writer.
// It runs on every call from a customer still pinned to 2026-03-01.

const OLD_STATUS = { succeeded: 'paid' };
const OLD_FIELD = { full_name: 'customer_name', 'total.amount_cents': 'amount', 'total.currency': 'currency' };

export default {
  from: '2026-03-01',
  to: '2026-09-01',
  changes: [
    "customer_name was renamed to full_name",
    "amount (dollars) and currency became total { amount_cents, currency }",
    "status 'paid' was renamed to 'succeeded'",
    "created (Unix seconds) became created_at (ISO 8601 text)",
    "GET /orders/{id}/label was removed; labels moved to the Labels API",
  ],

  // An old-style request on its way in, rewritten for the new version.
  upgradeRequest(req) {
    if (req.method === 'POST' && req.path === '/orders' && req.body) {
      const { customer_name, amount, currency, ...rest } = req.body;
      req.body = { ...rest };
      if (customer_name !== undefined) req.body.full_name = customer_name;
      if (amount !== undefined) {
        req.body.total = { amount_cents: Math.round(amount * 100), currency: String(currency ?? 'usd').toUpperCase() };
      }
    }
    return req;
  },

  // A new-style answer on its way out, rewritten into what the old caller expects.
  downgradeResponse(res) {
    const body = res.body;
    if (body?.object === 'order') res.body = toOldOrder(body);
    if (body?.object === 'list') body.data = body.data.map(toOldOrder);
    if (body?.error?.param in OLD_FIELD) {
      for (const [now, before] of Object.entries(OLD_FIELD)) {
        body.error.message = body.error.message.replaceAll(`'${now}'`, `'${before}'`);
      }
      body.error.param = OLD_FIELD[body.error.param];
    }
    return res;
  },

  // Calls no translation can save. Mender answers these with 410 Gone and a migration link.
  untranslatable: [
    {
      method: 'GET',
      path: /^\/orders\/[^/]+\/label$/,
      reason: 'Shipping labels moved to the Labels API in 2026-09-01. This call needs a code change.',
      guide: 'https://docs.parcel.example/migrate/2026-09-01#labels',
    },
  ],
};

function toOldOrder({ full_name, total, status, created_at, ...rest }) {
  return {
    ...rest,
    customer_name: full_name,
    amount: total.amount_cents / 100,
    currency: total.currency.toLowerCase(),
    status: OLD_STATUS[status] ?? status,
    created: Math.floor(Date.parse(created_at) / 1000),
  };
}
