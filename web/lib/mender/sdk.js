// Generates a small TypeScript client from an OpenAPI 3 or Swagger 2 description: a type for
// every named schema and one typed function per endpoint. It is a starting point for the people
// who call an API (what SDK generators such as Stainless or Fern do in full), not a full SDK:
// JSON bodies only, no pagination helpers, no retries.
//
//   generateClient(spec) → TypeScript source as a string

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'];
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const RESERVED = new Set(['break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'let', 'static', 'implements', 'interface', 'package', 'private', 'protected', 'public', 'await']);
const MAX_DEPTH = 6;

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const words = (text) => String(text).replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean);
const pascal = (text) => words(text).map((word) => word[0].toUpperCase() + word.slice(1)).join('') || 'Unnamed';
const camel = (text) => { const name = pascal(text); return name[0].toLowerCase() + name.slice(1); };
const key = (name) => (IDENTIFIER.test(name) ? name : JSON.stringify(name));
const comment = (text) => String(text ?? '').replace(/\*\//g, '* /').split('\n')[0].slice(0, 160).trim();

function pointer(spec, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return undefined;
  return ref.slice(2).split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~')).reduce((node, part) => node?.[part], spec);
}

// Names for every reusable schema: "#/components/schemas/full-repository" → FullRepository.
function namedSchemas(spec) {
  const found = new Map();
  const taken = new Set(['ApiError', 'ClientOptions', 'Client']);
  const add = (prefix, schemas) => {
    for (const name of Object.keys(schemas ?? {})) {
      let typeName = pascal(name);
      if (/^[0-9]/.test(typeName)) typeName = `Schema${typeName}`;
      while (taken.has(typeName)) typeName = `${typeName}Type`;
      taken.add(typeName);
      found.set(`${prefix}${name.replace(/~/g, '~0').replace(/\//g, '~1')}`, typeName);
    }
  };
  add('#/components/schemas/', spec?.components?.schemas);
  add('#/definitions/', spec?.definitions);
  return found;
}

function makeTyper(spec, names) {
  const typeOf = (schema, depth = 0) => {
    if (!isRecord(schema)) return 'unknown';
    if (typeof schema.$ref === 'string') return names.get(schema.$ref) ?? (depth < MAX_DEPTH ? typeOf(pointer(spec, schema.$ref), depth + 1) : 'unknown');
    if (depth > MAX_DEPTH) return 'unknown';
    const orNull = (text) => (schema.nullable || (Array.isArray(schema.type) && schema.type.includes('null')) ? `${text} | null` : text);
    if (Array.isArray(schema.allOf)) return orNull(schema.allOf.map((part) => `(${typeOf(part, depth + 1)})`).join(' & ') || 'unknown');
    const options = schema.oneOf ?? schema.anyOf;
    if (Array.isArray(options)) return orNull([...new Set(options.map((part) => typeOf(part, depth + 1)))].join(' | ') || 'unknown');
    if (Array.isArray(schema.enum) && schema.enum.length) return orNull(schema.enum.map((value) => JSON.stringify(value)).join(' | '));
    const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type ?? (schema.properties ? 'object' : schema.items ? 'array' : undefined);
    switch (type) {
      case 'string': return orNull(schema.format === 'binary' ? 'Blob' : 'string');
      case 'integer':
      case 'number': return orNull('number');
      case 'boolean': return orNull('boolean');
      case 'array': return orNull(`Array<${typeOf(schema.items, depth + 1)}>`);
      case 'object': {
        const required = new Set(schema.required ?? []);
        const fields = Object.entries(schema.properties ?? {}).map(([name, child]) => {
          const note = isRecord(child) && child.description ? `/** ${comment(child.description)} */ ` : '';
          return `${note}${key(name)}${required.has(name) ? '' : '?'}: ${typeOf(child, depth + 1)};`;
        });
        const extra = schema.additionalProperties;
        // Any other key: `| undefined` so it also fits the optional fields listed above.
        if (extra === true || isRecord(extra)) fields.push(`[key: string]: ${extra === true ? 'unknown' : `${typeOf(extra, depth + 1)} | undefined`};`);
        return orNull(fields.length ? `{ ${fields.join(' ')} }` : 'Record<string, unknown>');
      }
      default: return 'unknown';
    }
  };
  return typeOf;
}

const resolve = (spec, node) => {
  let current = node;
  for (let i = 0; i < 10 && isRecord(current) && typeof current.$ref === 'string'; i++) current = pointer(spec, current.$ref);
  return isRecord(current) ? current : {};
};

function jsonSchemaIn(spec, content) {
  if (!isRecord(content)) return undefined;
  const type = Object.keys(content).find((t) => /json/i.test(t));
  return type ? content[type]?.schema : undefined;
}

// Everything a generated function needs to know about one endpoint.
function operationsOf(spec) {
  const swagger2 = typeof spec?.swagger === 'string';
  const out = [];
  for (const [path, rawItem] of Object.entries(spec?.paths ?? {})) {
    const item = resolve(spec, rawItem);
    for (const method of METHODS) {
      const op = item[method];
      if (!isRecord(op)) continue;
      const parameters = [...(item.parameters ?? []), ...(op.parameters ?? [])].map((p) => resolve(spec, p)).filter((p) => p.name && p.in);
      let body;
      if (swagger2) body = parameters.find((p) => p.in === 'body')?.schema;
      else if (op.requestBody) body = jsonSchemaIn(spec, resolve(spec, op.requestBody).content);
      let answer;
      const codes = Object.keys(op.responses ?? {}).filter((code) => /^2/.test(code)).sort();
      for (const code of codes) {
        const response = resolve(spec, op.responses[code]);
        answer = swagger2 ? response.schema : jsonSchemaIn(spec, response.content);
        if (answer) break;
      }
      out.push({
        method: method.toUpperCase(),
        path,
        operationId: op.operationId,
        summary: op.summary ?? op.description,
        deprecated: Boolean(op.deprecated),
        params: parameters.filter((p) => p.in === 'path' || p.in === 'query'),
        body,
        bodyRequired: swagger2 ? Boolean(parameters.find((p) => p.in === 'body')?.required) : Boolean(resolve(spec, op.requestBody ?? {}).required),
        answer,
      });
    }
  }
  return out;
}

export function generateClient(spec) {
  const names = namedSchemas(spec);
  const typeOf = makeTyper(spec, names);
  const title = spec?.info?.title ?? 'API';
  const version = spec?.info?.version ?? '';
  const lines = [
    `// TypeScript client for ${comment(title)}${version ? ` ${comment(version)}` : ''}, generated by API Mender (apimender.com).`,
    '// A starting point: JSON requests and answers, one function per endpoint. Regenerate it when the API changes.',
    '/* eslint-disable */',
    '',
    'export class ApiError extends Error {',
    '  readonly status: number;',
    '  readonly body: unknown;',
    '  constructor(status: number, body: unknown) {',
    '    super(`The API answered ${status}`);',
    '    this.status = status;',
    '    this.body = body;',
    '  }',
    '}',
    '',
    'export type ClientOptions = { baseUrl: string; headers?: Record<string, string>; fetch?: typeof fetch };',
    '',
  ];
  for (const [ref, typeName] of names) {
    const schema = pointer(spec, ref);
    if (isRecord(schema) && schema.description) lines.push(`/** ${comment(schema.description)} */`);
    // A schema that only points at another one becomes an alias of it.
    lines.push(`export type ${typeName} = ${typeOf(isRecord(schema) ? schema : {}, 1)};`);
  }
  lines.push(
    '',
    'export function createClient(options: ClientOptions) {',
    '  const call = options.fetch ?? fetch;',
    '  async function send<T>(method: string, path: string, query: Record<string, unknown>, body?: unknown): Promise<T> {',
    "    const url = new URL(options.baseUrl.replace(/\\/$/, '') + path);",
    '    for (const [name, value] of Object.entries(query)) {',
    '      if (value === undefined || value === null) continue;',
    '      for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(name, String(item));',
    '    }',
    "    const headers: Record<string, string> = { accept: 'application/json', ...options.headers };",
    "    if (body !== undefined) headers['content-type'] = 'application/json';",
    '    const response = await call(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });',
    '    const text = await response.text();',
    '    let data: unknown = text;',
    '    try { data = text ? JSON.parse(text) : undefined; } catch { /* not JSON: keep the text */ }',
    '    if (!response.ok) throw new ApiError(response.status, data);',
    '    return data as T;',
    '  }',
    '',
    '  return {',
  );
  const used = new Set();
  for (const op of operationsOf(spec)) {
    let name = camel(op.operationId ?? `${op.method.toLowerCase()} ${op.path.replace(/[{}]/g, '')}`);
    if (!IDENTIFIER.test(name) || RESERVED.has(name)) name = `call${pascal(name)}`;
    while (used.has(name)) name = `${name}Again`;
    used.add(name);
    const required = (p) => p.in === 'path' || p.required;
    const fields = op.params.map((p) => `${key(p.name)}${required(p) ? '' : '?'}: ${typeOf(p.schema ?? p)};`);
    if (op.body) fields.push(`body${op.bodyRequired ? '' : '?'}: ${typeOf(op.body)};`);
    const anyRequired = op.params.some(required) || (op.body && op.bodyRequired);
    const argument = fields.length ? `params: { ${fields.join(' ')} }${anyRequired ? '' : ' = {}'}` : '';
    const address = '`' + op.path.replace(/`/g, '\\`').replace(/\$\{/g, '\\${').replace(/\{([^}]+)\}/g, (_, param) => `\${encodeURIComponent(String(params[${JSON.stringify(param)}]))}`) + '`';
    const query = `{ ${op.params.filter((p) => p.in === 'query').map((p) => `${key(p.name)}: params[${JSON.stringify(p.name)}]`).join(', ')} }`;
    const answer = op.answer ? typeOf(op.answer) : op.method === 'DELETE' || op.method === 'HEAD' ? 'void' : 'unknown';
    const docs = [op.summary && comment(op.summary), `${op.method} ${op.path}`, op.deprecated && '@deprecated'].filter(Boolean).join(' · ');
    lines.push(`    /** ${docs} */`);
    lines.push(`    ${name}: (${argument}): Promise<${answer}> => send<${answer}>(${JSON.stringify(op.method)}, ${address}, ${query}${op.body ? ', params.body' : ''}),`);
  }
  lines.push('  };', '}', '', 'export type Client = ReturnType<typeof createClient>;', '');
  return lines.join('\n');
}
