// Provider change ingestion job. Runs in GitHub Actions on a schedule (see
// .github/workflows/provider-contracts.yml) or by hand. It reads only public,
// authoritative provider contracts and writes only public catalog rows; it
// never sees tenant data.
//
//   node scripts/sync-provider-contracts.mjs [--provider github-rest] [--from V --to V]
//        [--old FILE --new FILE] [--out delta.json] [--write]
//
// --write upserts into Supabase (NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SECRET_KEY);
// without it the delta is only printed / saved, so the job can be reviewed first.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createClient } from '@supabase/supabase-js';
import { buildCatalogDelta, withLatestSnapshot } from '../lib/engine/provider-sync.ts';
import { getProvider, listProviders } from '../lib/engine/providers/registry.ts';

const MAX_BYTES = 64 * 1024 * 1024;
const { values } = parseArgs({ options: {
  provider: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' },
  old: { type: 'string' }, new: { type: 'string' }, out: { type: 'string' }, write: { type: 'boolean' },
} });

async function load(path, url) {
  let bytes;
  if (path) bytes = await readFile(path);
  else {
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(180_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  if (bytes.byteLength > MAX_BYTES) throw new Error('contract exceeds 64 MB');
  return { document: JSON.parse(bytes.toString('utf8')), sha256: createHash('sha256').update(bytes).digest('hex') };
}

const selected = values.provider ? [getProvider(values.provider)] : listProviders();
if (selected.includes(null)) throw new Error(`unknown provider ${values.provider}`);
// Snapshot providers: the newest commit of their published contract is the
// newest version; the adapter's baseline is the oldest.
const providers = [];
for (const provider of selected) {
  // --new FILE --to V reviews a downloaded snapshot without asking GitHub for the newest commit.
  if (provider.versioning === 'snapshot' && values.new && values.to)
    providers.push({ ...provider, contractSources: [...provider.contractSources, { version: values.to, url: `file:${values.new}`, format: 'openapi-json' }] });
  else providers.push(await withLatestSnapshot(provider, fetch, process.env.GITHUB_TOKEN));
}
const deltas = [];
for (const provider of providers) {
  const versions = provider.contractSources.map(source => source.version);
  const to = values.to ?? versions.at(-1);
  if (versions.length < 2 && !values.from) {
    console.log(`${provider.id}: newest published contract is still the baseline ${versions[0]}`);
    continue;
  }
  // Every older version is compared with the newest, so a call pinned to any
  // of them can be checked.
  for (const from of values.from ? [values.from] : versions.slice(0, -1)) {
    const source = version => provider.contractSources.find(item => item.version === version)?.url;
    const [before, after] = [await load(values.old, source(from)), await load(values.new, source(to))];
    const delta = await buildCatalogDelta({ provider, fromVersion: from, toVersion: to,
      oldDocument: before.document, newDocument: after.document, oldSha256: before.sha256, newSha256: after.sha256 });
    console.log(`${provider.id} ${from} → ${to}: ${delta.versions[0].operationKeys.length} operations, `
      + `${delta.changes.length} request-contract changes in ${new Set(delta.changes.map(c => c.operation)).size} operations, `
      + `${delta.slices.length} slices, ${delta.skipped.length} skipped`);
    for (const change of delta.changes) console.log(`  ${change.kind.padEnd(30)} ${change.operation}  [${change.fields.join(', ')}]`);
    deltas.push(delta);
  }
}

if (values.out) await writeFile(values.out, JSON.stringify(deltas, null, 2));
if (values.write) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY are required for --write');
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  for (const delta of deltas) {
    const { error: versionError } = await db.from('provider_contract_versions').upsert(delta.versions.map(version => ({
      provider_id: version.providerId, version: version.version, sha256: version.sha256,
      source_url: version.sourceUrl, operation_keys: version.operationKeys, fetched_at: new Date().toISOString(),
    })), { onConflict: 'provider_id,version' });
    if (versionError) throw versionError;
    for (let index = 0; index < delta.slices.length; index += 100) {
      const { error } = await db.from('provider_contract_slices').upsert(delta.slices.slice(index, index + 100).map(slice => ({
        provider_id: slice.providerId, version: slice.version, operation: slice.operation, sha256: slice.sha256,
        document: slice.document, source_url: slice.sourceUrl, fetched_at: new Date().toISOString(),
      })), { onConflict: 'provider_id,version,operation' });
      if (error) throw error;
    }
  }
  console.log('catalog written');
}
