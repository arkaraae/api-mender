// Public API of the provider-independent pipeline (find half).
export type * from './types.ts';
export { canonicalJson, sha256Hex } from './hash.ts';
export { contractSourceFor, getProvider, listProviders, providerForOrigin } from './providers/registry.ts';
export {
  dynamicSegmentsAlign, isTruncated, listOperations, matchOperationKey, parseOperationKey,
  requestSchemaOf, sliceOperation, sliceOperations,
} from './openapi-slice.ts';
export type { SliceMeta } from './openapi-slice.ts';
export { discoverApiUsage, inventoryFromCalls, isScannableSource, mapServiceOperations, parseApiCalls } from './inventory.ts';
export type { DiscoverOptions } from './inventory.ts';
export { diffOperation, diffRemovedOperation, replacementCandidates } from './contract-diff.ts';
export type { DiffOptions } from './contract-diff.ts';
export { analyzeImpact } from './impact.ts';
export type { ImpactInput } from './impact.ts';
export { findProviderImpact } from './pipeline.ts';
export type { FindInput, FindResult } from './pipeline.ts';

// --- repair/ exports go here (owned by the repair module) ---
