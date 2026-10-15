// Finding rules from examples, with no AI.
//
// Give it the same records as the old and the new version return them. It proposes rules for
// every field that changed, keeps only the rules that hold on every example in both directions,
// and reports what it could not explain instead of guessing.

import { convertValue, escapeKey, parsePath, sameValue } from './rules.js';

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const RATIOS = [10, 100, 1000, 1e6, 0.1, 0.01, 0.001, 1e-6];
const RANK = { rename: 6, time: 5, type: 4, scale: 3, case: 2, values: 1 };
const ORDER = ['endpoint_moved', 'rename', 'scale', 'case', 'time', 'type', 'values', 'add', 'remove', 'endpoint_removed'];

// ---------- reading a record ----------

// Plain values and lists of plain values are leaves. Lists of records are kept apart so their
// items can be compared one by one.
function read(value, prefix = '', out = { leaves: new Map(), lists: new Map() }) {
  if (isRecord(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0 && prefix) out.leaves.set(prefix, { value: '{}', empty: true });
    for (const key of keys) read(value[key], prefix ? `${prefix}.${escapeKey(key)}` : escapeKey(key), out);
  } else if (Array.isArray(value) && value.length > 0 && value.every(isRecord)) {
    out.lists.set(prefix, value);
  } else if (prefix) {
    out.leaves.set(prefix, Array.isArray(value) ? { value: JSON.stringify(value), array: value } : { value });
  }
  return out;
}

const sameLeaf = (a, b) => Boolean(a && b) && Object.is(a.value, b.value);
const segmentsOf = (path) => parsePath(path).map((s) => escapeKey(s.key) + (s.each ? '[]' : ''));
const under = (path, parent) => path === parent || path.startsWith(`${parent}.`);

// ---------- how alike two field names are ----------

const words = (path) => String(path).replace(/\[\]/g, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[._\-\s\\]+/).map((w) => w.toLowerCase()).filter(Boolean);
const lastKey = (path) => segmentsOf(path).at(-1).replace(/\[\]$/, '').toLowerCase();

// Is `short` an abbreviation of `long`? "qty" and "quantity", "amt" and "amount", "bill" and "billing".
function abbreviates(short, long) {
  if (short.length < 3 || short.length >= long.length || short[0] !== long[0]) return false;
  let at = 0;
  for (const ch of long) if (ch === short[at]) at += 1;
  return at === short.length;
}

const wordScore = (a, b) => (a === b ? 1 : abbreviates(a, b) || abbreviates(b, a) ? 0.5 : 0);

// 0 means the two names have nothing in common. A shared word scores 1, an abbreviation 0.5,
// and an identical last part (total.currency and currency) adds 2.
export function likeness(a, b) {
  const wa = words(a);
  const shared = words(b).reduce((sum, w) => sum + Math.max(0, ...wa.map((v) => wordScore(v, w))), 0);
  return shared + (lastKey(a) === lastKey(b) ? 2 : 0);
}

// ---------- what could turn one value into another ----------

function numeric(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value);
  return null;
}

function timeFormatOf(value) {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d{9,13}$/.test(value) ? Number(value) : null;
  if (n !== null) {
    const text = typeof value === 'string';
    if (n > 1e8 && n < 1e11) return { format: 'unix_seconds', text };
    if (n >= 1e11 && n < 1e14) return { format: 'unix_ms', text };
    return null;
  }
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.test(value)) {
    return { format: /\.\d/.test(value) ? 'iso8601_ms' : 'iso8601', text: true };
  }
  return null;
}

const instant = (value, format) => {
  const out = convertValue({ op: 'time', oldFormat: format, newFormat: 'unix_ms' }, 'up', value);
  return typeof out === 'number' ? out : NaN;
};

function caseOf(text) {
  if (text === text.toUpperCase() && text !== text.toLowerCase()) return 'upper';
  if (text === text.toLowerCase() && text !== text.toUpperCase()) return 'lower';
  return 'mixed';
}

const decimalsOf = (text) => (String(text).split('.')[1] ?? '').length;

// A short label such as "paid" or "in_progress", as opposed to free text, a count or a flag.
// Numbers and true/false that differ between versions are far more often changed data than a
// renamed value, so only labels qualify.
function enumLike(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 32 && /^[\w .:\-/+]+$/.test(value) && value.trim().split(/\s+/).length <= 3;
}

const mapKey = (value) => (typeof value === 'string' ? value : JSON.stringify(value));

function mergeTemplates(a, b) {
  const { map: ma, ...pa } = a;
  const { map: mb, ...pb } = b;
  if (JSON.stringify(pa) !== JSON.stringify(pb)) return null;
  if (!ma) return a;
  for (const [key, value] of Object.entries(mb)) if (key in ma && !Object.is(ma[key], value)) return null;
  return { ...pa, map: { ...ma, ...mb } };
}

// Every kind of rule that would explain old value x becoming new value y.
function relate(a, b, samePath) {
  if (a.empty || b.empty) return a.empty && b.empty && !samePath ? [{ op: 'rename' }] : [];
  if (a.array || b.array) {
    if (!a.array || !b.array) return [];
    if (a.value === b.value) return samePath ? [] : [{ op: 'rename' }];
    if (a.array.length !== b.array.length) return [];
    // The same change applied to each item of a list of plain values.
    let common = null;
    for (let i = 0; i < a.array.length; i++) {
      if (Object.is(a.array[i], b.array[i])) continue;
      const options = relate({ value: a.array[i] }, { value: b.array[i] }, true);
      common = common === null ? options : common.map((t) => options.map((o) => mergeTemplates(t, o)).find(Boolean)).filter(Boolean);
      if (common.length === 0) return [];
    }
    return (common ?? []).map((t) => ({ ...t, each: true }));
  }

  const x = a.value;
  const y = b.value;
  if (Object.is(x, y)) return samePath ? [] : [{ op: 'rename' }];
  if (x === null || y === null || x === undefined || y === undefined) return [];
  const out = [];
  const kx = typeof x;
  const ky = typeof y;

  const tx = timeFormatOf(x);
  const ty = timeFormatOf(y);
  if (tx && ty && tx.format !== ty.format && Math.abs(instant(x, tx.format) - instant(y, ty.format)) < 1000) {
    const rule = { op: 'time', oldFormat: tx.format, newFormat: ty.format };
    if (tx.text && tx.format.startsWith('unix')) rule.oldType = 'string';
    if (ty.text && ty.format.startsWith('unix')) rule.newType = 'string';
    out.push(rule);
  }

  if (kx !== ky && ['string', 'number', 'boolean'].includes(kx) && ['string', 'number', 'boolean'].includes(ky)) {
    const same = kx === 'boolean' || ky === 'boolean'
      ? (kx === 'string' || ky === 'string' ? String(x) === String(y) : Number(x) === Number(y))
      : String(x) === String(y);
    if (same) out.push({ op: 'type', oldType: kx, newType: ky });
  }

  const nx = numeric(x);
  const ny = numeric(y);
  if (nx !== null && ny !== null && nx !== 0 && kx !== 'boolean' && ky !== 'boolean') {
    for (const factor of RATIOS) {
      const expected = Number((factor >= 1 ? nx * factor : nx / Math.round(1 / factor)).toPrecision(15));
      if (Math.abs(ny - expected) > 1e-9 * Math.max(1, Math.abs(ny))) continue;
      const rule = { op: 'scale', factor };
      if (kx === 'string' || ky === 'string') {
        rule.oldType = kx;
        rule.newType = ky;
        if (kx === 'string') rule.oldDecimals = decimalsOf(x);
        if (ky === 'string') rule.newDecimals = decimalsOf(y);
      }
      out.push(rule);
    }
  }

  if (kx === 'string' && ky === 'string' && x.toLowerCase() === y.toLowerCase() && caseOf(x) !== 'mixed' && caseOf(y) !== 'mixed') {
    out.push({ op: 'case', oldCase: caseOf(x), newCase: caseOf(y) });
  }

  if (kx === ky && enumLike(x) && enumLike(y)) {
    const rule = { op: 'values', map: { [mapKey(x)]: y } };
    if (kx !== 'string') rule.oldType = kx;
    out.push(rule);
  }
  return out;
}

// ---------- checking a proposed rule against every example ----------

function convertLeaf(candidate, direction, leaf) {
  if (!candidate.each) return convertValue(candidate.rule, direction, leaf.value);
  if (!leaf.array) return undefined;
  return JSON.stringify(leaf.array.map((item) => convertValue(candidate.rule, direction, item)));
}

function agrees(candidate, got, leaf) {
  if (sameValue(got, leaf.value)) return true;
  if (candidate.rule.op !== 'time' || candidate.each) return false;
  const coarse = [candidate.rule.oldFormat, candidate.rule.newFormat].some((f) => f === 'unix_seconds' || f === 'iso8601');
  const fa = timeFormatOf(got);
  const fb = timeFormatOf(leaf.value);
  return Boolean(coarse && fa && fb && Math.abs(instant(got, fa.format) - instant(leaf.value, fb.format)) < 1000);
}

function holds(candidate, tables) {
  let support = 0;
  const seen = new Set();
  let strong = false;
  for (const table of tables) {
    const a = table.old.leaves.get(candidate.a);
    const b = table.new.leaves.get(candidate.b);
    if (!a && !b) continue;
    if (!a || !b) return null;
    if (!agrees(candidate, convertLeaf(candidate, 'up', a), b) || !agrees(candidate, convertLeaf(candidate, 'down', b), a)) return null;
    support += 1;
    seen.add(a.value);
    strong ||= informative(a);
  }
  return support ? { support, distinct: seen.size, strong } : null;
}

// Is this value distinctive enough that two fields holding it are probably the same field?
function informative(leaf) {
  const v = leaf.value;
  if (leaf.array) return v.length >= 8;
  if (typeof v === 'string') return v.length >= 4 && !/^(true|false|null|none|yes|no)$/i.test(v);
  if (typeof v === 'number') return !Number.isInteger(v) || Math.abs(v) >= 100;
  return false;
}

function candidates(tables) {
  const found = new Map();
  for (const table of tables) {
    const oldLeft = [...table.old.leaves].filter(([path, leaf]) => !sameLeaf(leaf, table.new.leaves.get(path)));
    const newLeft = [...table.new.leaves].filter(([path, leaf]) => !sameLeaf(leaf, table.old.leaves.get(path)));
    for (const [a, la] of oldLeft) {
      for (const [b, lb] of newLeft) {
        for (const template of relate(la, lb, a === b)) {
          const { map, each, ...params } = template;
          const key = JSON.stringify([params, a, b, Boolean(each)]);
          const entry = found.get(key) ?? {
            rule: { ...params, old: each ? `${a}[]` : a, new: each ? `${b}[]` : b, ...(map ? { map: {} } : {}) },
            a, b, each: Boolean(each), clash: false,
          };
          if (map) {
            for (const [from, to] of Object.entries(map)) {
              if (from in entry.rule.map && !Object.is(entry.rule.map[from], to)) entry.clash = true;
              entry.rule.map[from] = to;
            }
          }
          found.set(key, entry);
        }
      }
    }
  }
  return [...found.values()].filter((c) => !c.clash);
}

function accepted(candidate) {
  const { rule, a, b, proof, like } = candidate;
  // A count that went from 1 to 10 is more likely changed data than a change of unit, so a
  // scale needs a distinctive number or a second example.
  if (a === b) return rule.op !== 'scale' || proof.strong || proof.distinct >= 2;
  if (rule.op === 'time' || rule.op === 'case') return true;
  if (rule.op === 'values') return like >= 2;
  return like > 0 || proof.strong || proof.distinct >= 2;
}

// ---------- lists of records ----------

function explainLists(tables) {
  const rules = [];
  const notes = [];
  const oldPaths = [...new Set(tables.flatMap((t) => [...t.old.lists.keys()]))];
  const newPaths = [...new Set(tables.flatMap((t) => [...t.new.lists.keys()]))];
  const matched = new Set();

  const lineUp = (p, q) => {
    const pairs = [];
    for (const table of tables) {
      const before = table.old.lists.get(p);
      const after = table.new.lists.get(q);
      if (!before && !after) continue;
      if (!before || !after) return null;
      if (before.length !== after.length) return 'length';
      before.forEach((item, i) => pairs.push({ old: item, new: after[i] }));
    }
    return pairs;
  };

  for (const p of oldPaths) {
    let q = newPaths.includes(p) ? p : null;
    let pairs = q ? lineUp(p, q) : null;
    if (!q) {
      // The list itself may have been renamed: find a new list that lines up item for item.
      const option = newPaths.filter((n) => !oldPaths.includes(n) && !matched.has(n))
        .map((n) => ({ n, pairs: lineUp(p, n) })).filter((o) => Array.isArray(o.pairs))
        .sort((x, y) => likeness(p, y.n) - likeness(p, x.n))[0];
      if (option) { q = option.n; pairs = option.pairs; }
    }
    if (!q || pairs === null) {
      if (!tables.some((t) => t.new.leaves.has(p))) rules.push({ op: 'remove', old: p });
      else notes.push({ code: 'shape_changed', path: p, message: `${p} was a list of records and is now something else. Mender can't line the two up.` });
      continue;
    }
    matched.add(q);
    if (pairs === 'length') {
      notes.push({ code: 'list_length', path: p, message: `The list ${p} has a different number of items in the two versions, so its items can't be lined up.` });
      continue;
    }
    const inner = explainRules(pairs);
    if (p !== q) rules.push({ op: 'rename', old: p, new: q });
    for (const rule of inner.rules) {
      rules.push({ ...rule, ...(rule.old !== undefined ? { old: `${p}[].${rule.old}` } : {}), ...(rule.new !== undefined ? { new: `${q}[].${rule.new}` } : {}) });
    }
    for (const note of inner.notes) notes.push({ ...note, path: `${q}[].${note.path}`, message: `In each item of ${q}: ${note.message}` });
  }
  for (const q of newPaths) {
    if (matched.has(q) || oldPaths.includes(q)) continue;
    if (tables.some((t) => t.old.leaves.has(q))) notes.push({ code: 'shape_changed', path: q, message: `${q} is now a list of records and was something else before. Mender can't line the two up.` });
    else rules.push({ op: 'add', new: q });
  }
  return { rules, notes, oldPaths, newPaths };
}

// ---------- folding "everything under a moved to b" into one rule ----------

function collapse(rules, tables) {
  const oldLeaves = [...new Set(tables.flatMap((t) => [...t.old.leaves.keys(), ...t.old.lists.keys()]))];
  const newLeaves = [...new Set(tables.flatMap((t) => [...t.new.leaves.keys(), ...t.new.lists.keys()]))];
  const options = new Map();
  for (const rule of rules) {
    if (rule.op !== 'rename') continue;
    const so = segmentsOf(rule.old);
    const sn = segmentsOf(rule.new);
    for (let k = 1; k < so.length && k < sn.length && so.at(-k) === sn.at(-k); k++) {
      const P = so.slice(0, so.length - k).join('.');
      const Q = sn.slice(0, sn.length - k).join('.');
      if (P !== Q && !P.includes('[]') && !Q.includes('[]')) options.set(`${P}\u0000${Q}`, { P, Q });
    }
  }
  let out = rules;
  for (const { P, Q } of [...options.values()].sort((x, y) => x.P.length - y.P.length)) {
    const suffix = (rule) => rule.op === 'rename' && under(rule.old, P) && rule.old !== P && under(rule.new, Q) && rule.old.slice(P.length) === rule.new.slice(Q.length);
    const group = out.filter(suffix);
    if (group.length < 2) continue;
    const pGone = !newLeaves.some((path) => under(path, P));
    const qNew = !oldLeaves.some((path) => under(path, Q));
    const allMoved = oldLeaves.filter((path) => under(path, P)).every((path) => out.some((r) => r.old !== undefined && (r.old === path || r.old === `${path}[]`) && (r.op === 'remove' || under(r.new, Q))));
    const allArrived = newLeaves.filter((path) => under(path, Q)).every((path) => out.some((r) => r.new !== undefined && (r.new === path || r.new === `${path}[]`) && (r.op === 'add' || under(r.old, P))));
    if (pGone && qNew && allMoved && allArrived) out = [...out.filter((r) => !group.includes(r)), { op: 'rename', old: P, new: Q }];
  }
  return out;
}

// ---------- the main entry ----------

// Returns { rules, notes }. Notes say what the rules could not explain, in plain words.
export function explainRules(input) {
  // A pair of lists is the same as several pairs of records.
  const pairs = [];
  const notes = [];
  for (const pair of input) {
    if (Array.isArray(pair.old) && Array.isArray(pair.new)) {
      if (pair.old.length === pair.new.length) pair.old.forEach((item, i) => pairs.push({ old: item, new: pair.new[i] }));
      else notes.push({ code: 'list_length', path: '', message: 'The two lists have a different number of records, so they can\'t be lined up.' });
    } else if (isRecord(pair.old) && isRecord(pair.new)) {
      pairs.push(pair);
    }
  }
  const tables = pairs.map((pair) => ({ old: read(pair.old), new: read(pair.new) }));

  const lists = explainLists(tables);
  notes.push(...lists.notes);

  // Propose, prove on every example, then give each field at most one rule: best evidence first.
  const proven = candidates(tables)
    .map((c) => ({ ...c, proof: holds(c, tables), like: likeness(c.a, c.b) }))
    .filter((c) => c.proof)
    .sort((x, y) => y.proof.support - x.proof.support || y.like - x.like || RANK[y.rule.op] - RANK[x.rule.op]);
  const usedOld = new Set();
  const usedNew = new Set();
  let rules = [];
  for (const c of proven) {
    if (usedOld.has(c.a) || usedNew.has(c.b)) continue;
    if (!accepted(c)) continue;
    const rival = proven.find((o) => o !== c && o.a === c.a && o.b !== c.b && !usedNew.has(o.b) && accepted(o) && o.proof.support === c.proof.support && o.like === c.like && RANK[o.rule.op] === RANK[c.rule.op]);
    if (rival) notes.push({ code: 'ambiguous', path: c.a, message: `${c.a} could be ${c.b} or ${rival.b} in the new version. Mender picked ${c.b}; add another example to be sure.` });
    usedOld.add(c.a);
    usedNew.add(c.b);
    rules.push(c.rule);
  }

  // What is left: fields that vanished, fields that appeared, and differences nothing explains.
  const oldPaths = [...new Set(tables.flatMap((t) => [...t.old.leaves.keys()]))];
  const newPaths = [...new Set(tables.flatMap((t) => [...t.new.leaves.keys()]))];
  for (const path of oldPaths) {
    if (usedOld.has(path)) continue;
    const withOld = tables.filter((t) => t.old.leaves.has(path));
    const alsoNew = withOld.filter((t) => t.new.leaves.has(path));
    if (alsoNew.length === 0) {
      if (!tables.some((t) => t.new.leaves.has(path)) && !lists.newPaths.includes(path)) rules.push({ op: 'remove', old: path });
      continue;
    }
    const differing = alsoNew.find((t) => !sameLeaf(t.old.leaves.get(path), t.new.leaves.get(path)));
    if (alsoNew.length < withOld.length) {
      notes.push({ code: 'inconsistent', path, message: `${path} is in the new version for some examples and missing for others.` });
    } else if (differing) {
      const before = JSON.stringify(differing.old.leaves.get(path).array ?? differing.old.leaves.get(path).value);
      const after = JSON.stringify(differing.new.leaves.get(path).array ?? differing.new.leaves.get(path).value);
      notes.push({ code: 'unexplained', path, message: `${path} differs between the versions (${before.slice(0, 60)} → ${after.slice(0, 60)}) and no rule explains it. If it changes on every call, add it to Ignore.` });
    }
  }
  for (const path of newPaths) {
    if (usedNew.has(path) || oldPaths.includes(path) || lists.oldPaths.includes(path)) continue;
    const values = tables.filter((t) => t.new.leaves.has(path)).map((t) => t.new.leaves.get(path));
    const constant = values.every((leaf) => Object.is(leaf.value, values[0].value));
    if (constant) {
      rules.push({ op: 'add', new: path, value: values[0].empty ? {} : values[0].array ?? values[0].value });
    } else {
      rules.push({ op: 'add', new: path });
      notes.push({ code: 'no_default', path, message: `The new field ${path} is different in every example, so there is no default to send for old callers.` });
    }
  }

  rules = collapse([...rules, ...lists.rules], tables);
  rules.sort((a, b) => ORDER.indexOf(a.op) - ORDER.indexOf(b.op) || String(a.old ?? a.new).localeCompare(String(b.old ?? b.new)));
  return { rules, notes };
}

// Finds rules from one or more example pairs: [{ old, new }, ...].
export const inferRules = (pairs) => explainRules(pairs).rules;
