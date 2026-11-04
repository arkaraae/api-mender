import { parse } from '@babel/parser';
import { parseStaticHttpCalls } from './static-http-calls.ts';

type Node = { type?: string; start?: number; end?: number; loc?: { start?: { line?: number } }; [key: string]: any };
type CallEvidence = { file: string; line: number; endpoint: string; origin: string;
  fields: string[]; fieldsComplete: boolean };

function unwrap(node: Node | undefined): Node | undefined {
  while (node && ['TSAsExpression', 'TSTypeAssertion', 'TSNonNullExpression', 'ParenthesizedExpression'].includes(node.type || ''))
    node = node.expression;
  return node;
}

function literal(node: Node | undefined): string | null {
  node = unwrap(node);
  if (node?.type === 'StringLiteral') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions?.length === 0) return node.quasis?.[0]?.value?.cooked ?? null;
  return null;
}

function keyName(node: Node | undefined): string | null {
  if (!node || node.type !== 'ObjectProperty' || node.computed) return null;
  if (node.key?.type === 'Identifier') return node.key.name;
  return literal(node.key);
}

function property(node: Node | undefined, key: string): Node | undefined {
  node = unwrap(node);
  if (node?.type !== 'ObjectExpression' || node.properties?.some((item: Node) => keyName(item) === null)) return undefined;
  return node.properties?.find((item: Node) => keyName(item) === key)?.value;
}

function member(node: Node | undefined, owner: string, name: string) {
  node = unwrap(node);
  return node?.type === 'MemberExpression' && !node.computed
    && node.object?.type === 'Identifier' && node.object.name === owner
    && node.property?.type === 'Identifier' && node.property.name === name;
}

function requestSchema(contract: object, endpoint: string) {
  const match = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) (\/.*)$/.exec(endpoint);
  if (!match) throw new Error('Invalid operation evidence');
  const document = contract as { paths?: Record<string, Record<string, any>> };
  const schema = document.paths?.[match[2]]?.[match[1].toLowerCase()]?.requestBody?.content?.['application/json']?.schema;
  if (schema?.type !== 'object' || !Array.isArray(schema.required) || !schema.properties
    || typeof schema.properties !== 'object' || Array.isArray(schema.properties)
    || schema.required.length > 100 || !schema.required.every((name: unknown) => typeof name === 'string'))
    throw new Error('The current operation has no supported JSON request schema');
  return { method: match[1], path: match[2], required: schema.required as string[],
    properties: schema.properties as Record<string, unknown> };
}

function matchingBody(node: Node, evidence: CallEvidence, method: string, path: string): Node | null {
  if (node.type !== 'CallExpression' || node.loc?.start?.line !== evidence.line) return null;
  const callee = unwrap(node.callee);
  if (!(callee?.type === 'Identifier' && callee.name === 'fetch') && !member(callee, 'globalThis', 'fetch')) return null;
  const address = literal(node.arguments?.[0]);
  if (!address) return null;
  let url: URL;
  try { url = new URL(address); } catch { return null; }
  if (url.protocol !== 'https:' || url.origin !== evidence.origin || url.pathname !== path || url.search || url.hash) return null;
  const options = unwrap(node.arguments?.[1]);
  const configured = property(options, 'method');
  if ((configured ? literal(configured)?.toUpperCase() : 'GET') !== method) return null;
  const body = unwrap(property(options, 'body'));
  if (body?.type !== 'CallExpression' || !member(body.callee, 'JSON', 'stringify') || body.arguments?.length !== 1) return null;
  const object = unwrap(body.arguments[0]);
  return object?.type === 'ObjectExpression' ? object : null;
}

/** Make one bounded, reviewable request-key suggestion. No repository code is executed here. */
export function proposeRequestFieldRepair(input: {
  source: string; evidence: CallEvidence; contract: object; missing: string[];
}) {
  const { source, evidence } = input;
  if (source.length > 64_000 || evidence.file.length > 512
    || !/^[A-Za-z0-9_./-]+\.(?:m?js|c?js|tsx?)$/.test(evidence.file)
    || evidence.file.startsWith('/') || evidence.file.split('/').some(part => part === '.' || part === '..')
    || !Number.isSafeInteger(evidence.line) || evidence.line < 1 || evidence.line > 100_000
    || evidence.fieldsComplete !== true || !Array.isArray(evidence.fields) || evidence.fields.length > 100)
    throw new Error('Unsupported or oversized source evidence');
  const schema = requestSchema(input.contract, evidence.endpoint);
  if (input.missing.length !== 1 || !schema.required.includes(input.missing[0]))
    throw new Error('A single required request field is needed for this repair');
  const newField = input.missing[0];
  if (newField.length > 120 || !/^[A-Za-z_$][\w$]*$/.test(newField))
    throw new Error('The new field cannot be edited safely');
  const oldFields = evidence.fields.filter(name => !Object.hasOwn(schema.properties, name));
  if (oldFields.length !== 1 || schema.required.includes(oldFields[0]) || oldFields[0] === newField)
    throw new Error('The replaced request field is ambiguous');
  const oldField = oldFields[0];
  if (oldField.length > 120 || !/^[A-Za-z_$][\w$]*$/.test(oldField))
    throw new Error('The old field cannot be edited safely');
  const beforeCalls = parseStaticHttpCalls(evidence.file, source);
  const beforeMatches = beforeCalls.filter(call => call.line === evidence.line
    && call.endpoint === evidence.endpoint && call.origin === evidence.origin);
  if (beforeMatches.length !== 1 || !beforeMatches[0].fieldsComplete
    || JSON.stringify(beforeMatches[0].fields) !== JSON.stringify(evidence.fields))
    throw new Error('Source no longer matches the pinned finding');
  let syntax: Node;
  try { syntax = parse(source, { sourceType: 'unambiguous', plugins: ['typescript', 'jsx'] }) as Node; }
  catch { throw new Error('Source could not be parsed'); }
  const stack: Node[] = [syntax];
  const bodies: Node[] = [];
  let visited = 0;
  while (stack.length && visited++ < 100_000) {
    const node = stack.pop()!;
    const body = matchingBody(node, evidence, schema.method, schema.path);
    if (body) bodies.push(body);
    for (const [key, value] of Object.entries(node)) {
      if (key === 'loc' || key === 'tokens' || key === 'comments' || key === 'extra') continue;
      if (Array.isArray(value)) {
        for (const child of value)
          if (child && typeof child === 'object' && typeof child.type === 'string') stack.push(child);
      } else if (value && typeof value === 'object' && typeof value.type === 'string') stack.push(value);
    }
  }
  if (stack.length || bodies.length !== 1) throw new Error('Could not isolate one request body');
  const entries = bodies[0].properties as Node[];
  if (entries.length > 100 || entries.some(entry => keyName(entry) === null))
    throw new Error('The request body has dynamic or unsupported keys');
  const names = entries.map(keyName);
  if (names.filter(name => name === oldField).length !== 1 || names.includes(newField)
    || new Set(names).size !== names.length) throw new Error('Request keys cannot be renamed unambiguously');
  const hit = entries.find(entry => keyName(entry) === oldField)!;
  const key = hit.key as Node;
  if (!Number.isSafeInteger(key.start) || !Number.isSafeInteger(key.end)) throw new Error('Source location is missing');
  const replacement = hit.shorthand ? `${newField}: ${oldField}`
    : key.type === 'StringLiteral' ? JSON.stringify(newField) : newField;
  const afterSource = source.slice(0, key.start) + replacement + source.slice(key.end);
  if (afterSource.length > 64_000) throw new Error('Repair exceeds source size limit');
  const afterCalls = parseStaticHttpCalls(evidence.file, afterSource);
  if (afterCalls.length !== beforeCalls.length) throw new Error('Repair changed call inventory unexpectedly');
  const repaired = afterCalls.filter(call => call.line === evidence.line
    && call.endpoint === evidence.endpoint && call.origin === evidence.origin);
  if (repaired.length !== 1 || !repaired[0].fieldsComplete || repaired[0].fields.includes(oldField)
    || !schema.required.every(field => repaired[0].fields.includes(field)))
    throw new Error('Repaired request does not satisfy the current contract');
  return { file: evidence.file, line: key.loc?.start?.line || evidence.line,
    oldField, newField, before: source.slice(key.start, key.end), after: replacement,
    afterSource, staticVerified: true as const, runtimeVerified: false as const,
    note: 'The edited request contains the current operation’s required field names. Field meaning and runtime behavior still need a customer test.' };
}
