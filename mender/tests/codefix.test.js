// Fixing a consumer's code from the rules: what gets rewritten, and what is left alone.

import { fixConsumer, scan } from '../src/codefix.js';
import { rulesFromOpenApi } from '../src/openapi.js';
import { makeManaged, managedContract } from './managed.fixture.js';
import { assert, same } from './helpers.js';

const RENAME = [{ op: 'rename', old: 'customerId', new: 'accountId', in: 'request' }];
const PATHS = { paths: ['/api/managed/quotes'] };
const fix = (source, rules = RENAME, options = PATHS) => fixConsumer(source, rules, options);

// examples/quote-api-consumer/src/client.mjs, unchanged.
const TEAM_CLIENT = `/** A separate application using the public, database-backed Quote API. */
export async function createQuote(apiBaseUrl, customerId, sku) {
  const response = await fetch(\`\${apiBaseUrl}/api/managed/quotes\`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ customerId, sku }),
  });
  if (!response.ok) throw new Error(\`Quote API returned \${response.status}: \${await response.text()}\`);
  return response.json();
}
`;

export const codefix = [
  ['The team\'s client gets exactly one line changed, from rules read out of the two contracts', () => {
    const rules = rulesFromOpenApi(managedContract(1, 'customerId'), managedContract(2, 'accountId')).rules;
    const result = fix(TEAM_CLIENT, rules);
    same(result.changes, [{ line: 6, before: 'body: JSON.stringify({ customerId, sku }),', after: 'body: JSON.stringify({ accountId: customerId, sku }),' }]);
    same([result.needsDecision, result.summary], [null, 'The request to /api/managed/quotes now sends customerId as accountId.']);
    assert(result.after === TEAM_CLIENT.replace('{ customerId, sku }', '{ accountId: customerId, sku }'), 'something else in the file changed');
  }],

  ['The fixed client really works: it fails before, passes after, against version 2', async () => {
    const api = makeManaged(['customerId', 'accountId']);
    const run = async (source) => {
      const module = await import(`data:text/javascript,${encodeURIComponent(source)}`);
      const real = globalThis.fetch;
      globalThis.fetch = (input, init) => api(new Request(input, init));
      try { return await module.createQuote('https://managed.example.test', 'customer_1', 'WIDGET-1').then((q) => q.contractVersion, (e) => e.message); } finally { globalThis.fetch = real; }
    };
    assert(/returned 422/.test(await run(TEAM_CLIENT)), 'the old client should fail on version 2');
    same(await run(fix(TEAM_CLIENT).after), 2);
  }],

  ['Keys written with a value, or in quotes, are renamed in place', () => {
    same(fix("fetch('/api/managed/quotes', { body: JSON.stringify({ customerId: user.id, sku }) })").after, "fetch('/api/managed/quotes', { body: JSON.stringify({ accountId: user.id, sku }) })");
    same(fix(`fetch('/api/managed/quotes', { body: JSON.stringify({ 'customerId': id, "sku": s }) })`).after, `fetch('/api/managed/quotes', { body: JSON.stringify({ 'accountId': id, "sku": s }) })`);
  }],

  ['Other calling styles are handled: a data argument, and an options object that holds the address', () => {
    same(fix('await axios.post(`${base}/api/managed/quotes`, { customerId, sku }, { timeout: 5000 });').after, 'await axios.post(`${base}/api/managed/quotes`, { accountId: customerId, sku }, { timeout: 5000 });');
    same(fix("request({ url: '/api/managed/quotes', method: 'POST', json: { customerId } })").after, "request({ url: '/api/managed/quotes', method: 'POST', json: { accountId: customerId } })");
  }],

  ['TypeScript and several calls in one file are handled', () => {
    const source = "const a = fetch('/api/managed/quotes', { body: JSON.stringify({ customerId, sku } satisfies QuoteRequest) });\nconst b = fetch('/api/managed/quotes', { body: JSON.stringify({ customerId: other as string, sku }) });";
    const result = fix(source);
    same(result.changes.map((c) => c.line), [1, 2]);
    assert(result.after.includes('{ accountId: customerId, sku } satisfies') && result.after.includes('{ accountId: other as string, sku }'), result.after);
  }],

  ['The same word elsewhere is left alone: other calls, comments, text, and unpacking', () => {
    const source = [
      '// customerId is sent to /api/managed/quotes',
      'const { customerId } = session;',
      'log({ customerId });',
      "const note = 'customerId goes to /api/managed/quotes';",
      "track('/api/other', { customerId });",
      "fetch('/api/managed/quotes', { body: JSON.stringify({ customerId, sku }) }).then(({ customerId: echoed }) => echoed);",
    ].join('\n');
    const result = fix(source);
    same(result.changes.map((c) => c.line), [6]);
    const lines = result.after.split('\n');
    same(lines.slice(0, 5), source.split('\n').slice(0, 5));
    assert(lines[5] === "fetch('/api/managed/quotes', { body: JSON.stringify({ accountId: customerId, sku }) }).then(({ customerId: echoed }) => echoed);", lines[5]);
  }],

  ['A request that already sends the new field is not touched, and says why', () => {
    const source = "fetch('/api/managed/quotes', { body: JSON.stringify({ customerId, accountId, sku }) })";
    const result = fix(source);
    assert(result.after === source && /already sends accountId/.test(result.needsDecision), JSON.stringify(result));
  }],

  ['When the call cannot be found, nothing changes and the reason is given', () => {
    const source = "const url = base + '/api/managed/quotes';\nsend(url, { customerId });";
    const result = fix(source);
    assert(result.after === source && /could not find/.test(result.needsDecision), JSON.stringify(result));
    assert(/could not find a call/.test(fix('export const x = 1;').needsDecision), 'missing endpoint was not reported');
  }],

  ['Changes the fixer cannot make safely are spelled out for a person', () => {
    const rules = [
      ...RENAME,
      { op: 'scale', old: 'amount', new: 'total.amount_cents', factor: 100, in: 'request' },
      { op: 'add', new: 'region', in: 'request' },
      { op: 'rename', old: 'name', new: 'full_name', in: 'response' },
    ];
    const result = fix(TEAM_CLIENT, rules);
    assert(result.changes.length === 1, 'the plain rename should still be applied');
    for (const fragment of ['amount is now total.amount_cents, multiplied by 100', 'Send the new field region', 'The answer changed: name is now full_name']) {
      assert(result.needsDecision.includes(fragment), `missing "${fragment}" in: ${result.needsDecision}`);
    }
  }],

  ['Running the fixer twice changes nothing the second time', () => {
    const once = fix(TEAM_CLIENT).after;
    same(fix(once).after, once);
  }],

  ['The scanner is not fooled by regular expressions, division, nested templates or escapes', () => {
    const source = "const re = /[{'\"]\\/api/g; const half = total / 2; const s = 'it\\'s {'; const t = `a ${`b ${c}`} {`;\nfetch('/api/managed/quotes', { body: JSON.stringify({ customerId }) });";
    const kinds = scan(source).filter((t) => t.type === 'regex' || t.type === 'template' || t.type === 'string').map((t) => t.type);
    same(kinds, ['regex', 'string', 'template', 'string']);
    same(fix(source).changes, [{ line: 2, before: "fetch('/api/managed/quotes', { body: JSON.stringify({ customerId }) });", after: "fetch('/api/managed/quotes', { body: JSON.stringify({ accountId: customerId }) });" }]);
  }],

  ['A new name that is not a valid identifier is written as a quoted key', () => {
    same(fix("fetch('/api/managed/quotes', { body: JSON.stringify({ customerId }) })", [{ op: 'rename', old: 'customerId', new: 'account-id' }]).after, "fetch('/api/managed/quotes', { body: JSON.stringify({ 'account-id': customerId }) })");
  }],
];
