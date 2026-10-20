import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';

const path = resolve(import.meta.dirname, '../../supabase/functions/check-aws-sdk/index.ts');

test('an AWS release creates review findings only for repositories with scanned S3 calls', async () => {
  const source = readFileSync(path, 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replace(/^import \{ createClient \} from 'npm:@supabase\/supabase-js@2\.117\.1';\s*/m, '');
  const recorded = [];
  const previous = { id: 'old-snapshot', sha256: '0'.repeat(64), retrieved_at: '2026-10-01T00:00:00Z', metadata: { version: 'v3.900.0' } };
  const user = {
    auth: { getUser: async () => ({ data: { user: { id: 'owner' } }, error: null }) },
    from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { id: 'workspace' }, error: null }) }) }) }),
  };
  const admin = {
    from(table) {
      if (table === 'source_snapshots') return {
        select: () => ({ eq: () => ({ eq: () => ({ order: () => ({ limit: () => ({ maybeSingle: async () => ({ data: previous, error: null }) }) }) }) }) }),
        upsert: () => ({ select: () => ({ single: async () => ({ data: { id: 'new-snapshot' }, error: null }) }) }),
      };
      if (table === 'monitored_repositories') return {
        select: () => ({ eq: () => ({ eq: () => ({ limit: async () => ({ data: [
          { id: 's3-repo', head_sha: 'a'.repeat(40), call_sites: [{ endpoint: 'S3 PutObject', file: 'src/s3.ts', line: 8 }] },
          { id: 'stripe-repo', head_sha: 'b'.repeat(40), call_sites: [{ endpoint: 'POST /v1/payment_intents', file: 'src/stripe.ts', line: 3 }] },
        ], error: null }) }) }) }),
      };
      if (table === 'findings') return { upsert: async item => { recorded.push(item); return { error: null }; } };
      throw new Error(`Unexpected table: ${table}`);
    },
  };
  let handler;
  const Deno = { serve: fn => { handler = fn; }, env: { get: key => ({ SUPABASE_URL: 'https://db.example', SUPABASE_PUBLISHABLE_KEYS: '{"default":"publishable"}', SUPABASE_SECRET_KEYS: '{"default":"secret"}' })[key] } };
  const createClient = (_url, key) => key === 'secret' ? admin : user;
  const fetcher = async () => Response.json({ tag_name: 'v3.901.0', published_at: '2026-10-19T00:00:00Z', html_url: 'https://github.com/aws/aws-sdk-js-v3/releases/tag/v3.901.0', body: 'Release notes' });
  new Function('createClient', 'Deno', 'fetch', 'crypto', 'Request', 'Response', 'AbortSignal', js)(createClient, Deno, fetcher, crypto, Request, Response, AbortSignal);
  const response = await handler(new Request('https://db.example/functions/v1/check-aws-sdk', { method: 'POST', headers: { authorization: 'Bearer user-token' }, body: JSON.stringify({ workspaceId: 'a'.repeat(8) + '-aaaa-aaaa-aaaa-' + 'a'.repeat(12) }) }));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.state, 'changed');
  assert.equal(result.findings, 1);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].repository_id, 's3-repo');
  assert.equal(recorded[0].confidence, 'informational');
  assert.match(recorded[0].description, /no breaking change or code impact has been proven/i);
});
