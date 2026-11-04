import { parse } from '@babel/parser';

export type HttpCallSite = {
  file: string; line: number; symbol: string; endpoint: string; origin: string;
  fields: string[]; fieldsComplete: boolean; bodyLine?: number;
  uncertain: true; reason: string;
};

type Node = { type?: string; start?: number; loc?: { start?: { line?: number } }; [key: string]: any };

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

function asCall(file: string, node: Node): HttpCallSite | null {
  if (node.type !== 'CallExpression') return null;
  const callee = unwrap(node.callee);
  const isFetch = callee?.type === 'Identifier' && callee.name === 'fetch' || member(callee, 'globalThis', 'fetch');
  const isAxios = callee?.type === 'MemberExpression' && !callee.computed
    && callee.object?.type === 'Identifier' && callee.object.name === 'axios'
    && ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(callee.property?.name);
  if (!isFetch && !isAxios) return null;
  const address = literal(node.arguments?.[0]);
  if (!address || address.length > 2048) return null;
  let url: URL;
  try { url = new URL(address); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  let method: string;
  let body: ReturnType<typeof jsonBody> = null;
  if (isFetch) {
    const options = unwrap(node.arguments?.[1]);
    if (options && options.type !== 'ObjectExpression') return null;
    if (options?.properties?.some((item: Node) => propertyName(item) === null)) return null;
    const configured = property(options, 'method');
    const methodText = configured ? literal(configured) : 'GET';
    if (!methodText || !/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/i.test(methodText)) return null;
    method = methodText.toUpperCase();
    body = jsonBody(options);
  } else {
    method = callee?.property?.name?.toUpperCase();
    // Axios may transform request data. Keep its body unknown until that case is modeled.
  }
  const line = node.loc?.start?.line;
  if (typeof line !== 'number' || !Number.isSafeInteger(line) || !method) return null;
  return {
    file, line, symbol: isFetch ? 'fetch' : `axios.${method.toLowerCase()}`,
    endpoint: `${method} ${url.pathname}`, origin: url.origin,
    fields: body?.fields || [], fieldsComplete: Boolean(body), bodyLine: body?.bodyLine,
    uncertain: true,
    reason: body ? 'Literal JSON request keys parsed; runtime behavior has not been verified'
      : 'Static HTTP URL found; request body or runtime behavior has not been verified',
  };
}

// Parsing never runs repository code. Unsupported syntax falls back to the
// conservative text scanner; it cannot establish that a dynamic body is safe.
export function parseStaticHttpCalls(file: string, source: string): HttpCallSite[] {
  let syntax: Node;
  try { syntax = parse(source, { sourceType: 'unambiguous', plugins: ['typescript', 'jsx'] }) as Node; }
  catch { return []; }
  const calls: HttpCallSite[] = [];
  const stack: Node[] = [syntax];
  let visited = 0;
  while (stack.length && visited++ < 100_000 && calls.length < 200) {
    const node = stack.pop()!;
    const call = asCall(file, node);
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
  return calls.sort((a, b) => a.line - b.line);
}
