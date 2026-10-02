// Edge cases for the rules engine: the values, shapes and inputs most likely to break a translator.

import { applyRules, changelog, checkRule, checkRules, compileRules, describeRule, differences, parsePath, sameValue, verifyRules } from '../src/rules.js';
import { assert, clone, same, throws } from './helpers.js';

const up = (record, rules) => applyRules(clone(record), rules, 'up');
const down = (record, rules) => applyRules(clone(record), rules, 'down');

const CENTS = { op: 'scale', old: 'amount', new: 'amount_cents', factor: 100 };
const CREATED = { op: 'time', old: 'created', new: 'created_at', oldFormat: 'unix_seconds', newFormat: 'iso8601' };

export const conversions = [
  ['A missing field is skipped and nothing appears in its place', () => {
    same(up({ x: 1 }, [{ op: 'rename', old: 'a', new: 'b' }, CENTS, CREATED]), { x: 1 });
  }],

  ['null stays null instead of becoming 0', () => {
    same(up({ amount: null }, [CENTS]), { amount_cents: null });
    same(down({ amount_cents: null }, [CENTS]), { amount: null });
  }],

  ['A null timestamp stays null instead of becoming 1970', () => {
    same(up({ created: null }, [CREATED]), { created_at: null });
    same(down({ created_at: null }, [CREATED]), { created: null });
  }],

  ['A date nobody can read is passed through as it was', () => {
    same(down({ created_at: 'not a date' }, [CREATED]), { created: 'not a date' });
    same(up({ created: 'soon' }, [CREATED]), { created_at: 'soon' });
  }],

  ['Zero is converted, not treated as missing', () => {
    same(up({ amount: 0 }, [CENTS]), { amount_cents: 0 });
    same(down({ amount_cents: 0 }, [CENTS]), { amount: 0 });
  }],

  ['Negative money converts both ways', () => {
    same(up({ amount: -12.5 }, [CENTS]), { amount_cents: -1250 });
    same(down({ amount_cents: -1250 }, [CENTS]), { amount: -12.5 });
  }],

  ['Awkward decimals come out as exact cents and go back exactly', () => {
    for (const dollars of [19.99, 0.07, 1.15, 4.35, 0.1, 0.29, 1.1, 33.33, 1000.01, 0.01, 999999.99]) {
      const cents = up({ amount: dollars }, [CENTS]).amount_cents;
      assert(cents === Math.round(dollars * 100), `${dollars} became ${cents} cents`);
      assert(Number.isInteger(cents), `${cents} is not a whole number of cents`);
      assert(down({ amount_cents: cents }, [CENTS]).amount === dollars, `${cents} cents did not return to ${dollars}`);
    }
  }],

  ['A fraction that belongs in the result is kept, not rounded away', () => {
    same(up({ rate: 0.155 }, [{ op: 'scale', old: 'rate', new: 'rate_percent', factor: 100 }]), { rate_percent: 15.5 });
  }],

  ['Very large amounts keep every digit', () => {
    same(up({ amount: 123456789012.34 }, [CENTS]), { amount_cents: 12345678901234 });
    same(down({ amount_cents: 12345678901234 }, [CENTS]), { amount: 123456789012.34 });
  }],

  ['Money written as text ("12.50") becomes whole cents and returns with its zeros', () => {
    const rule = { ...CENTS, oldType: 'string', newType: 'number', oldDecimals: 2 };
    same(up({ amount: '12.50' }, [rule]), { amount_cents: 1250 });
    same(down({ amount_cents: 1250 }, [rule]), { amount: '12.50' });
    same(down({ amount_cents: 5 }, [rule]), { amount: '0.05' });
  }],

  ['A number sent as text stays text after scaling', () => {
    same(up({ amount: '12.5' }, [CENTS]), { amount_cents: '1250' });
    same(up({ amount: 'twelve' }, [CENTS]), { amount_cents: 'twelve' });
  }],

  ['Dividing works too (cents back to dollars as the forward direction)', () => {
    const rule = { op: 'scale', old: 'price_cents', new: 'price', factor: 0.01 };
    same(up({ price_cents: 1999 }, [rule]), { price: 19.99 });
    same(down({ price: 19.99 }, [rule]), { price_cents: 1999 });
  }],

  ['Renamed values map forward and back, and unknown values pass through', () => {
    const rule = { op: 'values', field: 'status', map: { paid: 'succeeded' } };
    same(up({ status: 'paid' }, [rule]), { status: 'succeeded' });
    same(up({ status: 'pending' }, [rule]), { status: 'pending' });
    same(down({ status: 'succeeded' }, [rule]), { status: 'paid' });
    same(down({ status: 'refunded' }, [rule]), { status: 'refunded' });
  }],

  ['Number and true/false values can be renamed to labels and return as their original type', () => {
    const level = { op: 'values', field: 'level', map: { 1: 'low', 2: 'high' }, oldType: 'number' };
    same(up({ level: 1 }, [level]), { level: 'low' });
    same(down({ level: 'high' }, [level]), { level: 2 });
    const active = { op: 'values', field: 'active', map: { true: 'enabled', false: 'disabled' }, oldType: 'boolean' };
    same(up({ active: true }, [active]), { active: 'enabled' });
    same(down({ active: 'disabled' }, [active]), { active: false });
  }],

  ['When two old values share one new value, the way back picks the first listed', () => {
    const rule = { op: 'values', field: 'status', map: { paid: 'succeeded', settled: 'succeeded' } };
    same(up({ status: 'settled' }, [rule]), { status: 'succeeded' });
    same(down({ status: 'succeeded' }, [rule]), { status: 'paid' });
  }],

  ['Times convert between seconds, milliseconds and ISO text', () => {
    same(up({ created: 1767452400 }, [CREATED]), { created_at: '2026-01-03T15:00:00Z' });
    same(down({ created_at: '2026-01-03T15:00:00Z' }, [CREATED]), { created: 1767452400 });
    const ms = { op: 'time', old: 'ts', new: 'at', oldFormat: 'unix_ms', newFormat: 'iso8601_ms' };
    same(up({ ts: 1767452400123 }, [ms]), { at: '2026-01-03T15:00:00.123Z' });
    same(down({ at: '2026-01-03T15:00:00.123Z' }, [ms]), { ts: 1767452400123 });
  }],

  ['A time with a zone offset, with no zone, or with microseconds is read as the right moment', () => {
    same(down({ created_at: '2026-01-03T10:00:00-05:00' }, [CREATED]), { created: 1767452400 });
    same(down({ created_at: '2026-01-03T15:00:00' }, [CREATED]), { created: 1767452400 });
    same(down({ created_at: '2026-01-03T15:00:00.644000Z' }, [CREATED]), { created: 1767452400 });
  }],

  ['Times before 1970 and times sent as text work', () => {
    same(up({ created: -86400 }, [CREATED]), { created_at: '1969-12-31T00:00:00Z' });
    same(down({ created_at: '1969-12-31T00:00:00Z' }, [CREATED]), { created: -86400 });
    const text = { ...CREATED, oldType: 'string' };
    same(up({ created: '1767452400' }, [text]), { created_at: '2026-01-03T15:00:00Z' });
    same(down({ created_at: '2026-01-03T15:00:00Z' }, [text]), { created: '1767452400' });
  }],

  ['A number that became text converts both ways, and ids too big for a number are left alone', () => {
    const rule = { op: 'type', field: 'id', oldType: 'number', newType: 'string' };
    same(up({ id: 42 }, [rule]), { id: '42' });
    same(down({ id: '42' }, [rule]), { id: 42 });
    same(down({ id: '9007199254740993' }, [rule]), { id: '9007199254740993' });
    same(down({ id: 'ord_1' }, [rule]), { id: 'ord_1' });
  }],

  ['true/false converts to text and to 0/1 and back', () => {
    const text = { op: 'type', field: 'live', oldType: 'boolean', newType: 'string' };
    same(up({ live: true }, [text]), { live: 'true' });
    same(down({ live: 'false' }, [text]), { live: false });
    const number = { op: 'type', field: 'live', oldType: 'boolean', newType: 'number' };
    same(up({ live: false }, [number]), { live: 0 });
    same(down({ live: 1 }, [number]), { live: true });
  }],

  ['A letter-case rule leaves non-text values alone', () => {
    const rule = { op: 'case', field: 'currency', oldCase: 'lower', newCase: 'upper' };
    same(up({ currency: 'usd' }, [rule]), { currency: 'USD' });
    same(up({ currency: 840 }, [rule]), { currency: 840 });
    same(down({ currency: 'EUR' }, [rule]), { currency: 'eur' });
  }],
];

export const moving = [
  ['Two fields can swap names', () => {
    const rules = [{ op: 'rename', old: 'first', new: 'last' }, { op: 'rename', old: 'last', new: 'first' }];
    same(up({ first: 'A', last: 'B' }, rules), { first: 'B', last: 'A' });
    same(down({ first: 'B', last: 'A' }, rules), { first: 'A', last: 'B' });
  }],

  ['A field can move into a name another rule vacates, in either rule order', () => {
    const rules = [{ op: 'rename', old: 'a', new: 'b' }, { op: 'rename', old: 'b', new: 'c' }];
    for (const order of [rules, [...rules].reverse()]) {
      same(up({ a: 1, b: 2 }, order), { b: 1, c: 2 });
      same(down({ b: 1, c: 2 }, order), { a: 1, b: 2 });
    }
  }],

  ['A rename never overwrites a field the caller already sent', () => {
    const rules = [{ op: 'rename', old: 'customerId', new: 'accountId' }];
    same(up({ customerId: 'c1', accountId: 'a9', amountCents: 5 }, rules), { customerId: 'c1', accountId: 'a9', amountCents: 5 });
    same(up({ customerId: 'c1', amountCents: 5 }, rules), { accountId: 'c1', amountCents: 5 });
  }],

  ['Fields move into a nested object and back, leaving no empty object behind', () => {
    const rules = [{ ...CENTS, new: 'total.amount_cents' }, { op: 'case', old: 'currency', new: 'total.currency', oldCase: 'lower', newCase: 'upper' }];
    same(up({ id: 1, amount: 12.5, currency: 'usd' }, rules), { id: 1, total: { amount_cents: 1250, currency: 'USD' } });
    same(down({ id: 1, total: { amount_cents: 1250, currency: 'USD' } }, rules), { id: 1, amount: 12.5, currency: 'usd' });
  }],

  ['An object can be renamed while a field inside it is converted', () => {
    const rules = [{ op: 'rename', old: 'total', new: 'price' }, { op: 'scale', old: 'total.amount', new: 'price.amount_cents', factor: 100 }];
    same(up({ total: { amount: 12.5, currency: 'usd' } }, rules), { price: { amount_cents: 1250, currency: 'usd' } });
    same(down({ price: { amount_cents: 1250, currency: 'usd' } }, rules), { total: { amount: 12.5, currency: 'usd' } });
  }],

  ['A rule applies to every item of a list', () => {
    const rules = [{ op: 'rename', old: 'items[].qty', new: 'items[].quantity' }];
    const before = { items: [{ sku: 'a', qty: 1 }, { sku: 'b', qty: 2 }, { sku: 'c' }] };
    const after = { items: [{ sku: 'a', quantity: 1 }, { sku: 'b', quantity: 2 }, { sku: 'c' }] };
    same(up(before, rules), after);
    same(down(after, rules), before);
  }],

  ['A list can be renamed while a field in each item is renamed too', () => {
    const rules = [{ op: 'rename', old: 'items', new: 'lines' }, { op: 'rename', old: 'items[].qty', new: 'lines[].quantity' }];
    same(up({ items: [{ sku: 'a', qty: 1 }] }, rules), { lines: [{ sku: 'a', quantity: 1 }] });
    same(down({ lines: [{ sku: 'a', quantity: 1 }] }, rules), { items: [{ sku: 'a', qty: 1 }] });
  }],

  ['Lists inside lists are reached', () => {
    const rules = [{ op: 'scale', old: 'orders[].items[].price', new: 'orders[].items[].price_cents', factor: 100 }];
    same(up({ orders: [{ items: [{ price: 1.5 }, { price: 2 }] }, { items: [] }] }, rules), { orders: [{ items: [{ price_cents: 150 }, { price_cents: 200 }] }, { items: [] }] });
  }],

  ['Each value of a plain list can be converted', () => {
    const rules = [{ op: 'case', field: 'currencies[]', oldCase: 'lower', newCase: 'upper' }];
    same(up({ currencies: ['usd', 'eur'] }, rules), { currencies: ['USD', 'EUR'] });
    same(down({ currencies: ['USD', 'EUR'] }, rules), { currencies: ['usd', 'eur'] });
    same(up({ currencies: [] }, rules), { currencies: [] });
  }],

  ['One field of each item can be pulled out into its own list and put back', () => {
    const rules = [{ op: 'rename', old: 'items[].sku', new: 'skus[]' }];
    same(up({ items: [{ sku: 'a', qty: 1 }, { sku: 'b', qty: 2 }] }, rules), { items: [{ qty: 1 }, { qty: 2 }], skus: ['a', 'b'] });
    same(down({ items: [{ qty: 1 }, { qty: 2 }], skus: ['a', 'b'] }, rules), { items: [{ qty: 1, sku: 'a' }, { qty: 2, sku: 'b' }] });
  }],

  ['A field name that contains a dot or a bracket is addressed exactly', () => {
    same(up({ 'user.name': 'Ann', user: { name: 'other' } }, [{ op: 'rename', old: 'user\\.name', new: 'userName' }]), { userName: 'Ann', user: { name: 'other' } });
    same(up({ 'a[0]': 1 }, [{ op: 'rename', old: 'a\\[0]', new: 'first' }]), { first: 1 });
  }],

  ['Names in any alphabet, and emoji, survive untouched', () => {
    const rules = [{ op: 'rename', old: 'имя', new: '名前' }];
    same(up({ 'имя': 'Ольга 🚀', note: 'café' }, rules), { '名前': 'Ольга 🚀', note: 'café' });
    same(down({ '名前': 'Ольга 🚀' }, rules), { 'имя': 'Ольга 🚀' });
  }],

  ['A field twelve levels deep is reached', () => {
    const deep = 'a.b.c.d.e.f.g.h.i.j.k.l';
    const record = {};
    deep.split('.').reduce((node, key, i, all) => (node[key] = i === all.length - 1 ? 7 : {}), record);
    const out = up(record, [{ op: 'rename', old: deep, new: 'flat' }]);
    same(out, { flat: 7 });
    same(down(out, [{ op: 'rename', old: deep, new: 'flat' }]), record);
  }],

  ['A whole list of records and non-record inputs are handled', () => {
    same(applyRules([{ a: 1 }, { a: 2 }], [{ op: 'rename', old: 'a', new: 'b' }], 'up'), [{ b: 1 }, { b: 2 }]);
    for (const value of ['text', 5, true, null]) assert(Object.is(applyRules(value, [CENTS], 'up'), value), `${value} was changed`);
  }],

  ['A default is added only when the field is missing, and removed on the way back', () => {
    const rules = [{ op: 'add', new: 'capture_method', value: 'automatic' }];
    same(up({ a: 1 }, rules), { a: 1, capture_method: 'automatic' });
    same(up({ capture_method: 'manual' }, rules), { capture_method: 'manual' });
    same(down({ a: 1, capture_method: 'automatic' }, rules), { a: 1 });
  }],

  ['Defaults work inside objects and inside every item of a list', () => {
    same(up({ a: 1 }, [{ op: 'add', new: 'meta.source', value: 'api' }]), { a: 1, meta: { source: 'api' } });
    const rules = [{ op: 'add', new: 'items[].tax_code', value: 'none' }];
    same(up({ items: [{ sku: 'a' }, { sku: 'b', tax_code: 'food' }] }, rules), { items: [{ sku: 'a', tax_code: 'none' }, { sku: 'b', tax_code: 'food' }] });
    same(up({ other: 1 }, rules), { other: 1 });
    same(down({ items: [{ sku: 'a', tax_code: 'none' }] }, rules), { items: [{ sku: 'a' }] });
  }],

  ['A new field with no default is only hidden from old callers', () => {
    const rules = [{ op: 'add', new: 'documentId' }];
    same(up({ id: 1 }, rules), { id: 1 });
    same(down({ id: 1, documentId: 'abc' }, rules), { id: 1 });
  }],

  ['A dropped field is removed going forward and left alone going back', () => {
    const rules = [{ op: 'remove', old: 'legacy.note' }];
    same(up({ a: 1, legacy: { note: 'x' } }, rules), { a: 1 });
    same(down({ a: 1 }, rules), { a: 1 });
  }],

  ['Forward then back returns the original record, for every kind of rule at once', () => {
    const rules = [
      { op: 'rename', old: 'customer_name', new: 'customer.full_name' },
      { ...CENTS, new: 'total.amount_cents' },
      { op: 'case', old: 'currency', new: 'total.currency', oldCase: 'lower', newCase: 'upper' },
      { op: 'values', field: 'status', map: { paid: 'succeeded', void: 'canceled' } },
      CREATED,
      { op: 'type', field: 'id', oldType: 'number', newType: 'string' },
      { op: 'rename', old: 'items', new: 'lines' },
      { op: 'rename', old: 'items[].qty', new: 'lines[].quantity' },
      { op: 'scale', old: 'items[].price', new: 'lines[].price_cents', factor: 100 },
    ];
    const records = [
      { id: 7, customer_name: 'Maya Chen', amount: 19.99, currency: 'usd', status: 'paid', created: 1767452400, items: [{ sku: 'a', qty: 2, price: 4.35 }, { sku: 'b', qty: 1, price: 0.07 }] },
      { id: 0, customer_name: '', amount: 0, currency: 'eur', status: 'void', created: 0, items: [] },
      { id: 12, customer_name: null, amount: null, currency: 'gbp', status: 'weird', created: null, items: [{ sku: 'z' }] },
    ];
    for (const record of records) same(down(up(record, rules), rules), record, 'round trip changed the record');
  }],

  ['The order rules are listed in does not change the result', () => {
    const rules = [
      { op: 'rename', old: 'customer_name', new: 'full_name' },
      { ...CENTS, new: 'total.amount_cents' },
      { op: 'case', old: 'currency', new: 'total.currency', oldCase: 'lower', newCase: 'upper' },
      { op: 'values', field: 'status', map: { paid: 'succeeded' } },
      CREATED,
      { op: 'rename', old: 'items', new: 'lines' },
      { op: 'rename', old: 'items[].qty', new: 'lines[].quantity' },
    ];
    const record = { customer_name: 'Maya', amount: 12.5, currency: 'usd', status: 'paid', created: 1767452400, items: [{ qty: 1 }] };
    const expected = up(record, rules);
    let seed = 11;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let run = 0; run < 25; run++) {
      const shuffled = [...rules].sort(() => random() - 0.5);
      same(up(record, shuffled), expected, 'a different rule order gave a different result');
      same(down(expected, shuffled), record, 'a different rule order broke the way back');
    }
  }],

  ['A record with 2,000 fields and 500 rules translates quickly', () => {
    const record = Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`field_${i}`, i]));
    const rules = Array.from({ length: 500 }, (_, i) => ({ op: 'rename', old: `field_${i}`, new: `renamed_${i}` }));
    const started = Date.now();
    const out = up(record, rules);
    assert(out.renamed_499 === 499 && out.field_1999 === 1999 && !('field_0' in out), 'wrong result');
    assert(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
  }],
];

export const safety = [
  ['Field paths that could tamper with the runtime are refused', () => {
    for (const path of ['__proto__.polluted', 'constructor.prototype.polluted', 'a.__proto__', 'prototype']) {
      assert(checkRule({ op: 'rename', old: path, new: 'x' }), `${path} was accepted`);
      assert(checkRule({ op: 'add', new: path, value: true }), `${path} was accepted as a default`);
      throws(() => applyRules({ a: 1 }, [{ op: 'add', new: path, value: true }], 'up'), /can't be used/);
    }
    assert(({}).polluted === undefined, 'Object.prototype was polluted');
  }],

  ['A request that carries a "__proto__" key cannot tamper with other records', () => {
    const record = JSON.parse('{"__proto__": {"evil": true}, "a": 1}');
    const out = applyRules(record, [{ op: 'rename', old: 'a', new: 'b' }], 'up');
    assert(out.b === 1, 'rename did not run');
    assert(({}).evil === undefined, 'Object.prototype was polluted');
  }],

  ['Broken paths are refused with a plain message', () => {
    for (const path of ['', 'a..b', '.a', 'a.']) throws(() => parsePath(path), /not a valid field path/);
  }],

  ['Each kind of broken rule is refused with a message that says what to fix', () => {
    const bad = [
      [{ op: 'teleport', old: 'a', new: 'b' }, /Unknown rule type/],
      [{ op: 'rename', old: 'a' }, /missing new/],
      [{ op: 'scale', old: 'a', new: 'b' }, /missing factor/],
      [{ op: 'scale', old: 'a', new: 'b', factor: 0 }, /positive factor/],
      [{ op: 'scale', old: 'a', new: 'b', factor: 'lots' }, /positive factor/],
      [{ op: 'time', old: 'a', new: 'b', oldFormat: 'unix_seconds', newFormat: 'roman' }, /Time formats/],
      [{ op: 'type', old: 'a', new: 'b', oldType: 'number', newType: 'date' }, /Types must be/],
      [{ op: 'values', field: 'a', map: 'paid' }, /needs a map/],
      [{ op: 'rename', old: 'items[].a', new: 'b' }, /same number of times/],
      [{ op: 'rename', old: 'a', new: 'b', in: 'header' }, /request, response or query/],
      [{ op: 'rename', old: 'a', new: 'b', endpoint: 'orders' }, /must look like/],
      [{ op: 'endpoint_removed', method: 'GET', path: 'orders' }, /start with/],
      ['rename a to b', /must be an object/],
    ];
    for (const [rule, pattern] of bad) {
      const problem = checkRule(rule);
      assert(problem && pattern.test(problem), `${JSON.stringify(rule)} gave: ${problem}`);
    }
    assert(checkRule({ op: 'rename', old: 'a', new: 'b', in: 'request', endpoint: ['POST /orders', '/orders/{id}'] }) === null, 'a good rule was refused');
  }],

  ['Two rules fighting over one field are refused', () => {
    assert(/Two rules use the new field/.test(checkRules([{ op: 'rename', old: 'a', new: 'c' }, { op: 'rename', old: 'b', new: 'c' }])), 'two writers were accepted');
    assert(/Two rules use the old field/.test(checkRules([{ op: 'rename', old: 'a', new: 'b' }, { op: 'remove', old: 'a' }])), 'two readers were accepted');
    assert(checkRules([{ op: 'rename', old: 'a', new: 'c', in: 'request' }, { op: 'rename', old: 'b', new: 'c', in: 'response' }]) === null, 'rules for different places were refused');
    assert(checkRules([{ op: 'rename', old: 'a', new: 'c', endpoint: 'POST /x' }, { op: 'rename', old: 'b', new: 'c', endpoint: 'POST /y' }]) === null, 'rules for different endpoints were refused');
    throws(() => compileRules({ from: '1', to: '2', rules: [{ op: 'rename', old: 'a', new: 'c' }, { op: 'rename', old: 'b', new: 'c' }] }), /Two rules/);
  }],

  ['Every rule can be described in words, and the changelog lists them all', () => {
    const rules = [
      { op: 'rename', old: 'a', new: 'b' }, CENTS, { op: 'case', field: 'c', newCase: 'upper' }, { op: 'values', field: 's', map: { paid: 'succeeded' } },
      CREATED, { op: 'type', field: 'id', oldType: 'number', newType: 'string' }, { op: 'add', new: 'n', value: 1 }, { op: 'add', new: 'm' },
      { op: 'remove', old: 'r' }, { op: 'endpoint_moved', method: 'get', old: '/a/{id}', new: '/b/{id}' }, { op: 'endpoint_removed', method: 'get', path: '/c' },
      { op: 'rename', old: 'q', new: 'p', in: 'query', endpoint: 'GET /orders' },
    ];
    for (const rule of rules) {
      const text = describeRule(rule);
      assert(text.length > 10 && !text.includes('undefined') && !text.startsWith('Unknown'), `bad description: ${text}`);
    }
    const log = changelog({ from: '1', to: '2', rules });
    assert(log.split('\n').length === rules.length + 2 && log.includes('Changes from 1 to 2'), 'changelog is incomplete');
  }],
];

const adapterFor = (rules, extra = {}) => compileRules({ from: '1', to: '2', rules, ...extra });

export const adapters = [
  ['A rule limited to requests is not applied to answers', () => {
    const adapter = adapterFor([{ op: 'rename', old: 'customerId', new: 'accountId', in: 'request' }]);
    same(adapter.upgradeRequest({ method: 'POST', path: '/quotes', body: { customerId: 'c' } }).body, { accountId: 'c' });
    same(adapter.downgradeResponse({ status: 200, body: { accountId: 'c' } }, { method: 'POST', path: '/quotes' }).body, { accountId: 'c' });
  }],

  ['A rule limited to one endpoint leaves other endpoints alone', () => {
    const adapter = adapterFor([{ op: 'rename', old: 'name', new: 'full_name', endpoint: 'POST /users' }]);
    same(adapter.upgradeRequest({ method: 'POST', path: '/users', body: { name: 'A' } }).body, { full_name: 'A' });
    same(adapter.upgradeRequest({ method: 'POST', path: '/orders', body: { name: 'A' } }).body, { name: 'A' });
    same(adapter.upgradeRequest({ method: 'PUT', path: '/users', body: { name: 'A' } }).body, { name: 'A' });
  }],

  ['An endpoint with an id in it matches any id but not longer paths', () => {
    const adapter = adapterFor([{ op: 'rename', old: 'name', new: 'full_name', endpoint: 'GET /users/{id}' }]);
    const answer = (path) => adapter.downgradeResponse({ status: 200, body: { full_name: 'A' } }, { method: 'GET', path }).body;
    same(answer('/users/u_1'), { name: 'A' });
    same(answer('/users/u_1/'), { name: 'A' });
    same(answer('/users/u_1/orders'), { full_name: 'A' });
    same(answer('/users'), { full_name: 'A' });
  }],

  ['Error answers are not translated as if they were records', () => {
    const adapter = adapterFor([{ op: 'values', field: 'status', map: { paid: 'succeeded' } }]);
    same(adapter.downgradeResponse({ status: 422, body: { status: 'succeeded', message: 'x' } }).body, { status: 'succeeded', message: 'x' });
    same(adapter.downgradeResponse({ status: 200, body: { status: 'succeeded' } }).body, { status: 'paid' });
  }],

  ['A validation error names the field the old caller actually sent', () => {
    const adapter = adapterFor([{ op: 'rename', old: 'customer_name', new: 'full_name' }]);
    const res = adapter.downgradeResponse({ status: 400, body: { error: { param: 'full_name', message: "Missing required field 'full_name'." } } }, { method: 'POST', path: '/orders' });
    same(res.body, { error: { param: 'customer_name', message: "Missing required field 'customer_name'." } });
  }],

  ['Records inside a list answer are translated, including a custom list name', () => {
    const rules = [{ op: 'rename', old: 'customer_name', new: 'full_name' }];
    same(adapterFor(rules).downgradeResponse({ status: 200, body: { object: 'list', data: [{ full_name: 'A' }, { full_name: 'B' }], has_more: false } }).body,
      { object: 'list', data: [{ customer_name: 'A' }, { customer_name: 'B' }], has_more: false });
    same(adapterFor(rules, { lists: ['results'] }).downgradeResponse({ status: 200, body: { results: [{ full_name: 'A' }], data: [{ full_name: 'B' }] } }).body,
      { results: [{ customer_name: 'A' }], data: [{ full_name: 'B' }] });
    same(adapterFor(rules).downgradeResponse({ status: 200, body: [{ full_name: 'A' }] }).body, [{ customer_name: 'A' }]);
  }],

  ['Query string rules rename and convert, and values stay text', () => {
    const adapter = adapterFor([
      { op: 'rename', old: 'customer', new: 'customer_id', in: 'query' },
      { op: 'time', field: 'since', oldFormat: 'unix_seconds', newFormat: 'iso8601', in: 'query' },
    ]);
    const req = adapter.upgradeRequest({ method: 'GET', path: '/orders', query: { customer: 'c1', since: '1767452400', limit: '5' } });
    same(req.query, { customer_id: 'c1', since: '2026-01-03T15:00:00Z', limit: '5' });
    same(adapter.upgradeRequest({ method: 'POST', path: '/orders', query: {}, body: { customer: 'c1' } }).body, { customer: 'c1' });
  }],

  ['A moved endpoint keeps its ids, and can change method', () => {
    const adapter = adapterFor([
      { op: 'endpoint_moved', method: 'GET', old: '/orders/{id}/label', new: '/v2/labels/{id}' },
      { op: 'endpoint_moved', method: 'put', old: '/orders/{id}', new: '/orders/{id}', newMethod: 'patch' },
      { op: 'endpoint_moved', method: 'GET', old: '/a/{id}', new: '/b/{other}' },
    ]);
    same(adapter.upgradeRequest({ method: 'GET', path: '/orders/ord_1/label' }).path, '/v2/labels/ord_1');
    const put = adapter.upgradeRequest({ method: 'PUT', path: '/orders/ord_1', body: {} });
    same([put.method, put.path], ['PATCH', '/orders/ord_1']);
    same(adapter.upgradeRequest({ method: 'GET', path: '/a/1' }).path, '/a/1');
    same(adapter.upgradeRequest({ method: 'POST', path: '/orders/ord_1/label' }).path, '/orders/ord_1/label');
  }],

  ['A removed endpoint matches any id, with or without a trailing slash', () => {
    const [gone] = adapterFor([{ op: 'endpoint_removed', method: 'get', path: '/orders/{id}/label' }]).untranslatable;
    assert(gone.method === 'GET' && gone.path.test('/orders/ord_1/label') && gone.path.test('/orders/x/label/'), 'did not match');
    assert(!gone.path.test('/orders/ord_1') && !gone.path.test('/orders/a/b/label'), 'matched too much');
    assert(gone.reason.includes('GET /orders/{id}/label was removed in 2'), 'default message is missing');
  }],

  ['Bodies that are not records pass through untouched', () => {
    const adapter = adapterFor([{ op: 'rename', old: 'a', new: 'b' }]);
    for (const body of [null, undefined, 'text', 7, true]) same(adapter.upgradeRequest({ method: 'POST', path: '/', body }).body, body);
    same(adapter.downgradeResponse({ status: 200, body: 'ok' }).body, 'ok');
  }],
];

export const proof = [
  ['A time kept in whole seconds is compared at whole-second precision', () => {
    const rules = [{ ...CREATED, newFormat: 'iso8601_ms' }];
    const [result] = verifyRules(rules, [{ old: { created: 1767452400 }, new: { created_at: '2026-01-03T15:00:00.789Z' } }]);
    same([result.upDiffs, result.downDiffs], [[], []]);
    const [off] = verifyRules(rules, [{ old: { created: 1767452400 }, new: { created_at: '2026-01-03T15:00:02.000Z' } }]);
    assert(off.downDiffs.length === 1 && off.upDiffs.length === 1, 'a two-second difference was accepted');
  }],

  ['A dropped object is reported as lost, not as a failure', () => {
    const [result] = verifyRules([{ op: 'remove', old: 'debug' }], [{ old: { a: 1, debug: { x: 1, y: [1, 2] } }, new: { a: 1 } }]);
    same([result.upDiffs, result.downDiffs, result.lost], [[], [], ['debug']]);
  }],

  ['A difference inside a list is reported with its exact position', () => {
    const [result] = verifyRules([], [{ old: { items: [{ qty: 1 }, { qty: 2 }] }, new: { items: [{ qty: 1 }, { qty: 3 }] } }]);
    same(result.upDiffs, [{ path: 'items[1].qty', expected: 3, got: 2 }]);
  }],

  ['A wrong rule is caught in both directions', () => {
    const [result] = verifyRules([{ ...CENTS, factor: 10 }], [{ old: { amount: 12.5 }, new: { amount_cents: 1250 } }]);
    same(result.upDiffs, [{ path: 'amount_cents', expected: 1250, got: 125 }]);
    same(result.downDiffs, [{ path: 'amount', expected: 12.5, got: 125 }]);
  }],

  ['The same moment written two ways counts as equal; different moments do not', () => {
    assert(sameValue('2026-01-03T15:00:00Z', '2026-01-03T15:00:00+00:00'), 'Z and +00:00 differ');
    assert(sameValue('2026-01-03T15:00:00Z', '2026-01-03T10:00:00-05:00'), 'offsets differ');
    assert(!sameValue('2026-01-03T15:00:00Z', '2026-01-03T15:00:01Z'), 'one second apart was equal');
    assert(!sameValue('paid', 'Paid') && !sameValue(1, '1') && sameValue(NaN, NaN), 'plain comparison is wrong');
  }],

  ['Missing and extra fields both count as differences', () => {
    same(differences({ a: 1, b: 2 }, { a: 1, c: 3 }).map((d) => d.path).sort(), ['b', 'c']);
    same(differences({ a: [] }, { a: [] }), []);
    same(differences({ a: {} }, { a: [] }).length, 1);
    same(differences({ a: null }, {}).length, 1);
  }],
];
