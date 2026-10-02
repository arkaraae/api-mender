// Reading two API descriptions (OpenAPI 3.x or Swagger 2) and working out the rules between them.
//
//   rulesFromOpenApi(oldSpec, newSpec)        → { rules, notes, operations }
//   proveWithSchemas(oldSpec, newSpec, rules) → { ok, samples, checks }
//
// A spec says what shape the data has, not what it means, so a rule read from specs is a
// well-founded proposal. proveWithSchemas then generates sample requests from the old spec and
// sample answers from the new one, runs them through the rules, and checks the results against
// the other version's spec. Whatever the specs cannot settle is listed in `notes`.

import { compileRules, escapeKey, parsePath } from './rules.js';
import { likeness } from './infer.js';

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'];
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// ---------- reading schemas ----------

function pointer(spec, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return undefined;
  return ref.slice(2).split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~')).reduce((node, key) => node?.[key], spec);
}

// Follows $ref, merges allOf, and picks the first real option of oneOf/anyOf.
export function resolve(schema, spec, depth = 0) {
  let s = schema;
  const seen = new Set();
  while (isRecord(s) && typeof s.$ref === 'string') {
    if (seen.has(s.$ref)) return {};
    seen.add(s.$ref);
    s = pointer(spec, s.$ref);
  }
  if (!isRecord(s)) return {};
  if (Array.isArray(s.allOf) && depth < 8) {
    const parts = s.allOf.map((part) => resolve(part, spec, depth + 1));
    const merged = { ...s, type: s.type ?? parts.find((p) => p.type)?.type, properties: {}, required: [...(s.required ?? [])] };
    for (const part of parts) {
      Object.assign(merged.properties, part.properties ?? {});
      merged.required.push(...(part.required ?? []));
    }
    Object.assign(merged.properties, s.properties ?? {});
    delete merged.allOf;
    return merged;
  }
  const options = s.oneOf ?? s.anyOf;
  if (Array.isArray(options) && options.length && !s.properties && !s.type && depth < 8) {
    const picks = options.map((option) => resolve(option, spec, depth + 1));
    const real = picks.filter((p) => typeOf(p) !== 'null');
    return { ...(real[0] ?? {}), nullable: real.length !== picks.length || Boolean(real[0]?.nullable), polymorphic: real.length > 1 };
  }
  return s;
}

function typeOf(s) {
  if (Array.isArray(s.type)) return s.type.find((t) => t !== 'null') ?? 'null';
  if (s.type) return s.type;
  if (s.properties) return 'object';
  if (s.items) return 'array';
  if (Array.isArray(s.enum) && s.enum.length) return typeof s.enum[0] === 'number' ? 'number' : typeof s.enum[0];
  return undefined;
}

const nullable = (s) => Boolean(s.nullable) || (Array.isArray(s.type) && s.type.includes('null'));

// Every plain field of a schema, keyed by path ("total.amount_cents", "items[].sku").
//   where: 'request' skips read-only fields, 'response' skips write-only fields.
export function flattenSchema(schema, spec, where) {
  const leaves = new Map();
  const notes = [];
  let list = false;
  const walk = (raw, path, required, depth, trail = []) => {
    // A schema that contains itself (a category with a parent category) is followed once.
    const name = isRecord(raw) && typeof raw.$ref === 'string' ? raw.$ref : null;
    if (name && trail.includes(name)) return;
    if (name) trail = [...trail, name];
    const s = resolve(raw, spec);
    if ((where === 'request' && s.readOnly) || (where === 'response' && s.writeOnly)) return;
    if (s.polymorphic) notes.push({ code: 'one_of', path, message: `${path || 'The body'} can take several shapes (oneOf/anyOf). Mender read the first one only.` });
    const type = typeOf(s);
    if (type === 'object' && isRecord(s.properties) && depth < 12) {
      const needed = new Set(s.required ?? []);
      for (const [key, child] of Object.entries(s.properties)) walk(child, path ? `${path}.${escapeKey(key)}` : escapeKey(key), required && needed.has(key), depth + 1, trail);
      return;
    }
    if (type === 'array' && s.items && depth < 12) {
      const item = resolve(s.items, spec);
      if (typeOf(item) === 'object' && isRecord(item.properties)) {
        if (path === '') { list = true; walk(s.items, '', required, depth + 1, trail); } else walk(s.items, `${path}[]`, required, depth + 1, trail);
        return;
      }
      if (path) leaves.set(`${path}[]`, leaf(item, required));
      return;
    }
    if (path) leaves.set(path, leaf(s, required));
  };
  const leaf = (s, required) => ({
    type: typeOf(s), format: s.format, enum: Array.isArray(s.enum) ? s.enum : undefined, required, nullable: nullable(s),
    default: s.default, example: s.example ?? (Array.isArray(s.examples) ? s.examples[0] : undefined),
    from: s['x-mender-from'], description: typeof s.description === 'string' ? s.description : '',
  });
  walk(schema, '', true, 0);
  return { leaves, notes, list };
}

// ---------- reading operations ----------

function jsonFirst(content) {
  const types = Object.keys(content ?? {});
  const type = types.find((t) => /json/i.test(t)) ?? types[0];
  return type && content[type]?.schema ? { schema: content[type].schema, contentType: type } : null;
}

// Every operation of a spec, keyed by "METHOD /path".
export function operationsOf(spec) {
  const out = new Map();
  const swagger2 = typeof spec?.swagger === 'string';
  for (const [path, item] of Object.entries(spec?.paths ?? {})) {
    if (!isRecord(item)) continue;
    for (const method of METHODS) {
      const op = item[method];
      if (!isRecord(op)) continue;
      const parameters = [...(item.parameters ?? []), ...(op.parameters ?? [])].map((p) => resolve(p, spec));
      let request = null;
      if (swagger2) {
        const body = parameters.find((p) => p.in === 'body');
        const form = parameters.filter((p) => p.in === 'formData');
        if (body?.schema) request = { schema: body.schema, contentType: (op.consumes ?? spec.consumes ?? ['application/json'])[0] };
        else if (form.length) {
          request = {
            schema: { type: 'object', properties: Object.fromEntries(form.map((p) => [p.name, p])), required: form.filter((p) => p.required).map((p) => p.name) },
            contentType: 'application/x-www-form-urlencoded',
          };
        }
      } else if (op.requestBody) {
        request = jsonFirst(resolve(op.requestBody, spec).content);
      }
      let response = null;
      const codes = Object.keys(op.responses ?? {});
      for (const code of [...codes.filter((c) => /^2/.test(c)).sort(), ...codes.filter((c) => c === 'default')]) {
        const answer = resolve(op.responses[code], spec);
        const found = swagger2 ? (answer.schema ? { schema: answer.schema } : null) : jsonFirst(answer.content);
        if (found) { response = { ...found, status: /^\d+$/.test(code) ? Number(code) : 200 }; break; }
      }
      out.set(`${method.toUpperCase()} ${path}`, {
        method: method.toUpperCase(), path, operationId: op.operationId, request, response,
        query: parameters.filter((p) => p.in === 'query'),
      });
    }
  }
  return out;
}

const shapeOf = (path) => path.replace(/\{[^}]+\}/g, '{}').replace(/\/+$/, '') || '/';
const namesIn = (path) => [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);

// ---------- what could turn one field into another ----------

const wordsOf = (path, leaf) => `${String(path).replace(/([a-z0-9])([A-Z])/g, '$1 $2')} ${leaf.format ?? ''}`.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const TIME_WORDS = new Set(['created', 'updated', 'deleted', 'modified', 'timestamp', 'time', 'date', 'at', 'ts', 'expires', 'expiry', 'since', 'until', 'unix', 'epoch']);

function timeFormat(path, leaf) {
  const words = wordsOf(path, leaf);
  const text = `${leaf.description} ${leaf.format ?? ''}`.toLowerCase();
  if (leaf.type === 'string') return leaf.format === 'date-time' ? 'iso8601' : null;
  if (leaf.type !== 'integer' && leaf.type !== 'number') return null;
  const timeLike = words.some((w) => TIME_WORDS.has(w)) || /unix|epoch|timestamp/.test(text);
  if (!timeLike) return null;
  return words.includes('ms') || words.includes('millis') || /millisecond/.test(text) ? 'unix_ms' : 'unix_seconds';
}

// How many of this field's units make one whole unit: 100 for cents, 1000 for milliseconds.
function unitOf(path, leaf) {
  const words = wordsOf(path, leaf);
  const text = leaf.description.toLowerCase();
  if (words.some((w) => ['cents', 'cent', 'minor', 'pence', 'pennies'].includes(w)) || /\b(cents|minor units?)\b/.test(text)) return 100;
  if (words.some((w) => ['ms', 'millis', 'milliseconds', 'msec'].includes(w))) return 1000;
  if (words.some((w) => ['micros', 'us', 'microseconds'].includes(w))) return 1e6;
  return 1;
}

const numberLike = (leaf) => leaf.type === 'integer' || leaf.type === 'number';
const simple = (leaf) => ['string', 'integer', 'number', 'boolean'].includes(leaf.type);
const jsonType = (leaf) => (leaf.type === 'integer' ? 'number' : leaf.type);

function enumRule(before, after) {
  if (!before.enum || !after.enum) return { notes: [] };
  const gone = before.enum.filter((v) => !after.enum.includes(v));
  const came = after.enum.filter((v) => !before.enum.includes(v));
  if (gone.length === 0) return { notes: came.length ? [{ code: 'enum_added', message: `can now be ${came.map((v) => JSON.stringify(v)).join(', ')}, which old callers have never seen` }] : [] };
  const strings = [...before.enum, ...after.enum].every((v) => typeof v === 'string');
  if (strings) {
    for (const [oldCase, newCase] of [['lower', 'upper'], ['upper', 'lower']]) {
      const shift = (v, c) => (c === 'upper' ? v.toUpperCase() : v.toLowerCase());
      if (before.enum.every((v) => v === shift(v, oldCase) && after.enum.includes(shift(v, newCase))) && after.enum.every((v) => v === shift(v, newCase))) {
        return { rule: { op: 'case', oldCase, newCase }, notes: [] };
      }
    }
  }
  const map = {};
  const notes = [];
  const left = [...came];
  for (const value of gone) {
    const scored = left.map((c) => ({ c, score: likeness(String(value), String(c)) + (String(value).toLowerCase() === String(c).toLowerCase() ? 5 : 0) })).sort((x, y) => y.score - x.score);
    const pick = scored[0] && (scored[0].score > 0 || (gone.length === 1 && came.length === 1)) ? scored[0].c : undefined;
    if (pick === undefined) {
      notes.push({ code: 'enum_removed', message: `no longer accepts ${JSON.stringify(value)}, and the spec does not say what replaced it` });
      continue;
    }
    map[typeof value === 'string' ? value : JSON.stringify(value)] = pick;
    left.splice(left.indexOf(pick), 1);
  }
  if (!Object.keys(map).length) return { notes };
  const rule = { op: 'values', map };
  if (typeof gone[0] !== 'string') rule.oldType = typeof gone[0];
  return { rule, notes };
}

// The rule (without paths) that would turn field `before` into field `after`, or null when the
// two can't be the same field. `{}` means "same field, no conversion needed".
function conversion(before, after, oldPath, newPath) {
  if (!simple(before) || !simple(after)) return before.type === after.type ? { rule: {}, notes: [] } : null;
  const tb = timeFormat(oldPath, before);
  const ta = timeFormat(newPath, after);
  if (tb && ta && tb !== ta) return { rule: { op: 'time', oldFormat: tb, newFormat: ta }, notes: [] };
  if (numberLike(before) && numberLike(after)) {
    const factor = unitOf(newPath, after) / unitOf(oldPath, before);
    return { rule: Math.abs(factor - 1) > 1e-12 ? { op: 'scale', factor: Number(factor.toPrecision(12)) } : {}, notes: [] };
  }
  if (jsonType(before) !== jsonType(after)) {
    if ((tb && !ta) || (!tb && ta)) return null;
    return { rule: { op: 'type', oldType: jsonType(before), newType: jsonType(after) }, notes: [] };
  }
  const values = enumRule(before, after);
  return { rule: values.rule ?? {}, notes: values.notes };
}

// ---------- comparing two schemas ----------

function compare(before, after, where) {
  const rules = [];
  const notes = [];
  const has = (rule) => Object.keys(rule).length > 0;
  const note = (code, path, message) => notes.push({ code, path, message });

  const common = [...before.keys()].filter((path) => after.has(path));
  const removed = [...before.keys()].filter((path) => !after.has(path));
  const added = [...after.keys()].filter((path) => !before.has(path));

  // Same place, new type, format or allowed values.
  for (const path of common) {
    const found = conversion(before.get(path), after.get(path), path, path);
    if (!found) { note('type_changed', path, `${path} changed from ${before.get(path).type} to ${after.get(path).type}, which Mender can't convert.`); continue; }
    if (has(found.rule)) rules.push({ ...found.rule, old: path, new: path });
    for (const n of found.notes) note(n.code, path, `${path} ${n.message}.`);
  }

  // The provider said where a field came from: "x-mender-from": "customer_name".
  const hinted = new Set();
  const usedOld = new Set();
  for (const path of added) {
    const from = after.get(path).from;
    if (typeof from !== 'string') continue;
    const parent = path.includes('.') ? path.slice(0, path.lastIndexOf('.')) : '';
    const source = [from, parent ? `${parent}.${from}` : from].find((candidate) => before.has(candidate) && !usedOld.has(candidate));
    if (!source) continue;
    const found = conversion(before.get(source), after.get(path), source, path);
    if (!found) continue;
    rules.push({ op: 'rename', ...found.rule, old: source, new: path });
    hinted.add(path);
    usedOld.add(source);
  }

  // A request field that became required must come from somewhere: often the field that
  // stopped being required at the same moment.
  const nowRequired = where === 'request' ? common.filter((p) => !before.get(p).required && after.get(p).required) : [];
  const relaxed = where === 'request' ? common.filter((p) => before.get(p).required && !after.get(p).required) : [];

  const leaving = [...removed.filter((p) => !usedOld.has(p)), ...relaxed];
  const arriving = [...added.filter((p) => !hinted.has(p)), ...nowRequired];
  const options = [];
  for (const a of leaving) {
    for (const b of arriving) {
      // A field of every list item can't become a single field, or the other way round.
      if (a.split('[]').length !== b.split('[]').length) continue;
      const found = conversion(before.get(a), after.get(b), a, b);
      if (found) options.push({ a, b, found, like: likeness(a, b), swap: relaxed.includes(a) || nowRequired.includes(b) });
    }
  }
  const takenOld = new Set();
  const takenNew = new Set();
  const alone = (o) => options.filter((x) => x.a === o.a && !takenNew.has(x.b)).length === 1 && options.filter((x) => x.b === o.b && !takenOld.has(x.a)).length === 1;
  for (const o of [...options].sort((x, y) => y.like - x.like)) {
    if (takenOld.has(o.a) || takenNew.has(o.b)) continue;
    // Either the names are related, or these two are the only fields that could match each other.
    // A field that merely became required is never matched to an unrelated name: that would
    // copy one field's value into another.
    if (o.like <= 0 && (o.swap || !alone(o))) continue;
    takenOld.add(o.a);
    takenNew.add(o.b);
    rules.push({ op: 'rename', ...o.found.rule, old: o.a, new: o.b });
    for (const n of o.found.notes) note(n.code, o.b, `${o.b} ${n.message}.`);
    if (o.swap) note('required_swap', o.b, `${o.b} became required when ${o.a} stopped being required, so Mender treats ${o.a} as its old name. Confirm with a real call.`);
    else if (o.like <= 0) note('weak_match', o.b, `${o.a} and ${o.b} share no words; they are matched only because nothing else fits. Confirm with a real record.`);
  }

  for (const path of removed) {
    if (usedOld.has(path) || takenOld.has(path)) continue;
    rules.push({ op: 'remove', old: path });
    note('removed', path, where === 'response'
      ? `${path} is no longer returned, so old callers stop receiving it.`
      : `${path} is no longer accepted, so Mender drops it from old callers' requests.`);
  }
  for (const path of [...added, ...nowRequired]) {
    if (hinted.has(path) || takenNew.has(path)) continue;
    const field = after.get(path);
    if (where === 'response') {
      if (added.includes(path)) rules.push({ op: 'add', new: path });
      continue;
    }
    if (!field.required) continue;
    const fallback = field.default ?? before.get(path)?.default;
    if (fallback !== undefined) rules.push({ op: 'add', new: path, value: fallback });
    else note('needs_default', path, `${path} is now required and old callers never send it. Add a default, or this call needs a code change.`);
  }
  return { rules, notes };
}

// ---------- the main entry ----------

const signature = (rule) => JSON.stringify(Object.entries(rule).filter(([key]) => key !== 'endpoint').sort(([a], [b]) => a.localeCompare(b)));

// Compares two specs and proposes rules. Returns { rules, notes, operations }.
export function rulesFromOpenApi(oldSpec, newSpec) {
  const before = operationsOf(oldSpec);
  const after = operationsOf(newSpec);
  const structural = [];
  const scoped = [];
  const notes = [];
  const operations = [];
  const claimed = new Set();
  // Which old operations contain a field, per place: decides whether a rule can drop its scope.
  const holders = new Map();

  for (const [key, op] of before) {
    let target = after.get(key);
    let moved = null;
    if (!target) {
      target = [...after.values()].find((o) => o.method === op.method && shapeOf(o.path) === shapeOf(op.path) && !claimed.has(`${o.method} ${o.path}`));
    }
    if (!target && op.operationId) {
      target = [...after.values()].find((o) => o.operationId === op.operationId && !before.has(`${o.method} ${o.path}`) && !claimed.has(`${o.method} ${o.path}`));
      if (target) {
        // Keep the old names of the ids so the path can be rebuilt from the old request.
        const names = namesIn(op.path);
        let i = 0;
        const path = target.path.replace(/\{[^}]+\}/g, () => `{${names[i++] ?? `id${i}`}}`);
        moved = { op: 'endpoint_moved', method: op.method, old: op.path, new: path, ...(target.method !== op.method ? { newMethod: target.method } : {}) };
        if (namesIn(op.path).length !== namesIn(target.path).length) {
          notes.push({ code: 'path_changed', path: key, message: `${key} moved to ${target.method} ${target.path}, which takes different ids. This call needs a code change.` });
          moved = null;
          target = null;
        }
      }
    }
    if (!target) {
      structural.push({ op: 'endpoint_removed', method: op.method, path: op.path });
      operations.push({ endpoint: key, status: 'removed' });
      continue;
    }
    claimed.add(`${target.method} ${target.path}`);
    if (moved) structural.push(moved);
    operations.push({ endpoint: key, status: moved ? 'moved' : 'kept', to: `${target.method} ${target.path}` });

    for (const where of ['request', 'response']) {
      if (!op[where] && !target[where]) {
        if (where === 'response' && op.method !== 'DELETE') notes.push({ code: 'no_schema', path: key, message: `${key}: neither version describes its answer, so changes to the answer can't be read from the specs. Check them with real records.` });
        continue;
      }
      if (!op[where] || !target[where]) {
        notes.push({ code: 'no_schema', path: key, message: `${key}: only one version describes its ${where}, so ${where} changes can't be read from the specs.` });
        continue;
      }
      if (where === 'request' && /json/i.test(op.request.contentType) !== /json/i.test(target.request.contentType)) {
        notes.push({ code: 'content_type', path: key, message: `${key} changed its request format from ${op.request.contentType} to ${target.request.contentType}. Mender translates fields, not formats.` });
      }
      const a = flattenSchema(op[where].schema, oldSpec, where);
      const b = flattenSchema(target[where].schema, newSpec, where);
      for (const path of a.leaves.keys()) {
        const id = `${where}|${path}`;
        holders.set(id, [...(holders.get(id) ?? []), key]);
      }
      if (a.list !== b.list) {
        notes.push({ code: 'list_shape', path: key, message: `${key}: the ${where} switched between a bare list and an object. Mender can't wrap or unwrap a list yet, so this call needs a code change.` });
        continue;
      }
      const found = compare(a.leaves, b.leaves, where);
      for (const rule of found.rules) scoped.push({ ...rule, in: where, endpoint: key });
      for (const n of [...a.notes, ...b.notes, ...found.notes]) notes.push({ ...n, message: `${key} ${where}: ${n.message}` });
    }

    // Query parameters: renamed, or newly required.
    const oldQuery = new Map(op.query.map((p) => [p.name, p]));
    const newQuery = new Map(target.query.map((p) => [p.name, p]));
    const goneQuery = [...oldQuery.keys()].filter((n) => !newQuery.has(n));
    const cameQuery = [...newQuery.keys()].filter((n) => !oldQuery.has(n));
    for (const name of goneQuery) {
      const best = cameQuery.map((n) => ({ n, like: likeness(name, n) })).sort((x, y) => y.like - x.like)[0];
      if (best && (best.like > 0 || (goneQuery.length === 1 && cameQuery.length === 1))) {
        scoped.push({ op: 'rename', old: escapeKey(name), new: escapeKey(best.n), in: 'query', endpoint: key });
        cameQuery.splice(cameQuery.indexOf(best.n), 1);
      }
    }
    for (const name of cameQuery) {
      if (newQuery.get(name).required) notes.push({ code: 'needs_default', path: key, message: `${key}: the query parameter ${name} is now required and old callers never send it.` });
    }
  }

  // A rule that holds on every operation carrying that field loses its endpoint; the rest keep a list.
  const groups = new Map();
  for (const rule of scoped) {
    const id = signature(rule);
    const group = groups.get(id) ?? { rule, endpoints: [] };
    group.endpoints.push(rule.endpoint);
    groups.set(id, group);
  }
  const data = [];
  for (const { rule, endpoints } of groups.values()) {
    const { endpoint, ...rest } = rule;
    const everywhere = holders.get(`${rule.in}|${rule.old ?? ''}`) ?? [];
    const general = rule.in !== 'query' && rule.old !== undefined && everywhere.length > 0 && everywhere.every((e) => endpoints.includes(e));
    data.push(general ? rest : { ...rest, endpoint: endpoints.length === 1 ? endpoints[0] : endpoints });
  }
  // The same rule for requests and answers everywhere becomes one rule for both.
  const merged = [];
  for (const rule of data) {
    if (rule.endpoint || !rule.in || rule.in === 'query') { merged.push(rule); continue; }
    const { in: where, ...rest } = rule;
    const twin = data.find((other) => other !== rule && !other.endpoint && other.in && other.in !== where && other.in !== 'query' && JSON.stringify({ ...other, in: where }) === JSON.stringify(rule));
    if (!twin) merged.push(rule);
    else if (where === 'request') merged.push(rest);
  }

  const seenNotes = new Set();
  return {
    rules: [...structural, ...merged],
    notes: notes.filter((n) => !seenNotes.has(n.message) && seenNotes.add(n.message)),
    operations,
  };
}

// ---------- samples and validation ----------

const pickNumber = (s, fallback) => {
  let n = fallback;
  if (typeof s.minimum === 'number' && n < s.minimum) n = s.minimum;
  if (typeof s.maximum === 'number' && n > s.maximum) n = s.maximum;
  return n;
};

// One value that fits a schema. `onlyRequired` leaves optional fields out.
const LOOP = Symbol('schema contains itself');

export function sampleOf(schema, spec, options = {}, name = '', depth = 0, trail = []) {
  const refName = isRecord(schema) && typeof schema.$ref === 'string' ? schema.$ref : null;
  if (refName && trail.includes(refName)) return LOOP;
  if (refName) trail = [...trail, refName];
  const s = resolve(schema, spec);
  if (s.example !== undefined) return structuredClone(s.example);
  if (s.default !== undefined) return structuredClone(s.default);
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
  const type = typeOf(s);
  const leafLike = { type, format: s.format, description: typeof s.description === 'string' ? s.description : '' };
  if (type === 'object') {
    const out = {};
    if (depth > 40) return out;
    const needed = new Set(s.required ?? []);
    // Deep inside a large schema only the required fields are filled in, so samples stay
    // small but still fit their schema.
    const lean = options.onlyRequired || depth > 6;
    for (const [key, child] of Object.entries(s.properties ?? {})) {
      const c = resolve(child, spec);
      if ((options.where === 'request' && c.readOnly) || (options.where === 'response' && c.writeOnly)) continue;
      if (lean && !needed.has(key)) continue;
      let value = sampleOf(child, spec, options, key, depth + 1, trail);
      // A required field that contains its own schema again: build it with required fields only.
      if (value === LOOP && needed.has(key)) value = sampleOf(child, spec, { ...options, onlyRequired: true }, key, depth + 20, []);
      if (value !== LOOP) out[key] = value;
    }
    return out;
  }
  if (type === 'array') {
    if (depth > 6 || !s.items) return [];
    const item = sampleOf(s.items, spec, options, name, depth + 1, trail);
    return item === LOOP ? [] : [item];
  }
  if (type === 'integer' || type === 'number') {
    const time = timeFormat(name, leafLike);
    if (time) return time === 'unix_ms' ? 1767452400000 : 1767452400;
    if (unitOf(name, leafLike) === 100) return pickNumber(s, 1250);
    return pickNumber(s, type === 'integer' ? 3 : 12.5);
  }
  if (type === 'boolean') return true;
  if (type === 'string') {
    if (s.format === 'date-time') return '2026-01-03T15:00:00Z';
    if (s.format === 'date') return '2026-01-03';
    if (s.format === 'uuid') return '3f2b0c7e-8d1a-4c59-9b7e-1a2b3c4d5e6f';
    if (s.format === 'email') return 'ann@example.com';
    if (s.format === 'uri' || s.format === 'url') return 'https://example.com/a';
    return `sample-${name || 'text'}`;
  }
  return null;
}

function setEvery(node, segments, value, i = 0) {
  if (!isRecord(node)) return;
  const { key, each } = segments[i];
  if (!(key in node)) return;
  const last = i === segments.length - 1;
  if (each) {
    if (!Array.isArray(node[key])) return;
    if (last) node[key] = node[key].map(() => value);
    else node[key].forEach((item) => setEvery(item, segments, value, i + 1));
    return;
  }
  if (last) node[key] = value;
  else setEvery(node[key], segments, value, i + 1);
}

// A set of samples that exercises a schema: every field, required fields only, and enough
// extra samples that every allowed value of every field appears at least once. Sample k uses
// the k-th allowed value of each field, so a schema with thousands of fields still needs only
// as many samples as its longest list of values (at most 12).
export function samplesFor(schema, spec, where) {
  const full = sampleOf(schema, spec, { where });
  const samples = [full];
  const lean = sampleOf(schema, spec, { where, onlyRequired: true });
  if (JSON.stringify(lean) !== JSON.stringify(full)) samples.push(lean);
  if (isRecord(full)) {
    const choices = [...flattenSchema(schema, spec, where).leaves].filter(([, field]) => (field.enum ?? []).length > 1);
    const rounds = Math.min(12, Math.max(0, ...choices.map(([, field]) => field.enum.length)));
    for (let k = 1; k < rounds; k++) {
      const copy = structuredClone(full);
      for (const [path, field] of choices) setEvery(copy, parsePath(path), field.enum[k % field.enum.length]);
      samples.push(copy);
    }
  }
  return samples;
}

const at = (path, key) => (path ? `${path}.${key}` : key);

// Checks a value against a schema. `strict` also rejects fields the schema does not declare.
export function validate(value, schema, spec, options = {}, path = '') {
  const s = resolve(schema, spec);
  const errors = [];
  const fail = (message) => errors.push({ path: path || '(body)', message });
  const type = typeOf(s);
  if (value === null || value === undefined) {
    if (value === undefined || (!nullable(s) && type !== 'null' && type !== undefined)) fail(value === undefined ? 'is missing' : 'is null');
    return errors;
  }
  if (Array.isArray(s.enum) && !s.enum.some((allowed) => Object.is(allowed, value))) fail(`is ${JSON.stringify(value)}, which is not one of ${JSON.stringify(s.enum)}`);
  if (type === 'object') {
    if (!isRecord(value)) { fail('should be an object'); return errors; }
    for (const key of s.required ?? []) {
      const child = resolve(s.properties?.[key] ?? {}, spec);
      const skipped = (options.where === 'request' && child.readOnly) || (options.where === 'response' && child.writeOnly);
      if (!(key in value) && !skipped) errors.push({ path: at(path, key), message: 'is required and missing' });
    }
    for (const [key, item] of Object.entries(value)) {
      const child = s.properties?.[key];
      if (child) errors.push(...validate(item, child, spec, options, at(path, key)));
      else if (isRecord(s.properties) && (s.additionalProperties === false || (options.strict && !s.additionalProperties))) errors.push({ path: at(path, key), message: 'is not a field of this version' });
    }
  } else if (type === 'array') {
    if (!Array.isArray(value)) { fail('should be a list'); return errors; }
    value.forEach((item, i) => errors.push(...validate(item, s.items ?? {}, spec, options, `${path}[${i}]`)));
  } else if (type === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value)) fail(`should be a whole number, got ${JSON.stringify(value)}`);
  } else if (type === 'number') {
    if (typeof value !== 'number') fail(`should be a number, got ${JSON.stringify(value)}`);
  } else if (type === 'string') {
    if (typeof value !== 'string') fail(`should be text, got ${JSON.stringify(value)}`);
    else if (s.format === 'date-time' && Number.isNaN(Date.parse(value))) fail(`should be a date and time, got ${JSON.stringify(value)}`);
  } else if (type === 'boolean') {
    if (typeof value !== 'boolean') fail(`should be true or false, got ${JSON.stringify(value)}`);
  }
  if (typeof value === 'number') {
    if (typeof s.minimum === 'number' && value < s.minimum) fail(`is below the minimum ${s.minimum}`);
    if (typeof s.maximum === 'number' && value > s.maximum) fail(`is above the maximum ${s.maximum}`);
  }
  return errors;
}

// Runs generated samples through the rules and checks them against the other version's spec:
// old-style requests must become valid new requests, and new answers must become valid old answers.
export function proveWithSchemas(oldSpec, newSpec, rules) {
  const adapter = compileRules({ from: 'old', to: 'new', rules });
  const before = operationsOf(oldSpec);
  const after = [...operationsOf(newSpec).values()];
  const checks = [];
  let samples = 0;
  for (const [key, op] of before) {
    const path = op.path.replace(/\{[^}]+\}/g, 'sample');
    const call = { method: op.method, path, query: {} };
    if (adapter.untranslatable.some((u) => u.method === op.method && u.path.test(path))) {
      checks.push({ endpoint: key, status: 'removed', samples: 0, failures: [] });
      continue;
    }
    const sent = adapter.upgradeRequest({ ...call });
    const target = after.find((o) => o.method === String(sent.method).toUpperCase() && new RegExp(`^${shapeOf(o.path).split('{}').map((p) => p.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('[^/]+')}/?$`).test(sent.path));
    if (!target) {
      checks.push({ endpoint: key, status: 'unmatched', samples: 0, failures: [{ where: 'request', path: '(endpoint)', message: `${sent.method} ${sent.path} is not in the new spec` }] });
      continue;
    }
    const failures = [];
    let count = 0;
    // A sample is only evidence if it fits the spec it was generated from.
    const fits = (sample, schema, spec, where) => validate(sample, schema, spec, { where }).length === 0;
    if (op.request && target.request) {
      for (const sample of samplesFor(op.request.schema, oldSpec, 'request')) {
        if (!fits(sample, op.request.schema, oldSpec, 'request')) continue;
        count += 1;
        const body = adapter.upgradeRequest({ ...call, body: structuredClone(sample) }).body;
        for (const error of validate(body, target.request.schema, newSpec, { strict: true, where: 'request' })) if (failures.length < 20) failures.push({ where: 'request', ...error });
      }
    }
    if (op.response && target.response) {
      for (const sample of samplesFor(target.response.schema, newSpec, 'response')) {
        if (!fits(sample, target.response.schema, newSpec, 'response')) continue;
        count += 1;
        const body = adapter.downgradeResponse({ status: 200, body: structuredClone(sample) }, call).body;
        for (const error of validate(body, op.response.schema, oldSpec, { strict: true, where: 'response' })) if (failures.length < 20) failures.push({ where: 'response', ...error });
      }
    }
    samples += count;
    checks.push({ endpoint: key, status: failures.length ? 'failed' : 'passed', samples: count, failures });
  }
  return { ok: checks.every((c) => c.failures.length === 0), samples, checks };
}
