import type { OperationSlice } from './types.ts';
import { canonicalJson, sha256Hex } from './hash.ts';
import { plainName } from './text.ts';

// Provider documents are untrusted and can be tens of megabytes. A slice is
// the one operation the customer's code uses, copied out with every bound
// below applied, so what is stored, diffed and shown later is small.

type Json = Record<string, unknown>;

export type SliceMeta = { providerId: string; version: string; sourceUrl: string };

const methods = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'];
const maxSchemaDepth = 6;        // nested schemas below the request body
const maxSchemaNodes = 5_000;    // schemas copied per operation
const maxProperties = 500;       // properties of one object schema
const maxListed = 200;           // entries of required / enum / type
const maxAlternatives = 32;      // members of allOf / oneOf / anyOf
const maxRefHops = 32;
const maxText = 2_000;           // characters of one string keyword
const maxSliceBytes = 64_000;
const maxOperations = 20_000;
const maxSliced = 200;

const truncatedFlag = 'x-mender-truncated';

const isRecord = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value);
// Own properties only: `document['__proto__']` must not reach Object.prototype.
const own = (record: Json, key: string) => (Object.hasOwn(record, key) ? record[key] : undefined);
const isScalar = (value: unknown) => value === null || ['string', 'number', 'boolean'].includes(typeof value);

export function parseOperationKey(key: string): { method: string; path: string } | null {
  if (typeof key !== 'string' || key.length > 1_024) return null;
  const match = /^(GET|PUT|POST|DELETE|PATCH|HEAD|OPTIONS) (\/[^\s?#]*)$/.exec(key);
  return match ? { method: match[1], path: match[2] } : null;
}

// Every `METHOD /path` in the document, in document order.
export function listOperations(document: unknown, limit = maxOperations): string[] {
  const paths = isRecord(document) ? own(document, 'paths') : undefined;
  if (!isRecord(paths)) return [];
  const keys: string[] = [];
  for (const path of Object.keys(paths)) {
    const item = paths[path];
    if (!isRecord(item)) continue;
    for (const method of methods) {
      if (keys.length >= Math.min(limit, maxOperations)) return keys;
      const key = `${method.toUpperCase()} ${path}`;
      if (isRecord(own(item, method)) && parseOperationKey(key)) keys.push(key);
    }
  }
  return keys;
}

const segmentsOf = (path: string) => path.replace(/\/$/, '').split('/').slice(1);
const isParameter = (segment: string) => /^\{[^{}]+\}$/.test(segment);

// How well a call path fits a contract path, or null when it does not. A
// contract `{param}` takes exactly one non-empty segment; a call `{}` (a
// dynamic segment) fits any one segment. `guessed` counts dynamic segments
// laid over a contract literal: possible, but nothing in the code says so.
function fit(contractPath: string, callPath: string): { literal: number; guessed: number } | null {
  const contract = segmentsOf(contractPath);
  const call = segmentsOf(callPath);
  if (contract.length !== call.length || contract.length > 64) return null;
  let literal = 0;
  let guessed = 0;
  for (let index = 0; index < contract.length; index++) {
    if (!call[index]) return null;
    if (isParameter(contract[index])) continue;
    if (call[index] === '{}') guessed++;
    else if (call[index] === contract[index]) literal++;
    else return null;
  }
  return { literal, guessed };
}

// Maps a call endpoint such as `POST /repos/acme/widgets/issues` or
// `POST /repos/{}/{}/issues` to its contract key. The key with the most
// literally matching segments wins, then the one with the fewest guessed
// segments. A tie between different keys is ambiguous and yields null: a
// finding must not be pinned on one of two equally likely operations.
export function matchOperationKey(operationKeys: readonly string[], callEndpoint: string): string | null {
  const call = parseOperationKey(callEndpoint);
  if (!call) return null;
  type Scored = { key: string; literal: number; guessed: number };
  const scored: Scored[] = [];
  for (const key of [...new Set(operationKeys.slice(0, maxOperations))]) {
    const candidate = parseOperationKey(key);
    const score = candidate && candidate.method === call.method ? fit(candidate.path, call.path) : null;
    if (score) scored.push({ key, ...score });
  }
  scored.sort((a, b) => b.literal - a.literal || a.guessed - b.guessed);
  const [best, next] = scored;
  if (!best || (next && next.literal === best.literal && next.guessed === best.guessed)) return null;
  return best.key;
}

// True when every dynamic segment of the call sits on a contract parameter,
// so the match rests on literal path text alone.
export function dynamicSegmentsAlign(operationKey: string, callEndpoint: string): boolean {
  const contract = parseOperationKey(operationKey);
  const call = parseOperationKey(callEndpoint);
  return Boolean(contract && call && fit(contract.path, call.path)?.guessed === 0);
}

type Copy = { document: Json; nodes: number; truncated: boolean; rootCut: boolean; trail: Set<string> };

// Anything past a bound becomes `{}` ("any value"), which a comparison reads
// as unknown rather than as a change.
function cut(state: Copy, depth: number): Json {
  state.truncated = true;
  if (depth === 0) state.rootCut = true;
  return {};
}

// Follows local `#/components/...` references. Remote and relative references
// are never fetched; a reference already being expanded is a cycle.
function follow(value: unknown, state: Copy): { value: unknown; entered: string[] } | null {
  const entered: string[] = [];
  while (isRecord(value) && typeof own(value, '$ref') === 'string') {
    const ref = own(value, '$ref') as string;
    if (!ref.startsWith('#/components/') || ref.length > 512 || state.trail.has(ref) || entered.length >= maxRefHops) {
      for (const name of entered) state.trail.delete(name);
      return null;
    }
    state.trail.add(ref);
    entered.push(ref);
    value = state.document;
    for (const part of ref.slice(2).split('/')) {
      value = isRecord(value) ? own(value, part.replace(/~1/g, '/').replace(/~0/g, '~')) : undefined;
    }
  }
  return { value, entered };
}

const schemaMaps = ['properties'];
const schemaValues = ['items', 'additionalProperties', 'not'];
const schemaLists = ['allOf', 'oneOf', 'anyOf'];
const scalarLists = ['required', 'enum', 'type'];

function copySchema(raw: unknown, state: Copy, depth: number): Json {
  if (depth >= maxSchemaDepth || state.nodes >= maxSchemaNodes) return cut(state, depth);
  state.nodes++;
  const followed = follow(raw, state);
  if (!followed) return cut(state, depth);
  const copied = isRecord(followed.value) ? copyKeywords(followed.value, state, depth) : null;
  for (const name of followed.entered) state.trail.delete(name);
  return copied ?? cut(state, depth);
}

// Keeps the keywords that describe shape. Examples, defaults that are not
// scalars and vendor extensions are dropped: they can be large and say nothing
// a comparison uses. Returns null when a part is too large to keep whole,
// because half a `required` list would read as a contract change.
function copyKeywords(schema: Json, state: Copy, depth: number): Json | null {
  const entries: [string, unknown][] = [];
  for (const key of Object.keys(schema).slice(0, 64)) {
    const value = schema[key];
    if (schemaMaps.includes(key) && isRecord(value)) {
      const names = Object.keys(value);
      if (names.length > maxProperties) return null;
      entries.push([key, Object.fromEntries(names.map(name => [name, copySchema(value[name], state, depth + 1)]))]);
    } else if (schemaValues.includes(key) && isRecord(value)) {
      entries.push([key, copySchema(value, state, depth + 1)]);
    } else if (schemaLists.includes(key) && Array.isArray(value)) {
      if (value.length > maxAlternatives) return null;
      entries.push([key, value.map(item => copySchema(item, state, depth + 1))]);
    } else if (scalarLists.includes(key) && Array.isArray(value)) {
      if (value.length > maxListed || !value.every(item => isScalar(item) && String(item).length <= 256)) return null;
      entries.push([key, [...value]]);
    } else if (typeof value === 'string') {
      entries.push([key, value.slice(0, maxText)]);
    } else if (isScalar(value)) {
      entries.push([key, value]);
    }
  }
  // fromEntries defines own properties, so a property named __proto__ stays data.
  return Object.fromEntries(entries);
}

function copyParameters(item: Json, operation: Json, state: Copy) {
  const listed = [own(item, 'parameters'), own(operation, 'parameters')].flatMap(list => (Array.isArray(list) ? list : []));
  const kept: Json[] = [];
  for (const raw of listed.slice(0, 100)) {
    const followed = follow(raw, state);
    if (!followed) continue;
    for (const name of followed.entered) state.trail.delete(name);
    const parameter = followed.value;
    if (!isRecord(parameter) || typeof parameter.name !== 'string' || parameter.name.length > 128) continue;
    if (parameter.in !== 'path' && parameter.in !== 'header') continue;
    kept.push({ name: parameter.name, in: parameter.in, required: parameter.required === true });
  }
  return kept;
}

const bodyMediaTypes = [/^application\/json\s*(;|$)/i, /^application\/x-www-form-urlencoded\s*(;|$)/i, /^multipart\/form-data\s*(;|$)/i];
const mediaKeyOf = (type: string) => type.split(';')[0].trim().toLowerCase();

function copyRequestBody(operation: Json, state: Copy): Json | null {
  const followed = follow(own(operation, 'requestBody'), state);
  if (!followed) return null;
  for (const name of followed.entered) state.trail.delete(name);
  const body = followed.value;
  const content = isRecord(body) ? own(body, 'content') : undefined;
  if (!isRecord(body) || !isRecord(content)) return null;
  // JSON first (GitHub, OpenAI); form bodies (Stripe, Twilio) carry the same
  // top-level request properties. The media type is kept as published.
  const names = Object.keys(content).slice(0, 20);
  const type = bodyMediaTypes.map(pattern => names.find(name => pattern.test(name))).find(name => name !== undefined);
  const media = type === undefined ? undefined : content[type];
  if (!isRecord(media) || own(media, 'schema') === undefined) return null;
  return { required: body.required === true, content: { [mediaKeyOf(type!)]: { schema: copySchema(own(media, 'schema'), state, 0) } } };
}

// Response bodies are left out: the pipeline reasons about what a caller
// sends. Status codes stay so the slice remains a valid operation.
function copyResponses(operation: Json) {
  const responses = own(operation, 'responses');
  const codes = isRecord(responses) ? Object.keys(responses).filter(code => /^([1-5]\d\d|[1-5]XX|default)$/.test(code)).slice(0, 50) : [];
  return Object.fromEntries(codes.map(code => [code, { description: '' }]));
}

function copyServers(document: Json) {
  const servers = own(document, 'servers');
  return (Array.isArray(servers) ? servers : []).slice(0, 10)
    .flatMap(server => (isRecord(server) && typeof server.url === 'string' && server.url.length <= 2_048 ? [{ url: server.url }] : []));
}

type Cut = { slice: OperationSlice } | { slice: null; reason: 'not-found' | 'too-large' };

async function cutOperation(document: unknown, operationKey: string, meta: SliceMeta): Promise<Cut> {
  const key = parseOperationKey(operationKey);
  const openapi = isRecord(document) ? own(document, 'openapi') : undefined;
  const paths = isRecord(document) ? own(document, 'paths') : undefined;
  if (!key || !isRecord(document) || typeof openapi !== 'string' || !/^3\.(0|1)\./.test(openapi) || !isRecord(paths)) return { slice: null, reason: 'not-found' };
  const item = own(paths, key.path);
  const method = key.method.toLowerCase();
  const operation = isRecord(item) ? own(item, method) : undefined;
  if (!isRecord(item) || !isRecord(operation)) return { slice: null, reason: 'not-found' };

  const state: Copy = { document, nodes: 0, truncated: false, rootCut: false, trail: new Set() };
  const info = own(document, 'info');
  const requestBody = copyRequestBody(operation, state);
  // A request schema cut at its root would read as "accepts anything".
  if (state.rootCut) return { slice: null, reason: 'too-large' };
  const sliced: Json = {
    openapi: openapi.slice(0, 16),
    info: {
      title: isRecord(info) && typeof info.title === 'string' ? info.title.slice(0, 200) : '',
      version: isRecord(info) && typeof info.version === 'string' ? info.version.slice(0, 100) : '',
    },
    servers: copyServers(document),
    paths: { [key.path]: { [method]: {
      ...(typeof operation.operationId === 'string' ? { operationId: operation.operationId.slice(0, 200) } : {}),
      parameters: copyParameters(item, operation, state),
      ...(requestBody ? { requestBody } : {}),
      responses: copyResponses(operation),
    } } },
    ...(state.truncated ? { [truncatedFlag]: true } : {}),
  };
  const canonical = canonicalJson(sliced);
  if (new TextEncoder().encode(canonical).byteLength > maxSliceBytes) return { slice: null, reason: 'too-large' };
  return { slice: {
    providerId: meta.providerId, version: meta.version, operation: operationKey,
    document: sliced, sha256: await sha256Hex(canonical), sourceUrl: meta.sourceUrl,
  } };
}

// Cuts one operation into a small self-contained OpenAPI document. Returns
// null when the operation is absent, the document is not OpenAPI 3.0/3.1, or
// the result would exceed the bounds: a request schema too large at its top
// level, or a slice over 64 KB. Smaller overflows deeper in the schema are
// replaced by `{}` and the document is marked `x-mender-truncated: true`.
export async function sliceOperation(document: unknown, operationKey: string, meta: SliceMeta): Promise<OperationSlice | null> {
  return (await cutOperation(document, operationKey, meta)).slice;
}

export async function sliceOperations(document: unknown, operationKeys: readonly string[], meta: SliceMeta):
  Promise<{ slices: OperationSlice[]; limitations: string[] }> {
  const wanted = [...new Set(operationKeys)];
  const slices: OperationSlice[] = [];
  const limitations: string[] = [];
  if (wanted.length > maxSliced) limitations.push(`Only the first ${maxSliced} operations in use were read from the ${plainName(meta.version)} contract`);
  for (const key of wanted.slice(0, maxSliced)) {
    const result = await cutOperation(document, key, meta);
    if (result.slice) {
      slices.push(result.slice);
      if (isTruncated(result.slice)) limitations.push(`Deeply nested parts of ${plainName(key)} in the ${plainName(meta.version)} contract were not read`);
    } else if (result.reason === 'too-large') {
      limitations.push(`${plainName(key)} in the ${plainName(meta.version)} contract is too large to analyse and was skipped`);
    }
  }
  return { slices, limitations };
}

export function isTruncated(slice: OperationSlice): boolean {
  return own(slice.document as Json, truncatedFlag) === true;
}

// The sliced request schema (JSON or form body), or null when the operation takes no body.
export function requestSchemaOf(slice: OperationSlice): Record<string, unknown> | null {
  const key = parseOperationKey(slice.operation);
  let node: unknown = slice.document;
  for (const part of key ? ['paths', key.path, key.method.toLowerCase(), 'requestBody', 'content'] : []) {
    node = isRecord(node) ? own(node, part) : undefined;
  }
  if (!key || !isRecord(node)) return null;
  const type = ['application/json', 'application/x-www-form-urlencoded', 'multipart/form-data'].find(name => isRecord(own(node as Json, name)));
  const schema = type === undefined ? undefined : own(own(node, type) as Json, 'schema');
  return isRecord(schema) ? schema : null;
}
