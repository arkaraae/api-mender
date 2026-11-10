// Deterministic gates every proposed patch must pass, whoever wrote it. A
// model's answer is untrusted: these checks, not the prompt, are what keep a
// patch inside the one request body it was asked to change.
//
// Details are shown to reviewers and logged. They name gates, counts,
// identifiers and field names only, never source text.
import type { Finding, LineEdit, PolicyCheck } from '../types.ts';
import { parseStaticHttpCalls } from '../../static-http-calls.ts';
import { bodyProperties, fetchCallsStartingOn, keyName, parseSource, textOf, unwrap, walk } from './ast.ts';
import type { BodyProperty, Node, TargetCall } from './ast.ts';
import { applyLineEdits, applyUnifiedDiff, countChangedLines, splitLines, unifiedDiff } from './diff.ts';
import { findSecrets } from './secrets.ts';
import { locateTargetCall } from './task.ts';
import type { RepairContract, SupportedRepairTask } from './task.ts';

export const POLICY_GATES = ['edits-in-range', 'bounded-size', 'single-file', 'parses', 'outside-untouched',
  'call-inventory-stable', 'body-satisfies-contract', 'no-new-capabilities', 'values-preserved',
  'no-secrets-added', 'changes-something'] as const;
export type PolicyGate = typeof POLICY_GATES[number];

export type PatchInput = { finding: Finding; task: SupportedRepairTask; contract: RepairContract; source: string; edits: LineEdit[] };
export type PatchEvaluation = { passed: boolean; checks: PolicyCheck[]; afterSource?: string; diff?: string };

type Verdict = { passed: boolean; detail: string };
const pass = (detail: string): Verdict => ({ passed: true, detail });
const fail = (detail: string): Verdict => ({ passed: false, detail });

const MAX_CHANGED_LINES = 20;
const MAX_GROWTH_BYTES = 2048;
// Syntax that only shapes data. Any other node type is a potential new
// capability and may not become more frequent inside the editable lines.
const DATA_TYPES = new Set(['ObjectExpression', 'ObjectProperty', 'ArrayExpression', 'Identifier', 'StringLiteral',
  'NullLiteral', 'ConditionalExpression', 'LogicalExpression', 'BinaryExpression', 'UnaryExpression']);
// Literals whose text must not change at all.
const FROZEN_LITERALS = new Set(['TemplateLiteral', 'RegExpLiteral', 'BigIntLiteral', 'DecimalLiteral', 'DirectiveLiteral', 'JSXText']);
const IMPORT_TYPES = ['Import', 'ImportExpression', 'ImportDeclaration', 'TSImportEqualsDeclaration', 'TSImportType'];
const CODE_LOADERS = ['require', 'eval', 'Function', 'importScripts'];

const bytes = (text: string) => new TextEncoder().encode(text).length;
// Names come from untrusted code or model output; show only identifier-like ones.
const shown = (name: string) => /^[A-Za-z_$][\w$.-]{0,63}$/.test(name) ? name : '<non-identifier>';
const list = (names: Iterable<string>) => [...new Set(names)].slice(0, 8).map(shown).join(', ');

type Region = { start: number; end: number };

/** Character span of the editable lines, terminators included. */
function regionOf(source: string, range: { start: number; end: number }): Region {
  let offset = 0;
  let start = 0;
  const lines = splitLines(source);
  for (let index = 0; index < lines.length && index < range.end; index++) {
    if (index === range.start - 1) start = offset;
    offset += lines[index].text.length + lines[index].eol.length;
  }
  return { start, end: offset };
}

type Context = {
  input: PatchInput;
  after: string;
  diff: string;
  before: { source: string; syntax: Node | null; region: Region; call: TargetCall | null };
  patched: { source: string; syntax: Node | null; region: Region; call: TargetCall | null };
};

function editsInRange({ task, edits }: PatchInput, applied: boolean): Verdict {
  const { start, end } = task.editableRange;
  const outside = edits.filter(edit => !(edit.startLine >= start && edit.endLine <= end)).length;
  if (!edits.length) return fail('The patch has no edits');
  if (outside) return fail(`${outside} edit(s) touch lines outside the editable lines ${start}-${end}`);
  return applied ? pass(`All edits lie inside lines ${start}-${end}`) : fail('Edits are malformed, unsorted or overlapping');
}

function boundedSize(context: Context): Verdict {
  const changed = countChangedLines(context.diff);
  const growth = bytes(context.after) - bytes(context.input.source);
  if (changed > MAX_CHANGED_LINES) return fail(`The patch changes ${changed} lines; the limit is ${MAX_CHANGED_LINES}`);
  if (growth > MAX_GROWTH_BYTES) return fail(`The patch grows the file by ${growth} bytes; the limit is ${MAX_GROWTH_BYTES}`);
  return pass(`${changed} changed line(s), ${growth} byte(s) of growth`);
}

// True by construction; asserted by reading the diff back with the strict
// applier, which accepts exactly one file and must reproduce the patched text.
function singleFile(context: Context): Verdict {
  if (!context.diff) return pass('The diff is empty');
  try {
    return applyUnifiedDiff(context.input.source, context.diff, context.input.finding.location.file) === context.after
      ? pass('The diff names only the finding\'s file and reproduces the patched text')
      : fail('The diff does not reproduce the patched text');
  } catch { return fail('The diff is not a clean single-file patch for the finding\'s file'); }
}

function parses(context: Context): Verdict {
  if (!context.before.syntax) return fail('The original source does not parse');
  return context.patched.syntax ? pass('Original and patched source both parse') : fail('The patched source does not parse');
}

function linesOutsideEditsIdentical(context: Context): boolean {
  const before = splitLines(context.input.source);
  const after = splitLines(context.after);
  const equal = (a: number, b: number, count: number) => {
    for (let index = 0; index < count; index++) {
      const x = before[a + index];
      const y = after[b + index];
      if (!x || !y || x.text !== y.text || x.eol !== y.eol) return false;
    }
    return true;
  };
  let from = 0;
  let to = 0;
  for (const edit of context.input.edits) {
    if (!equal(from, to, edit.startLine - 1 - from)) return false;
    to += edit.startLine - 1 - from + edit.replacement.split('\n').length;
    from = edit.endLine;
  }
  return before.length - from === after.length - to && equal(from, to, before.length - from);
}

// Every syntax node that does not start inside the editable lines, by type and
// position relative to the region. Equal lists mean the edit did not change
// how the rest of the file parses (an unclosed quote or comment would).
function outsideShape(syntax: Node, region: Region): string | null {
  const place = (offset: number) => offset <= region.start ? `${offset}` : offset >= region.end ? `e${offset - region.end}` : 'in';
  const shape: string[] = [];
  const complete = walk(syntax, node => {
    const start = node.start ?? 0;
    if (start >= region.start && start < region.end) return;
    shape.push(`${node.type}:${place(start)}:${place(node.end ?? 0)}`);
  });
  return complete ? shape.sort().join('|') : null;
}

function outsideUntouched(context: Context): Verdict {
  if (!linesOutsideEditsIdentical(context)) return fail('A line outside the edited ranges changed');
  const { before, patched } = context;
  if (!before.syntax || !patched.syntax) return fail('Lines outside the edits are identical, but the syntax around them could not be compared');
  const shape = outsideShape(before.syntax, before.region);
  if (shape === null || shape !== outsideShape(patched.syntax, patched.region))
    return fail('The edit changes how code outside the editable lines parses');
  return pass('Every line outside the edited ranges is byte-identical and parses to the same syntax');
}

// Inventory rows with line numbers after the edit shifted back, so an
// unchanged call compares equal. Rows inside the editable lines are split out.
function inventory(file: string, source: string, range: { start: number; end: number }, lineShift: number) {
  const inside: Array<{ origin: string; endpoint: string; symbol: string }> = [];
  const outside: string[] = [];
  for (const call of parseStaticHttpCalls(file, source)) {
    if (call.line >= range.start && call.line <= range.end + lineShift) {
      inside.push({ origin: call.origin, endpoint: call.endpoint, symbol: call.symbol });
      continue;
    }
    const row: Record<string, unknown> = { ...call };
    for (const key of ['line', 'endLine', 'bodyLine'])
      if (typeof row[key] === 'number' && (row[key] as number) > range.end + lineShift) row[key] = (row[key] as number) - lineShift;
    outside.push(JSON.stringify(row));
  }
  return { inside: JSON.stringify(inside), outside: JSON.stringify(outside), count: inside.length + outside.length };
}

function sameCallFrame(context: Context, before: TargetCall, after: TargetCall): string | null {
  const a = context.before.source;
  const b = context.patched.source;
  if (textOf(a, before.node.callee) !== textOf(b, after.node.callee)) return 'the function being called changed';
  if (textOf(a, before.node.arguments[0]) !== textOf(b, after.node.arguments[0])) return 'the URL expression changed';
  const frame = (source: string, call: TargetCall) => (call.options.properties as Node[])
    .map(item => item === call.bodyProperty ? `body:${textOf(source, unwrap(item.value)?.callee)}` : textOf(source, item));
  const options = frame(a, before);
  const patched = frame(b, after);
  if (options.length !== patched.length || options.some((text, index) => text !== patched[index]))
    return 'a request option other than the body changed (method, headers or another option)';
  // With the options equal, this pins every remaining character on the
  // editable lines: only the body's object literal is free to differ.
  if (a.slice(context.before.region.start, before.bodyObject.start) !== b.slice(context.patched.region.start, after.bodyObject.start)
    || a.slice(before.bodyObject.end, context.before.region.end) !== b.slice(after.bodyObject.end, context.patched.region.end))
    return 'text around the request body changed';
  return null;
}

function callInventoryStable(context: Context): Verdict {
  const { finding, task, source } = context.input;
  const lineShift = splitLines(context.after).length - splitLines(source).length;
  const before = inventory(finding.location.file, source, task.editableRange, 0);
  const after = inventory(finding.location.file, context.after, task.editableRange, lineShift);
  if (before.count !== after.count) return fail(`The number of HTTP calls changed from ${before.count} to ${after.count}`);
  if (before.outside !== after.outside) return fail('An HTTP call other than the target changed');
  if (before.inside !== after.inside) return fail('The target call\'s origin, method or path changed');
  if (!context.before.call) return fail('The target call could not be located in the original source');
  if (!context.patched.call) return fail('The patched source no longer has the target call with the same origin, method and path on the same line');
  const difference = sameCallFrame(context, context.before.call, context.patched.call);
  return difference ? fail(`The target call is not stable: ${difference}`)
    : pass(`${before.count} inventoried HTTP call(s) unchanged; target call keeps its callee, URL, method, headers and options`);
}

function patchedBody(context: Context): BodyProperty[] | null {
  return context.patched.call ? bodyProperties(context.patched.source, context.patched.call) : null;
}

function bodySatisfiesContract(context: Context): Verdict {
  const { contract } = context.input;
  const body = patchedBody(context);
  if (!body) return fail('The patched request body is not a JSON.stringify of an object with literal keys');
  const names = body.map(item => item.name);
  const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
  if (duplicates.length) return fail(`The body repeats field(s): ${list(duplicates)}`);
  const removed = names.filter(name => contract.removed.includes(name));
  if (removed.length) return fail(`The body still sends removed field(s): ${list(removed)}`);
  const missing = contract.required.filter(name => !names.includes(name));
  if (missing.length) return fail(`The body lacks required field(s): ${list(missing)}`);
  const accepted = contract.acceptedProperties;
  const unknown = accepted ? names.filter(name => !accepted.includes(name)) : [];
  if (unknown.length) return fail(`The body sends field(s) the new contract does not accept: ${list(unknown)}`);
  return pass(`Body fields ${list(names)} satisfy the new contract${accepted ? '' : ' (accepted properties unknown; only removed and required fields checked)'}`);
}

type Features = {
  types: Map<string, number>; callees: string[]; identifiers: Set<string>; keys: Set<string>;
  strings: Set<string>; frozen: string[]; operators: Set<string>;
};

/** What the code that starts inside the editable lines can do, as comparable facts. */
function featuresOf(source: string, syntax: Node, region: Region): Features | null {
  const features: Features = { types: new Map(), callees: [], identifiers: new Set(), keys: new Set(),
    strings: new Set(), frozen: [], operators: new Set() };
  const complete = walk(syntax, (node, parent) => {
    const start = node.start ?? 0;
    const type = node.type || '';
    if (start < region.start || start >= region.end || type === 'File' || type === 'Program') return;
    features.types.set(type, (features.types.get(type) || 0) + 1);
    const isKey = parent?.type === 'ObjectProperty' && parent.key === node && !parent.computed;
    if (type === 'CallExpression' || type === 'OptionalCallExpression' || type === 'NewExpression') features.callees.push(textOf(source, node.callee));
    else if (type === 'Identifier' || type === 'JSXIdentifier') (isKey ? features.keys : features.identifiers).add(node.name);
    else if (type === 'StringLiteral') (isKey ? features.keys : features.strings).add(node.value);
    else if (type === 'UnaryExpression' || type === 'BinaryExpression') features.operators.add(`${type}:${node.operator}`);
    else if (FROZEN_LITERALS.has(type)) features.frozen.push(`${type}:${textOf(source, node)}`);
  });
  features.callees.sort();
  features.frozen.sort();
  return complete ? features : null;
}

// Names the new contract itself gives to request properties: the only new
// object keys or strings a patch may introduce.
function contractNames({ contract, finding }: PatchInput): Set<string> {
  const defined = Object.entries(finding.change.after || {}).filter(([, schema]) => schema !== null).map(([name]) => name);
  return new Set([...(contract.acceptedProperties || []), ...contract.required, ...defined]
    .filter(name => !contract.removed.includes(name)));
}

function notIn(items: Iterable<string>, allowed: { has(item: string): boolean }): string[] {
  return [...items].filter(item => !allowed.has(item));
}

function extraCallees(before: string[], after: string[]): number {
  const left = [...before];
  return after.filter(callee => { const at = left.indexOf(callee); if (at === -1) return true; left.splice(at, 1); return false; }).length;
}

function noNewCapabilities(context: Context): Verdict {
  const { before, patched } = context;
  if (!before.syntax || !patched.syntax) return fail('Not evaluated: the source does not parse');
  const was = featuresOf(before.source, before.syntax, before.region);
  const now = featuresOf(patched.source, patched.syntax, patched.region);
  if (!was || !now) return fail('The file is too large to analyse');
  const comments = (syntax: Node) => JSON.stringify(((syntax.comments || []) as Node[]).map(comment => [comment.type, comment.value]));
  if (comments(before.syntax) !== comments(patched.syntax)) return fail('The patch adds, removes or changes a comment');
  const grew = (type: string) => (now.types.get(type) || 0) > (was.types.get(type) || 0);
  if (IMPORT_TYPES.some(grew)) return fail('The patch adds an import');
  const loaders = CODE_LOADERS.filter(name => now.identifiers.has(name) && !was.identifiers.has(name));
  if (loaders.length) return fail(`The patch introduces code loading or evaluation: ${list(loaders)}`);
  const calls = extraCallees(was.callees, now.callees);
  if (calls || ['CallExpression', 'OptionalCallExpression', 'NewExpression'].some(grew))
    return fail('The patch introduces a new call or constructor expression');
  if (was.frozen.join('\n') !== now.frozen.join('\n')) return fail('The patch changes a template literal, regular expression or other fixed literal');
  const syntax = [...now.types.keys()].filter(type => !DATA_TYPES.has(type) && grew(type));
  if (syntax.length) return fail(`The patch introduces new syntax: ${list(syntax)}`);
  const identifiers = notIn(now.identifiers, new Set([...was.identifiers, 'undefined']));
  if (identifiers.length) return fail(`The patch references name(s) not used in the original lines: ${list(identifiers)}`);
  const keys = notIn(now.keys, new Set([...was.keys, ...contractNames(context.input)]));
  if (keys.length) return fail(`The patch adds object key(s) that are not contract property names: ${list(keys)}`);
  if (notIn(now.strings, was.strings).length) return fail('The patch adds a string literal that was not in the original lines');
  const allowedOperators = new Set(was.operators);
  if (notIn(now.operators, allowedOperators).length) return fail('The patch introduces a new operator');
  return pass('No new calls, imports, names, strings, literals, operators or comments on the editable lines');
}

// A value may be re-wrapped in an array or object literal, and nothing else:
// no conditionals, logic, comparisons, negation or placeholder leaves, which
// could send something other than the value (`[!login]`, `null ? [login] : null`).
// Every leaf must be a value being moved, and each occurrence is counted.
function onlyWraps(source: string, node: Node | null | undefined, moved: Set<string>, found: string[]): boolean {
  if (!node) return false;
  const text = textOf(source, node);
  if (moved.has(text)) { found.push(text); return true; }
  switch (node.type) {
    // One null guard is allowed: `value ? [value] : []`. The test must be the
    // moved value itself and the fallback empty, so the value is sent
    // whenever it exists and nothing else ever is.
    case 'ConditionalExpression': {
      const fallback = unwrap(node.alternate);
      const empty = fallback?.type === 'NullLiteral' || (fallback?.type === 'Identifier' && fallback.name === 'undefined')
        || (fallback?.type === 'ArrayExpression' && fallback.elements.length === 0)
        || (fallback?.type === 'ObjectExpression' && fallback.properties.length === 0);
      const guard = textOf(source, node.test);
      return moved.has(guard) && empty && onlyWraps(source, node.consequent, new Set([guard]), found) && found.at(-1) === guard;
    }
    case 'ArrayExpression': return node.elements.length > 0 && (node.elements as Array<Node | null>).every(child => onlyWraps(source, child, moved, found));
    case 'ObjectExpression': return node.properties.length > 0 && (node.properties as Node[]).every(item => keyName(item) !== null && onlyWraps(source, item.value, moved, found));
    default: return false;
  }
}

function valuesPreserved(context: Context): Verdict {
  const { contract, finding } = context.input;
  const before = context.before.call ? bodyProperties(context.before.source, context.before.call) : null;
  const after = patchedBody(context);
  if (!before || !after) return fail('Not evaluated: the request body could not be read before and after');
  const beforeNames = before.map(item => item.name);
  if (new Set(beforeNames).size !== beforeNames.length) return fail('The original body repeats a field, so values cannot be tracked');
  const isDropped = (name: string) => contract.removed.includes(name)
    || (contract.acceptedProperties !== null && !contract.acceptedProperties.includes(name));
  const reshapable = finding.change.kind === 'request-property-type-changed' ? finding.change.fields : [];
  const dropped = before.filter(item => isDropped(item.name));
  const moved = new Set(dropped.map(item => item.valueText));
  const found = new Set<string>();
  for (const item of before.filter(entry => !isDropped(entry.name))) {
    const now = after.filter(entry => entry.name === item.name);
    if (now.length !== 1) return fail(`Field ${shown(item.name)} is no longer sent exactly once`);
    if (now[0].valueText === item.valueText) continue;
    // A type change keeps the field and re-wraps its own value, nothing more.
    const carried: string[] = [];
    if (!reshapable.includes(item.name) || !onlyWraps(context.patched.source, now[0].value, new Set([item.valueText]), carried) || carried.length !== 1)
      return fail(`The value sent as ${shown(item.name)} changed`);
  }
  for (const item of after.filter(entry => !beforeNames.includes(entry.name))) {
    const carried: string[] = [];
    if (!onlyWraps(context.patched.source, item.value, moved, carried) || !carried.length)
      return fail(`New field ${shown(item.name)} carries something other than a value moved from a removed field`);
    for (const text of carried) {
      // A moved value goes to exactly one place; copying it into a second
      // field (e.g. the issue body) changes what is sent.
      if (found.has(text)) return fail(`A moved value is sent more than once (again as ${shown(item.name)})`);
      found.add(text);
    }
  }
  const lost = dropped.filter(item => !found.has(item.valueText)).map(item => item.name);
  // Dropping data may be right, but it is a human decision, never an automatic one.
  if (lost.length) return fail(`The value previously sent as ${list(lost)} is no longer sent`);
  return pass('Every value sent before is still sent; kept fields are textually identical');
}

function noSecretsAdded({ source, edits }: PatchInput): Verdict {
  const lines = splitLines(source).map(line => line.text);
  const added = edits.flatMap(edit => {
    const original = new Set(lines.slice(edit.startLine - 1, edit.endLine));
    return edit.replacement.split('\n').filter(line => !original.has(line));
  });
  const rules = findSecrets(added.join('\n'));
  return rules.length ? fail(`Added lines match secret rule(s): ${rules.join(', ')}`) : pass('No added line matches a secret rule');
}

function side(finding: Finding, source: string, range: { start: number; end: number }, lineShift: number, original: boolean) {
  const syntax = parseSource(source);
  const evidence = finding.evidence.call;
  let call: TargetCall | null = null;
  if (original) call = locateTargetCall(finding, source);
  else if (syntax) {
    const matches = (fetchCallsStartingOn(syntax, range.start) || [])
      .filter(item => item.endpoint === evidence.endpoint && item.origin === evidence.origin);
    call = matches.length === 1 ? matches[0] : null;
  }
  return { source, syntax, region: regionOf(source, { start: range.start, end: range.end + lineShift }), call };
}

/** Run every gate and report each one. A patch is acceptable only when all pass. */
export function evaluatePatch(input: PatchInput): PatchEvaluation {
  let after: string | null = null;
  try { after = applyLineEdits(input.source, input.edits); } catch { /* reported by edits-in-range */ }
  const verdicts = new Map<PolicyGate, Verdict>();
  verdicts.set('edits-in-range', editsInRange(input, after !== null));
  let diff: string | undefined;
  if (after !== null) {
    diff = unifiedDiff(input.finding.location.file, input.source, after);
    const lineShift = splitLines(after).length - splitLines(input.source).length;
    const context: Context = { input, after, diff,
      before: side(input.finding, input.source, input.task.editableRange, 0, true),
      patched: side(input.finding, after, input.task.editableRange, lineShift, false) };
    verdicts.set('bounded-size', boundedSize(context));
    verdicts.set('single-file', singleFile(context));
    verdicts.set('parses', parses(context));
    verdicts.set('outside-untouched', outsideUntouched(context));
    verdicts.set('call-inventory-stable', callInventoryStable(context));
    verdicts.set('body-satisfies-contract', bodySatisfiesContract(context));
    verdicts.set('no-new-capabilities', noNewCapabilities(context));
    verdicts.set('values-preserved', valuesPreserved(context));
    verdicts.set('no-secrets-added', noSecretsAdded(input));
    verdicts.set('changes-something', after !== input.source ? pass('The patch changes the file') : fail('The patch changes nothing'));
  }
  const checks = POLICY_GATES.map(name => ({ name, ...(verdicts.get(name) || fail('Not evaluated: the edits could not be applied')) }));
  return { passed: checks.every(check => check.passed), checks, ...(after !== null ? { afterSource: after, diff } : {}) };
}
