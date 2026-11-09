// Shared contract for the provider-independent Mender pipeline:
//
//   repository discovery → API usage inventory → provider change ingestion →
//   contract diff → impact analysis → evidence-backed finding →
//   bounded repair proposal → validation → draft PR or CLI patch
//
// Everything under lib/engine must run unchanged in three places: the
// Cloudflare Worker, the Mender CLI (Node), and tests. Use only Web APIs
// (fetch, crypto.subtle, TextEncoder) and @babel/parser. No node:* imports,
// no process.env, no filesystem. Callers inject files, contracts and fetch.
//
// Every value here is plain JSON so it can be written to a report file.

/** A static call site found by parsing. Compatible with HttpCallSite in ../static-http-calls.ts. */
export type ApiCall = {
  file: string;
  /** 1-based line of the call expression. */
  line: number;
  /** 1-based last line of the call expression, when known. */
  endLine?: number;
  symbol: string;
  /** `METHOD /path`. Dynamic path segments from template literals are written as `{}`. */
  endpoint: string;
  origin: string;
  /** Top-level JSON request keys, only meaningful when fieldsComplete is true. */
  fields: string[];
  fieldsComplete: boolean;
  bodyLine?: number;
  /** Literal request headers, lower-cased names. Absent when headers are dynamic or unknown. */
  headers?: Record<string, string>;
  /** True when the header object was fully literal, so a missing header is known to be missing. */
  headersComplete?: boolean;
};

/** One external API a codebase uses, as shown under Integrated Services. */
export type IntegratedService = {
  providerId: string;
  providerName: string;
  origin: string;
  /** Distinct operations in use, as contract operation keys where they matched. */
  operations: string[];
  callCount: number;
  files: string[];
  /** Version the code pins through the provider's version header, when it is a literal. */
  pinnedVersions: string[];
  /** 'catalog' when a ProviderAdapter recognised the origin, 'unknown-origin' otherwise. */
  recognition: 'catalog' | 'unknown-origin';
};

export type UsageInventory = {
  schemaVersion: 1;
  calls: ApiCall[];
  services: IntegratedService[];
  filesScanned: number;
  limitations: string[];
};

/** Where an authoritative contract for one provider version can be fetched. */
export type ContractSource = {
  version: string;
  /** Must be https. The engine never follows a source URL that came from repository content. */
  url: string;
  format: 'openapi-json';
  /** Human-readable page describing breaking changes, shown as evidence only. */
  changelogUrl?: string;
};

/**
 * A provider integration. Adding a provider means adding one adapter; nothing
 * else in the pipeline names a provider.
 */
export type ProviderAdapter = {
  id: string;
  name: string;
  /** HTTPS origins that identify calls to this provider. */
  origins: string[];
  /** Request header that selects an API version, lower-case, when the provider has one. */
  versionHeader?: string;
  /** Version the provider applies when the header is absent. */
  defaultVersion?: string;
  /** Known contract versions, oldest first. */
  contractSources: ContractSource[];
};

/**
 * One operation cut out of a provider contract. A whole provider document can
 * be tens of megabytes; slices are what get stored, diffed and shown to a model.
 */
export type OperationSlice = {
  providerId: string;
  version: string;
  /** `METHOD /path/{param}` exactly as the contract writes it. */
  operation: string;
  /** Self-contained OpenAPI 3 document holding only this operation, $refs resolved. */
  document: object;
  /** SHA-256 of the canonical JSON of `document`. */
  sha256: string;
  sourceUrl: string;
};

export type ChangeKind =
  | 'request-property-removed'
  | 'request-property-required'
  | 'request-property-type-changed'
  | 'operation-removed'
  | 'other';

export type ContractChange = {
  providerId: string;
  operation: string;
  fromVersion: string;
  toVersion: string;
  kind: ChangeKind;
  /** Request fields the change concerns. */
  fields: string[];
  /** One sentence, derived from the contracts, saying what changed upstream. */
  summary: string;
  /** Schemas of the affected fields before and after (null when absent). Bounded in size. */
  before: Record<string, unknown | null>;
  after: Record<string, unknown | null>;
  oldSha256: string;
  newSha256: string;
  oldSourceUrl: string;
  newSourceUrl: string;
  changelogUrl?: string;
};

/** Whether the break affects this call today. */
export type Applicability =
  /** The call pins or defaults to a version where the change is live. */
  | 'active'
  /** The call pins an older version; the break lands on upgrade or when that version is retired. */
  | 'on-upgrade'
  | 'unknown';

export type Confidence = 'high' | 'medium' | 'low';

/** 'test-confirmed' only when a configured check failed before the patch and passed after it. */
export type Verification = 'static-inferred' | 'test-confirmed';

export type Finding = {
  schemaVersion: 1;
  /** SHA-256 over provider, operation, change kind, fields, versions, file and line. */
  id: string;
  provider: { id: string; name: string };
  title: string;
  /** What changed upstream. */
  change: ContractChange;
  /** The exact repository location that uses the affected API. */
  location: { file: string; line: number; endLine?: number; bodyLine?: number; symbol: string };
  /** What may break and why. */
  impact: {
    summary: string;
    /** How the provider treats the old request once the change applies. */
    failureMode: 'request-rejected' | 'value-silently-ignored' | 'unknown';
  };
  evidence: {
    call: ApiCall;
    /** Version read from a literal version header, or null. */
    pinnedVersion: string | null;
    applicability: Applicability;
    /** Each deterministic check that supports the finding, in plain words. */
    staticChecks: string[];
    /** What this finding does not establish. */
    limits: string[];
  };
  confidence: Confidence;
  verification: Verification;
  /** True when the engine has a bounded repair strategy for this change kind and call shape. */
  repairable: boolean;
};

/** A replacement of whole lines inside the excerpt the model was shown. */
export type LineEdit = {
  /** 1-based, inclusive, in the original file. */
  startLine: number;
  endLine: number;
  /** Replacement text for those lines, without a trailing newline. */
  replacement: string;
};

export type RepairMethod = 'deterministic' | 'self-hosted-model';

export type PolicyCheck = { name: string; passed: boolean; detail: string };

export type RepairProposal = {
  schemaVersion: 1;
  findingId: string;
  method: RepairMethod;
  /** Model identifier as configured, null for deterministic repairs. */
  model: string | null;
  file: string;
  edits: LineEdit[];
  /** Unified diff against the original file, `a/<file>` → `b/<file>`. Applies with `git apply`. */
  diff: string;
  sourceSha256: string;
  patchedSha256: string;
  /** Every gate the patch passed. A proposal is only returned when all passed. */
  policy: PolicyCheck[];
  /** The model's one-line reason, treated as untrusted text for display only. */
  rationale: string;
  /** What remains unproven after static checks. */
  uncertainty: string[];
};

/** Why no patch was produced. Abstaining is a normal outcome, not an error. */
export type RepairAbstention = {
  schemaVersion: 1;
  findingId: string;
  abstained: true;
  stage: 'unsupported' | 'model-abstained' | 'model-invalid-output' | 'policy-rejected' | 'model-unavailable';
  reason: string;
  /** Gates that ran, including the one that failed, when stage is 'policy-rejected'. */
  policy?: PolicyCheck[];
};

export type RepairResult = RepairProposal | RepairAbstention;

export type ModelConfig = {
  /** Base URL of an OpenAI-compatible server, e.g. https://models.internal.example/v1. */
  endpoint: string;
  /** Model name passed through to the server. */
  model: string;
  /** Bearer credential for the private model gateway. Never logged. */
  apiKey?: string;
  /** 'hosted': Mender-operated inference. 'customer-managed': must resolve to loopback or a private address unless allowRemote is set. */
  mode: 'hosted' | 'customer-managed';
  allowRemote?: boolean;
  timeoutMs?: number;
  fetcher?: typeof fetch;
};

export type CheckResult = {
  name: string;
  /** The exact argv that ran. */
  command: string[];
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  passed: boolean;
};

export type ValidationReport = {
  schemaVersion: 1;
  isolation: {
    /** 'container' and 'namespace' block network and bound resources; 'process' does not isolate. */
    backend: 'container' | 'namespace' | 'process';
    network: 'none' | 'host';
    limits: { cpuSeconds: number; memoryMb: number; wallSeconds: number; pids: number };
  };
  patchApplied: boolean;
  before: CheckResult[];
  after: CheckResult[];
  /** All configured checks passed on the patched tree. */
  checksPassed: boolean;
  /** At least one check failed before the patch and passed after it. */
  breakReproduced: boolean;
  /** Always states that passing checks are not proof of correct behavior. */
  statement: string;
};
