import type { ApiCall, ContractChange, Finding, OperationSlice, ProviderAdapter, UsageInventory } from './types.ts';
import { diffOperation, diffRemovedOperation } from './contract-diff.ts';
import { analyzeImpact } from './impact.ts';
import { discoverApiUsage, inventoryFromCalls, mapServiceOperations } from './inventory.ts';
import { dynamicSegmentsAlign, listOperations, matchOperationKey, sliceOperations } from './openapi-slice.ts';
import { contractSourceFor, listProviders } from './providers/registry.ts';
import { byText } from './text.ts';

export type FindInput = {
  provider: ProviderAdapter;
  /** Parsed OpenAPI documents for the two versions. Untrusted. */
  oldDocument: unknown;
  newDocument: unknown;
  fromVersion: string;
  toVersion: string;
} & ({ files: Iterable<{ path: string; source: string }>; calls?: undefined } | { calls: ApiCall[]; files?: undefined });

export type FindResult = {
  inventory: UsageInventory;
  slices: { old: OperationSlice[]; new: OperationSlice[] };
  changes: ContractChange[];
  findings: Finding[];
};

// A path whose parameter names are blanked, to find an operation whose
// parameters were merely renamed between versions.
const shapeOf = (operation: string) => operation.replace(/\{[^{}/]+\}/g, '{}');

// A match that would lay a blanked parameter over a literal segment is a
// different operation, not a rename.
function renamed(newKeys: string[], key: string): string | null {
  const found = matchOperationKey(newKeys, shapeOf(key));
  return found && dynamicSegmentsAlign(found, shapeOf(key)) ? found : null;
}

// Usage-driven ingestion for callers that already hold both documents: only
// the operations the code actually calls are cut out, diffed and checked.
export async function findProviderImpact(input: FindInput): Promise<FindResult> {
  const { provider, fromVersion, toVersion } = input;
  const providers = [provider, ...listProviders().filter(known => known.id !== provider.id)];
  const scanned = input.files ? discoverApiUsage(input.files, { providers }) : inventoryFromCalls(input.calls, { providers });
  const calls = scanned.calls.filter(call => provider.origins.includes(call.origin));

  const oldKeys = listOperations(input.oldDocument);
  const newKeys = listOperations(input.newDocument);
  const used = [...new Set(calls.map(call => matchOperationKey(oldKeys, call.endpoint)).filter((key): key is string => key !== null))].sort(byText);
  // The same operation in the new contract, by exact key or by path shape.
  const counterpart = new Map(used.map(key => [key, newKeys.includes(key) ? key : renamed(newKeys, key)]));

  const oldSource = contractSourceFor(provider, fromVersion);
  const newSource = contractSourceFor(provider, toVersion);
  const old = await sliceOperations(input.oldDocument, used, { providerId: provider.id, version: fromVersion, sourceUrl: oldSource?.url ?? '' });
  const next = await sliceOperations(input.newDocument, [...counterpart.values()].filter((key): key is string => key !== null),
    { providerId: provider.id, version: toVersion, sourceUrl: newSource?.url ?? '' });

  const options = { providerName: provider.name, changelogUrl: newSource?.changelogUrl };
  const changes: ContractChange[] = [];
  for (const oldSlice of old.slices) {
    const key = counterpart.get(oldSlice.operation);
    const newSlice = next.slices.find(slice => slice.operation === key);
    if (key === null) changes.push(diffRemovedOperation(oldSlice, { version: toVersion, sourceUrl: newSource?.url ?? '' }, options));
    else if (newSlice) changes.push(...diffOperation(oldSlice, newSlice, options));
  }

  const mapped = mapServiceOperations(scanned, provider.id, oldKeys);
  return {
    inventory: { ...mapped, limitations: [...mapped.limitations, ...old.limitations, ...next.limitations] },
    slices: { old: old.slices, new: next.slices },
    changes,
    findings: await analyzeImpact({ provider, changes, calls, operationKeys: oldKeys }),
  };
}
