// Parcel: a made-up shipping-orders API used to demo Mender.
// makeParcel(version) returns a fetch-style handler, (Request) => Promise<Response>,
// with its own in-memory store. 2026-03-01 is the code Parcel ran before the upgrade;
// 2026-09-01 replaced it.

export const V1 = '2026-03-01';
export const V2 = '2026-09-01';
export const API = 'https://api.parcel.example';

export const NAMES = [
  'Maya Chen', 'Omar Haddad', 'Lucía Romero', 'Kenji Watanabe', 'Amara Okafor', 'Ines Duarte',
  'Priya Nair', 'Tomás Silva', 'Hana Kim', 'Leo Novak', 'Zara Ahmed', 'Felix Braun',
];
const STATUSES = ['paid', 'paid', 'paid', 'pending', 'refunded', 'failed'];

// Orders every customer already has, stored in neutral form so both versions serve the same data.
function seed() {
  const start = Date.UTC(2026, 0, 3, 15, 0, 0) / 1000;
  return NAMES.map((name, i) => ({
    id: `ord_${1001 + i}`,
    name,
    cents: 1250 + ((i * 737) % 9000),
    status: STATUSES[i % STATUSES.length],
    created: start + i * 86400 + i * 1337,
    items: [{ sku: `SKU-${200 + i}`, qty: 1 + (i % 3) }],
  }));
}

const v1Order = (o) => ({
  id: o.id,
  object: 'order',
  customer_name: o.name,
  amount: o.cents / 100,
  currency: 'usd',
  status: o.status,
  created: o.created,
  items: o.items,
});

const v2Order = (o) => ({
  id: o.id,
  object: 'order',
  full_name: o.name,
  total: { amount_cents: o.cents, currency: 'USD' },
  status: o.status === 'paid' ? 'succeeded' : o.status,
  created_at: new Date(o.created * 1000).toISOString(),
  items: o.items,
});

function parseV1(body) {
  if (!body || typeof body.customer_name !== 'string') return fail("Missing required field 'customer_name'.", 'customer_name');
  if (typeof body.amount !== 'number' || body.amount <= 0) return fail("Field 'amount' must be a positive number of dollars.", 'amount');
  return { order: { name: body.customer_name, cents: Math.round(body.amount * 100), items: body.items ?? [] } };
}

const V2_FIELDS = ['full_name', 'total', 'items'];
const V2_HINTS = {
  customer_name: "Unknown field 'customer_name'. Did you mean 'full_name'?",
  amount: "Unknown field 'amount'. Send the price as 'total.amount_cents'.",
  currency: "Unknown field 'currency'. Send it as 'total.currency'.",
};

function parseV2(body) {
  const unknown = Object.keys(body ?? {}).find((k) => !V2_FIELDS.includes(k));
  if (unknown) return fail(V2_HINTS[unknown] ?? `Unknown field '${unknown}'.`, unknown);
  if (typeof body?.full_name !== 'string') return fail("Missing required field 'full_name'.", 'full_name');
  if (!Number.isInteger(body.total?.amount_cents) || body.total.amount_cents <= 0) {
    return fail("Field 'total.amount_cents' must be a positive integer.", 'total.amount_cents');
  }
  return { order: { name: body.full_name, cents: body.total.amount_cents, items: body.items ?? [] } };
}

function fail(message, param) {
  return { error: { message, param } };
}

function json(status, body, version) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'parcel-version': version },
  });
}

export function makeParcel(version) {
  const orders = new Map(seed().map((o) => [o.id, o]));
  const render = version === V1 ? v1Order : v2Order;

  return async function parcel(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    let match;

    if (request.method === 'POST' && path === '/orders') {
      const body = await request.json().catch(() => null);
      const parsed = version === V1 ? parseV1(body) : parseV2(body);
      if (parsed.error) return json(400, { error: { type: 'invalid_request', ...parsed.error } }, version);
      const order = {
        id: `ord_${Math.random().toString(36).slice(2, 10)}`,
        created: Math.floor(Date.now() / 1000),
        status: 'pending',
        ...parsed.order,
      };
      orders.set(order.id, order);
      return json(201, render(order), version);
    }

    if (request.method === 'GET' && path === '/orders') {
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 10, 1), 100);
      const all = [...orders.values()].sort((a, b) => a.created - b.created);
      return json(200, { object: 'list', data: all.slice(0, limit).map(render), has_more: all.length > limit }, version);
    }

    if (request.method === 'GET' && (match = path.match(/^\/orders\/([^/]+)\/label$/))) {
      if (version !== V1) {
        return json(404, { error: { type: 'not_found', message: 'Unknown endpoint. Shipping labels moved to the Labels API in 2026-09-01.' } }, version);
      }
      const order = orders.get(match[1]);
      if (!order) return json(404, { error: { type: 'not_found', message: `No order '${match[1]}'.` } }, version);
      return json(200, { object: 'label', order_id: order.id, carrier: 'UPS', url: `https://labels.parcel.example/${order.id}.pdf` }, version);
    }

    if (request.method === 'GET' && (match = path.match(/^\/orders\/([^/]+)$/))) {
      const order = orders.get(match[1]);
      if (!order) return json(404, { error: { type: 'not_found', message: `No order '${match[1]}'.` } }, version);
      return json(200, render(order), version);
    }

    return json(404, { error: { type: 'not_found', message: `Unknown endpoint ${request.method} ${path}.` } }, version);
  };
}
