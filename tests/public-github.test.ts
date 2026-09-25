import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { scanPublicRepository } from '../lib/public-github';

test('public scan pins files to one commit and inventories a Stripe call', async () => {
  const original = globalThis.fetch;
  const head = 'a'.repeat(40);
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ dependencies: { stripe: '17.0.0' } }),
    'src/payments.ts': `import Stripe from 'stripe';\nconst stripe = new Stripe('test', { apiVersion: '2024-06-20' });\nstripe.paymentIntents.create({amount: 100, currency: 'usd'});`,
  };
  const requested: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requested.push(url);
    if (url.endsWith('/repos/example/payments')) return Response.json({ private: false, archived: false });
    if (url.endsWith('/branches/main')) return Response.json({ commit: { sha: head } });
    if (url.endsWith(`/git/commits/${head}`)) return Response.json({ tree: { sha: 'tree-1' } });
    if (url.endsWith('/git/trees/tree-1?recursive=1')) return Response.json({ truncated: false, tree: Object.entries(files).map(([path, content]) => ({ path, size: Buffer.byteLength(content), type: 'blob', mode: '100644' })) });
    const path = url.split(`/${head}/`)[1];
    if (path && files[path]) return new Response(files[path]);
    return new Response('missing', { status: 404 });
  }) as typeof fetch;
  try {
    const result = await scanPublicRepository('example/payments', 'main');
    assert.equal(result.head, head);
    assert.equal(result.inventory.calls.length, 1);
    assert.equal(result.inventory.sdkVersion, '17.0.0');
    assert.ok(requested.filter(url => url.includes('raw.githubusercontent.com')).every(url => url.includes(`/${head}/`)));
  } finally { globalThis.fetch = original; }
});

test('public scan rejects malformed repository names before network access', async () => {
  await assert.rejects(scanPublicRepository('https://internal.example/x', 'main'), /Invalid repository/);
});
