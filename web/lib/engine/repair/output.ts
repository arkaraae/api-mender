// Validates a model's answer as hostile input. Server-side schema enforcement
// is optional and varies by server, so nothing here relies on it.
import type { LineEdit } from '../types.ts';
import type { SupportedRepairTask } from './task.ts';

export type ModelDecision =
  | { decision: 'abstain'; reason: string }
  | { decision: 'patch'; reason: string; edits: LineEdit[] };

export class ModelOutputError extends Error {
  constructor(message: string) { super(message); this.name = 'ModelOutputError'; }
}

const MAX_EDITS = 3;
const MAX_REPLACEMENT_BYTES = 2048;
const MAX_REASON_CHARS = 300;

function invalid(detail: string): never { throw new ModelOutputError(`Model output is invalid: ${detail}`); }

function exactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const own = Object.keys(value);
  return own.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

/**
 * One printable line. The reason is shown to reviewers, so control characters,
 * line breaks and bidirectional or zero-width format characters are removed.
 */
export function sanitiseReason(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/[\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/g, '')
    .replace(/[\ud800-\udfff]/g, '')
    .replace(/\s+/g, ' ').trim().slice(0, MAX_REASON_CHARS);
}

function parseEdit(value: unknown, task: SupportedRepairTask): LineEdit {
  if (!exactKeys(value, ['start_line', 'end_line', 'replacement'])) invalid('an edit has the wrong keys');
  const { start_line: startLine, end_line: endLine, replacement } = value;
  if (typeof startLine !== 'number' || typeof endLine !== 'number' || !Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine))
    invalid('edit line numbers must be integers');
  // The model was only shown the excerpt; a line number outside it is noise.
  // Whether the line was *editable* is a policy gate, reported separately.
  if (startLine < task.excerptRange.start || endLine > task.excerptRange.end || endLine < startLine)
    invalid('an edit refers to lines outside the excerpt');
  if (typeof replacement !== 'string') invalid('edit replacement must be a string');
  // Tab and line feed are the only control characters source lines need.
  const text = replacement.replace(/\r\n/g, '\n').replace(/\n$/, '');
  if (/[\u0000-\u0008\u000b-\u001f\u007f\u2028\u2029]/.test(text)) invalid('edit replacement contains control characters');
  return { startLine, endLine, replacement: text };
}

/** Strictly validate a decoded model answer against the task it was given. */
export function parseModelDecision(value: unknown, task: SupportedRepairTask): ModelDecision {
  if (!exactKeys(value, ['decision', 'reason', 'edits'])) invalid('expected exactly decision, reason and edits');
  if (value.decision !== 'patch' && value.decision !== 'abstain') invalid('unknown decision');
  if (typeof value.reason !== 'string') invalid('reason must be a string');
  if (!Array.isArray(value.edits)) invalid('edits must be an array');
  const reason = sanitiseReason(value.reason);
  if (value.decision === 'abstain') {
    if (value.edits.length) invalid('an abstention must not carry edits');
    return { decision: 'abstain', reason };
  }
  if (value.edits.length < 1 || value.edits.length > MAX_EDITS) invalid(`a patch needs 1 to ${MAX_EDITS} edits`);
  const edits = value.edits.map(edit => parseEdit(edit, task));
  for (let index = 1; index < edits.length; index++)
    if (edits[index].startLine <= edits[index - 1].endLine) invalid('edits must be sorted and must not overlap');
  const bytes = edits.reduce((total, edit) => total + new TextEncoder().encode(edit.replacement).length, 0);
  if (bytes > MAX_REPLACEMENT_BYTES) invalid('replacement text is too large');
  return { decision: 'patch', reason, edits };
}
