// Turns a finding into the narrowest task a model (or a rule) may work on:
// a few numbered lines, the range it may edit, and a bounded copy of the
// contract change. Everything the model is shown is decided here.
import type { ChangeKind, Finding } from '../types.ts';
import { bodyProperties, parseSource, targetCallsStartingOn } from './ast.ts';
import type { TargetCall } from './ast.ts';
import { isSafeDiffPath, splitLines } from './diff.ts';

/** Deterministic facts about the NEW version of the operation that the gates check patches against. */
export type RepairContract = {
  /** Request properties the new contract accepts. Null when unknown or the schema is open. */
  acceptedProperties: string[] | null;
  required: string[];
  /** Properties the new contract no longer accepts. */
  removed: string[];
};

export type BoundedChange = {
  operation: string; kind: ChangeKind; fields: string[];
  fromVersion: string; toVersion: string;
  before: Record<string, unknown>; after: Record<string, unknown>;
};

export type SupportedRepairTask = {
  supported: true;
  findingId: string;
  file: string;
  /** Numbered lines shown to the model: the call plus context. */
  excerpt: Array<{ line: number; text: string }>;
  excerptRange: { start: number; end: number };
  /** Exactly the lines of the call expression. 1-based, inclusive. */
  editableRange: { start: number; end: number };
  change: BoundedChange;
};

export type UnsupportedRepairTask = { supported: false; reason: string };
export type RepairTask = SupportedRepairTask | UnsupportedRepairTask;

const MAX_SOURCE_CHARS = 300_000;
const MAX_EXCERPT_LINES = 60;
const MAX_EXCERPT_BYTES = 4096;
const CONTEXT_LINES = 2;
const MAX_CHANGE_CHARS = 1500;
const SOURCE_FILE = /\.(?:[cm]?js|jsx|[cm]?ts|tsx)$/;

const unsupported = (reason: string): UnsupportedRepairTask => ({ supported: false, reason });
const clip = (text: unknown, limit: number) => String(text).slice(0, limit);
const byteLength = (text: string) => new TextEncoder().encode(text).length;

// Provider schemas can be huge and are untrusted text. Keep the shape, cut
// the bulk: short strings, few keys, shallow nesting.
function bounded(value: unknown, depth: number): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return clip(value, 160);
  if (typeof value !== 'object' || depth >= 4) return null;
  if (Array.isArray(value)) return value.slice(0, 8).map(item => bounded(item, depth + 1));
  return Object.fromEntries(Object.entries(value).slice(0, 8)
    .map(([key, item]) => [clip(key, 64), bounded(item, depth + 1)]));
}

// Fallback when even the bounded schemas are too large: type facts only.
function typeOnly(schemas: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(schemas).map(([name, schema]) => {
    if (!schema || typeof schema !== 'object') return [name, null];
    const { type, nullable } = schema as { type?: unknown; nullable?: unknown };
    return [name, { type: typeof type === 'string' ? clip(type, 32) : null, nullable: nullable === true }];
  }));
}

function boundedChange(finding: Finding): BoundedChange {
  const { change } = finding;
  let before = bounded(change.before, 0) as Record<string, unknown>;
  let after = bounded(change.after, 0) as Record<string, unknown>;
  if (JSON.stringify({ before, after }).length > MAX_CHANGE_CHARS) { before = typeOnly(before); after = typeOnly(after); }
  return { operation: clip(change.operation, 200), kind: change.kind,
    fields: change.fields.slice(0, 20).map(name => clip(name, 128)),
    fromVersion: clip(change.fromVersion, 40), toVersion: clip(change.toVersion, 40), before, after };
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');

/**
 * Find the call the finding describes in the current source. Null when the
 * source has moved on: line numbers from a stale scan must never be edited.
 */
/** For an SDK call, the client root and provider the finding attributed it to. */
export function sdkRootOf(finding: Finding): { root: string; providerId: string } | undefined {
  const { sdk, symbol } = finding.evidence.call;
  if (!sdk || !symbol.endsWith(`.${sdk}`)) return undefined;
  return { root: symbol.slice(0, -(sdk.length + 1)), providerId: finding.provider.id };
}

export function locateTargetCall(finding: Finding, source: string): TargetCall | null {
  const syntax = parseSource(source);
  const evidence = finding.evidence.call;
  if (!syntax || !evidence.fieldsComplete) return null;
  const matches = (targetCallsStartingOn(syntax, finding.location.line, finding.location.file, sdkRootOf(finding)) || [])
    .filter(call => call.endpoint === evidence.endpoint && call.origin === evidence.origin);
  if (matches.length !== 1) return null;
  const properties = bodyProperties(source, matches[0]);
  if (!properties || !sameSet([...new Set(properties.map(item => item.name))], evidence.fields)) return null;
  return matches[0];
}

function validShape(finding: Finding, contract: RepairContract): boolean {
  const names = (value: unknown) => Array.isArray(value) && value.length <= 500
    && value.every(name => typeof name === 'string' && name.length <= 128);
  return Number.isSafeInteger(finding.location?.line) && finding.location.line >= 1
    && typeof finding.evidence?.call?.endpoint === 'string' && typeof finding.evidence.call.origin === 'string'
    && Array.isArray(finding.evidence.call.fields) && Array.isArray(finding.change?.fields)
    && (contract.acceptedProperties === null || names(contract.acceptedProperties))
    && names(contract.required) && names(contract.removed);
}

/** Build the bounded task, or say why this finding cannot be repaired automatically. */
export function buildRepairTask(finding: Finding, source: string, contract: RepairContract): RepairTask {
  if (!validShape(finding, contract)) return unsupported('The finding or contract facts are malformed');
  if (!finding.repairable) return unsupported('The finding is not marked repairable');
  const file = finding.location.file;
  if (!isSafeDiffPath(file) || !SOURCE_FILE.test(file) || finding.evidence.call.file !== file)
    return unsupported('Only JavaScript and TypeScript files with plain repository-relative paths are supported');
  if (source.length > MAX_SOURCE_CHARS) return unsupported('The source file is too large');
  // Babel counts these as line breaks; the line editor does not. Refuse
  // rather than risk editing a different line than the one that was parsed.
  if (/\r(?!\n)|[\u2028\u2029]/.test(source)) return unsupported('The source file uses unusual line terminators');
  const call = locateTargetCall(finding, source);
  if (!call) return unsupported('The source no longer contains the call this finding describes');
  const lines = splitLines(source);
  const editableRange = { start: call.startLine, end: call.endLine };
  const excerptRange = { start: Math.max(1, call.startLine - CONTEXT_LINES), end: Math.min(lines.length, call.endLine + CONTEXT_LINES) };
  const excerpt = lines.slice(excerptRange.start - 1, excerptRange.end)
    .map((line, index) => ({ line: excerptRange.start + index, text: line.text }));
  if (excerpt.length > MAX_EXCERPT_LINES || byteLength(excerpt.map(line => line.text).join('\n')) > MAX_EXCERPT_BYTES)
    return unsupported('The call is too large for a bounded repair');
  return { supported: true, findingId: finding.id, file, excerpt, excerptRange, editableRange, change: boundedChange(finding) };
}
