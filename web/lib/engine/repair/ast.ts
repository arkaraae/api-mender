// Read-only syntax helpers shared by the repair task builder and the policy
// gates. Parsing never runs repository code.
import { parse } from '@babel/parser';
import { describeSdkCall, sdkContext } from '../sdk/js-sdk-calls.ts';

export type Node = {
  type?: string; start?: number; end?: number;
  loc?: { start?: { line?: number }; end?: { line?: number } };
  [key: string]: any;
};

const WRAPPERS = ['TSAsExpression', 'TSSatisfiesExpression', 'TSTypeAssertion', 'TSNonNullExpression', 'ParenthesizedExpression'];
// Comment nodes carry a `type` too; they are compared separately, never walked.
const SKIPPED_KEYS = new Set(['loc', 'tokens', 'comments', 'extra', 'errors',
  'leadingComments', 'trailingComments', 'innerComments']);
const MAX_NODES = 200_000;
// Stands in for `${expression}` while a template-literal URL is parsed.
const PARAM = '__MENDER_PARAM__';

/** Same parser options as the inventory, so both see the same syntax. Null when the source does not parse. */
export function parseSource(source: string): Node | null {
  try { return parse(source, { sourceType: 'unambiguous', plugins: ['typescript', 'jsx'] }) as Node; }
  catch { return null; }
}

function children(node: Node): Node[] {
  const found: Node[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (SKIPPED_KEYS.has(key)) continue;
    if (Array.isArray(value)) {
      for (const child of value) if (child && typeof child === 'object' && typeof child.type === 'string') found.push(child);
    } else if (value && typeof value === 'object' && typeof value.type === 'string') found.push(value);
  }
  return found;
}

/** Visit every node with its parent. Returns false when the tree is too large to have been fully visited. */
export function walk(root: Node, visit: (node: Node, parent: Node | null) => void): boolean {
  const stack: Array<[Node, Node | null]> = [[root, null]];
  let visited = 0;
  while (stack.length) {
    if (visited++ >= MAX_NODES) return false;
    const [node, parent] = stack.pop()!;
    visit(node, parent);
    for (const child of children(node)) stack.push([child, node]);
  }
  return true;
}

export function unwrap(node: Node | undefined): Node | undefined {
  while (node && WRAPPERS.includes(node.type || '')) node = node.expression;
  return node;
}

export function textOf(source: string, node: Node | undefined): string {
  return node && typeof node.start === 'number' && typeof node.end === 'number' ? source.slice(node.start, node.end) : '';
}

function literal(node: Node | undefined): string | null {
  node = unwrap(node);
  if (node?.type === 'StringLiteral') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions?.length === 0) return node.quasis?.[0]?.value?.cooked ?? null;
  return null;
}

/** Literal, non-computed key of an object property; null for spreads, methods and computed keys. */
export function keyName(node: Node | undefined): string | null {
  if (!node || node.type !== 'ObjectProperty' || node.computed) return null;
  if (node.key?.type === 'Identifier') return node.key.name;
  return node.key?.type === 'StringLiteral' ? node.key.value : null;
}

function member(node: Node | undefined, owner: string, name: string): boolean {
  node = unwrap(node);
  return node?.type === 'MemberExpression' && !node.computed
    && node.object?.type === 'Identifier' && node.object.name === owner
    && node.property?.type === 'Identifier' && node.property.name === name;
}

function isFetchCallee(node: Node | undefined): boolean {
  const callee = unwrap(node);
  return (callee?.type === 'Identifier' && callee.name === 'fetch') || member(callee, 'globalThis', 'fetch');
}

// `https://host/repos/${owner}/issues` → origin + `/repos/{}/issues`. A
// dynamic origin is not resolved: the call cannot be tied to a provider.
function staticUrl(node: Node | undefined): { origin: string; path: string } | null {
  node = unwrap(node);
  let address: string | null = null;
  if (node?.type === 'StringLiteral') address = node.value;
  else if (node?.type === 'TemplateLiteral') {
    const parts = (node.quasis as Node[]).map(quasi => quasi.value?.cooked);
    if (parts.some(part => typeof part !== 'string' || part.includes(PARAM))) return null;
    address = parts.join(PARAM);
  }
  if (!address || address.length > 2048) return null;
  let url: URL;
  try { url = new URL(address); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.origin.includes(PARAM)) return null;
  return { origin: url.origin, path: url.pathname.split(PARAM).join('{}') };
}

export type BodyProperty = { name: string; node: Node; value: Node; valueText: string };

export type TargetCall = {
  /** 'fetch': fetch(url, { body: JSON.stringify({...}) }). 'sdk': an official SDK method called with a request object. */
  kind: 'fetch' | 'sdk';
  node: Node;
  origin: string;
  /** `METHOD /path`, template expressions written as `{}`. */
  endpoint: string;
  options: Node;
  /** The `body` property of the options object. */
  bodyProperty: Node;
  /** The object literal passed to JSON.stringify. */
  bodyObject: Node;
  startLine: number;
  endLine: number;
  /** Request-object keys that are path parameters or SDK options, not body fields (SDK calls). */
  ignoredKeys: string[];
};

// Only `fetch(url, { …literal options…, body: JSON.stringify({ … }) })` is
// described. Anything looser has a body the gates could not read back.
function describeFetch(node: Node): TargetCall | null {
  if (node.type !== 'CallExpression' || !isFetchCallee(node.callee) || node.arguments?.length !== 2) return null;
  const url = staticUrl(node.arguments[0]);
  const options = unwrap(node.arguments[1]);
  if (!url || options?.type !== 'ObjectExpression') return null;
  const properties = options.properties as Node[];
  if (properties.some(item => keyName(item) === null)) return null;
  const named = (name: string) => properties.filter(item => keyName(item) === name);
  const methods = named('method');
  const bodies = named('body');
  if (methods.length > 1 || bodies.length !== 1) return null;
  const method = methods.length ? literal(methods[0].value)?.toUpperCase() : 'GET';
  if (!method || !/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(method)) return null;
  const body = unwrap(bodies[0].value);
  if (body?.type !== 'CallExpression' || !member(body.callee, 'JSON', 'stringify') || body.arguments?.length !== 1) return null;
  const bodyObject = unwrap(body.arguments[0]);
  const startLine = node.loc?.start?.line;
  const endLine = node.loc?.end?.line;
  if (bodyObject?.type !== 'ObjectExpression' || typeof startLine !== 'number' || typeof endLine !== 'number') return null;
  return { kind: 'fetch', node, origin: url.origin, endpoint: `${method} ${url.path}`, options, bodyProperty: bodies[0], bodyObject, startLine, endLine, ignoredKeys: [] };
}

/** Every describable fetch call whose expression starts on `line`. */
export function fetchCallsStartingOn(syntax: Node, line: number): TargetCall[] | null {
  const calls: TargetCall[] = [];
  const complete = walk(syntax, node => {
    if (node.type !== 'CallExpression' || node.loc?.start?.line !== line) return;
    const call = describeFetch(node);
    if (call) calls.push(call);
  });
  return complete ? calls : null;
}

/**
 * Every describable call whose expression starts on `line`: fetch calls, and
 * SDK method calls passed a literal request object. `sdkRoot` names a client
 * the finding already attributed (one imported from another file).
 */
export function targetCallsStartingOn(syntax: Node, line: number, file: string, sdkRoot?: { root: string; providerId: string }): TargetCall[] | null {
  const fetches = fetchCallsStartingOn(syntax, line);
  if (!fetches) return null;
  const nodes: Node[] = [];
  if (!walk(syntax, node => { nodes.push(node); })) return null;
  const context = sdkContext(file, nodes, undefined, sdkRoot);
  if (!context.clients.size) return fetches;
  const sdk: TargetCall[] = [];
  for (const node of nodes) {
    if (node.type !== 'CallExpression' || node.loc?.start?.line !== line) continue;
    const described = describeSdkCall(node, context);
    const params = unwrap(described?.params);
    const startLine = node.loc?.start?.line;
    const endLine = node.loc?.end?.line;
    if (!described || params?.type !== 'ObjectExpression' || typeof startLine !== 'number' || typeof endLine !== 'number') continue;
    sdk.push({ kind: 'sdk', node, origin: described.provider.origins[0], endpoint: described.endpoint, options: params, bodyProperty: params,
      bodyObject: params, startLine, endLine, ignoredKeys: described.ignoredKeys });
  }
  return [...fetches, ...sdk];
}

/** Top-level JSON keys of the request body. Null when a spread, method or computed key makes them unknowable. */
export function bodyProperties(source: string, call: TargetCall): BodyProperty[] | null {
  const result: BodyProperty[] = [];
  for (const node of call.bodyObject.properties as Node[]) {
    const name = keyName(node);
    if (name !== null && call.ignoredKeys.includes(name)) continue;
    if (name === null || name.length > 128 || !node.value) return null;
    result.push({ name, node, value: node.value, valueText: textOf(source, node.value) });
  }
  return result.length <= 100 ? result : null;
}
