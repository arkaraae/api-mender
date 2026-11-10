import { compareContracts } from '../contract-source.ts';
import type { ChangeKind, ContractChange, OperationSlice } from './types.ts';
import { requestSchemaOf } from './openapi-slice.ts';
import { byText, plainName } from './text.ts';

// Turns two slices of one operation into structured request-level changes.
// Property changes are read straight from the two sliced schemas; the rules
// engine behind compareContracts supplies the verdict and anything else it
// finds, which is reported as kind 'other'.
//
// Provider documents are untrusted. `summary` is written by this file from
// names and versions only; provider prose (descriptions) travels solely
// inside `before`/`after`, bounded in size.

type Json = Record<string, unknown>;

export type DiffOptions = {
  changelogUrl?: string;
  /** Display name used in summaries. Defaults to the slice's providerId. */
  providerName?: string;
};

const maxFieldJson = 2_048;
const maxDescription = 400;
const maxChanges = 100;
const maxCandidates = 5;

const isRecord = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (record: Json, key: string) => (Object.hasOwn(record, key) ? record[key] : undefined);

type Request = { properties: Json; required: string[] };

// Only a plain object schema is read. A body composed with allOf/oneOf has no
// single property list, so property-level changes are not claimed for it.
function requestOf(slice: OperationSlice): Request | null {
  const schema = requestSchemaOf(slice);
  const properties = schema ? own(schema, 'properties') : undefined;
  if (!schema || !isRecord(properties)) return null;
  const required = own(schema, 'required');
  return { properties, required: Array.isArray(required) ? required.filter((name): name is string => typeof name === 'string') : [] };
}

function shortenText(value: unknown, depth = 0): unknown {
  if (depth > 12) return {};
  if (Array.isArray(value)) return value.map(item => shortenText(item, depth + 1));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).map(key => {
    const item = value[key];
    return [key, key === 'description' && typeof item === 'string' && item.length > maxDescription
      ? `${item.slice(0, maxDescription)}...` : shortenText(item, depth + 1)];
  }));
}

// A field schema as evidence: whole when it fits in ~2 KB of JSON, otherwise
// reduced to its outline, otherwise to its type.
function bounded(schema: unknown): unknown | null {
  if (!isRecord(schema)) return null;
  const full = shortenText(schema);
  if (JSON.stringify(full).length <= maxFieldJson) return full;
  const items = own(schema, 'items');
  const outline = Object.fromEntries(['type', 'format', 'nullable', 'enum', 'description']
    .filter(key => own(schema, key) !== undefined).map(key => [key, own(schema, key)])
    .concat(isRecord(items) && own(items, 'type') !== undefined ? [['items', { type: own(items, 'type') }]] : []));
  const short = shortenText(outline);
  return JSON.stringify(short).length <= maxFieldJson ? short : { type: typeof own(schema, 'type') === 'string' ? own(schema, 'type') : 'unknown' };
}

const stem = (name: string) => name.toLowerCase().replace(/[_-]/g, '');

// Replacement candidates for a removed property: properties of the NEW
// contract whose name, lower-cased with `_` and `-` dropped, extends or is
// extended by the removed name by at most three trailing characters, the
// shorter of the two being at least three long (assignee → assignees,
// team_id → team_ids). A naming heuristic only: it proposes where to look and
// does not claim the provider intends the candidate as the replacement.
export function replacementCandidates(removed: string, newProperties: readonly string[]): string[] {
  const from = stem(removed);
  return newProperties.filter(name => {
    const to = stem(name);
    const [short, long] = from.length <= to.length ? [from, to] : [to, from];
    return name !== removed && short.length >= 3 && long.length - short.length <= 3 && long.startsWith(short) && long !== short;
  }).sort(byText).slice(0, maxCandidates);
}

function typesOf(schema: unknown): string[] | null {
  const type = isRecord(schema) ? own(schema, 'type') : undefined;
  if (typeof type === 'string') return [type];
  return Array.isArray(type) && type.length && type.every(item => typeof item === 'string') ? [...type as string[]].sort() : null;
}

// Conservative: both versions must state a type for a difference to count.
// Additions are not breaking: a new enum value, a union gaining a member,
// integer widening to number.
function narrowed(before: string[] | null, after: string[] | null) {
  if (!before || !after) return false;
  return before.some(type => !after.includes(type) && !(type === 'integer' && after.includes('number')));
}

function typeChanged(before: unknown, after: unknown): boolean {
  if (!isRecord(before) || !isRecord(after)) return false;
  if (narrowed(typesOf(before), typesOf(after))) return true;
  if (narrowed(typesOf(own(before, 'items')), typesOf(own(after, 'items')))) return true;
  const was = own(before, 'enum');
  const now = own(after, 'enum');
  return Array.isArray(was) && Array.isArray(now) && was.some(value => !now.includes(value));
}

const validName = (name: string) => name.length > 0 && name.length <= 128;

type Draft = { kind: ChangeKind; fields: string[]; summary: string; evidence: string[] };

function describe(kind: ChangeKind, field: string, operation: string, provider: string, from: string, to: string) {
  const name = `\`${plainName(field)}\``;
  if (kind === 'request-property-removed') return `${provider} ${to} no longer accepts request property ${name} on ${operation}; it was accepted in ${from}.`;
  if (kind === 'request-property-required') return `${provider} ${to} requires request property ${name} on ${operation}; it was not required in ${from}.`;
  return `${provider} ${to} changes the accepted type or values of request property ${name} on ${operation} compared with ${from}.`;
}

function propertyChanges(before: Request, after: Request, say: (kind: ChangeKind, field: string) => string): Draft[] {
  const drafts: Draft[] = [];
  const oldNames = Object.keys(before.properties).filter(validName);
  const newNames = Object.keys(after.properties).filter(validName);
  for (const field of oldNames) {
    if (Object.hasOwn(after.properties, field)) {
      if (typeChanged(before.properties[field], after.properties[field])) {
        drafts.push({ kind: 'request-property-type-changed', fields: [field], summary: say('request-property-type-changed', field), evidence: [field] });
      }
    } else {
      drafts.push({ kind: 'request-property-removed', fields: [field], summary: say('request-property-removed', field),
        evidence: [field, ...replacementCandidates(field, newNames)] });
    }
  }
  for (const field of after.required.filter(validName)) {
    if (!before.required.includes(field)) {
      drafts.push({ kind: 'request-property-required', fields: [field], summary: say('request-property-required', field), evidence: [field] });
    }
  }
  return drafts;
}

const topLevel = (path: string) => String(path).split('.')[0].replaceAll('[]', '');

// Whatever the rules engine calls breaking that the property comparison did
// not already explain, as one unclassified change.
function unclassified(oldSlice: OperationSlice, newSlice: OperationSlice, covered: Set<string>, operation: string, provider: string): Draft | null {
  let report: ReturnType<typeof compareContracts>;
  try { report = compareContracts(oldSlice.document, newSlice.document); } catch { return null; }
  if (report.verdict !== 'breaks') return null;
  const open = report.changes.filter(change => change.severity === 'error' && !change.fields.map(topLevel).every(field => covered.has(field)));
  const notes = report.notes.filter((note: { severity: string }) => note.severity === 'error');
  if (!open.length && (covered.size || !notes.length)) return null;
  const fields = [...new Set(open.flatMap(change => change.fields.map(topLevel)))].filter(validName).sort(byText).slice(0, 20);
  // Rule names are fixed identifiers from the rules engine, not provider text.
  const rules = [...new Set([...open, ...notes].map(item => item.rule))].filter(rule => /^[a-z-]{1,64}$/.test(rule)).sort(byText).slice(0, 10);
  return { kind: 'other', fields, evidence: fields,
    summary: `${provider} ${plainName(newSlice.version)} changes the request contract of ${operation} compared with ${plainName(oldSlice.version)} in a way that is not classified (${rules.join(', ') || 'unspecified'}).` };
}

function order(a: Draft, b: Draft) {
  return byText(a.kind, b.kind) || byText(a.fields.join(','), b.fields.join(','));
}

// Structured changes between two versions of one operation, sorted by kind
// then field. One change per property. For a removed property `before` and
// `after` also carry its replacement candidates (see replacementCandidates):
// keys not listed in `fields` are candidates, with null where a version lacks
// them. An unchanged operation yields [].
export function diffOperation(oldSlice: OperationSlice, newSlice: OperationSlice, options: DiffOptions = {}): ContractChange[] {
  if (oldSlice.sha256 === newSlice.sha256) return [];
  const provider = plainName(options.providerName ?? oldSlice.providerId, 80);
  const operation = plainName(oldSlice.operation);
  const before = requestOf(oldSlice);
  const after = requestOf(newSlice);
  const say = (kind: ChangeKind, field: string) => describe(kind, field, operation, provider, plainName(oldSlice.version), plainName(newSlice.version));
  const drafts = before && after ? propertyChanges(before, after, say) : [];
  const other = unclassified(oldSlice, newSlice, new Set(drafts.flatMap(draft => draft.fields)), operation, provider);
  return [...drafts, ...(other ? [other] : [])].sort(order).slice(0, maxChanges).map(draft => ({
    providerId: oldSlice.providerId, operation: oldSlice.operation,
    fromVersion: oldSlice.version, toVersion: newSlice.version,
    kind: draft.kind, fields: draft.fields, summary: draft.summary,
    before: Object.fromEntries(draft.evidence.map(name => [name, bounded(before && own(before.properties, name))])),
    after: Object.fromEntries(draft.evidence.map(name => [name, bounded(after && own(after.properties, name))])),
    oldSha256: oldSlice.sha256, newSha256: newSlice.sha256,
    oldSourceUrl: oldSlice.sourceUrl, newSourceUrl: newSlice.sourceUrl,
    ...(options.changelogUrl ? { changelogUrl: options.changelogUrl } : {}),
  }));
}

// The operation exists in the old contract and nowhere in the new one. There
// is no new slice to hash, so newSha256 is the hash of the whole new document
// when the caller has it and '' otherwise.
export function diffRemovedOperation(oldSlice: OperationSlice, next: { version: string; sourceUrl: string; sha256?: string }, options: DiffOptions = {}): ContractChange {
  const provider = plainName(options.providerName ?? oldSlice.providerId, 80);
  return {
    providerId: oldSlice.providerId, operation: oldSlice.operation,
    fromVersion: oldSlice.version, toVersion: next.version,
    kind: 'operation-removed', fields: [],
    summary: `${provider} ${plainName(next.version)} no longer describes ${plainName(oldSlice.operation)}; it was present in ${plainName(oldSlice.version)}.`,
    before: {}, after: {},
    oldSha256: oldSlice.sha256, newSha256: next.sha256 ?? '',
    oldSourceUrl: oldSlice.sourceUrl, newSourceUrl: next.sourceUrl,
    ...(options.changelogUrl ? { changelogUrl: options.changelogUrl } : {}),
  };
}
