// Fixing a consumer's code from the rules, with no AI.
//
// The gateway keeps old callers working; this is how they catch up. Given the source of a
// JavaScript or TypeScript client and the rules for a version change, fixConsumer rewrites the
// request the client sends to the changed endpoint:
//
//   body: JSON.stringify({ customerId, sku })   →   body: JSON.stringify({ accountId: customerId, sku })
//
// It only touches object literals inside the call that names the endpoint, and only for plain
// renames of request fields. Anything it cannot do safely (a field that moved into a nested
// object, a unit change, a computed key) is returned as `needsDecision`, in words, for a person
// or a model to handle. The result should always be checked by running the consumer's tests.

import { normalizeRule } from './rules.js';

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const OPEN = { '(': ')', '[': ']', '{': '}' };
const CLOSE = new Set([')', ']', '}']);
// After these, a "/" starts a regular expression rather than a division.
const BEFORE_REGEX = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^', 'return', 'typeof', 'case', 'in', 'of']);

// Splits source into tokens, keeping comments, strings and templates whole so nothing inside
// them is mistaken for code.
export function scan(source) {
  const tokens = [];
  let i = 0;
  let last = null; // the last token that is not space or a comment
  const push = (type, start, end) => {
    const token = { type, text: source.slice(start, end), start, end };
    tokens.push(token);
    if (type !== 'space' && type !== 'comment') last = token;
  };
  const skipString = (quote, from) => {
    let j = from + 1;
    while (j < source.length && source[j] !== quote) { if (source[j] === '\\') j += 1; if (source[j] === '\n' && quote !== '`') break; j += 1; }
    return Math.min(j + 1, source.length);
  };
  const skipTemplate = (from) => {
    let j = from + 1;
    while (j < source.length && source[j] !== '`') {
      if (source[j] === '\\') { j += 2; continue; }
      if (source[j] === '$' && source[j + 1] === '{') {
        let depth = 1;
        j += 2;
        while (j < source.length && depth > 0) {
          const ch = source[j];
          if (ch === '{') depth += 1;
          else if (ch === '}') depth -= 1;
          else if (ch === '"' || ch === "'") { j = skipString(ch, j); continue; } else if (ch === '`') { j = skipTemplate(j); continue; }
          j += 1;
        }
        continue;
      }
      j += 1;
    }
    return Math.min(j + 1, source.length);
  };
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (/\s/.test(ch)) { let j = i; while (j < source.length && /\s/.test(source[j])) j += 1; push('space', i, j); i = j; continue; }
    if (ch === '/' && next === '/') { let j = i; while (j < source.length && source[j] !== '\n') j += 1; push('comment', i, j); i = j; continue; }
    if (ch === '/' && next === '*') { const end = source.indexOf('*/', i + 2); const j = end === -1 ? source.length : end + 2; push('comment', i, j); i = j; continue; }
    if (ch === '"' || ch === "'") { const j = skipString(ch, i); push('string', i, j); i = j; continue; }
    if (ch === '`') { const j = skipTemplate(i); push('template', i, j); i = j; continue; }
    if (ch === '/' && (!last || BEFORE_REGEX.has(last.text))) {
      let j = i + 1;
      let inClass = false;
      while (j < source.length && source[j] !== '\n' && (source[j] !== '/' || inClass)) { if (source[j] === '\\') j += 1; else if (source[j] === '[') inClass = true; else if (source[j] === ']') inClass = false; j += 1; }
      j += 1;
      while (j < source.length && /[a-z]/i.test(source[j])) j += 1;
      push('regex', i, j); i = j; continue;
    }
    if (/[A-Za-z_$]/.test(ch)) { let j = i; while (j < source.length && /[A-Za-z0-9_$]/.test(source[j])) j += 1; push('word', i, j); i = j; continue; }
    if (/[0-9]/.test(ch)) { let j = i; while (j < source.length && /[0-9A-Za-z_.]/.test(source[j])) j += 1; push('number', i, j); i = j; continue; }
    if (ch === '=' && next === '>') { push('punct', i, i + 2); i += 2; continue; }
    if (ch === '.' && next === '.' && source[i + 2] === '.') { push('punct', i, i + 3); i += 3; continue; }
    push('punct', i, i + 1);
    i += 1;
  }
  return tokens;
}

const unquote = (token) => (token.type === 'string' ? token.text.slice(1, -1) : token.text);

// Finds the request-field renames the fixer can apply by itself, and describes the rest.
function plan(rules) {
  const renames = [];
  const manual = [];
  for (const raw of rules) {
    const rule = normalizeRule(raw);
    if (rule.in === 'response' || rule.in === 'query') {
      if (rule.in === 'response' && rule.op !== 'add') manual.push(`The answer changed: ${describe(rule)}. Update the code that reads it.`);
      continue;
    }
    if (rule.op === 'rename' && !rule.old.includes('.') && !rule.new.includes('.') && !rule.old.includes('[]')) { renames.push(rule); continue; }
    if (rule.op === 'endpoint_removed') manual.push(`${rule.method} ${rule.path} was removed. This call needs to be redesigned.`);
    else if (rule.op === 'endpoint_moved') manual.push(`${rule.method} ${rule.old} moved to ${rule.newMethod ?? rule.method} ${rule.new}. Update the address.`);
    else if (rule.op === 'add' && 'value' in rule) manual.push(`Send the new field ${rule.new} (the adapter uses ${JSON.stringify(rule.value)} for old callers).`);
    else if (rule.op === 'add') manual.push(`Send the new field ${rule.new}; nothing the old request carries can fill it.`);
    else if (rule.op === 'remove') manual.push(`Stop sending ${rule.old}; the new version no longer accepts it.`);
    else manual.push(`Change the request: ${describe(rule)}.`);
  }
  return { renames, manual };
}

function describe(rule) {
  if (rule.op === 'scale') return `${rule.old} is now ${rule.new}, multiplied by ${rule.factor}`;
  if (rule.op === 'time') return `${rule.old} (${rule.oldFormat}) is now ${rule.new} (${rule.newFormat})`;
  if (rule.op === 'values') return `${rule.new} uses new values (${Object.entries(rule.map).map(([a, b]) => `${a} → ${b}`).join(', ')})`;
  if (rule.op === 'type') return `${rule.old} (${rule.oldType}) is now ${rule.new} (${rule.newType})`;
  if (rule.op === 'case') return `${rule.old} is now ${rule.new} in ${rule.newCase} case`;
  return `${rule.old} is now ${rule.new}`;
}

// fixConsumer(source, rules, { paths: ['/api/managed/quotes'] })
//   → { after, changes: [{ line, before, after }], summary, needsDecision }
// `after` equals the source when nothing was changed; `needsDecision` is null when the fix is
// complete as far as the rules go.
export function fixConsumer(source, rules, options = {}) {
  const paths = options.paths ?? [];
  const { renames, manual } = plan(rules);
  const untouched = (why) => ({ after: source, changes: [], summary: '', needsDecision: why });
  if (!renames.length) return untouched(manual.length ? manual.join(' ') : 'These rules change nothing a client sends.');
  if (!paths.length) return untouched('Tell Mender which endpoint this client calls.');

  const tokens = scan(source);
  const code = tokens.filter((t) => t.type !== 'space' && t.type !== 'comment');
  const partner = new Map();
  const stack = [];
  code.forEach((token, index) => {
    if (token.type !== 'punct') return;
    if (OPEN[token.text]) stack.push(index);
    else if (CLOSE.has(token.text) && stack.length && OPEN[code[stack.at(-1)].text] === token.text) { const open = stack.pop(); partner.set(open, index); partner.set(index, open); }
  });

  // The calls that name the endpoint: fetch(`${base}/api/managed/quotes`, { … }).
  const ranges = [];
  code.forEach((token, index) => {
    if ((token.type !== 'string' && token.type !== 'template') || !paths.some((p) => token.text.includes(p))) return;
    let depth = 0;
    for (let k = index - 1; k >= 0; k--) {
      const t = code[k];
      if (t.type !== 'punct') continue;
      if (CLOSE.has(t.text)) depth += 1;
      else if (OPEN[t.text]) {
        if (depth > 0) { depth -= 1; continue; }
        if (t.text === '(' && partner.has(k)) { ranges.push([k, partner.get(k)]); break; }
      }
    }
  });
  if (!ranges.length) return untouched(`Mender could not find a call to ${paths.join(' or ')} in this file.`);

  const edits = [];
  const problems = [];
  const lineOf = (offset) => source.slice(0, offset).split('\n').length;
  const seen = new Set();
  for (const [from, to] of ranges) {
    for (let k = from + 1; k < to; k++) {
      if (code[k].text !== '{' || code[k].type !== 'punct' || !partner.has(k) || seen.has(k)) continue;
      const before = code[k - 1]?.text;
      if (before === '=>' || before === ')') continue; // a function body, not an object
      seen.add(k);
      const end = partner.get(k);
      // "{ a } = x" and "({ a }) => …" take fields out of an object; they are not requests.
      const next = code[end + 1]?.text;
      if (next === '=' || (next === ')' && ['=>', '{'].includes(code[end + 2]?.text))) continue;
      // The entries of this object literal: runs of tokens between top-level commas.
      const entries = [];
      let start = k + 1;
      for (let m = k + 1; m <= end; m++) {
        const t = code[m];
        if (t.type === 'punct' && OPEN[t.text] && partner.has(m) && m !== end) { m = partner.get(m); continue; }
        if (m === end || (t.type === 'punct' && t.text === ',')) { if (m > start) entries.push([start, m - 1]); start = m + 1; }
      }
      const keyOf = ([a, b]) => {
        const first = code[a];
        if (first.type !== 'word' && first.type !== 'string') return null;
        if (a === b) return first.type === 'word' ? { name: first.text, token: first, shorthand: true } : null;
        return code[a + 1].text === ':' ? { name: unquote(first), token: first, shorthand: false } : null;
      };
      const keys = entries.map(keyOf).filter(Boolean);
      for (const rule of renames) {
        const hit = keys.find((key) => key.name === rule.old);
        if (!hit) continue;
        if (keys.some((key) => key.name === rule.new)) { problems.push(`Line ${lineOf(hit.token.start)} already sends ${rule.new} next to ${rule.old}; decide which one the new version should get.`); continue; }
        const quote = hit.token.type === 'string' ? hit.token.text[0] : null;
        const name = quote ? `${quote}${rule.new}${quote}` : IDENTIFIER.test(rule.new) ? rule.new : `'${rule.new}'`;
        edits.push({ start: hit.token.start, end: hit.token.end, text: hit.shorthand ? `${name}: ${rule.old}` : name, rule });
      }
    }
  }

  const missing = renames.filter((rule) => !edits.some((e) => e.rule === rule));
  for (const rule of missing) problems.push(`Mender could not find where ${rule.old} is sent to ${paths.join(' or ')}; rename it to ${rule.new} by hand.`);
  if (!edits.length) return untouched([...problems, ...manual].join(' '));

  let after = source;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) after = after.slice(0, edit.start) + edit.text + after.slice(edit.end);
  const oldLines = source.split('\n');
  const newLines = after.split('\n');
  const changes = [...new Set(edits.map((e) => lineOf(e.start)))].sort((a, b) => a - b).map((line) => ({ line, before: oldLines[line - 1].trim(), after: newLines[line - 1].trim() }));
  const done = [...new Set(edits.map((e) => `${e.rule.old} as ${e.rule.new}`))];
  const rest = [...problems, ...manual];
  return {
    after,
    changes,
    summary: `The request to ${paths.join(', ')} now sends ${done.join(' and ')}.`,
    needsDecision: rest.length ? rest.join(' ') : null,
  };
}
