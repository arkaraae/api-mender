// Acme Outdoor's checkout code, written in March 2026 against Parcel 2026-03-01.
// Acme never touches this file during the demo. Only Parcel changes.

import { API, V1 } from './parcel.js';

export class ParcelError extends Error {
  constructor(status, error) {
    super(`${status} ${error?.type ?? 'error'}: ${error?.message ?? 'Request failed'}`);
    this.name = 'ParcelError';
  }
}

export function parcelClient(handler, key) {
  const client = { lastHeaders: null };
  async function send(method, path, body) {
    const response = await handler(new Request(API + path, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        'parcel-version': V1,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    }));
    client.lastHeaders = response.headers;
    const data = await response.json();
    if (!response.ok) throw new ParcelError(response.status, data.error);
    return data;
  }
  client.get = (path) => send('GET', path);
  client.post = (path, body) => send('POST', path, body);
  return client;
}

// The two jobs Acme's app runs. Each one either prints a line or throws.
export const acmeJobs = [
  {
    name: 'Print last receipt',
    async run(parcel) {
      const past = await parcel.get('/orders/ord_1001');
      const placed = new Date(past.created * 1000).toDateString();
      return `${past.id} · ${past.customer_name} · $${past.amount.toFixed(2)} · ${past.status} · placed ${placed}`;
    },
  },
  {
    name: 'Create new order',
    async run(parcel) {
      const order = await parcel.post('/orders', {
        customer_name: 'Jonas Berg',
        amount: 25.5,
        currency: 'usd',
        items: [{ sku: 'TENT-2P', qty: 1 }],
      });
      return `${order.id} · ${order.customer_name} · $${order.amount.toFixed(2)} ${order.currency.toUpperCase()} · ${order.status}`;
    },
  },
];
