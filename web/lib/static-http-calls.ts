import { parse } from '@babel/parser';

export type HttpCallSite = {
  file: string; line: number; symbol: string; endpoint: string; origin: string;
  fields: string[]; fieldsComplete: boolean; bodyLine?: number;
  uncertain: true; reason: string;
};

// The same call with what the provider pipeline also needs. Kept beside
// HttpCallSite, whose stored shape must not change.
export type HttpCallDetail = {
  call: HttpCallSite;
  endLine?: number;
  /** Literal headers by lower-cased name. Absent when the header object could not be read. */
  headers?: Record<string, string>;
  /** True only when every header name and value was a literal, so an absent header is known absent. */
  headersComplete: boolean;
};

type Node = { type?: string; start?: number; loc?: { start?: { line?: number }; end?: { line?: number } }; [key: string]: any };

function unwrap(node: Node | undefined): Node | undefined {
  while (node && ['TSAsExpression', 'TSTypeAssertion', 'TSNonNullExpression', 'ParenthesizedExpression'].includes(node.type || '')) node = node.expression;
  return node;
}

function literal(node: Node | undefined): string | null {
  node = unwrap(node);
  if (node?.type === 'StringLiteral') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions?.length === 0) return node.quasis?.[0]?.value?.cooked ?? null;
  return null;
}

function propertyName(node: Node | undefined): string | null {
  if (!node || node.type !== 'ObjectProperty') return null;
  if (node.key?.type === 'Identifier' && !node.computed) return node.key.name;
  return literal(node.key);
}

function property(object: Node | undefined, name: string): Node | undefined {
  object = unwrap(object);
  if (object?.type !== 'ObjectExpression') return undefined;
  return object?.properties?.find((item: Node) => propertyName(item) === name)?.value;
}

function member(node: Node | undefined, owner: string, name: string) {
  node = unwrap(node);
  return node?.type === 'MemberExpression' && !node.computed
    && node.object?.type === 'Identifier' && node.object.name === owner
    && node.property?.type === 'Identifier' && node.property.name === name;
}

function jsonFields(node: Node | undefined) {
  node = unwrap(node);
  if (node?.type !== 'ObjectExpression') return null;
  const fields: string[] = [];
  for (const item of node.properties || []) {
    const name = propertyName(item);
    if (name === null || name.length > 128) return null; // A spread or computed key could supply any required field.
    fields.push(name);
  }
  return fields.length <= 100 ? [...new Set(fields)] : null;
}

function jsonBody(options: Node | undefined) {
  const body = unwrap(property(options, 'body'));
  if (body?.type !== 'CallExpression' || !member(body.callee, 'JSON', 'stringify') || body.arguments?.length !== 1) return null;
  const fields = jsonFields(body.arguments[0]);
  return fields ? { fields, bodyLine: body.arguments[0]?.loc?.start?.line } : null;
}

// Stands in for a `${...}` path expression while the URL is parsed. A template
// that already contains it is refused, so it can only come from an expression.
const dynamicMarker = 'mender-dynamic-segment';

// A template URL is read only when its literal prefix fixes scheme, host and
// port and ends the authority with `/`: `https://api.example.com${rest}` could
// resolve to another host. An expression after `?` or `#` is refused as well.
function templateAddress(node: Node | undefined): string | null {
  node = unwrap(node);
  if (node?.type !== 'TemplateLiteral' || !node.expressions?.length || node.expressions.length > 32) return null;
  const parts: unknown[] = (node.quasis || []).map((quasi: Node) => quasi?.value?.cooked);
  if (parts.length !== node.expressions.length + 1) return null;
  if (!parts.every((part): part is string => typeof part === 'string' && !part.includes(dynamicMarker))) return null;
  if (!/^https:\/\/[^/?#@\\\s]+\//.test(parts[0])) return null;
  const query = parts.findIndex(part => /[?#]/.test(part));
  if (query !== -1 && query < parts.length - 1) return null;
  return parts.join(dynamicMarker);
}

// A segment that is wholly or partly an expression is written `{}`.
function templatePath(pathname: string) {
  return pathname.split('/').map(segment => segment.includes(dynamicMarker) ? '{}' : segment).join('/');
}

const headerName = /^[!#$%&'*+.^_`|~0-9a-z-]{1,128}$/;

// Header names are case-insensitive and a spread or computed key can override
// anything, so a name is kept only when exactly one literal key sets it to a
// literal value and nothing dynamic sits in the same object.
function literalHeaders(node: Node | undefined): { headers?: Record<string, string>; complete: boolean } {
  node = unwrap(node);
  if (!node) return { headers: {}, complete: true };
  if (node.type !== 'ObjectExpression' || (node.properties || []).length > 50) return { complete: false };
  const written = new Map<string, { key: string; value: string | null }[]>();
  let complete = true;
  for (const item of node.properties || []) {
    const key = propertyName(item);
    if (key === null) return { complete: false };
    const name = key.toLowerCase();
    const value = literal(item.value);
    written.set(name, [...(written.get(name) || []), { key, value: value !== null && value.length <= 1024 ? value : null }]);
  }
  const headers = new Map<string, string>();
  for (const [name, entries] of written) {
    const last = entries[entries.length - 1];
    if (!headerName.test(name) || entries.some(entry => entry.key !== last.key || entry.value === null)) complete = false;
    else headers.set(name, last.value!);
  }
  // fromEntries defines own properties, so a header named __proto__ stays data.
  return { headers: Object.fromEntries(headers), complete };
}

function asCall(file: string, node: Node, templates: boolean): HttpCallDetail | null {
  if (node.type !== 'CallExpression') return null;
  const callee = unwrap(node.callee);
  const isFetch = callee?.type === 'Identifier' && callee.name === 'fetch' || member(callee, 'globalThis', 'fetch');
  const isAxios = callee?.type === 'MemberExpression' && !callee.computed
    && callee.object?.type === 'Identifier' && callee.object.name === 'axios'
    && ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(callee.property?.name);
  if (!isFetch && !isAxios) return null;
  const fixed = literal(node.arguments?.[0]);
  const address = fixed ?? (templates ? templateAddress(node.arguments?.[0]) : null);
  if (!address || address.length > 2048) return null;
  let url: URL;
  try { url = new URL(address); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  let method: string;
  let body: ReturnType<typeof jsonBody> = null;
  let headers: ReturnType<typeof literalHeaders>;
  if (isFetch) {
    const options = unwrap(node.arguments?.[1]);
    if (options && options.type !== 'ObjectExpression') return null;
    if (options?.properties?.some((item: Node) => propertyName(item) === null)) return null;
    const configured = property(options, 'method');
    const methodText = configured ? literal(configured) : 'GET';
    if (!methodText || !/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/i.test(methodText)) return null;
    method = methodText.toUpperCase();
    body = jsonBody(options);
    headers = literalHeaders(options ? property(options, 'headers') : undefined);
  } else {
    method = callee?.property?.name?.toUpperCase();
    // Axios may transform request data. Keep its body unknown until that case is modeled.
    // Its defaults and interceptors can add headers, so the set is never complete.
    const config = unwrap(node.arguments?.[['POST', 'PUT', 'PATCH'].includes(method) ? 2 : 1]);
    const configured = config?.type === 'ObjectExpression' && config.properties.every((item: Node) => propertyName(item) !== null)
      ? property(config, 'headers') : undefined;
    headers = { headers: configured ? literalHeaders(configured).headers : undefined, complete: false };
  }
  const line = node.loc?.start?.line;
  if (typeof line !== 'number' || !Number.isSafeInteger(line) || !method) return null;
  const endLine = node.loc?.end?.line;
  const call: HttpCallSite = {
    file, line, symbol: isFetch ? 'fetch' : `axios.${method.toLowerCase()}`,
    endpoint: `${method} ${fixed === null ? templatePath(url.pathname) : url.pathname}`, origin: url.origin,
    fields: body?.fields || [], fieldsComplete: Boolean(body), bodyLine: body?.bodyLine,
    uncertain: true,
    reason: body ? 'Literal JSON request keys parsed; runtime behavior has not been verified'
      : 'Static HTTP URL found; request body or runtime behavior has not been verified',
  };
  return {
    call, endLine: typeof endLine === 'number' && Number.isSafeInteger(endLine) && endLine >= line ? endLine : undefined,
    headers: headers.headers, headersComplete: headers.complete,
  };
}

// Parsing never runs repository code. Unsupported syntax falls back to the
// conservative text scanner; it cannot establish that a dynamic body is safe.
export function parseStaticHttpCalls(file: string, source: string): HttpCallSite[] {
  return collectCalls(file, source, false).map(detail => detail.call);
}

// Also reads template-literal URLs (dynamic path segments become `{}`),
// literal request headers and the last line of each call.
export function parseHttpCallDetails(file: string, source: string): HttpCallDetail[] {
  return collectCalls(file, source, true);
}

function collectCalls(file: string, source: string, templates: boolean): HttpCallDetail[] {
  let syntax: Node;
  try { syntax = parse(source, { sourceType: 'unambiguous', plugins: ['typescript', 'jsx'] }) as Node; }
  catch { return []; }
  const calls: HttpCallDetail[] = [];
  const stack: Node[] = [syntax];
  let visited = 0;
  while (stack.length && visited++ < 100_000 && calls.length < 200) {
    const node = stack.pop()!;
    const call = asCall(file, node, templates);
    if (call) calls.push(call);
    for (const [key, value] of Object.entries(node)) {
      if (key === 'loc' || key === 'tokens' || key === 'comments' || key === 'extra') continue;
      if (Array.isArray(value)) {
        for (const child of value) if (child && typeof child === 'object' && typeof child.type === 'string') stack.push(child);
      } else if (value && typeof value === 'object' && typeof value.type === 'string') {
        stack.push(value);
      }
    }
  }
  return calls.sort((a, b) => a.call.line - b.call.line);
}
