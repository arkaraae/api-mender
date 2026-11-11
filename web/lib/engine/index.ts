// Public API of the provider-independent pipeline (find half).
export type * from './types.ts';
export { canonicalJson, sha256Hex } from './hash.ts';
export { contractEndpoint, contractSourceFor, getProvider, listProviders, providerForOrigin } from './providers/registry.ts';
export { latestSnapshotSource, withLatestSnapshot } from './provider-snapshot.ts';
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


// Repair half: bounded proposals checked by deterministic gates.
export { deterministicRename, proposeRepair } from './repair/index.ts';
export type { ProposeRepairInput } from './repair/index.ts';
export {
  HOSTED_AI_PROVIDER_DOMAINS, POLICY_GATES, RESPONSE_SCHEMA, SYSTEM_PROMPT, applyLineEdits, applyUnifiedDiff,
  assertPrivateModelEndpoint, buildMessages, buildRepairTask, evaluatePatch, excerptContainsSecret, findSecrets,
  isHostedAiProviderHost, parseModelDecision, requestStructuredCompletion, unifiedDiff,
} from './repair/index.ts';
export type { RepairContract, RepairTask, SupportedRepairTask } from './repair/index.ts';
export { repairContractFor } from './repair/contract.ts';

// Customer-managed boundary: the only report that may leave the customer.
export { REPORT_FIELD_GROUPS, buildMetadataReport, isReportRejection, validateMetadataReport } from './boundary.ts';
export type { MetadataReport, ReportFieldGroup } from './boundary.ts';
