// Provider contracts for the CLI. Authoritative documents only: either a
// local file the operator points at, or the URL named by the provider
// adapter (never a URL from repository content). Downloads are cached by
// content address so offline and CI runs can reuse them.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const MAX_CONTRACT_BYTES = 64 * 1024 * 1024;

function cacheDir() {
  return process.env.MENDER_CACHE_DIR || path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'mender', 'contracts');
}

async function download(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error(`refusing non-https contract URL ${parsed.origin}`);
  const response = await fetch(parsed, { redirect: 'error', signal: AbortSignal.timeout(120_000),
    headers: { accept: 'application/json', 'user-agent': 'mender-cli' } });
  if (!response.ok) throw new Error(`contract download returned HTTP ${response.status} for ${parsed.origin}${parsed.pathname}`);
  const length = Number(response.headers.get('content-length') || 0);
  if (length > MAX_CONTRACT_BYTES) throw new Error('contract is larger than the 64 MB limit');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_CONTRACT_BYTES) { await reader.cancel(); throw new Error('contract is larger than the 64 MB limit'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * Load the contract document for one provider version.
 * @param {{ contractSources: { version: string, url: string }[], id: string }} provider
 * @param {string} version
 * @param {{ file?: string, offline?: boolean }} [options]
 * @returns {Promise<{ document: unknown, sha256: string, origin: 'file' | 'cache' | 'download', url: string | null }>}
 */
export async function loadContract(provider, version, options = {}) {
  let bytes;
  let origin;
  let url = null;
  if (options.file) {
    bytes = await readFile(options.file);
    if (bytes.byteLength > MAX_CONTRACT_BYTES) throw new Error(`${options.file} is larger than the 64 MB limit`);
    origin = 'file';
  } else {
    const source = provider.contractSources.find(item => item.version === version);
    if (!source) throw new Error(`${provider.id} has no published contract for version ${version}; known: ${provider.contractSources.map(item => item.version).join(', ')}`);
    url = source.url;
    const key = createHash('sha256').update(url).digest('hex');
    const cached = path.join(cacheDir(), `${key}.json`);
    bytes = await readFile(cached).catch(() => null);
    origin = 'cache';
    if (!bytes) {
      if (options.offline) throw new Error(`contract ${provider.id} ${version} is not cached and --offline was given`);
      bytes = await download(url);
      origin = 'download';
      await mkdir(cacheDir(), { recursive: true, mode: 0o700 });
      const temp = `${cached}.${process.pid}.tmp`;
      await writeFile(temp, bytes, { mode: 0o600 });
      await rename(temp, cached);
    }
  }
  let document;
  try { document = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error(`contract ${provider.id} ${version} is not valid JSON`); }
  // A wrong file must fail loudly, not look like "no operations used".
  if (!document || typeof document !== 'object' || Array.isArray(document) || typeof document.openapi !== 'string'
    || !/^3\.[01]\./.test(document.openapi) || !document.paths || typeof document.paths !== 'object')
    throw new Error(`contract ${provider.id} ${version} is not an OpenAPI 3.0/3.1 document`);
  return { document, sha256: createHash('sha256').update(bytes).digest('hex'), origin, url };
}
