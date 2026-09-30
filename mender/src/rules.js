// Mender rules: a readable adapter format.
// Each rule says how one field relates between the old and the new version. Mender runs the
// rules forward for requests from old callers and backward for answers to them, so one list
// describes both directions. Rules are data, so an adapter can be reviewed, diffed and
// proven without running generated code.
//
//   rename            same value, new name or place           { op, old, new }
//   scale             new = old × factor                      { op, old, new, factor }
//   case              same text, different letter case        { op, old, new, oldCase, newCase }
//   values            renamed values                          { op, old, new, map: { oldValue: newValue } }
//   time              same moment, different format           { op, old, new, oldFormat, newFormat }
//   add               new field old callers never send        { op, new, value }
//   remove            field the new version dropped           { op, old }
//   endpoint_removed  call no translation can save            { op, method, path, message, guide }

export const TIME_FORMATS = ['unix_seconds', 'unix_ms', 'iso8601', 'iso8601_ms'];

// ---------- paths ----------

const split = (path) => String(path).split('.');

function hasPath(obj, path) {
  let node = obj;
  for (const key of split(path)) {
    if (node === null || typeof node !== 'object' || !(key in node)) return false;
    node = node[key];
  }
  return true;
}

function getPath(obj, path) {
  return split(path).reduce((node, key) => (node == null ? undefined : node[key]), obj);
}

function setPath(obj, path, value) {
  const keys = split(path);
  let node = obj;
  for (const key of keys.slice(0, -1)) {
    if (node[key] === null || typeof node[key] !== 'object') node[key] = {};
    node = node[key];
  }
  node[keys.at(-1)] = value;
}

function deletePath(obj, path) {
  const keys = split(path);
  const parents = [];
  let node = obj;
  for (const key of keys.slice(0, -1)) {
    if (node === null || typeof node !== 'object') return;
    parents.push([node, key]);
    node = node[key];
  }
  if (node && typeof node === 'object') delete node[keys.at(-1)];
  for (let i = parents.length - 1; i >= 0; i--) {
    const [parent, key] = parents[i];
    const child = parent[key];
    if (child && typeof child === 'object' && !Array.isArray(child) && Object.keys(child).length === 0) delete parent[key];
    else break;
  }
}

// ---------- conversions ----------

function toMs(value, format) {
  if (format === 'unix_seconds') return Number(value) * 1000;
  if (format === 'unix_ms') return Number(value);
  return Date.parse(value);
}

function fromMs(ms, format) {
  if (format === 'unix_seconds') return Math.floor(ms / 1000);
  if (format === 'unix_ms') return ms;
  const iso = new Date(ms).toISOString();
  return format === 'iso8601' ? iso.replace(/\.\d{3}Z$/, 'Z') : iso;
}

const setCase = (value, which) => (typeof value !== 'string' ? value : which === 'upper' ? value.toUpperCase() : which === 'lower' ? value.toLowerCase() : value);
const has = (map, key) => Object.prototype.hasOwnProperty.call(map ?? {}, key);
const inverse = (map) => Object.fromEntries(Object.entries(map ?? {}).map(([a, b]) => [String(b), a]));

const CONVERT = {
  rename: { up: (v) => v, down: (v) => v },
  scale: {
    up: (v, r) => (typeof v !== 'number' ? v : r.factor >= 1 ? Math.round(v * r.factor) : v / Math.round(1 / r.factor)),
    down: (v, r) => (typeof v !== 'number' ? v : r.factor >= 1 ? v / r.factor : Math.round(v * Math.round(1 / r.factor))),
  },
  case: { up: (v, r) => setCase(v, r.newCase), down: (v, r) => setCase(v, r.oldCase) },
  values: {
    up: (v, r) => (has(r.map, v) ? r.map[v] : v),
    down: (v, r) => {
      const back = inverse(r.map);
      if (!has(back, v)) return v;
      const original = back[v];
      return typeof v === 'number' || typeof v === 'boolean' ? JSON.parse(original) : original;
    },
  },
  time: { up: (v, r) => fromMs(toMs(v, r.oldFormat), r.newFormat), down: (v, r) => fromMs(toMs(v, r.newFormat), r.oldFormat) },
};

export function normalizeRule(rule) {
  const r = { ...rule };
  if (r.field && !r.old && !r.new) { r.old = r.field; r.new = r.field; }
  if (r.op === 'values' && !r.new) r.new = r.old;
  if (r.op === 'values' && !r.old) r.old = r.new;
  if (r.op === 'scale') r.factor = Number(r.factor);
  return r;
}

export function checkRule(rule) {
  const r = normalizeRule(rule);
  const need = {
    rename: ['old', 'new'], scale: ['old', 'new', 'factor'], case: ['old', 'new'], values: ['old', 'new', 'map'],
    time: ['old', 'new', 'oldFormat', 'newFormat'], add: ['new'], remove: ['old'], endpoint_removed: ['method', 'path'],
  }[r.op];
  if (!need) return `Unknown rule type "${r.op}".`;
  const missing = need.filter((k) => r[k] === undefined || r[k] === '');
  if (missing.length) return `A ${r.op} rule is missing ${missing.join(', ')}.`;
  if (r.op === 'scale' && !(r.factor > 0)) return 'A scale rule needs a positive factor.';
  if (r.op === 'time' && ![r.oldFormat, r.newFormat].every((f) => TIME_FORMATS.includes(f))) return `Time formats must be one of ${TIME_FORMATS.join(', ')}.`;
  return null;
}

// Runs the rules on one object. direction 'up' = old → new, 'down' = new → old.
export function applyRules(obj, rules, direction) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const list = (direction === 'up' ? rules : [...rules].reverse()).map(normalizeRule);
  for (const r of list) {
    if (r.op === 'endpoint_removed') continue;
    if (r.op === 'add') {
      if (direction === 'up' && !hasPath(obj, r.new)) setPath(obj, r.new, structuredClone(r.value));
      if (direction === 'down') deletePath(obj, r.new);
      continue;
    }
    if (r.op === 'remove') {
      if (direction === 'up') deletePath(obj, r.old);
      continue;
    }
    const from = direction === 'up' ? r.old : r.new;
    const to = direction === 'up' ? r.new : r.old;
    if (!hasPath(obj, from)) continue;
    const value = getPath(obj, from);
    deletePath(obj, from);
    setPath(obj, to, CONVERT[r.op][direction](value, r));
  }
  return obj;
}

function translateBody(body, rules, direction) {
  if (Array.isArray(body?.data)) body.data = body.data.map((item) => applyRules(item, rules, direction));
  return applyRules(body, rules, direction);
}

function templateToRegex(template) {
  const escaped = String(template).split(/\{[^}]+\}/).map((part) => part.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'));
  return new RegExp(`^${escaped.join('[^/]+')}$`);
}

// Turns a rules file into an adapter the Mender runtime (withMender) can run.
export function compileRules(spec) {
  const rules = (spec.rules ?? []).map(normalizeRule);
  const problem = rules.map(checkRule).find(Boolean);
  if (problem) throw new Error(problem);
  const renamed = rules.filter((r) => r.old && r.new && r.old !== r.new);
  return {
    from: spec.from,
    to: spec.to,
    upgradeRequest(req) {
      if (req.body && typeof req.body === 'object') req.body = translateBody(req.body, rules, 'up');
      return req;
    },
    downgradeResponse(res) {
      const body = res.body;
      if (body?.error) {
        const rule = renamed.find((r) => r.new === body.error.param);
        if (rule) {
          body.error.param = rule.old;
          if (typeof body.error.message === 'string') body.error.message = body.error.message.replaceAll(`'${rule.new}'`, `'${rule.old}'`);
        }
      } else if (body && typeof body === 'object') {
        res.body = translateBody(body, rules, 'down');
      }
      return res;
    },
    untranslatable: rules.filter((r) => r.op === 'endpoint_removed').map((r) => ({
      method: String(r.method).toUpperCase(),
      path: templateToRegex(r.path),
      reason: r.message || `${String(r.method).toUpperCase()} ${r.path} was removed in ${spec.to}. This call needs a code change.`,
      guide: r.guide,
    })),
  };
}

// ---------- plain-language description ----------

const code = (text) => `\`${text}\``;
export function describeRule(rule) {
  const r = normalizeRule(rule);
  switch (r.op) {
    case 'rename': return `${code(r.old)} is now ${code(r.new)}`;
    case 'scale': return `${code(r.old)} is now ${code(r.new)}, multiplied by ${r.factor}`;
    case 'case': return `${code(r.old)} is now ${code(r.new)}, in ${r.newCase ?? 'a different'} case`;
    case 'values': return `${code(r.new)} values changed: ${Object.entries(r.map).map(([a, b]) => `${JSON.stringify(a)} → ${JSON.stringify(b)}`).join(', ')}${r.old !== r.new ? ` (was ${code(r.old)})` : ''}`;
    case 'time': return `${code(r.old)} (${r.oldFormat}) is now ${code(r.new)} (${r.newFormat})`;
    case 'add': return `New field ${code(r.new)}; old callers get the default ${JSON.stringify(r.value)}`;
    case 'remove': return `${code(r.old)} was dropped; old callers stop receiving it`;
    case 'endpoint_removed': return `${String(r.method).toUpperCase()} ${r.path} was removed; old callers get 410 Gone${r.guide ? ' with a migration link' : ''}`;
    default: return `Unknown rule ${JSON.stringify(r)}`;
  }
}

// ---------- comparing ----------

export function leaves(value, prefix = '', out = new Map()) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0 && prefix) out.set(prefix, '{}');
    for (const [key, v] of entries) leaves(v, prefix ? `${prefix}.${key}` : key, out);
  } else if (prefix) {
    out.set(prefix, Array.isArray(value) ? JSON.stringify(value) : value);
  }
  return out;
}

export function differences(expected, got) {
  const a = leaves(expected);
  const b = leaves(got);
  const out = [];
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    if (!Object.is(a.get(key), b.get(key))) out.push({ path: key, expected: a.get(key), got: b.get(key) });
  }
  return out;
}

// Proves rules on example pairs: old → new must give the new example, new → old the old one.
export function verifyRules(rules, pairs) {
  const dropped = new Set(rules.map(normalizeRule).filter((r) => r.op === 'remove').map((r) => r.old));
  return pairs.map((pair, index) => {
    const up = applyRules(structuredClone(pair.old), rules, 'up');
    const down = applyRules(structuredClone(pair.new), rules, 'down');
    const downAll = differences(pair.old, down);
    return {
      index,
      up,
      down,
      upDiffs: differences(pair.new, up),
      downDiffs: downAll.filter((d) => !dropped.has(d.path)),
      lost: downAll.filter((d) => dropped.has(d.path)).map((d) => d.path),
    };
  });
}

// ---------- finding rules from examples (no AI) ----------

const words = (path) => String(path).split(/[._\-]|(?=[A-Z])/).map((w) => w.toLowerCase()).filter(Boolean);
const likeness = (a, b) => {
  const wa = new Set(words(a));
  return words(b).filter((w) => wa.has(w)).length + (a.split('.').at(-1) === b.split('.').at(-1) ? 2 : 0);
};

function timeFormatOf(value) {
  if (typeof value === 'number') {
    if (value > 1e9 && value < 1e10) return 'unix_seconds';
    if (value > 1e12 && value < 1e13) return 'unix_ms';
    return null;
  }
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.test(value)) {
    return /\.\d+/.test(value) ? 'iso8601_ms' : 'iso8601';
  }
  return null;
}

const RATIOS = [10, 100, 1000, 0.1, 0.01, 0.001];
function scaleBetween(a, b) {
  if (typeof a !== 'number' || typeof b !== 'number' || a === 0) return null;
  return RATIOS.find((f) => Math.abs(b - (f >= 1 ? a * f : a / Math.round(1 / f))) < 1e-9 * Math.max(1, Math.abs(b))) ?? null;
}

function caseOf(text) {
  if (text === text.toUpperCase()) return 'upper';
  if (text === text.toLowerCase()) return 'lower';
  return 'mixed';
}

function inferPair(oldObj, newObj) {
  const before = leaves(oldObj);
  const after = leaves(newObj);
  const rules = [];
  const take = (oldPath, newPath) => { before.delete(oldPath); after.delete(newPath); };

  for (const [path, value] of [...before]) {
    if (after.has(path) && Object.is(after.get(path), value)) take(path, path);
  }

  // Each matcher looks for the best partner of an old field among the remaining new fields.
  const matchers = [
    (a, b) => {
      const fa = timeFormatOf(a);
      const fb = timeFormatOf(b);
      if (!fa || !fb || fa === fb) return null;
      return Math.abs(toMs(a, fa) - toMs(b, fb)) < 1000 ? { op: 'time', oldFormat: fa, newFormat: fb } : null;
    },
    (a, b) => (Object.is(a, b) ? { op: 'rename' } : null),
    (a, b) => {
      const factor = scaleBetween(a, b);
      return factor ? { op: 'scale', factor } : null;
    },
    (a, b) => (typeof a === 'string' && typeof b === 'string' && a !== b && a.toLowerCase() === b.toLowerCase()
      ? { op: 'case', oldCase: caseOf(a), newCase: caseOf(b) } : null),
  ];

  for (const matcher of matchers) {
    for (const [oldPath, a] of [...before]) {
      let best = null;
      for (const [newPath, b] of after) {
        const kind = matcher(a, b);
        if (!kind) continue;
        const score = likeness(oldPath, newPath);
        if (!best || score > best.score) best = { newPath, kind, score };
      }
      if (best) {
        rules.push({ ...best.kind, old: oldPath, new: best.newPath });
        take(oldPath, best.newPath);
      }
    }
  }

  // Same field, different value: a renamed value such as "paid" → "succeeded".
  for (const [oldPath, a] of [...before]) {
    let best = null;
    for (const [newPath, b] of after) {
      if (typeof a !== typeof b || typeof a === 'object') continue;
      const score = likeness(oldPath, newPath);
      if (score >= 2 && (!best || score > best.score)) best = { newPath, b, score };
    }
    if (best) {
      rules.push({ op: 'values', old: oldPath, new: best.newPath, map: { [String(a)]: best.b } });
      take(oldPath, best.newPath);
    }
  }

  for (const [oldPath] of before) rules.push({ op: 'remove', old: oldPath });
  for (const [newPath] of after) rules.push({ op: 'add', new: newPath, value: structuredClone(getPath(newObj, newPath) ?? null) });
  return rules;
}

const ORDER = ['rename', 'scale', 'case', 'time', 'values', 'add', 'remove', 'endpoint_removed'];

// Finds rules from one or more example pairs and merges them into one list.
export function inferRules(pairs) {
  const merged = new Map();
  for (const pair of pairs) {
    for (const rule of inferPair(pair.old, pair.new)) {
      const key = `${rule.op}|${rule.old ?? ''}|${rule.new ?? ''}`;
      const seen = merged.get(key);
      if (seen && rule.op === 'values') Object.assign(seen.map, rule.map);
      else if (!seen) merged.set(key, rule);
    }
  }
  return [...merged.values()].sort((a, b) => ORDER.indexOf(a.op) - ORDER.indexOf(b.op));
}
