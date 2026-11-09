// The customer-managed boundary.
//
// In customer-managed mode the CLI, the model and the checks all run in the
// customer's environment. The ONLY thing that may reach API Mender is the
// report built here, and only when the customer turns upload on. It is
// metadata: no source text, no source excerpts, no diffs, no prompts, no model
// output, no test output, no check commands.
//
// The same validator runs on both sides: the CLI validates what it is about to
// send, and the hosted ingest route validates what it receives and stores
// nothing that fails. Every object is checked against an exact key list, so a
// field that is not named in this file cannot cross.

import type { Finding, IntegratedService, RepairResult, ValidationReport } from './types.ts';

/** Field groups a customer can enable one by one. */
export const REPORT_FIELD_GROUPS = ['providers', 'findingStatus', 'filePaths', 'hashes', 'validation'] as const;
export type ReportFieldGroup = typeof REPORT_FIELD_GROUPS[number];

export type MetadataFindingStatus = 'open' | 'patch-proposed' | 'checks-passed' | 'checks-failed' | 'abstained';

export type MetadataReport = {
  schemaVersion: 1;
  mode: 'customer-managed';
  cliVersion: string;
  /** A label the customer chooses. It does not have to be the real repository name. */
  repositoryLabel: string;
  commitSha: string | null;
  generatedAt: string;
  /** The groups that were enabled. Anything outside them is absent, not empty. */
  fields: ReportFieldGroup[];
  /** Group 'providers'. Catalog providers only; unrecognised hosts are counted, never named. */
  providers?: {
    providerId: string; providerName: string; origin: string;
    /** Contract operation templates such as `POST /repos/{owner}/{repo}/issues`; never literal paths. */
    operations: string[];
    callCount: number; pinnedVersions: string[];
  }[];
  unrecognizedOriginCount?: number;
  /** Group 'findingStatus'. */
  findings?: {
    id: string; providerId: string; operation: string; kind: string;
    /** Provider request-field names from the public contract. */
    fields: string[];
    fromVersion: string; toVersion: string;
    confidence: string; verification: string; applicability: string; failureMode: string;
    status: MetadataFindingStatus;
    repairMethod?: 'deterministic' | 'self-hosted-model';
    /** Group 'filePaths'. */
    file?: string; line?: number;
    /** Group 'hashes'. Hashes of the file before and after, and of the diff; never the content. */
    sourceSha256?: string; patchedSha256?: string; diffSha256?: string;
    /** Group 'validation'. Check names and outcomes; never commands or output. */
    validation?: {
      backend: string; network: string; patchApplied: boolean;
      checksPassed: boolean; breakReproduced: boolean;
      checks: { name: string; phase: 'before' | 'after'; passed: boolean; exitCode: number | null; timedOut: boolean }[];
    };
  }[];
};

const sha256 = /^[a-f0-9]{64}$/;
const commit = /^[a-f0-9]{40}$/;
const token = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/;
const label = /^[A-Za-z0-9][A-Za-z0-9 _./:@()-]{0,199}$/;
// A contract template: every dynamic segment must be a `{name}` placeholder.
const operationTemplate = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) \/[A-Za-z0-9_.~{}/-]{0,400}$/;
const filePath = /^[A-Za-z0-9_@+.()[\]-][A-Za-z0-9_@+.()[\] /-]{0,511}$/;
const fieldName = /^[A-Za-z_$][\w$.-]{0,127}$/;

async function digest(text: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function statusOf(repair: RepairResult | undefined, validation: ValidationReport | undefined): MetadataFindingStatus {
  if (!repair) return 'open';
  if ('abstained' in repair) return 'abstained';
  if (!validation || !validation.patchApplied || !validation.after.length) return 'patch-proposed';
  return validation.checksPassed ? 'checks-passed' : 'checks-failed';
}

/**
 * Build the report from pipeline results. Only enabled groups are populated,
 * and the result is passed through validateMetadataReport before it is returned,
 * so a bug here fails closed instead of leaking a field.
 */
export async function buildMetadataReport(input: {
  cliVersion: string; repositoryLabel: string; commitSha?: string | null; generatedAt?: string;
  fields: readonly ReportFieldGroup[];
  services: IntegratedService[];
  /** Maps a service's raw call endpoint to its contract operation template, or null. */
  operationTemplate: (providerId: string, endpoint: string) => string | null;
  results: { finding: Finding; repair?: RepairResult; validation?: ValidationReport }[];
}): Promise<MetadataReport> {
  const enabled = new Set(input.fields);
  const report: MetadataReport = {
    schemaVersion: 1, mode: 'customer-managed', cliVersion: input.cliVersion,
    repositoryLabel: input.repositoryLabel, commitSha: input.commitSha ?? null,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    fields: REPORT_FIELD_GROUPS.filter(group => enabled.has(group)),
  };
  if (enabled.has('providers')) {
    const known = input.services.filter(service => service.recognition === 'catalog');
    report.providers = known.slice(0, 50).map(service => ({
      providerId: service.providerId, providerName: service.providerName, origin: service.origin,
      // A raw endpoint can hold literal path segments (an org or repo name).
      // Only the provider's own template for it is reported.
      operations: [...new Set(service.operations.map(endpoint => input.operationTemplate(service.providerId, endpoint))
        .filter((value): value is string => !!value))].sort().slice(0, 100),
      callCount: service.callCount, pinnedVersions: [...service.pinnedVersions].sort().slice(0, 10),
    }));
    report.unrecognizedOriginCount = input.services.length - known.length;
  }
  if (enabled.has('findingStatus')) {
    report.findings = [];
    for (const { finding, repair, validation } of input.results.slice(0, 200)) {
      const proposal = repair && !('abstained' in repair) ? repair : undefined;
      const entry: NonNullable<MetadataReport['findings']>[number] = {
        id: finding.id, providerId: finding.provider.id, operation: finding.change.operation,
        kind: finding.change.kind, fields: finding.change.fields.slice(0, 20),
        fromVersion: finding.change.fromVersion, toVersion: finding.change.toVersion,
        confidence: finding.confidence,
        verification: validation?.breakReproduced && validation.checksPassed ? 'test-confirmed' : finding.verification,
        applicability: finding.evidence.applicability, failureMode: finding.impact.failureMode,
        status: statusOf(repair, validation),
      };
      if (proposal) entry.repairMethod = proposal.method;
      if (enabled.has('filePaths')) { entry.file = finding.location.file; entry.line = finding.location.line; }
      if (enabled.has('hashes') && proposal) {
        entry.sourceSha256 = proposal.sourceSha256; entry.patchedSha256 = proposal.patchedSha256;
        entry.diffSha256 = await digest(proposal.diff);
      }
      if (enabled.has('validation') && validation) {
        const outcome = (phase: 'before' | 'after') => validation[phase].slice(0, 10).map(check => ({
          name: check.name, phase, passed: check.passed, exitCode: check.exitCode, timedOut: check.timedOut }));
        entry.validation = { backend: validation.isolation.backend, network: validation.isolation.network,
          patchApplied: validation.patchApplied, checksPassed: validation.checksPassed,
          breakReproduced: validation.breakReproduced, checks: [...outcome('before'), ...outcome('after')] };
      }
      report.findings.push(entry);
    }
  }
  return validateMetadataReport(report);
}

class Rejected extends Error {}
function fail(path: string, why: string): never { throw new Rejected(`${path}: ${why}`); }

function object(value: unknown, path: string, required: string[], optional: string[] = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'must be an object');
  const record = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  // Exact key lists are the control: an unknown key is rejected, not ignored.
  for (const key of Object.keys(record)) if (!allowed.has(key)) fail(`${path}.${key}`, 'is not an allowed field');
  for (const key of required) if (!Object.hasOwn(record, key)) fail(`${path}.${key}`, 'is required');
  return record;
}
function text(value: unknown, path: string, pattern: RegExp) {
  if (typeof value !== 'string' || !pattern.test(value)) fail(path, 'has an unexpected format');
  return value as string;
}
function list(value: unknown, path: string, max: number) {
  if (!Array.isArray(value) || value.length > max) fail(path, `must be a list of at most ${max}`);
  return value as unknown[];
}
function count(value: unknown, path: string, max = 1_000_000) {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) fail(path, 'must be a small whole number');
  return value as number;
}
function flag(value: unknown, path: string) {
  if (typeof value !== 'boolean') fail(path, 'must be true or false');
  return value as boolean;
}
function oneOf<T extends string>(value: unknown, path: string, options: readonly T[]) {
  if (typeof value !== 'string' || !options.includes(value as T)) fail(path, 'is not an allowed value');
  return value as T;
}

/**
 * Accept exactly the documented shape and return a fresh copy built from the
 * validated values. Throws with the offending path (never the offending value).
 */
export function validateMetadataReport(raw: unknown): MetadataReport {
  const root = object(raw, 'report',
    ['schemaVersion', 'mode', 'cliVersion', 'repositoryLabel', 'commitSha', 'generatedAt', 'fields'],
    ['providers', 'unrecognizedOriginCount', 'findings']);
  if (root.schemaVersion !== 1) fail('report.schemaVersion', 'is not supported');
  if (root.mode !== 'customer-managed') fail('report.mode', 'is not supported');
  const fields = list(root.fields, 'report.fields', REPORT_FIELD_GROUPS.length)
    .map((group, index) => oneOf(group, `report.fields[${index}]`, REPORT_FIELD_GROUPS));
  if (new Set(fields).size !== fields.length) fail('report.fields', 'has duplicates');
  const enabled = new Set(fields);
  if (typeof root.generatedAt !== 'string' || root.generatedAt.length > 40 || Number.isNaN(Date.parse(root.generatedAt)))
    fail('report.generatedAt', 'must be a timestamp');
  const report: MetadataReport = {
    schemaVersion: 1, mode: 'customer-managed',
    cliVersion: text(root.cliVersion, 'report.cliVersion', /^[0-9A-Za-z.+-]{1,32}$/),
    repositoryLabel: text(root.repositoryLabel, 'report.repositoryLabel', label),
    commitSha: root.commitSha === null ? null : text(root.commitSha, 'report.commitSha', commit),
    generatedAt: root.generatedAt as string, fields,
  };
  // A group that is not enabled must be absent. Present-but-disabled data is a
  // sender bug or an attempt to smuggle a field past the customer's setting.
  if (!enabled.has('providers') && (root.providers !== undefined || root.unrecognizedOriginCount !== undefined))
    fail('report.providers', 'is present but not enabled');
  if (!enabled.has('findingStatus') && root.findings !== undefined) fail('report.findings', 'is present but not enabled');
  if (enabled.has('providers')) {
    report.providers = list(root.providers ?? [], 'report.providers', 50).map((item, index) => {
      const path = `report.providers[${index}]`;
      const entry = object(item, path, ['providerId', 'providerName', 'origin', 'operations', 'callCount', 'pinnedVersions']);
      let origin: URL;
      try { origin = new URL(text(entry.origin, `${path}.origin`, /^https:\/\/[A-Za-z0-9.-]{1,253}(:\d{1,5})?$/)); }
      catch (error) { if (error instanceof Rejected) throw error; fail(`${path}.origin`, 'must be an https origin'); }
      return { providerId: text(entry.providerId, `${path}.providerId`, /^[a-z0-9][a-z0-9-]{0,62}$/),
        providerName: text(entry.providerName, `${path}.providerName`, label), origin: origin.origin,
        operations: list(entry.operations, `${path}.operations`, 100)
          .map((value, at) => text(value, `${path}.operations[${at}]`, operationTemplate)),
        callCount: count(entry.callCount, `${path}.callCount`),
        pinnedVersions: list(entry.pinnedVersions, `${path}.pinnedVersions`, 10)
          .map((value, at) => text(value, `${path}.pinnedVersions[${at}]`, token)) };
    });
    report.unrecognizedOriginCount = count(root.unrecognizedOriginCount ?? 0, 'report.unrecognizedOriginCount');
  }
  if (enabled.has('findingStatus')) {
    report.findings = list(root.findings ?? [], 'report.findings', 200).map((item, index) => {
      const path = `report.findings[${index}]`;
      const entry = object(item, path,
        ['id', 'providerId', 'operation', 'kind', 'fields', 'fromVersion', 'toVersion', 'confidence',
          'verification', 'applicability', 'failureMode', 'status'],
        ['repairMethod', 'file', 'line', 'sourceSha256', 'patchedSha256', 'diffSha256', 'validation']);
      const finding: NonNullable<MetadataReport['findings']>[number] = {
        id: text(entry.id, `${path}.id`, sha256),
        providerId: text(entry.providerId, `${path}.providerId`, /^[a-z0-9][a-z0-9-]{0,62}$/),
        operation: text(entry.operation, `${path}.operation`, operationTemplate),
        kind: oneOf(entry.kind, `${path}.kind`, ['request-property-removed', 'request-property-required',
          'request-property-type-changed', 'operation-removed', 'other'] as const),
        fields: list(entry.fields, `${path}.fields`, 20).map((value, at) => text(value, `${path}.fields[${at}]`, fieldName)),
        fromVersion: text(entry.fromVersion, `${path}.fromVersion`, token),
        toVersion: text(entry.toVersion, `${path}.toVersion`, token),
        confidence: oneOf(entry.confidence, `${path}.confidence`, ['high', 'medium', 'low'] as const),
        verification: oneOf(entry.verification, `${path}.verification`, ['static-inferred', 'test-confirmed'] as const),
        applicability: oneOf(entry.applicability, `${path}.applicability`, ['active', 'on-upgrade', 'unknown'] as const),
        failureMode: oneOf(entry.failureMode, `${path}.failureMode`,
          ['request-rejected', 'value-silently-ignored', 'unknown'] as const),
        status: oneOf(entry.status, `${path}.status`,
          ['open', 'patch-proposed', 'checks-passed', 'checks-failed', 'abstained'] as const),
      };
      if (entry.repairMethod !== undefined)
        finding.repairMethod = oneOf(entry.repairMethod, `${path}.repairMethod`, ['deterministic', 'self-hosted-model'] as const);
      const present = (key: string) => entry[key] !== undefined;
      if (!enabled.has('filePaths') && (present('file') || present('line'))) fail(`${path}.file`, 'is present but not enabled');
      if (!enabled.has('hashes') && (present('sourceSha256') || present('patchedSha256') || present('diffSha256')))
        fail(`${path}.sourceSha256`, 'is present but not enabled');
      if (!enabled.has('validation') && present('validation')) fail(`${path}.validation`, 'is present but not enabled');
      if (present('file')) {
        const file = text(entry.file, `${path}.file`, filePath);
        if (file.startsWith('/') || file.split('/').some(part => part === '.' || part === '..' || part === ''))
          fail(`${path}.file`, 'must be a relative repository path');
        finding.file = file;
        finding.line = count(entry.line, `${path}.line`, 10_000_000);
      }
      for (const key of ['sourceSha256', 'patchedSha256', 'diffSha256'] as const)
        if (present(key)) finding[key] = text(entry[key], `${path}.${key}`, sha256);
      if (present('validation')) {
        const vpath = `${path}.validation`;
        const validation = object(entry.validation, vpath,
          ['backend', 'network', 'patchApplied', 'checksPassed', 'breakReproduced', 'checks']);
        finding.validation = {
          backend: oneOf(validation.backend, `${vpath}.backend`, ['container', 'namespace', 'process'] as const),
          network: oneOf(validation.network, `${vpath}.network`, ['none', 'host'] as const),
          patchApplied: flag(validation.patchApplied, `${vpath}.patchApplied`),
          checksPassed: flag(validation.checksPassed, `${vpath}.checksPassed`),
          breakReproduced: flag(validation.breakReproduced, `${vpath}.breakReproduced`),
          checks: list(validation.checks, `${vpath}.checks`, 20).map((value, at) => {
            const cpath = `${vpath}.checks[${at}]`;
            const check = object(value, cpath, ['name', 'phase', 'passed', 'exitCode', 'timedOut']);
            return { name: text(check.name, `${cpath}.name`, /^[A-Za-z0-9_.-]{1,40}$/),
              phase: oneOf(check.phase, `${cpath}.phase`, ['before', 'after'] as const),
              passed: flag(check.passed, `${cpath}.passed`),
              exitCode: check.exitCode === null ? null : count(check.exitCode, `${cpath}.exitCode`, 255),
              timedOut: flag(check.timedOut, `${cpath}.timedOut`) };
          }),
        };
      }
      return finding;
    });
  }
  return report;
}

/** True when the error came from the validator, so callers can answer 422 instead of 500. */
export function isReportRejection(error: unknown): error is Error { return error instanceof Rejected; }
