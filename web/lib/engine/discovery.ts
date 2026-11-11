// Automatic provider discovery. Every external API host a scan finds is a
// candidate; Mend looks for that API's published OpenAPI description and,
// when one is found, watches it like a built-in provider:
//
//   1. the APIs.guru directory (thousands of public API descriptions, keyed
//      by provider domain), then
//   2. the conventional addresses on the API's own host (/openapi.json, …).
//
// When several descriptions are candidates, the one that matches the most
// endpoints the code actually calls wins, and it must match at least one.
// Hosts are untrusted (they come from repository code): only public DNS
// names over https are ever requested, and fetched documents are size-capped
// and treated as data. Pure functions here; fetching is injected.
import type { ProviderAdapter } from './types.ts';
import { listOperations, matchOperationKey } from './openapi-slice.ts';

export type HostCandidate = { url: string; source: 'apis.guru' | 'well-known'; name?: string };
export type ChosenContract = { url: string; source: HostCandidate['source']; name: string; basePath: string; matched: number; document: Record<string, unknown> };

const blockedSuffix = /(^|\.)(localhost|local|internal|intranet|corp|lan|home|test|example|invalid|onion|arpa)$/i;
const twoLevelSuffixes = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.jp', 'co.in', 'com.br', 'com.mx', 'co.za', 'com.sg', 'com.cn', 'com.tr']);

/** A public https origin Mend may request: DNS name with a dot, no IP literal, no internal suffix, no port. */
export function isPublicApiOrigin(origin: string): boolean {
  let url: URL;
  try { url = new URL(origin); } catch { return false; }
  const host = url.hostname.toLowerCase();
  return url.protocol === 'https:' && !url.port && !url.username && !url.password && url.origin === origin
    && host.length <= 253 && /^[a-z0-9.-]+$/.test(host) && host.includes('.') && !/^[\d.]+$/.test(host)
    && !host.startsWith('[') && !blockedSuffix.test(host) && host.split('.').every(label => label.length > 0 && label.length <= 63);
}

/** api.eu.zoom.us → zoom.us (with common two-level public suffixes). */
export function registrableDomain(host: string): string {
  const labels = host.toLowerCase().split('.');
  const lastTwo = labels.slice(-2).join('.');
  return labels.slice(twoLevelSuffixes.has(lastTwo) ? -3 : -2).join('.');
}

export const autoProviderId = (origin: string) => `auto:${new URL(origin).host}`;

type GuruVersion = { swaggerUrl?: unknown; info?: { title?: unknown } };
type GuruEntry = { preferred?: unknown; versions?: Record<string, GuruVersion> };

/** APIs.guru entries whose provider is this host or its registrable domain. */
export function guruCandidates(list: unknown, origin: string, limit = 6): HostCandidate[] {
  if (!list || typeof list !== 'object') return [];
  const host = new URL(origin).hostname.toLowerCase();
  const domain = registrableDomain(host);
  const out: HostCandidate[] = [];
  for (const [key, raw] of Object.entries(list as Record<string, GuruEntry>)) {
    const provider = key.split(':')[0].toLowerCase();
    if (provider !== host && provider !== domain) continue;
    const version = typeof raw?.preferred === 'string' ? raw.versions?.[raw.preferred] : undefined;
    const url = typeof version?.swaggerUrl === 'string' ? version.swaggerUrl : null;
    if (!url || !url.startsWith('https://api.apis.guru/')) continue;
    const title = typeof version?.info?.title === 'string' ? version.info.title.slice(0, 80) : key;
    // Exact host first, then the domain's other services.
    out.push({ url, source: 'apis.guru', name: title });
    if (provider === host) out.unshift(out.pop()!);
  }
  return out.slice(0, limit);
}

/** Where APIs conventionally publish their description. */
export function wellKnownUrls(origin: string): HostCandidate[] {
  return ['/openapi.json', '/swagger.json', '/.well-known/openapi.json', '/v3/api-docs', '/api/openapi.json', '/docs/openapi.json']
    .map(path => ({ url: `${origin}${path}`, source: 'well-known' as const }));
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

// Swagger 2.0 → the OpenAPI 3 shape the slicer reads: servers, request bodies
// (body and formData parameters) and $refs. Only what request diffing needs.
export function normalizeOpenApi(document: unknown): Record<string, unknown> | null {
  if (!isRecord(document)) return null;
  if (typeof document.openapi === 'string' && /^3\.(0|1)\./.test(document.openapi)) return document;
  if (document.swagger !== '2.0' || !isRecord(document.paths)) return null;
  const rewrite = (value: unknown, depth = 0): unknown => {
    if (depth > 64) return value;
    if (Array.isArray(value)) return value.map(item => rewrite(item, depth + 1));
    if (!isRecord(value)) return value;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = key === '$ref' && typeof item === 'string' ? item.replace(/^#\/definitions\//, '#/components/schemas/') : rewrite(item, depth + 1);
    }
    return out;
  };
  const scheme = Array.isArray(document.schemes) && document.schemes.includes('https') ? 'https' : 'https';
  const host = typeof document.host === 'string' ? document.host : '';
  const basePath = typeof document.basePath === 'string' ? document.basePath.replace(/\/+$/, '') : '';
  const paths: Record<string, unknown> = {};
  for (const [path, item] of Object.entries(document.paths)) {
    if (!isRecord(item)) continue;
    const next: Record<string, unknown> = {};
    const shared = Array.isArray(item.parameters) ? item.parameters : [];
    for (const [method, operation] of Object.entries(item)) {
      if (!isRecord(operation) || method === 'parameters') continue;
      const parameters = [...shared, ...(Array.isArray(operation.parameters) ? operation.parameters : [])].filter(isRecord);
      const body = parameters.find(parameter => parameter.in === 'body');
      const form = parameters.filter(parameter => parameter.in === 'formData' && typeof parameter.name === 'string');
      const kept = parameters.filter(parameter => parameter.in !== 'body' && parameter.in !== 'formData')
        .map(parameter => ({ ...parameter, schema: parameter.schema ?? (parameter.type ? { type: parameter.type } : undefined) }));
      const consumes = Array.isArray(operation.consumes) ? operation.consumes : Array.isArray(document.consumes) ? document.consumes : [];
      let requestBody: unknown;
      if (body && isRecord(body.schema)) requestBody = { required: body.required === true, content: { 'application/json': { schema: body.schema } } };
      else if (form.length) {
        const media = consumes.includes('multipart/form-data') ? 'multipart/form-data' : 'application/x-www-form-urlencoded';
        requestBody = { content: { [media]: { schema: { type: 'object',
          properties: Object.fromEntries(form.map(parameter => [parameter.name as string, { type: parameter.type ?? 'string', ...(parameter.enum ? { enum: parameter.enum } : {}) }])),
          required: form.filter(parameter => parameter.required === true).map(parameter => parameter.name) } } } };
      }
      const { parameters: _drop, consumes: _c, produces: _p, ...rest } = operation;
      next[method] = { ...rest, parameters: kept, ...(requestBody ? { requestBody } : {}), responses: isRecord(operation.responses) ? operation.responses : { default: { description: '' } } };
    }
    paths[path] = next;
  }
  return rewrite({
    openapi: '3.0.0', info: document.info ?? { title: '', version: '' },
    servers: host ? [{ url: `${scheme}://${host}${basePath}` }] : [],
    paths, components: { schemas: isRecord(document.definitions) ? document.definitions : {} },
  }) as Record<string, unknown>;
}

/** The path the description's servers put in front of every operation for this origin ('' when none). */
export function specBasePath(document: Record<string, unknown>, origin: string): string | null {
  const servers = Array.isArray(document.servers) ? document.servers : [];
  if (!servers.length) return '';
  for (const server of servers.slice(0, 10)) {
    if (!isRecord(server) || typeof server.url !== 'string' || server.url.includes('{')) continue;
    let url: URL;
    try { url = new URL(server.url, origin); } catch { continue; }
    if (url.origin === origin) return url.pathname.replace(/\/+$/, '');
  }
  return null;
}

/** How many called endpoints the description has an operation for. */
export function matchedEndpoints(document: Record<string, unknown>, basePath: string, endpoints: readonly string[]): number {
  const keys = listOperations(document);
  let matched = 0;
  for (const endpoint of endpoints) {
    const space = endpoint.indexOf(' ');
    const path = endpoint.slice(space + 1);
    const local = basePath && (path === basePath || path.startsWith(`${basePath}/`)) ? path.slice(basePath.length) || '/' : path;
    if (matchOperationKey(keys, `${endpoint.slice(0, space)} ${local}`)) matched++;
  }
  return matched;
}

/**
 * Choose among fetched candidate descriptions: it must serve this origin (or
 * name no server) and match at least one called endpoint; most matches wins.
 */
export function chooseContract(origin: string, endpoints: readonly string[], fetched: { candidate: HostCandidate; document: unknown }[]): ChosenContract | null {
  let best: ChosenContract | null = null;
  for (const { candidate, document } of fetched) {
    const normalized = normalizeOpenApi(document);
    if (!normalized) continue;
    const basePath = specBasePath(normalized, origin);
    if (basePath === null) continue;
    const matched = matchedEndpoints(normalized, basePath, endpoints);
    if (matched === 0 || (best && matched <= best.matched)) continue;
    const info = isRecord(normalized.info) ? normalized.info : {};
    const name = (candidate.name ?? (typeof info.title === 'string' ? info.title : new URL(origin).host)).replace(/[\u0000-\u001f]/g, ' ').slice(0, 80);
    best = { url: candidate.url, source: candidate.source, name, basePath, matched, document: normalized };
  }
  return best;
}

export type WatchedHostRow = { origin: string; provider_id: string; name: string | null; base_path: string | null; spec_url: string | null };

/** A discovered API as a provider adapter for the impact pipeline. */
export function autoProvider(row: WatchedHostRow): ProviderAdapter | null {
  if (!isPublicApiOrigin(row.origin) || row.provider_id !== autoProviderId(row.origin)) return null;
  return {
    id: row.provider_id, name: (row.name || new URL(row.origin).host).slice(0, 80), origins: [row.origin],
    ...(row.base_path ? { basePath: row.base_path } : {}),
    versioning: 'snapshot', snapshotApplicability: 'active',
    contractSources: row.spec_url ? [{ version: 'discovered', url: row.spec_url, format: 'openapi-json' }] : [],
  };
}
