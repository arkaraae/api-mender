import { parseModule } from './engine/parse.ts';
import { parseStaticHttpCalls } from './static-http-calls.ts';

type Node = { type?: string; loc?: { start?: { line?: number } }; [key: string]: any };
export type DatabaseWriteTrace = { responseField: string; table: string; column: string;
  writeLine: number; method: 'insert' | 'upsert'; evidence: 'direct-static-response-write' };
export type ApiDatabaseFlow = { file: string; callLine: number; endpoint: string; origin: string;
  databaseWrites: DatabaseWriteTrace[] };

function unwrap(node: Node | undefined): Node | undefined {
  while (node && ['AwaitExpression', 'TSAsExpression', 'TSTypeAssertion', 'TSNonNullExpression',
    'ParenthesizedExpression'].includes(node.type || '')) node = node.argument || node.expression;
  return node;
}

function member(node: Node | undefined, property: string): Node | undefined {
  node = unwrap(node);
  return node?.type === 'MemberExpression' && !node.computed
    && node.property?.type === 'Identifier' && node.property.name === property ? node.object : undefined;
}

function literal(node: Node | undefined): string | null {
  node = unwrap(node);
  if (node?.type === 'StringLiteral') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions?.length === 0)
    return node.quasis?.[0]?.value?.cooked || null;
  return null;
}

function isFetchCall(node: Node | undefined) {
  if (node?.type !== 'CallExpression') return false;
  const callee = unwrap(node.callee);
  return callee?.type === 'Identifier' && callee.name === 'fetch'
    || unwrap(member(callee, 'fetch'))?.type === 'Identifier'
      && unwrap(member(callee, 'fetch'))?.name === 'globalThis';
}

function properties(node: Node | undefined): { name: string; value: Node }[] | null {
  node = unwrap(node);
  if (node?.type !== 'ObjectExpression' || node.properties?.length > 100) return null;
  const output: { name: string; value: Node }[] = [];
  for (const entry of node.properties || []) {
    if (entry.type !== 'ObjectProperty' || entry.computed || entry.method) return null;
    const name = entry.key?.type === 'Identifier' ? entry.key.name : literal(entry.key);
    if (!name || name.length > 128) return null;
    output.push({ name, value: entry.value });
  }
  return output;
}

function declaration(statement: Node) {
  if (statement.type !== 'VariableDeclaration' || statement.kind !== 'const'
    || statement.declarations?.length !== 1) return null;
  const item = statement.declarations[0];
  return item.id?.type === 'Identifier' ? { name: item.id.name, init: unwrap(item.init) } : null;
}

function databaseWrites(statement: Node, payload: string): DatabaseWriteTrace[] {
  const expression = statement.type === 'ExpressionStatement' ? statement.expression
    : statement.type === 'VariableDeclaration' && statement.declarations?.length === 1
      ? statement.declarations[0].init : undefined;
  const call = unwrap(expression);
  if (call?.type !== 'CallExpression') return [];
  const method = member(call.callee, 'insert') ? 'insert' : member(call.callee, 'upsert') ? 'upsert' : null;
  if (!method || call.arguments?.length !== 1) return [];
  const from = unwrap(member(call.callee, method));
  if (from?.type !== 'CallExpression' || from.arguments?.length !== 1
    || !member(from.callee, 'from') || unwrap(member(from.callee, 'from'))?.type !== 'Identifier'
    || unwrap(member(from.callee, 'from'))?.name !== 'supabase') return [];
  const table = literal(from.arguments[0]);
  if (!table || table.length > 128) return [];
  const rows = properties(call.arguments[0]);
  if (!rows) return [];
  const writeLine = call.loc?.start?.line;
  if (!Number.isSafeInteger(writeLine)) return [];
  const line = writeLine as number;
  return rows.flatMap(({ name, value }) => {
    const fieldNode = unwrap(value);
    const field = fieldNode?.type === 'MemberExpression' && !fieldNode.computed
      && fieldNode.object?.type === 'Identifier' && fieldNode.object.name === payload
      && fieldNode.property?.type === 'Identifier' ? fieldNode.property.name : null;
    return field ? [{ responseField: field, table, column: name, writeLine: line,
      method, evidence: 'direct-static-response-write' as const }] : [];
  });
}

// This deliberately recognizes only three consecutive direct statements in
// one function body. It does not execute code or infer behavior across branches,
// aliases, helper calls, dynamic keys, or files.
export function traceStaticDatabaseWrites(file: string, source: string): ApiDatabaseFlow[] {
  let syntax: Node;
  try { syntax = parseModule(source) as Node; }
  catch { return []; }
  const calls = parseStaticHttpCalls(file, source).filter(call => call.symbol === 'fetch');
  if (!calls.length) return [];
  const flows: ApiDatabaseFlow[] = [];
  const stack: Node[] = [syntax];
  let visited = 0;
  while (stack.length && visited++ < 100_000 && flows.length < 100) {
    const node = stack.pop()!;
    if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ObjectMethod', 'ClassMethod']
      .includes(node.type || '') && node.body?.type === 'BlockStatement') {
      const statements: Node[] = node.body.body || [];
      for (let index = 0; index + 2 < statements.length; index++) {
        const response = declaration(statements[index]);
        const fetch = response?.init;
        if (!fetch || !isFetchCall(fetch)) continue;
        const call = calls.find(item => item.line === fetch.loc?.start?.line);
        if (!call) continue;
        const payload = declaration(statements[index + 1]);
        const json = payload?.init;
        if (!payload || json?.type !== 'CallExpression'
          || unwrap(member(json.callee, 'json'))?.type !== 'Identifier'
          || unwrap(member(json.callee, 'json'))?.name !== response?.name
          || json.arguments?.length !== 0) continue;
        const writes = databaseWrites(statements[index + 2], payload.name);
        if (writes.length) flows.push({ file, callLine: call.line, endpoint: call.endpoint,
          origin: call.origin, databaseWrites: writes });
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'tokens', 'comments', 'extra'].includes(key)) continue;
      if (Array.isArray(value)) {
        for (const child of value)
          if (child && typeof child === 'object' && typeof child.type === 'string') stack.push(child);
      } else if (value && typeof value === 'object' && typeof value.type === 'string') {
        stack.push(value);
      }
    }
  }
  return flows;
}
