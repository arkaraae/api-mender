// Edge cases for finding rules from examples: weak evidence, ambiguity, noise, lists, and
// examples that contradict each other. The finder must either prove a rule or say it can't.

import { explainRules, inferRules, likeness } from '../src/infer.js';
import { verifyRules } from '../src/rules.js';
import { assert, same } from './helpers.js';

const explain = (...pairs) => explainRules(pairs);
const has = (result, op, before, after) => result.rules.some((r) => r.op === op && (before === undefined || r.old === before) && (after === undefined || r.new === after));
const noted = (result, code, path) => result.notes.some((n) => n.code === code && (path === undefined || n.path === path));
const failures = (rules, pairs) => verifyRules(rules, pairs).flatMap((r) => [...r.upDiffs, ...r.downDiffs]);
const proven = (result, pairs) => {
  const bad = failures(result.rules, pairs);
  assert(bad.length === 0, `rules do not prove out: ${JSON.stringify(bad.slice(0, 3))} with ${JSON.stringify(result.rules)}`);
};

export const evidence = [
  ['Identical records need no rules and raise no notes', () => {
    const record = { id: 1, name: 'Ann', tags: ['a'], nested: { x: null }, items: [{ sku: 'a' }] };
    same(explain({ old: record, new: structuredClone(record) }), { rules: [], notes: [] });
    same(explainRules([]), { rules: [], notes: [] });
  }],

  ['A plain rename and a move into an object are found from one example', () => {
    const pair = { old: { id: 1, customer_name: 'Maya Chen', city: 'Lima' }, new: { id: 1, full_name: 'Maya Chen', address: { city: 'Lima' } } };
    const result = explain(pair);
    assert(has(result, 'rename', 'customer_name', 'full_name') && has(result, 'rename', 'city', 'address.city'), JSON.stringify(result.rules));
    proven(result, [pair]);
  }],

  ['Two unrelated fields that both happen to be true are not called a rename', () => {
    const result = explain({ old: { id: 1, is_trial: true }, new: { id: 1, archived: true } });
    assert(!has(result, 'rename'), 'guessed a rename from a shared true');
    assert(has(result, 'remove', 'is_trial') && has(result, 'add', undefined, 'archived'), JSON.stringify(result.rules));
  }],

  ['The same weak value is accepted as a rename when the names are related', () => {
    const result = explain({ old: { is_active: true, qty: 1 }, new: { active: true, quantity: 1 } });
    assert(has(result, 'rename', 'is_active', 'active') && has(result, 'rename', 'qty', 'quantity'), JSON.stringify(result.rules));
  }],

  ['When two fields hold the same value, each goes to the name it resembles', () => {
    const pair = { old: { billing_name: 'Ann Lee', shipping_name: 'Ann Lee' }, new: { ship_to_name: 'Ann Lee', bill_to_name: 'Ann Lee' } };
    const result = explain(pair);
    assert(has(result, 'rename', 'billing_name', 'bill_to_name') && has(result, 'rename', 'shipping_name', 'ship_to_name'), JSON.stringify(result.rules));
  }],

  ['A real tie is reported as ambiguous instead of being hidden', () => {
    const result = explain({ old: { code: 'ALPHA-1', other: 'ALPHA-1' }, new: { first: 'ALPHA-1', second: 'ALPHA-1' } });
    assert(noted(result, 'ambiguous'), `no ambiguity note: ${JSON.stringify(result)}`);
  }],

  ['A second example settles what one example could not', () => {
    const one = { old: { a_code: 'X1', b_code: 'X1' }, new: { first: 'X1', second: 'X1' } };
    const two = { old: { a_code: 'AA11', b_code: 'BB22' }, new: { first: 'AA11', second: 'BB22' } };
    assert(!has(explain(one), 'rename'), 'renamed on weak evidence');
    const result = explain(one, two);
    assert(has(result, 'rename', 'a_code', 'first') && has(result, 'rename', 'b_code', 'second'), JSON.stringify(result.rules));
    proven(result, [one, two]);
  }],

  ['A field that is only sometimes present can still be renamed', () => {
    const pairs = [{ old: { id: 1, nickname: 'Annie' }, new: { id: 1, alias: 'Annie' } }, { old: { id: 2 }, new: { id: 2 } }];
    const result = explainRules(pairs);
    assert(has(result, 'rename', 'nickname', 'alias'), JSON.stringify(result.rules));
    proven(result, pairs);
  }],

  ['Names are compared by shared words and abbreviations', () => {
    assert(likeness('qty', 'quantity') > 0 && likeness('amt', 'amount') > 0 && likeness('billing_name', 'bill_to_name') > likeness('billing_name', 'ship_to_name'), 'abbreviations are not recognised');
    assert(likeness('customerId', 'customer_id') >= 2 && likeness('currency', 'total.currency') >= 3, 'shared words are not counted');
    assert(likeness('note', 'memo') === 0 && likeness('is_trial', 'archived') === 0, 'unrelated names scored');
  }],
];

export const kinds = [
  ['Unit changes are found: ×100, ×1000, ÷100, and money written as text', () => {
    const pair = {
      old: { amount: 12.5, duration_s: 1.5, price_cents: 1999, fee: '12.50' },
      new: { amount_cents: 1250, duration_ms: 1500, price: 19.99, fee_cents: 1250 },
    };
    const result = explain(pair);
    const factor = (before) => result.rules.find((r) => r.op === 'scale' && r.old === before)?.factor;
    same([factor('amount'), factor('duration_s'), factor('price_cents'), factor('fee')], [100, 1000, 0.01, 100], JSON.stringify(result.rules));
    proven(result, [pair]);
    same(verifyRules(result.rules, [pair])[0].down.fee, '12.50');
  }],

  ['Time format changes are found in every direction', () => {
    const pair = {
      old: { created: 1767452400, ts: 1767452400123, updated: '2026-01-03T15:00:00Z', seen: '1767452400', at: 1767452400 },
      new: { created_at: '2026-01-03T15:00:00Z', ts: '2026-01-03T15:00:00.123Z', updated_ms: 1767452400000, seen_at: '2026-01-03T15:00:00Z', at: 1767452400000 },
    };
    const result = explain(pair);
    const rule = (before) => result.rules.find((r) => r.old === before);
    same([rule('created')?.op, rule('ts')?.op, rule('updated')?.op, rule('seen')?.op, rule('at')?.op], ['time', 'time', 'time', 'time', 'time'], JSON.stringify(result.rules));
    same([rule('created').newFormat, rule('ts').newFormat, rule('updated').newFormat, rule('seen').oldType, rule('at').newFormat], ['iso8601', 'iso8601_ms', 'unix_ms', 'string', 'unix_ms']);
    proven(result, [pair]);
  }],

  ['A number that became text, and true/false that became text, are found', () => {
    const pair = { old: { id: 42, order_id: 1001, live: true }, new: { id: '42', orderId: '1001', live: 'true' } };
    const result = explain(pair);
    assert(has(result, 'type', 'id', 'id') && has(result, 'type', 'order_id', 'orderId') && has(result, 'type', 'live', 'live'), JSON.stringify(result.rules));
    proven(result, [pair]);
  }],

  ['Letter-case changes are found; mixed case falls back to an exact value map', () => {
    const pair = { old: { currency: 'usd', country: 'Pe' }, new: { currency: 'USD', country: 'PE' } };
    const result = explain(pair);
    assert(has(result, 'case', 'currency') && has(result, 'values', 'country'), JSON.stringify(result.rules));
    proven(result, [pair]);
  }],

  ['Renamed values are merged across examples into one rule', () => {
    const pairs = [['paid', 'succeeded'], ['void', 'canceled'], ['pending', 'pending']].map(([a, b], i) => ({ old: { id: i, status: a }, new: { id: i, status: b } }));
    const result = explainRules(pairs);
    same(result.rules, [{ op: 'values', old: 'status', new: 'status', map: { paid: 'succeeded', void: 'canceled' } }]);
    proven(result, pairs);
  }],

  ['Examples that contradict each other produce a note, not a rule', () => {
    const pairs = [{ old: { status: 'paid' }, new: { status: 'succeeded' } }, { old: { status: 'paid' }, new: { status: 'complete' } }];
    const result = explainRules(pairs);
    assert(result.rules.length === 0 && noted(result, 'unexplained', 'status'), JSON.stringify(result));
  }],

  ['Two old values that became one new value are flagged, because the way back is unknowable', () => {
    const pairs = [{ old: { status: 'paid' }, new: { status: 'succeeded' } }, { old: { status: 'settled' }, new: { status: 'succeeded' } }];
    const result = explainRules(pairs);
    assert(!has(result, 'values') && noted(result, 'unexplained', 'status'), JSON.stringify(result));
  }],

  ['Free text that differs is called unexplained, not a renamed value', () => {
    const result = explain({ old: { display_name: 'Urbanización Unión, Lima, Peru' }, new: { display_name: 'Lima, Province of Lima, Peru' } });
    assert(result.rules.length === 0 && noted(result, 'unexplained', 'display_name'), JSON.stringify(result));
  }],

  ['Numbers and flags that simply differ are called unexplained', () => {
    const result = explain({ old: { views: 2, place_id: 3670138, open: true, retries: 1 }, new: { views: 3, place_id: 3692313, open: false, retries: 10 } });
    assert(result.rules.length === 0, `invented rules: ${JSON.stringify(result.rules)}`);
    for (const path of ['views', 'place_id', 'open', 'retries']) assert(noted(result, 'unexplained', path), `${path} was not flagged`);
  }],

  ['Seconds that became milliseconds are read as a time change, not a unit change', () => {
    const result = explain({ old: { at: 1767452400 }, new: { at: 1767452400000 } });
    same(result.rules.map((r) => r.op), ['time']);
  }],

  ['null on both sides is fine; null that became a value is flagged', () => {
    same(explain({ old: { note: null, a: 1 }, new: { note: null, a: 1 } }).rules, []);
    const result = explain({ old: { note: null }, new: { note: 'hello there' } });
    assert(result.rules.length === 0 && noted(result, 'unexplained', 'note'), JSON.stringify(result));
  }],

  ['Dropped and new fields get rules; a new field that varies gets no default', () => {
    const one = explain({ old: { a: 1, legacy: 'x' }, new: { a: 1, region: 'us' } });
    assert(has(one, 'remove', 'legacy') && one.rules.find((r) => r.op === 'add')?.value === 'us', JSON.stringify(one.rules));
    const two = explain({ old: { a: 1 }, new: { a: 1, documentId: 'abc' } }, { old: { a: 2 }, new: { a: 2, documentId: 'xyz' } });
    const add = two.rules.find((r) => r.op === 'add');
    assert(add && !('value' in add) && noted(two, 'no_default', 'documentId'), JSON.stringify(two));
  }],

  ['A field present in every old record but only some new ones is flagged', () => {
    const result = explain({ old: { a: 1, extra: 'x' }, new: { a: 1, extra: 'x' } }, { old: { a: 2, extra: 'y' }, new: { a: 2 } });
    assert(noted(result, 'inconsistent', 'extra'), JSON.stringify(result));
  }],
];

export const shapes = [
  ['A renamed field inside every item of a list is found', () => {
    const pair = { old: { items: [{ sku: 'a', qty: 1 }, { sku: 'b', qty: 2 }] }, new: { items: [{ sku: 'a', quantity: 1 }, { sku: 'b', quantity: 2 }] } };
    const result = explain(pair);
    same(result.rules, [{ op: 'rename', old: 'items[].qty', new: 'items[].quantity' }]);
    proven(result, [pair]);
  }],

  ['A renamed list with converted fields inside is found', () => {
    const pair = {
      old: { items: [{ sku: 'a', qty: 1, price: 4.35 }, { sku: 'b', qty: 2, price: 0.07 }] },
      new: { lines: [{ sku: 'a', quantity: 1, price_cents: 435 }, { sku: 'b', quantity: 2, price_cents: 7 }] },
    };
    const result = explain(pair);
    assert(has(result, 'rename', 'items', 'lines') && has(result, 'rename', 'items[].qty', 'lines[].quantity') && has(result, 'scale', 'items[].price', 'lines[].price_cents'), JSON.stringify(result.rules));
    proven(result, [pair]);
  }],

  ['A list whose length changed is flagged instead of being lined up wrongly', () => {
    const result = explain({ old: { items: [{ a: 1 }, { a: 2 }] }, new: { items: [{ a: 1 }] } });
    assert(noted(result, 'list_length', 'items') && result.rules.length === 0, JSON.stringify(result));
  }],

  ['A list of plain values changed item by item is found', () => {
    const pair = { old: { tags: ['red', 'blue'], codes: ['alpha', 'beta'] }, new: { tags: ['RED', 'BLUE'], labels: ['alpha', 'beta'] } };
    const result = explain(pair);
    assert(has(result, 'case', 'tags[]', 'tags[]') && has(result, 'rename', 'codes', 'labels'), JSON.stringify(result.rules));
    proven(result, [pair]);
  }],

  ['A one-letter list is too little evidence to call two lists the same', () => {
    const result = explain({ old: { codes: ['a'] }, new: { labels: ['a'] } });
    assert(!has(result, 'rename') && has(result, 'remove', 'codes') && has(result, 'add', undefined, 'labels'), JSON.stringify(result.rules));
  }],

  ['Lists inside lists are followed', () => {
    const pair = {
      old: { orders: [{ id: 1, items: [{ price: 1.5 }, { price: 2.25 }] }] },
      new: { orders: [{ id: 1, items: [{ price_cents: 150 }, { price_cents: 225 }] }] },
    };
    const result = explain(pair);
    same(result.rules, [{ op: 'scale', factor: 100, old: 'orders[].items[].price', new: 'orders[].items[].price_cents' }]);
    proven(result, [pair]);
  }],

  ['Two whole lists given as one example are lined up record by record', () => {
    const pair = { old: [{ id: 1, name: 'Ann Lee' }, { id: 2, name: 'Bo Park' }], new: [{ id: 1, full_name: 'Ann Lee' }, { id: 2, full_name: 'Bo Park' }] };
    same(inferRules([pair]), [{ op: 'rename', old: 'name', new: 'full_name' }]);
  }],

  ['An object renamed as a whole becomes one rule', () => {
    const pair = { old: { id: 1, address: { street: '1 Main St', city: 'Lima', zip: '15082' } }, new: { id: 1, shipping_address: { street: '1 Main St', city: 'Lima', zip: '15082' } } };
    const result = explain(pair);
    same(result.rules, [{ op: 'rename', old: 'address', new: 'shipping_address' }]);
    proven(result, [pair]);
  }],

  ['An object that only partly moved is not folded into one rule', () => {
    const pair = { old: { address: { street: '1 Main St', city: 'Lima', zip: '15082' } }, new: { shipping_address: { street: '1 Main St', city: 'Lima' }, address: { zip: '15082' } } };
    const result = explain(pair);
    assert(!has(result, 'rename', 'address', 'shipping_address') && has(result, 'rename', 'address.street', 'shipping_address.street'), JSON.stringify(result.rules));
    proven(result, [pair]);
  }],

  ['A record wrapped in an envelope is unwrapped for old callers', () => {
    const pair = { old: { id: 'u1', name: 'Ann Lee' }, new: { data: { id: 'u1', name: 'Ann Lee' }, meta: { version: 2 } } };
    const result = explain(pair);
    assert(has(result, 'rename', 'id', 'data.id') && has(result, 'rename', 'name', 'data.name') && has(result, 'add', undefined, 'meta.version'), JSON.stringify(result.rules));
    proven(result, [pair]);
  }],

  ['A field name with a dot in it is handled', () => {
    const pair = { old: { 'user.name': 'Ann Lee', 'a.b': { c: 1 } }, new: { userName: 'Ann Lee', 'a.b': { c: 1 } } };
    const result = explain(pair);
    same(result.rules, [{ op: 'rename', old: 'user\\.name', new: 'userName' }]);
    proven(result, [pair]);
  }],

  ['The real Strapi v4 → v5 change: fields leave "attributes", and documentId is new', () => {
    const pairs = [
      { old: { data: { id: 1, attributes: { title: 'Hello world', slug: 'hello-world' } }, meta: {} }, new: { data: { id: 1, documentId: 'znrlzntu9ei5onjvwfaalu2v', title: 'Hello world', slug: 'hello-world' }, meta: {} } },
      { old: { data: { id: 2, attributes: { title: 'Second post', slug: 'second-post' } }, meta: {} }, new: { data: { id: 2, documentId: 'a8jd72kslq0pxm3nv5bw1ety', title: 'Second post', slug: 'second-post' }, meta: {} } },
    ];
    const result = explainRules(pairs);
    assert(has(result, 'rename', 'data.attributes.title', 'data.title') && has(result, 'rename', 'data.attributes.slug', 'data.slug'), JSON.stringify(result.rules));
    assert(noted(result, 'no_default', 'data.documentId'), 'documentId should have no default');
    proven(result, pairs);
    same(verifyRules(result.rules, pairs).map((r) => r.unfilled), [['data.documentId'], ['data.documentId']]);
  }],

  ['OpenStreetMap-style noise: the real rename is found and the noisy fields are flagged', () => {
    const result = explain({
      old: { place_id: 3670138, class: 'highway', type: 'pedestrian', display_name: 'Urbanización Unión, Lima, Peru' },
      new: { place_id: 3692313, category: 'highway', type: 'pedestrian', display_name: 'Lima, Province of Lima, Peru' },
    });
    same(result.rules, [{ op: 'rename', old: 'class', new: 'category' }]);
    assert(noted(result, 'unexplained', 'place_id') && noted(result, 'unexplained', 'display_name'), JSON.stringify(result.notes));
  }],

  ['A list that became something else is flagged', () => {
    const result = explain({ old: { owners: [{ id: 1 }] }, new: { owners: 'ann' } });
    assert(noted(result, 'shape_changed', 'owners'), JSON.stringify(result));
  }],

  ['Three hundred renamed fields are found in good time', () => {
    const before = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`old_field_${i}`, `value-${i}-${i * 7919}`]));
    const after = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`new_field_${i}`, `value-${i}-${i * 7919}`]));
    const started = Date.now();
    const rules = inferRules([{ old: before, new: after }]);
    assert(rules.length === 300 && rules.every((r) => r.op === 'rename' && r.old.slice(10) === r.new.slice(10)), 'wrong rules');
    assert(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
  }],

  ['Whatever the input, the finder either proves its rules or raises a note', () => {
    const cases = [
      [{ old: { a: 1 }, new: { a: 2 } }],
      [{ old: { a: [1, 2] }, new: { a: [2, 1] } }],
      [{ old: { a: { b: [{ c: 1 }] } }, new: { a: { b: [{ c: 1 }, { c: 2 }] } } }],
      [{ old: { x: 'A' }, new: { y: 'B' } }],
      [{ old: { when: '2026-01-03' }, new: { when: '2026-01-03T00:00:00Z' } }],
      [{ old: { n: 1.5 }, new: { n: '1.50' } }],
      [{ old: {}, new: { a: { b: {} } } }],
      [{ old: { list: [] }, new: { list: [{ a: 1 }] } }],
      [{ old: { v: 'x' }, new: { v: null } }],
      [{ old: 'not a record', new: 5 }],
    ];
    for (const pairs of cases) {
      const result = explainRules(pairs);
      const records = pairs.filter((p) => p.old && typeof p.old === 'object');
      const bad = failures(result.rules, records);
      assert(bad.length === 0 || result.notes.length > 0, `silent failure for ${JSON.stringify(pairs)}: ${JSON.stringify(result)}`);
    }
  }],
];
