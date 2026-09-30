// Sample traffic: 200 calls from Parcel customers still pinned to 2026-03-01.
// Generated from a fixed seed so every run of the demo replays the same calls.

import { NAMES, V1 } from './parcel.js';

export const CUSTOMERS = [
  { id: 'acme', name: 'Acme Outdoor', key: 'sk_live_acme_4f2a', share: 0.45 },
  { id: 'bloom', name: 'Bloom & Stem', key: 'sk_live_bloom_91c0', share: 0.35 },
  { id: 'northwind', name: 'Northwind Tea', key: 'sk_live_northwind_07be', share: 0.2 },
];

export const customerFromKey = (key) => CUSTOMERS.find((c) => key?.endsWith(c.key)) ?? { id: 'unknown', name: 'Unknown' };

function random(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PRICES = [9.99, 12.5, 18, 19.99, 24.95, 42, 57.3, 88.88, 120, 249.99];
const SKUS = ['TENT-2P', 'MUG-ENAMEL', 'ROSE-DOZEN', 'TEA-SENCHA', 'LAMP-BRASS', 'SOCK-WOOL'];

export function sampleCalls(count = 200, seed = 7) {
  const next = random(seed);
  const pick = (list) => list[Math.floor(next() * list.length)];
  const calls = [];
  for (let i = 0; i < count; i++) {
    const roll = next();
    const customer = roll < 0.45 ? CUSTOMERS[0] : roll < 0.8 ? CUSTOMERS[1] : CUSTOMERS[2];
    const base = { customer: customer.id, key: customer.key, version: V1 };
    const order = `ord_${1001 + Math.floor(next() * NAMES.length)}`;
    const kind = next();
    if (i % 50 === 49) {
      calls.push({ ...base, customer: 'northwind', key: CUSTOMERS[2].key, method: 'GET', path: `/orders/${order}/label`, route: '/orders/{id}/label' });
    } else if (kind < 0.45) {
      calls.push({
        ...base,
        method: 'POST',
        path: '/orders',
        route: '/orders',
        body: { customer_name: pick(NAMES), amount: pick(PRICES), currency: 'usd', items: [{ sku: pick(SKUS), qty: 1 + Math.floor(next() * 3) }] },
      });
    } else if (kind < 0.9) {
      calls.push({ ...base, method: 'GET', path: `/orders/${order}`, route: '/orders/{id}' });
    } else {
      calls.push({ ...base, method: 'GET', path: `/orders?limit=${3 + Math.floor(next() * 6)}`, route: '/orders' });
    }
  }
  return calls;
}
