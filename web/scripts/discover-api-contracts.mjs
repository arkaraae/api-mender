// Automatic API discovery and watching. Runs in GitHub Actions after the
// built-in catalog sync (.github/workflows/provider-contracts.yml).
//
//   1. Resolve: for each API origin scans have found (api_hosts), look for
//      its published OpenAPI description (APIs.guru, then conventional
//      addresses on the host) and keep the one matching the most called
//      endpoints. The first copy becomes the baseline: slices of every
//      operation.
//   2. Watch: download each watched description again; when it changed,
//      store the new version and slices of operations whose request contract
//      changed. The Worker's hourly recheck turns those into findings.
//
// Reads only public documents. Hosts come from tenants' code, so only public
// https DNS names are requested, downloads are size-capped, and documents
// are parsed as data.
//
//   node scripts/discover-api-contracts.mjs [--dry-run] [--limit 40]
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { parseArgs } from 'node:util';
import { createClient } from '@supabase/supabase-js';
import { autoProvider, autoProviderId, chooseContract, guruCandidates, isPublicApiOrigin, normalizeOpenApi, wellKnownUrls } from '../lib/engine/discovery.ts';
import { baselineSlices, diffSnapshotAgainstSlices } from '../lib/engine/provider-sync.ts';
import { providerForOrigin } from '../lib/engine/providers/registry.ts';

// One candidate document is held in memory at a time. APIs.guru's index and
// the largest real descriptions fit well under these caps.
const MAX_BYTES = 12 * 1024 * 1024;
const GURU_MAX_BYTES = 16 * 1024 * 1024;
const DAY = 86_400_000;
const { values } = parseArgs({ options: { 'dry-run': { type: 'boolean' }, limit: { type: 'string', default: '40' } } });
const limit = Math.min(Math.max(Number(values.limit) || 40, 1), 200);
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
if (!url || !key) { console.log('No catalog secret: discovery skipped'); process.exit(0); }
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const now = () => new Date().toISOString();
const later = days => new Date(Date.now() + days * DAY).toISOString();

// Hosts come from tenants' code. Names that resolve to private, loopback,
// link-local or metadata addresses are refused before any request. (The
// runner has no access to anything private either; this is the second line.)
const blocked = new BlockList();
for (const [net, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]]) blocked.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [['::', 127], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) blocked.addSubnet(net, bits, 'ipv6');
async function assertPublicHost(address) {
  const { hostname } = new URL(address);
  const host = hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true, verbatim: true });
  for (const { address: ip, family } of addresses) {
    if (blocked.check(ip, family === 6 ? 'ipv6' : 'ipv4')) throw new Error(`${hostname} resolves to a private address`);
  }
}

async function download(address, { followRedirects, maxBytes = MAX_BYTES }) {
  if (!address.startsWith('https://')) throw new Error('only https is fetched');
  await assertPublicHost(address);
  const response = await fetch(address, { redirect: followRedirects ? 'follow' : 'error', signal: AbortSignal.timeout(60_000),
    headers: { accept: 'application/json', 'user-agent': 'api-mender-catalog (+https://apimender.com)' } });
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
  if (Number(response.headers.get('content-length') || 0) > maxBytes) throw new Error(`larger than ${maxBytes >> 20} MB`);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel(); throw new Error(`larger than ${maxBytes >> 20} MB`); }
    chunks.push(value);
  }
  const bytes = Buffer.concat(chunks);
  return { document: JSON.parse(bytes.toString('utf8')), sha256: createHash('sha256').update(bytes).digest('hex') };
}

let guruList;
async function guru() {
  if (guruList === undefined) {
    try { guruList = (await download('https://api.apis.guru/v2/list.json', { followRedirects: false, maxBytes: GURU_MAX_BYTES })).document; }
    catch (error) { console.log(`APIs.guru unavailable: ${error.message}`); guruList = null; }
  }
  return guruList;
}

async function writeVersion(version, slices) {
  if (values['dry-run']) return;
  const { error } = await db.from('provider_contract_versions').upsert({ provider_id: version.providerId, version: version.version,
    sha256: version.sha256, source_url: version.sourceUrl, operation_keys: version.operationKeys, fetched_at: now() }, { onConflict: 'provider_id,version' });
  if (error) throw error;
  for (let index = 0; index < slices.length; index += 100) {
    const { error: sliceError } = await db.from('provider_contract_slices').upsert(slices.slice(index, index + 100).map(slice => ({
      provider_id: slice.providerId, version: slice.version, operation: slice.operation, sha256: slice.sha256,
      document: slice.document, source_url: slice.sourceUrl, fetched_at: now() })), { onConflict: 'provider_id,version,operation' });
    if (sliceError) throw sliceError;
  }
}

async function update(origin, fields) {
  if (values['dry-run']) { console.log('  would set', JSON.stringify(fields)); return; }
  const { error } = await db.from('api_hosts').update({ ...fields, checked_at: now() }).eq('origin', origin);
  if (error) throw error;
}

// A database without the discovery migration: nothing to do yet.
const { error: tableError } = await db.from('api_hosts').select('origin').limit(1);
if (tableError?.code === 'PGRST205' || tableError?.code === '42P01') {
  console.log('This database has no api_hosts table yet (apply 20261111010000_api_auto_discovery.sql); discovery skipped.');
  process.exit(0);
}
if (tableError) throw tableError;

// 1. Resolve hosts without a watched description.
const { data: pending, error: pendingError } = await db.from('api_hosts').select('origin,sample_endpoints,attempts')
  .in('status', ['pending', 'not-found', 'failed']).lte('next_check_at', now()).order('next_check_at').limit(limit);
if (pendingError) throw pendingError;
for (const host of pending ?? []) {
  const { origin } = host;
  try {
    // Claim the host first, so a crash or timeout mid-way never retries it
    // in a tight loop.
    if (!values['dry-run']) await db.from('api_hosts').update({ next_check_at: later(1) }).eq('origin', origin);
    if (providerForOrigin(origin)) { await update(origin, { status: 'not-found', detail: 'Watched as a built-in provider', next_check_at: later(365) }); continue; }
    if (!isPublicApiOrigin(origin)) { await update(origin, { status: 'not-found', detail: 'Not a public host', next_check_at: later(90) }); continue; }
    const endpoints = Array.isArray(host.sample_endpoints) ? host.sample_endpoints.filter(item => typeof item === 'string') : [];
    const candidates = [...guruCandidates(await guru(), origin), ...wellKnownUrls(origin)].slice(0, 10);
    // Keep only the best match so far; every other document is dropped as
    // soon as it has been scored.
    let chosen = null;
    let chosenSha = null;
    let documents = 0;
    for (const candidate of candidates) {
      try {
        const { document, sha256 } = await download(candidate.url, { followRedirects: candidate.source === 'apis.guru' });
        documents++;
        const pick = chooseContract(origin, endpoints, [{ candidate, document }]);
        if (pick && (!chosen || pick.matched > chosen.matched)) { chosen = pick; chosenSha = sha256; }
      } catch { /* not published there */ }
    }
    if (!chosen) {
      console.log(`${origin}: no published description found (${documents} candidate documents)`);
      // Back off: weekly, then monthly.
      await update(origin, { status: 'not-found', attempts: (host.attempts ?? 0) + 1, detail: 'No public OpenAPI description found',
        next_check_at: later((host.attempts ?? 0) >= 4 ? 30 : 7) });
      continue;
    }
    const sha256 = chosenSha;
    const provider = autoProvider({ origin, provider_id: autoProviderId(origin), name: chosen.name, base_path: chosen.basePath, spec_url: chosen.url });
    const version = now().slice(0, 10);
    const { keys, slices } = await baselineSlices(provider, version, chosen.document, chosen.url);
    await writeVersion({ providerId: provider.id, version, sha256, sourceUrl: chosen.url, operationKeys: keys }, slices);
    console.log(`${origin}: watching ${chosen.name} from ${chosen.source} (${keys.length} operations, ${chosen.matched} called endpoints matched)`);
    await update(origin, { status: 'watching', name: chosen.name, spec_url: chosen.url, spec_source: chosen.source, base_path: chosen.basePath || null,
      attempts: 0, detail: `${chosen.matched} called endpoint(s) matched`, next_check_at: later(1) });
  } catch (error) {
    console.log(`${origin}: ${error.message}`);
    await update(origin, { status: 'failed', attempts: (host.attempts ?? 0) + 1, detail: String(error.message).slice(0, 300), next_check_at: later(1) });
  }
}

// 2. Re-download watched descriptions and record changes.
const { data: watched, error: watchedError } = await db.from('api_hosts').select('origin,provider_id,name,base_path,spec_url')
  .eq('status', 'watching').lte('next_check_at', now()).order('next_check_at').limit(limit * 3);
if (watchedError) throw watchedError;
for (const row of watched ?? []) {
  const provider = autoProvider(row);
  if (!provider || !row.spec_url) continue;
  try {
    if (!values['dry-run']) await db.from('api_hosts').update({ next_check_at: later(1) }).eq('origin', row.origin);
    const { document, sha256 } = await download(row.spec_url, { followRedirects: row.spec_url.startsWith('https://api.apis.guru/') });
    const normalized = normalizeOpenApi(document);
    if (!normalized) throw new Error('no longer an OpenAPI description');
    const { data: versions, error } = await db.from('provider_contract_versions').select('version,sha256,operation_keys')
      .eq('provider_id', provider.id).order('version');
    if (error) throw error;
    const baseline = versions?.[0];
    const newest = versions?.at(-1);
    if (!baseline || newest?.sha256 === sha256) { await update(row.origin, { next_check_at: later(1) }); continue; }
    const { data: baseSlices, error: sliceError } = await db.from('provider_contract_slices').select('provider_id,version,operation,sha256,document,source_url')
      .eq('provider_id', provider.id).eq('version', baseline.version).limit(2_000);
    if (sliceError) throw sliceError;
    let label = now().slice(0, 10);
    if (label === baseline.version) label = `${label}.2`;
    const delta = await diffSnapshotAgainstSlices({ provider, toVersion: label, newDocument: normalized, newSha256: sha256, sourceUrl: row.spec_url,
      baselineKeys: baseline.operation_keys, baseline: (baseSlices ?? []).map(slice => ({ providerId: slice.provider_id, version: slice.version,
        operation: slice.operation, sha256: slice.sha256, document: slice.document, sourceUrl: slice.source_url })) });
    await writeVersion(delta.version, delta.slices);
    console.log(`${row.origin}: new description ${label}: ${delta.changes.length} request-contract change(s) since ${baseline.version}`);
    for (const change of delta.changes.slice(0, 20)) console.log(`  ${change.kind.padEnd(30)} ${change.operation}  [${change.fields.join(', ')}]`);
    await update(row.origin, { next_check_at: later(1), detail: `${delta.changes.length} change(s) since ${baseline.version}` });
  } catch (error) {
    console.log(`${row.origin}: ${error.message}`);
    await update(row.origin, { next_check_at: later(1), detail: String(error.message).slice(0, 300) });
  }
}
