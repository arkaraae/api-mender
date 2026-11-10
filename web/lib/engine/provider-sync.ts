// Provider change ingestion, run offline (web/scripts/sync-provider-contracts.mjs),
// never in the Worker: provider documents are tens of megabytes.
//
// For two versions of one provider's official contract, every operation is
// sliced and diffed. The catalog keeps every operation key (for matching
// calls) and slices of only the operations whose request contract changed.
import type { ContractChange, OperationSlice, ProviderAdapter } from './types.ts';
import { diffOperation, diffRemovedOperation } from './contract-diff.ts';
import { listOperations, sliceOperation } from './openapi-slice.ts';
import { contractSourceFor } from './providers/registry.ts';

export type CatalogVersion = { providerId: string; version: string; sha256: string; sourceUrl: string; operationKeys: string[] };
export type CatalogDelta = {
  versions: CatalogVersion[];
  slices: OperationSlice[];
  changes: ContractChange[];
  /** Operations that could not be sliced within the bounds (reported, not guessed). */
  skipped: string[];
};

export async function buildCatalogDelta(input: {
  provider: ProviderAdapter; fromVersion: string; toVersion: string;
  oldDocument: unknown; newDocument: unknown; oldSha256: string; newSha256: string;
}): Promise<CatalogDelta> {
  const { provider, fromVersion, toVersion } = input;
  const oldUrl = contractSourceFor(provider, fromVersion)?.url ?? '';
  const newUrl = contractSourceFor(provider, toVersion)?.url ?? '';
  const oldKeys = listOperations(input.oldDocument);
  const newKeys = new Set(listOperations(input.newDocument));
  const options = { providerName: provider.name, changelogUrl: contractSourceFor(provider, toVersion)?.changelogUrl };
  const slices = new Map<string, OperationSlice>();
  const changes: ContractChange[] = [];
  const skipped: string[] = [];
  for (const key of oldKeys) {
    const before = await sliceOperation(input.oldDocument, key, { providerId: provider.id, version: fromVersion, sourceUrl: oldUrl });
    if (!before) { skipped.push(key); continue; }
    let found: ContractChange[];
    let after: OperationSlice | null = null;
    if (!newKeys.has(key)) found = [diffRemovedOperation(before, { version: toVersion, sourceUrl: newUrl }, options)];
    else {
      after = await sliceOperation(input.newDocument, key, { providerId: provider.id, version: toVersion, sourceUrl: newUrl });
      if (!after) { skipped.push(key); continue; }
      // Identical slices cannot differ; skip the comparison.
      found = after.sha256 === before.sha256 ? [] : diffOperation(before, after, options);
    }
    if (!found.length) continue;
    changes.push(...found);
    slices.set(`${fromVersion}\0${key}`, before);
    if (after) slices.set(`${toVersion}\0${key}`, after);
  }
  return {
    versions: [
      { providerId: provider.id, version: fromVersion, sha256: input.oldSha256, sourceUrl: oldUrl, operationKeys: oldKeys },
      { providerId: provider.id, version: toVersion, sha256: input.newSha256, sourceUrl: newUrl, operationKeys: [...newKeys] },
    ],
    slices: [...slices.values()], changes, skipped,
  };
}
