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
export { latestSnapshotSource, withLatestSnapshot } from './provider-snapshot.ts';

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

/**
 * For discovered APIs, whose old descriptions cannot be downloaded again: the
 * baseline is kept as slices of every operation, and each new snapshot is
 * diffed against those slices. Returns the new version row and the slices of
 * operations whose request contract changed.
 */
export async function diffSnapshotAgainstSlices(input: {
  provider: ProviderAdapter; baseline: OperationSlice[]; baselineKeys: string[];
  toVersion: string; newDocument: unknown; newSha256: string; sourceUrl: string;
}): Promise<{ version: CatalogVersion; slices: OperationSlice[]; changes: ContractChange[]; skipped: string[] }> {
  const { provider, toVersion, sourceUrl } = input;
  const newKeys = new Set(listOperations(input.newDocument));
  const options = { providerName: provider.name, changelogUrl: sourceUrl };
  const slices: OperationSlice[] = [];
  const changes: ContractChange[] = [];
  const skipped: string[] = [];
  for (const before of input.baseline) {
    let found: ContractChange[];
    if (!newKeys.has(before.operation)) found = [diffRemovedOperation(before, { version: toVersion, sourceUrl, sha256: input.newSha256 }, options)];
    else {
      const after = await sliceOperation(input.newDocument, before.operation, { providerId: provider.id, version: toVersion, sourceUrl });
      if (!after) { skipped.push(before.operation); continue; }
      found = after.sha256 === before.sha256 ? [] : diffOperation(before, after, options);
      if (found.length) slices.push(after);
    }
    changes.push(...found);
  }
  return { version: { providerId: provider.id, version: toVersion, sha256: input.newSha256, sourceUrl, operationKeys: [...newKeys] }, slices, changes, skipped };
}

/** Slices of every operation, kept as a discovered API's baseline. */
export async function baselineSlices(provider: ProviderAdapter, version: string, document: unknown, sourceUrl: string, limit = 1_500) {
  const keys = listOperations(document).slice(0, limit);
  const slices: OperationSlice[] = [];
  for (const key of keys) {
    const slice = await sliceOperation(document, key, { providerId: provider.id, version, sourceUrl });
    if (slice) slices.push(slice);
  }
  return { keys, slices };
}
