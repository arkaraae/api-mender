// Mender rules: a readable adapter format.
// Each rule says how one field relates between the old and the new version. Mender runs the
// rules forward on requests from old callers and backward on the answers they get, so one list
// describes both directions. Rules are data, so an adapter can be reviewed, diffed and proven
// without running generated code.
//
//   rename            same value, new name or place            { op, old, new }
//   scale             new = old × factor                       { op, old, new, factor }
//   case              same text, different letter case         { op, old, new, oldCase, newCase }
//   values            renamed values                           { op, old, new, map: { oldValue: newValue } }
//   time              same moment, different format            { op, old, new, oldFormat, newFormat }
//   type              same value, different JSON type          { op, old, new, oldType, newType }
//   add               new field old callers never send         { op, new, value }
//   remove            field the new version dropped            { op, old }
//   endpoint_moved    same call, new address or method         { op, method, old, new, newMethod }
//   endpoint_removed  call no translation can save             { op, method, path, message, guide }
//
// Paths are dotted ("total.amount_cents"). "items[].sku" means the sku of every item, and
// "\." is a literal dot inside a field name. A rule may be limited with `endpoint`
// ("POST /orders/{id}", or a list of them) and `in` ("request", "response" or "query").
//
// All rules read from the record as it arrived and then write, so they never trip over each
// other: two fields can swap names, and a field can move into a place another rule vacates.

export const TIME_FORMATS = ['unix_seconds', 'unix_ms', 'iso8601', 'iso8601_ms'];
export const VALUE_TYPES = ['string', 'number', 'boolean'];

const MOVES = new Set(['rename', 'scale', 'case', 'values', 'time', 'type']);
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SCOPES = new Set(['request', 'response', 'query']);

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isPrimitive = (value) => value === null || ['string', 'number', 'boolean'].includes(typeof value);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object ?? {}, key);

// ---------- paths ----------

export function escapeKey(key) {
  return String(key).replace(/[\\.[]/g, '\\$&');
}

// "a.items[].b" → [{ key: 'a' }, { key: 'items', each: true }, { key: 'b' }]
export function parsePath(path) {
  const text = String(path ?? '');
  const segments = [];
  let key = '';
  let each = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\' && i + 1 < text.length) { key += text[++i]; continue; }
    if (ch === '[' && text[i + 1] === ']' && (i + 2 === text.length || text[i + 2] === '.')) { each = true; i += 1; continue; }
    if (ch === '.') { segments.push({ key, each }); key = ''; each = false; continue; }
    key += ch;
  }
  segments.push({ key, each });
  for (const segment of segments) {
    if (segment.key === '') throw new Error(`"${text}" is not a valid field path.`);
    if (FORBIDDEN_KEYS.has(segment.key)) throw new Error(`"${segment.key}" can't be used in a field path.`);
  }
  return segments;
}

const formatPath = (segments) => segments.map((s) => escapeKey(s.key) + (s.each ? '[]' : '')).join('.');
const wildcards = (segments) => segments.filter((s) => s.each).length;

// Reads and removes what sits at a path. Returns undefined when nothing is there,
// { value } for a plain path and { each: [...] } for an "every element" path.
function take(node, segments, i = 0) {
  if (!isRecord(node)) return undefined;
  const { key, each } = segments[i];
  if (!own(node, key)) return undefined;
  const last = i === segments.length - 1;
  const child = node[key];
  if (each) {
    if (!Array.isArray(child)) return undefined;
    if (last) { delete node[key]; return { each: child.map((value) => ({ value })) }; }
    const results = child.map((item) => take(item, segments, i + 1));
    return results.some((result) => result !== undefined) ? { each: results } : undefined;
  }
  if (last) { delete node[key]; return { value: child }; }
  const result = take(child, segments, i + 1);
  if (result !== undefined && isRecord(child) && Object.keys(child).length === 0) delete node[key];
  return result;
}

function put(node, segments, taken, convert, i = 0) {
  const { key, each } = segments[i];
  const last = i === segments.length - 1;
  if (each) {
    if (!taken.each) return;
    if (!Array.isArray(node[key])) node[key] = taken.each.map(() => (last ? null : {}));
    const list = node[key];
    taken.each.forEach((item, index) => {
      if (item === undefined) return;
      if (last) { list[index] = convert(item.value); return; }
      if (!isRecord(list[index])) list[index] = {};
      put(list[index], segments, item, convert, i + 1);
    });
    return;
  }
  if (last) {
    if ('value' in taken) node[key] = convert(taken.value);
    return;
  }
  if (!isRecord(node[key])) node[key] = {};
  put(node[key], segments, taken, convert, i + 1);
}

function present(node, segments, i = 0) {
  if (!isRecord(node)) return false;
  const { key, each } = segments[i];
  if (!own(node, key)) return false;
  if (i === segments.length - 1) return true;
  if (each) return Array.isArray(node[key]) && node[key].some((item) => present(item, segments, i + 1));
  return present(node[key], segments, i + 1);
}

// Sets a default where a field is missing. Never overwrites what the caller sent.
function ensure(node, segments, value, i = 0) {
  if (!isRecord(node)) return;
  const { key, each } = segments[i];
  const last = i === segments.length - 1;
  if (each) {
    if (!last && Array.isArray(node[key])) node[key].forEach((item) => ensure(item, segments, value, i + 1));
    return;
  }
  if (last) {
    if (!own(node, key)) node[key] = structuredClone(value);
    return;
  }
  if (!own(node, key)) node[key] = {};
  ensure(node[key], segments, value, i + 1);
}

// ---------- conversions ----------

const tidy = (n) => Number(n.toPrecision(15));

function times(n, factor) {
  const inverse = 1 / factor;
  return tidy(factor < 1 && Math.abs(inverse - Math.round(inverse)) < 1e-9 ? n / Math.round(inverse) : n * factor);
}

function numeric(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function scaled(value, factor, type, decimals) {
  const n = numeric(value);
  if (n === null) return value;
  const out = times(n, factor);
  const asText = type ? type === 'string' : typeof value === 'string';
  if (!asText) return out;
  return Number.isInteger(decimals) ? out.toFixed(decimals) : String(out);
}

function toMs(value, format) {
  if (format === 'unix_seconds' || format === 'unix_ms') {
    const n = numeric(value);
    return n === null ? NaN : format === 'unix_seconds' ? n * 1000 : n;
  }
  if (typeof value !== 'string') return NaN;
  // A date-time with no zone is read as UTC, so the answer never depends on the server's clock zone.
  const zoned = !value.includes('T') || /[zZ]$|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value}Z`;
  return Date.parse(zoned);
}

function fromMs(ms, format, type) {
  if (!Number.isFinite(ms)) return undefined;
  if (format === 'unix_seconds' || format === 'unix_ms') {
    const n = format === 'unix_seconds' ? Math.floor(ms / 1000) : Math.round(ms);
    return type === 'string' ? String(n) : n;
  }
  const iso = new Date(ms).toISOString();
  return format === 'iso8601' ? iso.replace(/\.\d{3}Z$/, 'Z') : iso;
}

const setCase = (value, which) => (typeof value !== 'string' ? value : which === 'upper' ? value.toUpperCase() : which === 'lower' ? value.toLowerCase() : value);
const mapKey = (value) => (typeof value === 'string' ? value : JSON.stringify(value));
const fromKey = (key, type) => (type === 'number' ? Number(key) : type === 'boolean' ? key === 'true' : type === 'null' ? null : key);

function cast(value, type) {
  if (type === 'string') return typeof value === 'string' ? value : String(value);
  if (type === 'number') {
    if (typeof value === 'number') return value;
    if (typeof value === 'boolean') return value ? 1 : 0;
    const n = numeric(value);
    // A whole number too large for JSON numbers (an id, usually) stays text instead of being rounded.
    if (n === null || (/^-?\d+$/.test(value.trim()) && !Number.isSafeInteger(n))) return value;
    return n;
  }
  if (type === 'boolean') {
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === 1 || value === '1') return true;
    if (value === 'false' || value === 0 || value === '0') return false;
  }
  return value;
}

const CONVERT = {
  rename: { up: (v) => v, down: (v) => v },
  scale: {
    up: (v, r) => scaled(v, r.factor, r.newType, r.newDecimals),
    down: (v, r) => scaled(v, 1 / r.factor, r.oldType, r.oldDecimals),
  },
  case: { up: (v, r) => setCase(v, r.newCase), down: (v, r) => setCase(v, r.oldCase) },
  values: {
    up: (v, r) => (isPrimitive(v) && own(r.map, mapKey(v)) ? r.map[mapKey(v)] : v),
    down: (v, r) => {
      if (!isPrimitive(v)) return v;
      for (const [before, after] of Object.entries(r.map ?? {})) if (Object.is(after, v)) return fromKey(before, r.oldType);
      return v;
    },
  },
  time: {
    up: (v, r) => fromMs(toMs(v, r.oldFormat), r.newFormat, r.newType),
    down: (v, r) => fromMs(toMs(v, r.newFormat), r.oldFormat, r.oldType),
  },
  type: { up: (v, r) => cast(v, r.newType), down: (v, r) => cast(v, r.oldType) },
};

// Converts one value. Anything a rule can't convert (null, the wrong type, an unreadable date)
// passes through unchanged, so the API's own validation gets the final say.
export function convertValue(rule, direction, value) {
  if (value === null || value === undefined) return value;
  try {
    const out = CONVERT[rule.op][direction](value, rule);
    return out === undefined || (typeof out === 'number' && !Number.isFinite(out)) ? value : out;
  } catch {
    return value;
  }
}

// ---------- rules ----------

export function normalizeRule(rule) {
  const r = { ...rule };
  if (r.field && !r.old && !r.new) { r.old = r.field; r.new = r.field; }
  if (MOVES.has(r.op) && r.op !== 'rename') {
    if (r.old && !r.new) r.new = r.old;
    if (r.new && !r.old) r.old = r.new;
  }
  if (r.op === 'scale' && r.factor !== undefined) r.factor = Number(r.factor);
  if (r.method) r.method = String(r.method).toUpperCase();
  if (r.newMethod) r.newMethod = String(r.newMethod).toUpperCase();
  return r;
}

const NEEDS = {
  rename: ['old', 'new'], scale: ['old', 'new', 'factor'], case: ['old', 'new'], values: ['old', 'new', 'map'],
  time: ['old', 'new', 'oldFormat', 'newFormat'], type: ['old', 'new', 'oldType', 'newType'],
  add: ['new'], remove: ['old'], endpoint_removed: ['method', 'path'], endpoint_moved: ['method', 'old', 'new'],
};

const endpointsOf = (rule) => (rule.endpoint === undefined ? [] : Array.isArray(rule.endpoint) ? rule.endpoint : [rule.endpoint]);

// Returns what is wrong with a rule in plain words, or null when it is fine.
export function checkRule(rule) {
  if (!isRecord(rule)) return 'Each rule must be an object like { "op": "rename", ... }.';
  const r = normalizeRule(rule);
  const need = NEEDS[r.op];
  if (!need) return `Unknown rule type "${r.op}".`;
  const missing = need.filter((key) => r[key] === undefined || r[key] === '');
  if (missing.length) return `A ${r.op} rule is missing ${missing.join(', ')}.`;
  if (r.op === 'endpoint_removed' || r.op === 'endpoint_moved') {
    const paths = r.op === 'endpoint_removed' ? [r.path] : [r.old, r.new];
    if (!paths.every((p) => typeof p === 'string' && p.startsWith('/'))) return `An ${r.op} rule needs paths that start with "/".`;
    return null;
  }
  let oldPath;
  let newPath;
  try {
    if (r.old !== undefined) oldPath = parsePath(r.old);
    if (r.new !== undefined) newPath = parsePath(r.new);
  } catch (error) {
    return error.message;
  }
  if (MOVES.has(r.op) && wildcards(oldPath) !== wildcards(newPath)) return `"${r.old}" and "${r.new}" must use [] the same number of times.`;
  if (r.op === 'scale' && !(r.factor > 0 && Number.isFinite(r.factor))) return 'A scale rule needs a positive factor.';
  if (r.op === 'time' && ![r.oldFormat, r.newFormat].every((f) => TIME_FORMATS.includes(f))) return `Time formats must be one of ${TIME_FORMATS.join(', ')}.`;
  if (r.op === 'type' && ![r.oldType, r.newType].every((t) => VALUE_TYPES.includes(t))) return `Types must be one of ${VALUE_TYPES.join(', ')}.`;
  if (r.op === 'values' && !isRecord(r.map)) return 'A values rule needs a map like { "paid": "succeeded" }.';
  if (r.in !== undefined && !SCOPES.has(r.in)) return 'A rule\'s "in" must be request, response or query.';
  if (!endpointsOf(r).every((e) => typeof e === 'string' && /^([A-Z]+ )?\//.test(e))) return 'A rule\'s "endpoint" must look like "POST /orders/{id}".';
  return null;
}

function overlaps(a, b) {
  if (a.in && b.in && a.in !== b.in) return false;
  const ea = endpointsOf(a);
  const eb = endpointsOf(b);
  return ea.length === 0 || eb.length === 0 || ea.some((e) => eb.includes(e));
}

// Checks a whole list: every rule on its own, then rules that would fight over one field.
export function checkRules(rules) {
  if (!Array.isArray(rules)) return 'The rules must be a list.';
  for (const rule of rules) {
    const problem = checkRule(rule);
    if (problem) return problem;
  }
  const list = rules.map(normalizeRule);
  for (const side of ['old', 'new']) {
    const seen = [];
    for (const rule of list) {
      const reads = side === 'old' ? MOVES.has(rule.op) || rule.op === 'remove' : MOVES.has(rule.op) || rule.op === 'add';
      if (!reads || rule[side] === undefined) continue;
      const path = formatPath(parsePath(rule[side]));
      const clash = seen.find((other) => other.path === path && overlaps(other.rule, rule));
      if (clash) return `Two rules use the ${side === 'old' ? 'old' : 'new'} field "${rule[side]}". Keep one.`;
      seen.push({ path, rule });
    }
  }
  return null;
}

// Runs the rules on one record. direction 'up' = old → new, 'down' = new → old.
export function applyRules(record, rules, direction) {
  if (Array.isArray(record)) return record.map((item) => applyRules(item, rules, direction));
  if (!isRecord(record)) return record;
  const up = direction === 'up';
  const steps = [];
  rules.forEach((raw, index) => {
    const rule = normalizeRule(raw);
    if (MOVES.has(rule.op)) {
      steps.push({ rule, index, from: parsePath(up ? rule.old : rule.new), to: parsePath(up ? rule.new : rule.old), text: up ? rule.old : rule.new });
    } else if (rule.op === 'remove' && up) {
      steps.push({ rule, index, from: parsePath(rule.old), to: null });
    } else if (rule.op === 'add' && !up) {
      steps.push({ rule, index, from: parsePath(rule.new), to: null });
    }
  });

  // Take everything first, innermost fields before the objects that hold them.
  steps.sort((a, b) => b.from.length - a.from.length || a.index - b.index);
  for (const step of steps) step.taken = take(record, step.from);

  // Then write, outermost first. A value never overwrites something the caller sent under the
  // target name: in that case the original field is put back untouched.
  const writes = steps.filter((step) => step.to && step.taken !== undefined).sort((a, b) => a.to.length - b.to.length || a.index - b.index);
  for (const step of writes) {
    const moved = formatPath(step.from) !== formatPath(step.to);
    if (moved && wildcards(step.to) === 0 && present(record, step.to)) {
      put(record, step.from, step.taken, (value) => value);
      continue;
    }
    put(record, step.to, step.taken, (value) => convertValue(step.rule, direction, value));
  }

  if (up) {
    for (const raw of rules) {
      const rule = normalizeRule(raw);
      if (rule.op === 'add' && 'value' in rule) ensure(record, parsePath(rule.new), rule.value);
    }
  }
  return record;
}

// ---------- compiling rules into an adapter ----------

function templateToRegex(template) {
  const escaped = String(template).split(/\{[^}]+\}/).map((part) => part.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'));
  return new RegExp(`^${escaped.join('([^/]+)')}/?$`);
}

function matchesEndpoint(rule, call) {
  const list = endpointsOf(rule);
  if (list.length === 0) return true;
  return list.some((entry) => {
    const [first, second] = entry.split(' ');
    const method = second === undefined ? null : first;
    const template = second === undefined ? first : second;
    return (!method || method === String(call.method).toUpperCase()) && templateToRegex(template).test(call.path);
  });
}

function movePath(rule, path) {
  const names = [...rule.old.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
  const found = templateToRegex(rule.old).exec(path);
  if (!found) return null;
  const values = Object.fromEntries(names.map((name, i) => [name, found[i + 1]]));
  let missing = false;
  const moved = rule.new.replace(/\{([^}]+)\}/g, (whole, name) => {
    if (own(values, name)) return values[name];
    missing = true;
    return whole;
  });
  return missing ? null : moved;
}

// Turns a rules file into an adapter the Mender runtime (withMender) can run.
//   spec.lists: names of list fields whose items are records too (default ["data"]).
export function compileRules(spec) {
  const problem = checkRules(spec.rules ?? []);
  if (problem) throw new Error(problem);
  const rules = (spec.rules ?? []).map(normalizeRule);
  const lists = spec.lists ?? ['data'];
  const data = rules.filter((r) => MOVES.has(r.op) || r.op === 'add' || r.op === 'remove');
  const moves = rules.filter((r) => r.op === 'endpoint_moved');

  const rulesFor = (call, where) => data.filter((r) => (where === 'query' ? r.in === 'query' : r.in !== 'query' && (!r.in || r.in === where)) && matchesEndpoint(r, call));

  function translate(body, list, direction) {
    if (list.length === 0) return body;
    if (Array.isArray(body)) return body.map((item) => translate(item, list, direction));
    if (!isRecord(body)) return body;
    for (const key of lists) {
      if (Array.isArray(body[key]) && body[key].length && body[key].every(isRecord)) body[key] = body[key].map((item) => applyRules(item, list, direction));
    }
    return applyRules(body, list, direction);
  }

  return {
    from: spec.from,
    to: spec.to,
    rules,

    // req: { method, path, query, body } as the old caller sent it.
    upgradeRequest(req) {
      const call = { method: req.method, path: req.path };
      const queryRules = rulesFor(call, 'query');
      if (queryRules.length && isRecord(req.query)) {
        const query = applyRules({ ...req.query }, queryRules, 'up');
        req.query = Object.fromEntries(Object.entries(query).map(([k, v]) => [k, isPrimitive(v) ? String(v) : JSON.stringify(v)]));
      }
      if (req.body !== undefined && req.body !== null) req.body = translate(req.body, rulesFor(call, 'request'), 'up');
      const move = moves.find((m) => m.method === String(req.method).toUpperCase() && templateToRegex(m.old).test(req.path));
      if (move) {
        const moved = movePath(move, req.path);
        if (moved) { req.path = moved; req.method = move.newMethod ?? req.method; }
      }
      return req;
    },

    // res: { status, body } from the new version; call: the request as the old caller sent it.
    downgradeResponse(res, call = { method: 'GET', path: '/' }) {
      const body = res.body;
      if (isRecord(body) && isRecord(body.error)) {
        const candidates = rulesFor(call, 'request').filter((r) => r.old && r.new && r.old !== r.new);
        const rule = candidates.find((r) => r.new === body.error.param);
        if (rule) {
          body.error.param = rule.old;
          if (typeof body.error.message === 'string') body.error.message = body.error.message.replaceAll(`'${rule.new}'`, `'${rule.old}'`);
        }
        return res;
      }
      // Only answers that succeeded carry records; error bodies have their own shape.
      if (res.status === undefined || (res.status >= 200 && res.status < 300)) res.body = translate(body, rulesFor(call, 'response'), 'down');
      return res;
    },

    untranslatable: rules.filter((r) => r.op === 'endpoint_removed').map((r) => ({
      method: r.method,
      path: templateToRegex(r.path),
      reason: r.message || `${r.method} ${r.path} was removed in ${spec.to}. This call needs a code change.`,
      guide: r.guide,
    })),
  };
}

// ---------- plain-language description ----------

const code = (text) => `\`${text}\``;

export function describeRule(rule) {
  const r = normalizeRule(rule);
  const where = [r.in === 'query' ? 'in the query string' : r.in ? `in ${r.in}s` : '', endpointsOf(r).length ? `on ${endpointsOf(r).join(', ')}` : ''].filter(Boolean).join(' ');
  const scope = where ? ` (${where})` : '';
  switch (r.op) {
    case 'rename': return `${code(r.old)} is now ${code(r.new)}${scope}`;
    case 'scale': return `${code(r.old)} is now ${code(r.new)}, multiplied by ${r.factor}${scope}`;
    case 'case': return `${code(r.old)} is now ${code(r.new)}, in ${r.newCase ?? 'a different'} case${scope}`;
    case 'values': return `${code(r.new)} values changed: ${Object.entries(r.map).map(([a, b]) => `${JSON.stringify(fromKey(a, r.oldType))} → ${JSON.stringify(b)}`).join(', ')}${r.old !== r.new ? ` (was ${code(r.old)})` : ''}${scope}`;
    case 'time': return `${code(r.old)} (${r.oldFormat}) is now ${code(r.new)} (${r.newFormat})${scope}`;
    case 'type': return `${code(r.old)} (${r.oldType}) is now ${code(r.new)} (${r.newType})${scope}`;
    case 'add': return 'value' in r
      ? `New field ${code(r.new)}; old callers get the default ${JSON.stringify(r.value)}${scope}`
      : `New field ${code(r.new)}; old callers don't receive it${scope}`;
    case 'remove': return `${code(r.old)} was dropped; old callers stop receiving it${scope}`;
    case 'endpoint_moved': return `${r.method} ${r.old} is now ${r.newMethod ?? r.method} ${r.new}`;
    case 'endpoint_removed': return `${r.method} ${r.path} was removed; old callers get 410 Gone${r.guide ? ' with a migration link' : ''}`;
    default: return `Unknown rule ${JSON.stringify(r)}`;
  }
}

// A changelog entry customers can read, generated from the same rules the adapter runs.
export function changelog(spec) {
  const lines = (spec.rules ?? []).map((rule) => `- ${describeRule(rule).replaceAll('`', '')}`);
  return [`Changes from ${spec.from} to ${spec.to}`, '', ...lines].join('\n');
}

// ---------- comparing ----------

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

// Two values are the same when they are identical, or when both are the same moment in time
// written two ways ("…Z" and "…+00:00").
export function sameValue(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a === 'string' && typeof b === 'string' && ISO.test(a) && ISO.test(b)) {
    const ma = toMs(a, 'iso8601_ms');
    return Number.isFinite(ma) && ma === toMs(b, 'iso8601_ms');
  }
  return false;
}

// Every plain value in a record, keyed by where it sits ("items[0].sku").
export function leaves(value, prefix = '', out = new Map()) {
  if (isRecord(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0 && prefix) out.set(prefix, '{}');
    for (const key of keys) leaves(value[key], prefix ? `${prefix}.${escapeKey(key)}` : escapeKey(key), out);
  } else if (Array.isArray(value)) {
    if (value.length === 0 && prefix) out.set(prefix, '[]');
    value.forEach((item, index) => leaves(item, `${prefix}[${index}]`, out));
  } else if (prefix) {
    out.set(prefix, value);
  }
  return out;
}

export function differences(expected, got) {
  const a = leaves(expected);
  const b = leaves(got);
  const out = [];
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    const missing = !a.has(key) || !b.has(key);
    if (missing || !sameValue(a.get(key), b.get(key))) out.push({ path: key, expected: a.get(key), got: b.get(key) });
  }
  return out;
}

const general = (path) => path.replace(/\[\d+\]/g, '[]');
const PRECISION = { unix_seconds: 1000, iso8601: 1000, unix_ms: 1, iso8601_ms: 1 };

// Proves rules on example pairs: old → new must give the new example, new → old the old one.
export function verifyRules(rules, pairs) {
  const list = rules.map(normalizeRule);
  const removed = list.filter((r) => r.op === 'remove').map((r) => formatPath(parsePath(r.old)));
  // A dropped field covers everything inside it too.
  const droppedBy = (path) => removed.find((p) => path === p || path.startsWith(`${p}.`) || path.startsWith(`${p}[`));
  const dropped = { has: (path) => droppedBy(path) !== undefined };
  // A new field with no default can't be filled in for old callers. That is reported, not failed.
  const optional = list.filter((r) => r.op === 'add' && !('value' in r)).map((r) => formatPath(parsePath(r.new)));
  const unfilledBy = (path) => optional.find((p) => path === p || path.startsWith(`${p}.`) || path.startsWith(`${p}[`));
  // A time written in whole seconds can't carry milliseconds, so it is compared at its own precision.
  const coarse = new Map();
  for (const r of list.filter((x) => x.op === 'time')) {
    const precision = Math.max(PRECISION[r.oldFormat] ?? 1, PRECISION[r.newFormat] ?? 1);
    if (precision > 1) { coarse.set(formatPath(parsePath(r.new)), precision); coarse.set(formatPath(parsePath(r.old)), precision); }
  }
  const close = (d) => {
    const precision = coarse.get(general(d.path));
    if (!precision || d.expected === undefined || d.got === undefined) return false;
    const a = typeof d.expected === 'number' ? d.expected * (d.expected < 1e11 ? 1000 : 1) : toMs(d.expected, 'iso8601_ms');
    const b = typeof d.got === 'number' ? d.got * (d.got < 1e11 ? 1000 : 1) : toMs(d.got, 'iso8601_ms');
    return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < precision;
  };
  return pairs.map((pair, index) => {
    const up = applyRules(structuredClone(pair.old), list, 'up');
    const down = applyRules(structuredClone(pair.new), list, 'down');
    const downAll = differences(pair.old, down).filter((d) => !close(d));
    const upAll = differences(pair.new, up).filter((d) => !close(d));
    const unfilled = (d) => d.got === undefined && unfilledBy(general(d.path));
    return {
      index,
      up,
      down,
      upDiffs: upAll.filter((d) => !unfilled(d)),
      unfilled: [...new Set(upAll.map(unfilled).filter(Boolean))],
      downDiffs: downAll.filter((d) => !dropped.has(general(d.path))),
      lost: [...new Set(downAll.map((d) => droppedBy(general(d.path))).filter(Boolean))],
    };
  });
}
