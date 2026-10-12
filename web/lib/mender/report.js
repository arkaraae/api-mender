// Turns what the engine found between two API versions into a report a person can read at a
// glance: one verdict, a short list of changes grouped by what they mean for old callers, and
// the places where a change touches a caller's code. Used by the /check page.

import { describeRule, normalizeRule } from './rules.js';

// Notes that mean old callers break and nothing can translate for them.
const BLOCKING = new Set(['needs_default', 'type_changed', 'list_shape', 'path_changed', 'content_type', 'enum_removed']);

// What each kind of rule means for a caller still on the old version.
function kindOf(rule) {
  if (rule.op === 'endpoint_removed') return 'gone';
  // A dropped request field is a loss too: the old caller's value is silently ignored.
  if (rule.op === 'remove') return 'lost';
  return 'bridged';
}

const endpointsOf = (rule) => (rule.endpoint === undefined ? [] : [].concat(rule.endpoint));

function scopeOf(rule) {
  const where = rule.in === 'query' ? 'query string' : rule.in ? `${rule.in}s` : '';
  const endpoints = endpointsOf(rule);
  const on = endpoints.length > 2 ? `${endpoints.slice(0, 2).join(', ')} and ${endpoints.length - 2} more` : endpoints.join(', ');
  return [where && `in ${where}`, on && `on ${on}`].filter(Boolean).join(' ');
}

// The rule in words, without where it applies (that is shown separately).
function titleOf(rule) {
  if (rule.op === 'remove' && rule.in === 'request') return `${rule.old} is no longer accepted; old callers' value is ignored`;
  return describeRule({ ...rule, in: undefined, endpoint: undefined }).replaceAll('`', '');
}

// The top-level field a path sits under: "forks[].user.plan" → "forks".
const topOf = (path) => String(path ?? '').split('.')[0].replaceAll('[]', '');

// Many fields dropped under the same top-level field read as one change:
// "user: 22 fields are no longer returned".
function group(rules) {
  const items = [];
  const buckets = new Map();
  for (const raw of rules) {
    const rule = normalizeRule(raw);
    const kind = kindOf(rule);
    // Fields under one top-level field go together; so do top-level fields dropped from the same endpoints.
    const parent = kind !== 'lost' ? '' : String(rule.old).includes('.') ? topOf(rule.old) : '*';
    if (parent) {
      const key = `${parent}|${rule.in ?? ''}|${JSON.stringify(endpointsOf(rule))}`;
      if (!buckets.has(key)) {
        const item = { kind, rules: [], parent, scope: scopeOf(rule) };
        buckets.set(key, item);
        items.push(item);
      }
      buckets.get(key).rules.push(rule);
      continue;
    }
    items.push({ kind, rules: [rule], scope: scopeOf(rule) });
  }
  return items.map((item) => {
    if (item.rules.length >= 3) {
      const fields = item.rules.map((rule) => rule.old);
      const what = `${fields.length} fields are no longer ${item.rules[0].in === 'request' ? 'accepted' : 'returned'}`;
      const named = `${fields.slice(0, 2).join(', ')} and ${fields.length - 2} more fields are no longer ${item.rules[0].in === 'request' ? 'accepted' : 'returned'}`;
      const title = item.parent === '*' ? named : `${item.parent}: ${what}`;
      return { kind: item.kind, title, scope: item.scope, fields, rules: item.rules };
    }
    return item.rules.map((rule) => ({ kind: item.kind, title: titleOf(rule), scope: item.scope, fields: [rule.old ?? rule.new ?? rule.path].filter(Boolean), rules: [rule] }));
  }).flat();
}

// summarize({ found, proof }) → { verdict, headline, detail, items, attention, counts }
// `found` is what rulesFromOpenApi returned; `proof` (from proveWithSchemas) may still be missing.
export function summarize({ found, proof }) {
  const items = group(found.rules);
  const attention = found.notes
    .filter((note) => note.code !== 'removed') // already listed as a change
    .map((note) => ({ ...note, blocking: BLOCKING.has(note.code) }))
    .sort((a, b) => Number(b.blocking) - Number(a.blocking));
  const bridged = items.filter((item) => item.kind === 'bridged').length;
  const broken = items.length - bridged + attention.filter((note) => note.blocking).length;
  const statuses = { kept: 0, moved: 0, removed: 0 };
  for (const operation of found.operations ?? []) statuses[operation.status] = (statuses[operation.status] ?? 0) + 1;
  const counts = { endpoints: (found.operations ?? []).length, ...statuses, changes: items.length, toCheck: attention.length };
  const proofFailed = proof && !proof.ok;

  if (!items.length && !attention.some((note) => note.blocking)) {
    return { verdict: 'safe', headline: 'No breaking changes found', detail: 'Callers of the old version keep working as they are.', items, attention, counts };
  }
  if (!broken && !proofFailed) {
    return {
      verdict: 'bridged',
      headline: 'Breaking changes that Mender can bridge',
      detail: `Old callers would break on ${items.length} change${items.length === 1 ? '' : 's'}. Mender can translate their calls${proof ? `, proven on ${proof.samples} sample${proof.samples === 1 ? '' : 's'},` : ''} while they update.`,
      items,
      attention,
      counts,
    };
  }
  const lost = broken || (proof?.checks ?? []).filter((check) => check.failures.length).length;
  return {
    verdict: 'breaks',
    headline: 'Breaking changes that need code changes',
    detail: `${lost} thing${lost === 1 ? '' : 's'} old callers lose or can no longer do${bridged ? `; Mender can bridge the other ${bridged}` : ''}. Callers that use them have to change their code.`,
    items,
    attention,
    counts,
  };
}

// The address parts a caller's code would contain, e.g. "/v1/payment_intents" for
// "/v1/payment_intents/{intent}". Used to find the calls the code fixer should look at.
export function pathsOf(spec) {
  const out = new Set();
  for (const path of Object.keys(spec?.paths ?? {})) {
    const fixed = path.split('{')[0].replace(/\/+$/, '');
    if (fixed && fixed !== '/') out.add(fixed);
  }
  return [...out];
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// How a field shows up in code. "user.login" is looked for as "user.login" (or user?.login), since
// "login" alone is too common a word; a distinctive name like "hub_url" is looked for on its own.
function patternsFor(path) {
  const parts = String(path ?? '').replaceAll('[]', '').split('.').filter(Boolean);
  const leaf = parts.at(-1);
  if (!leaf || leaf.length < 3) return [];
  const patterns = [];
  if (parts.length > 1) patterns.push({ name: `${parts.at(-2)}.${leaf}`, test: new RegExp(`\\b${escape(parts.at(-2))}\\??\\.${escape(leaf)}\\b`) });
  if (leaf.includes('_') || leaf.length >= 8 || parts.length === 1) patterns.push({ name: leaf, test: new RegExp(`\\b${escape(leaf)}\\b`) });
  return patterns;
}

// Which changes touch this code: fields the code mentions, and removed endpoints it calls.
// touches(code, rules) → [{ name, kind, title }]
export function touches(code, rules) {
  const seen = new Map();
  for (const raw of rules) {
    const rule = normalizeRule(raw);
    const names = [];
    if (rule.op === 'endpoint_removed' || rule.op === 'endpoint_moved') {
      const fixed = String(rule.path ?? rule.old).split('{')[0].replace(/\/+$/, '');
      if (fixed.length > 1 && code.includes(fixed)) names.push(fixed);
    } else {
      const hit = patternsFor(rule.old ?? rule.new).find((pattern) => pattern.test.test(code));
      if (hit) names.push(hit.name);
    }
    for (const name of names) if (!seen.has(name)) seen.set(name, { name, kind: kindOf(rule), title: titleOf(rule) });
  }
  return [...seen.values()];
}
