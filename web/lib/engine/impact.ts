import type { ApiCall, Applicability, Confidence, ContractChange, Finding, ProviderAdapter } from './types.ts';
import { canonicalJson, sha256Hex } from './hash.ts';
import { dynamicSegmentsAlign, matchOperationKey } from './openapi-slice.ts';
import { byText, plainName } from './text.ts';

// Impact rules. Every finding is static inference: no code was run.
//
// A call is considered for a change when its origin is one of the provider's
// and its endpoint maps to the change's operation. When the caller passes the
// contract's full operation list, the call must map to that operation among
// all of them, so `/issues/comments` is not mistaken for `/issues/{number}`.
//
//   request-property-removed       affected only when the body is a complete
//                                  literal object that names the field. A
//                                  dynamic body is skipped: it would flag
//                                  every call to the operation.
//   request-property-required      affected when a complete literal body omits
//                                  the field. A dynamic or absent body may or
//                                  may not send it: reported at confidence
//                                  'low', not repairable.
//   request-property-type-changed  affected when a complete literal body names
//                                  the field. The value is not evaluated, so
//                                  confidence is at most 'medium' and it is
//                                  not repairable.
//   operation-removed              every matching call; the body is irrelevant.
//   other                          no finding: the change is not understood
//                                  well enough to point at a call.
//
// Applicability compares versions as text, which is only an ordering for
// ISO dates (YYYY-MM-DD); any other version scheme yields 'unknown'.
//   pinned (literal version header) >= toVersion          → active
//   pinned < toVersion                                     → on-upgrade
//   header known absent and provider default < toVersion   → on-upgrade
//   header known absent and provider default >= toVersion  → active
//   anything else                                          → unknown
//
// Confidence is 'high' only when the path match needs no guess, the field
// check is exact and applicability is known; otherwise 'medium' (or 'low' as
// above).
//
// Sentences in title, impact, staticChecks and limits are written here. Field
// and operation names are sanitised first; no text from the repository or the
// provider document is copied into them.

export type ImpactInput = {
  provider: ProviderAdapter;
  changes: ContractChange[];
  calls: ApiCall[];
  /** Every operation key of the old contract, to disambiguate path matches. */
  operationKeys?: readonly string[];
};

const maxFindings = 200;
const maxPairs = 200_000;
const dated = /^\d{4}-\d{2}-\d{2}$/;
const repairableFile = /\.[cm]?[jt]sx?$/;

type Assessment = {
  failureMode: Finding['impact']['failureMode'];
  impact: string;
  check: string;
  limits: string[];
  ceiling: Confidence;
  repairable: boolean;
};

function assess(change: ContractChange, call: ApiCall): Assessment | null {
  const field = `\`${plainName(change.fields[0] ?? '')}\``;
  const names = call.fieldsComplete && change.fields.length === 1 && call.fields.includes(change.fields[0]);
  const rewritable = call.fieldsComplete && repairableFile.test(call.file) && call.endLine !== undefined;
  switch (change.kind) {
    case 'request-property-removed':
      return names ? {
        failureMode: 'value-silently-ignored', ceiling: 'high', repairable: rewritable,
        impact: `This call sends ${field}, which the provider no longer accepts on this operation from ${plainName(change.toVersion)}.`,
        check: `The request body is a literal object whose keys were all read, and ${field} is one of them.`,
        limits: ['How the provider treats the removed property was not observed; it may be ignored or rejected.'],
      } : null;
    case 'request-property-required':
      if (change.fields.length !== 1 || (call.fieldsComplete && call.fields.includes(change.fields[0]))) return null;
      return call.fieldsComplete ? {
        failureMode: 'request-rejected', ceiling: 'high', repairable: rewritable,
        impact: `This call does not send ${field}, which the provider requires on this operation from ${plainName(change.toVersion)}.`,
        check: `The request body is a literal object whose keys were all read, and ${field} is not among them.`,
        limits: [],
      } : {
        failureMode: 'request-rejected', ceiling: 'low', repairable: false,
        impact: `This call may not send ${field}, which the provider requires on this operation from ${plainName(change.toVersion)}.`,
        check: 'The call targets the affected operation.',
        limits: [`The request body is dynamic or absent, so whether ${field} is sent could not be read.`],
      };
    case 'request-property-type-changed':
      return names ? {
        failureMode: 'unknown', ceiling: 'medium', repairable: false,
        impact: `This call sends ${field}, whose accepted type or values change from ${plainName(change.toVersion)}.`,
        check: `The request body is a literal object whose keys were all read, and ${field} is one of them.`,
        limits: [`The value sent for ${field} was not evaluated, so it may already satisfy the new contract.`],
      } : null;
    case 'operation-removed':
      return {
        failureMode: 'request-rejected', ceiling: 'high', repairable: false,
        impact: `This call targets an operation the provider no longer describes from ${plainName(change.toVersion)}.`,
        check: 'The call targets the removed operation.',
        limits: ['The operation may have moved to another path; no replacement was identified.'],
      };
    default:
      return null;
  }
}

function pinnedVersionOf(provider: ProviderAdapter, call: ApiCall): string | null {
  const header = provider.versionHeader;
  const value = header && call.headers && Object.hasOwn(call.headers, header) ? call.headers[header] : undefined;
  return typeof value === 'string' ? value : null;
}

function applicabilityOf(provider: ProviderAdapter, call: ApiCall, pinned: string | null, toVersion: string): { applicability: Applicability; check: string | null } {
  if (!provider.versionHeader || !dated.test(toVersion)) return { applicability: 'unknown', check: null };
  const header = `\`${plainName(provider.versionHeader)}\``;
  if (pinned !== null) {
    if (!dated.test(pinned)) return { applicability: 'unknown', check: null };
    return pinned >= toVersion
      ? { applicability: 'active', check: `The call sets ${header} to a literal version at or after ${plainName(toVersion)}.` }
      : { applicability: 'on-upgrade', check: `The call sets ${header} to a literal version before ${plainName(toVersion)}.` };
  }
  const fallback = provider.defaultVersion;
  if (call.headersComplete !== true || !fallback || !dated.test(fallback)) return { applicability: 'unknown', check: null };
  return fallback >= toVersion
    ? { applicability: 'active', check: `The call sends no ${header} header, and the provider then applies ${plainName(fallback)}.` }
    : { applicability: 'on-upgrade', check: `The call sends no ${header} header, and the provider then applies ${plainName(fallback)}, before the change.` };
}

function titleOf(change: ContractChange, provider: ProviderAdapter) {
  const field = `\`${plainName(change.fields[0] ?? '')}\``;
  const where = `${plainName(change.operation)} (${plainName(provider.name, 80)} ${plainName(change.toVersion)})`;
  if (change.kind === 'request-property-removed') return `Request property ${field} removed from ${where}`;
  if (change.kind === 'request-property-required') return `Request property ${field} now required on ${where}`;
  if (change.kind === 'request-property-type-changed') return `Request property ${field} changed type on ${where}`;
  return `Operation removed: ${where}`;
}

async function findingFor(provider: ProviderAdapter, change: ContractChange, call: ApiCall, verdict: Assessment): Promise<Finding> {
  const pinnedVersion = pinnedVersionOf(provider, call);
  const { applicability, check } = applicabilityOf(provider, call, pinnedVersion, change.toVersion);
  const aligned = dynamicSegmentsAlign(change.operation, call.endpoint);
  const confidence: Confidence = verdict.ceiling === 'high' && (applicability === 'unknown' || !aligned) ? 'medium' : verdict.ceiling;
  return {
    schemaVersion: 1,
    id: await sha256Hex(canonicalJson([provider.id, change.operation, change.kind, change.fields, change.fromVersion, change.toVersion, call.file, call.line])),
    provider: { id: provider.id, name: provider.name },
    title: titleOf(change, provider),
    change,
    location: {
      file: call.file, line: call.line, ...(call.endLine === undefined ? {} : { endLine: call.endLine }),
      ...(call.bodyLine === undefined ? {} : { bodyLine: call.bodyLine }), symbol: call.symbol,
    },
    impact: { summary: verdict.impact, failureMode: verdict.failureMode },
    evidence: {
      call, pinnedVersion, applicability,
      staticChecks: [
        'The call URL has a literal https origin that belongs to the provider.',
        aligned ? 'The method and path match the operation; every dynamic path segment sits on a path parameter.'
          : 'The method and path match the operation only if a dynamic path segment takes a fixed value.',
        verdict.check,
        ...(check ? [check] : []),
      ],
      limits: [
        'The code was not executed and no request was sent; this is inferred from source text and the provider contracts.',
        ...verdict.limits,
        ...(applicability === 'unknown' ? ['The API version this call uses at run time could not be determined.'] : []),
      ],
    },
    confidence,
    verification: 'static-inferred',
    repairable: verdict.repairable,
  };
}

function byPlace(a: Finding, b: Finding) {
  return byText(a.location.file, b.location.file) || a.location.line - b.location.line
    || byText(a.change.operation, b.change.operation) || byText(a.change.kind, b.change.kind)
    || byText(a.change.fields.join(','), b.change.fields.join(','));
}

// Findings sorted by file, line, operation, kind and field; at most 200.
export async function analyzeImpact(input: ImpactInput): Promise<Finding[]> {
  const { provider, changes } = input;
  const calls = input.calls.filter(call => provider.origins.includes(call.origin));
  const operations = [...new Set(changes.filter(change => change.providerId === provider.id).map(change => change.operation))];
  const keys = input.operationKeys ?? operations;
  // Each distinct endpoint is matched once, however many calls share it.
  const operationOf = new Map<string, string | null>();
  for (const call of calls) if (!operationOf.has(call.endpoint)) operationOf.set(call.endpoint, matchOperationKey(keys, call.endpoint));
  const findings: Finding[] = [];
  let pairs = 0;
  for (const change of changes) {
    if (change.providerId !== provider.id) continue;
    for (const call of calls) {
      if (++pairs > maxPairs) break;
      if (operationOf.get(call.endpoint) !== change.operation) continue;
      const verdict = assess(change, call);
      if (verdict) findings.push(await findingFor(provider, change, call, verdict));
    }
  }
  return findings.sort(byPlace).slice(0, maxFindings);
}
