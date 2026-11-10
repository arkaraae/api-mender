// Whole-line edits and unified diffs, as plain string functions so the Worker
// and the CLI produce and verify byte-identical patches without a git binary.
import type { LineEdit } from '../types.ts';

const CONTEXT = 3;
// Above this the middle of the file is emitted as one replaced block: still a
// correct diff, just not a minimal one.
const MAX_LCS_CELLS = 2_000_000;
const NO_NEWLINE = '\\ No newline at end of file';

type EolLine = { text: string; eol: '' | '\n' | '\r\n' };

/** Split on LF and CRLF only, keeping each line's terminator. A final unterminated line has eol ''. */
export function splitLines(source: string): EolLine[] {
  const lines: EolLine[] = [];
  let start = 0;
  while (start < source.length) {
    const feed = source.indexOf('\n', start);
    if (feed === -1) { lines.push({ text: source.slice(start), eol: '' }); break; }
    const crlf = feed > start && source[feed - 1] === '\r';
    lines.push({ text: source.slice(start, crlf ? feed - 1 : feed), eol: crlf ? '\r\n' : '\n' });
    start = feed + 1;
  }
  return lines;
}

function checkEdits(edits: readonly LineEdit[], lineCount: number) {
  let previousEnd = 0;
  for (const edit of edits) {
    if (!Number.isSafeInteger(edit.startLine) || !Number.isSafeInteger(edit.endLine) || typeof edit.replacement !== 'string'
      || edit.startLine <= previousEnd || edit.endLine < edit.startLine || edit.endLine > lineCount)
      throw new RangeError('Line edits must be sorted, non-overlapping and inside the file');
    previousEnd = edit.endLine;
  }
}

/**
 * Replace whole lines. Inserted lines take the terminator of the lines they
 * replace, so a CRLF file stays CRLF and a file without a final newline stays
 * without one.
 */
export function applyLineEdits(source: string, edits: readonly LineEdit[]): string {
  const lines = splitLines(source);
  checkEdits(edits, lines.length);
  const fileEol = lines.find(line => line.eol)?.eol || '\n';
  let out = '';
  let next = 0;
  for (const edit of edits) {
    for (; next < edit.startLine - 1; next++) out += lines[next].text + lines[next].eol;
    const lastEol = lines[edit.endLine - 1].eol;
    const innerEol = lastEol || lines[edit.startLine - 1].eol || fileEol;
    const replacement = edit.replacement.replace(/\r\n/g, '\n').split('\n');
    replacement.forEach((text, index) => { out += text + (index === replacement.length - 1 ? lastEol : innerEol); });
    next = edit.endLine;
  }
  for (; next < lines.length; next++) out += lines[next].text + lines[next].eol;
  return out;
}

// Diff lines are split on LF only, the way git reads them: a CR stays part of
// the line. `eol` false marks a final line with no terminator.
type DiffLine = { text: string; eol: boolean };
type Op = { kind: ' ' | '-' | '+'; line: DiffLine };

function diffLines(source: string): DiffLine[] {
  if (source === '') return [];
  const parts = source.split('\n');
  const last = parts.pop()!;
  const lines = parts.map(text => ({ text, eol: true }));
  if (last !== '') lines.push({ text: last, eol: false });
  return lines;
}

const same = (a: DiffLine, b: DiffLine) => a.text === b.text && a.eol === b.eol;

function middleOps(a: DiffLine[], b: DiffLine[]): Op[] {
  const removed: Op[] = [];
  const added: Op[] = [];
  const ops: Op[] = [];
  // Removals before additions inside one change block, as git writes them.
  const flush = () => { ops.push(...removed.splice(0), ...added.splice(0)); };
  if (a.length * b.length > MAX_LCS_CELLS) {
    return [...a.map(line => ({ kind: '-' as const, line })), ...b.map(line => ({ kind: '+' as const, line }))];
  }
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--)
    table[i * width + j] = same(a[i], b[j]) ? table[(i + 1) * width + j + 1] + 1
      : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && same(a[i], b[j])) { flush(); ops.push({ kind: ' ', line: a[i] }); i++; j++; }
    else if (j >= b.length || (i < a.length && table[(i + 1) * width + j] >= table[i * width + j + 1])) removed.push({ kind: '-', line: a[i++] });
    else added.push({ kind: '+', line: b[j++] });
  }
  flush();
  return ops;
}

function lineOps(before: DiffLine[], after: DiffLine[]): Op[] {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && same(before[prefix], after[prefix])) prefix++;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix
    && same(before[before.length - 1 - suffix], after[after.length - 1 - suffix])) suffix++;
  const context = (line: DiffLine): Op => ({ kind: ' ', line });
  return [...before.slice(0, prefix).map(context),
    ...middleOps(before.slice(prefix, before.length - suffix), after.slice(prefix, after.length - suffix)),
    ...before.slice(before.length - suffix).map(context)];
}

/** Repository-relative path that can be written into a diff header without quoting. */
export function isSafeDiffPath(file: string): boolean {
  return file.length > 0 && file.length <= 512 && !file.startsWith('/')
    && file.split('/').every(part => part !== '' && part !== '.' && part !== '..' && /^[A-Za-z0-9_.@()[\]+,=~$-]+$/.test(part));
}

function hunkText(ops: Op[], from: number, to: number, oldBefore: number, newBefore: number): string {
  const slice = ops.slice(from, to);
  const oldCount = slice.filter(op => op.kind !== '+').length;
  const newCount = slice.filter(op => op.kind !== '-').length;
  // An empty side is addressed by the line before it, per the unified format.
  let text = `@@ -${oldCount ? oldBefore + 1 : oldBefore},${oldCount} +${newCount ? newBefore + 1 : newBefore},${newCount} @@\n`;
  for (const op of slice) text += `${op.kind}${op.line.text}\n${op.line.eol ? '' : `${NO_NEWLINE}\n`}`;
  return text;
}

/**
 * Unified diff with three lines of context that `git apply` accepts. Returns
 * '' when the texts are identical.
 */
export function unifiedDiff(file: string, before: string, after: string): string {
  if (!isSafeDiffPath(file)) throw new Error('File path cannot be written to a diff header');
  if (before === after) return '';
  const ops = lineOps(diffLines(before), diffLines(after));
  let text = `--- a/${file}\n+++ b/${file}\n`;
  let index = 0;
  let oldLine = 0;
  let newLine = 0;
  const advance = (to: number) => {
    for (; index < to; index++) { if (ops[index].kind !== '+') oldLine++; if (ops[index].kind !== '-') newLine++; }
  };
  while (index < ops.length) {
    const first = ops.findIndex((op, at) => at >= index && op.kind !== ' ');
    if (first === -1) break;
    // Extend the hunk while the next change is close enough to share context.
    let last = first;
    for (let at = first + 1; at < ops.length && at - last <= 2 * CONTEXT + 1; at++) if (ops[at].kind !== ' ') last = at;
    const from = Math.max(index, first - CONTEXT);
    const to = Math.min(ops.length, last + 1 + CONTEXT);
    advance(from);
    text += hunkText(ops, from, to, oldLine, newLine);
    advance(to);
  }
  return text;
}

const FORBIDDEN_HEADER = /^(?:diff |index |old mode|new mode|deleted file mode|new file mode|rename |copy |similarity |dissimilarity |Binary files |GIT binary patch)/;

function fail(detail: string): never { throw new Error(`Patch rejected: ${detail}`); }

type Hunk = { oldStart: number; oldCount: number; ops: Op[] };

function parseHunks(rows: string[], at: number): Hunk[] {
  const hunks: Hunk[] = [];
  while (at < rows.length) {
    const header = /^@@ -(\d{1,9})(?:,(\d{1,9}))? \+(\d{1,9})(?:,(\d{1,9}))? @@/.exec(rows[at]);
    if (!header) fail('expected a hunk header; a patch may touch one file only');
    at++;
    let oldLeft = header[2] === undefined ? 1 : Number(header[2]);
    let newLeft = header[4] === undefined ? 1 : Number(header[4]);
    const hunk: Hunk = { oldStart: Number(header[1]), oldCount: oldLeft, ops: [] };
    while (oldLeft > 0 || newLeft > 0) {
      const row = rows[at++];
      const kind = row?.[0];
      if (kind !== ' ' && kind !== '-' && kind !== '+') fail('malformed hunk body');
      if (kind !== '+') oldLeft--;
      if (kind !== '-') newLeft--;
      if (oldLeft < 0 || newLeft < 0) fail('hunk line counts do not match its header');
      const line = { text: row.slice(1), eol: true };
      if (rows[at] === NO_NEWLINE) { line.eol = false; at++; }
      hunk.ops.push({ kind, line });
    }
    if (!hunk.ops.some(op => op.kind !== ' ')) fail('hunk changes nothing');
    hunks.push(hunk);
  }
  return hunks;
}

/**
 * Apply a single-file unified diff with no fuzz: every context and removed
 * line must match the source exactly at the stated position. Rejects renames,
 * mode changes, binary patches and any second file.
 */
export function applyUnifiedDiff(source: string, diff: string, file: string): string {
  if (!isSafeDiffPath(file)) fail('unsupported file path');
  if (diff.length > 1_000_000 || !diff.endsWith('\n')) fail('patch is empty, truncated or too large');
  const rows = diff.slice(0, -1).split('\n');
  if (rows[0] !== `--- a/${file}` || rows[1] !== `+++ b/${file}`) fail('patch does not name exactly the expected file');
  if (rows.slice(0, 2).some(row => FORBIDDEN_HEADER.test(row))) fail('unsupported patch header');
  const hunks = parseHunks(rows, 2);
  if (!hunks.length) fail('patch has no hunks');
  const old = diffLines(source);
  const result: DiffLine[] = [];
  let position = 0;
  for (const hunk of hunks) {
    const start = hunk.oldCount ? hunk.oldStart - 1 : hunk.oldStart;
    if (start < position || start > old.length) fail('hunks overlap or lie outside the file');
    result.push(...old.slice(position, start));
    position = start;
    for (const op of hunk.ops) {
      if (op.kind === '+') { result.push(op.line); continue; }
      if (position >= old.length || !same(old[position], op.line)) fail('context does not match the source');
      if (op.kind === ' ') result.push(old[position]);
      position++;
    }
  }
  result.push(...old.slice(position));
  // Only the last line of a file may lack a terminator.
  if (result.some((line, index) => !line.eol && index !== result.length - 1)) fail('misplaced end-of-file marker');
  return result.map(line => line.text + (line.eol ? '\n' : '')).join('');
}

/** Lines a diff removes and adds, read from hunk bodies only. */
export function countChangedLines(diff: string): number {
  return diff.split('\n').slice(2).filter(row => row[0] === '-' || row[0] === '+').length;
}
