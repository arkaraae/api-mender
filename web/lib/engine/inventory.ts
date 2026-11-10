import { parseHttpCallDetails } from '../static-http-calls.ts';
import type { ApiCall, IntegratedService, ProviderAdapter, UsageInventory } from './types.ts';
import { matchOperationKey } from './openapi-slice.ts';
import { listProviders, providerForOrigin } from './providers/registry.ts';
import { byText } from './text.ts';

// Repository content is untrusted: nothing here runs it, follows a URL found
// in it, or reads more than the bounds below.

// Same exclusions as the hosted scanner (ignoredDirectory and the test-file
// rule in ../public-scan.ts), so both report the same call sites.
const ignoredDirectory = /(^|\/)(node_modules|dist|build|vendor|fixtures|examples|__tests__|\.next)\//;
const sourceFile = /\.[cm]?[jt]sx?$/;
const testFile = /\.(test|spec)\.[cm]?[jt]sx?$/;
const maxFileLength = 300_000;
const maxExamined = 50_000;

export type DiscoverOptions = {
  /** Eligible files parsed before the scan stops. Default 2000. */
  maxFiles?: number;
  /** Call sites kept. Default 2000. */
  maxCalls?: number;
  /** Catalog to recognise origins with. Default: the provider registry. */
  providers?: ProviderAdapter[];
};

export function isScannableSource(path: string, source: string): boolean {
  return typeof path === 'string' && typeof source === 'string'
    && path.length <= 256 && source.length <= maxFileLength
    && sourceFile.test(path) && !path.endsWith('.d.ts') && !testFile.test(path) && !ignoredDirectory.test(path)
    && !path.split('/').some(part => part === '.' || part === '..');
}

// A superset of parseStaticHttpCalls: also template-literal URLs with a
// literal https origin (each dynamic path segment is written `{}`), literal
// request headers and the last line of the call. Shares that parser's bounds.
export function parseApiCalls(file: string, source: string): ApiCall[] {
  return parseHttpCallDetails(file, source).map(({ call, endLine, headers, headersComplete }) => ({
    file: call.file, line: call.line, ...(endLine === undefined ? {} : { endLine }),
    symbol: call.symbol, endpoint: call.endpoint, origin: call.origin,
    fields: call.fields, fieldsComplete: call.fieldsComplete,
    ...(call.bodyLine === undefined ? {} : { bodyLine: call.bodyLine }),
    ...(headers === undefined ? {} : { headers }),
    headersComplete,
  }));
}

function byLocation(a: ApiCall, b: ApiCall) {
  return byText(a.file, b.file) || a.line - b.line || byText(a.endpoint, b.endpoint);
}

function hostOf(origin: string) {
  try { return new URL(origin).host; } catch { return 'invalid'; }
}

// One service per origin. `operations` holds raw call endpoints until
// mapServiceOperations is given the provider's contract keys.
function groupServices(calls: ApiCall[], providers: ProviderAdapter[]): IntegratedService[] {
  const byOrigin = new Map<string, ApiCall[]>();
  for (const call of calls) byOrigin.set(call.origin, [...(byOrigin.get(call.origin) || []), call]);
  return [...byOrigin.keys()].sort(byText).map(origin => {
    const used = byOrigin.get(origin)!;
    const provider = providerForOrigin(origin, providers);
    const header = provider?.versionHeader;
    const pinned = header ? used.flatMap(call => {
      const value = call.headers && Object.hasOwn(call.headers, header) ? call.headers[header] : undefined;
      return typeof value === 'string' ? [value] : [];
    }) : [];
    return {
      providerId: provider?.id ?? `unknown:${hostOf(origin)}`,
      providerName: provider?.name ?? hostOf(origin),
      origin,
      operations: [...new Set(used.map(call => call.endpoint))].sort(byText),
      callCount: used.length,
      files: [...new Set(used.map(call => call.file))].sort(byText),
      pinnedVersions: [...new Set(pinned)].sort(byText),
      recognition: provider ? 'catalog' : 'unknown-origin',
    };
  });
}

const baseLimitations = [
  'Only fetch and axios calls whose URL starts with a literal https origin are detected; clients built another way are not listed',
  'Static scan only: no repository code was executed and no call was sent',
  'Test, fixture, example, vendored and build files are excluded',
];

// Builds an inventory from calls a caller already holds (for example from a
// stored scan). Calls are sorted by file, line and endpoint.
export function inventoryFromCalls(calls: readonly ApiCall[], options: DiscoverOptions & { filesScanned?: number; limitations?: string[] } = {}): UsageInventory {
  const maxCalls = options.maxCalls ?? 2_000;
  const kept = [...calls].sort(byLocation).slice(0, maxCalls);
  return {
    schemaVersion: 1,
    calls: kept,
    services: groupServices(kept, options.providers ?? listProviders()),
    filesScanned: options.filesScanned ?? new Set(kept.map(call => call.file)).size,
    limitations: [...baseLimitations, ...(options.limitations ?? []),
      ...(calls.length > maxCalls ? [`Only the first ${maxCalls} call sites were retained`] : [])],
  };
}

export function discoverApiUsage(files: Iterable<{ path: string; source: string }>, options: DiscoverOptions = {}): UsageInventory {
  const maxFiles = options.maxFiles ?? 2_000;
  const maxCalls = options.maxCalls ?? 2_000;
  const calls: ApiCall[] = [];
  const limitations: string[] = [];
  let examined = 0;
  let scanned = 0;
  for (const file of files) {
    if (++examined > maxExamined || scanned >= maxFiles) {
      limitations.push(`Scan stopped after ${scanned} files; later files were not read`);
      break;
    }
    if (!file || !isScannableSource(file.path, file.source)) continue;
    scanned++;
    // Cheap text test first, as the hosted scanner does, before a full parse.
    if (!/\bfetch\s*\(|\baxios\./.test(file.source)) continue;
    calls.push(...parseApiCalls(file.path, file.source));
    // Files are already bounded by maxFiles and each parse by its own cap,
    // so keep reading; inventoryFromCalls trims to maxCalls and says so.
    if (calls.length > maxCalls * 4) break;
  }
  return inventoryFromCalls(calls, { ...options, filesScanned: scanned, limitations });
}

// Rewrites one provider's raw call endpoints as contract operation keys.
// Endpoints that match no key (or match ambiguously) are kept as written.
export function mapServiceOperations(inventory: UsageInventory, providerId: string, operationKeys: readonly string[]): UsageInventory {
  return { ...inventory, services: inventory.services.map(service => (service.providerId !== providerId ? service : {
    ...service,
    operations: [...new Set(service.operations.map(endpoint => matchOperationKey(operationKeys, endpoint) ?? endpoint))].sort(byText),
  })) };
}
