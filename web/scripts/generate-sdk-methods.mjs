// Builds lib/engine/sdk/methods.generated.ts: for each catalog provider, the
// official SDK's client method chains and the HTTP operation each one calls.
// Read from the SDKs' own source, so a call such as
// `stripe.customers.create({...})` maps to `POST /v1/customers` exactly as the
// SDK sends it. Run by hand when an SDK adds methods:
//
//   node scripts/generate-sdk-methods.mjs --octokit DIR --stripe DIR --openai DIR
//
// DIRs are local clones of octokit/plugin-rest-endpoint-methods.js,
// stripe/stripe-node and openai/openai-node. Nothing here runs SDK code; the
// sources are parsed as text.
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parse } from '@babel/parser';

const { values } = parseArgs({ options: { octokit: { type: 'string' }, stripe: { type: 'string' }, openai: { type: 'string' },
  out: { type: 'string', default: new URL('../lib/engine/sdk/methods.generated.ts', import.meta.url).pathname } } });

const ts = file => parse(readFileSync(file, 'utf8'), { sourceType: 'module', plugins: ['typescript'], errorRecovery: true });
const camel = text => text.replace(/[-_]([a-z0-9])/g, (_, c) => c.toUpperCase());
const lowerFirst = text => text[0].toLowerCase() + text.slice(1);
const add = (table, chain, entry) => {
  const list = table[chain] ??= [];
  if (!list.some(item => item.e === entry.e && item.p === entry.p)) list.push(entry);
};

// Template literal or path`...` → '/x/{}/y' plus the identifiers used in it.
function templatePath(node) {
  if (node?.type === 'StringLiteral') return { path: node.value, names: [] };
  const template = node?.type === 'TaggedTemplateExpression' ? node.quasi : node?.type === 'TemplateLiteral' ? node : null;
  if (!template) return null;
  const names = template.expressions.map(expression => {
    let inner = expression;
    if (inner.type === 'CallExpression') inner = inner.arguments[0];
    if (inner?.type === 'MemberExpression' && !inner.computed) return inner.property.name;
    return inner?.type === 'Identifier' ? inner.name : null;
  });
  return { path: template.quasis.map(quasi => quasi.value.cooked).join('{}'), names };
}

// ── Octokit: generated/endpoints.ts maps namespace.method → "METHOD /path".
function octokit(dir) {
  const table = {};
  const file = ts(join(dir, 'src/generated/endpoints.ts'));
  const declaration = file.program.body.find(node => node.type === 'VariableDeclaration')?.declarations[0];
  for (const namespace of declaration.init.properties) {
    for (const method of namespace.value.properties) {
      const route = method.value.elements?.[0]?.value;
      if (typeof route !== 'string') continue;
      const pathKeys = [...route.matchAll(/\{([^}]+)\}/g)].map(match => match[1]);
      add(table, `${namespace.key.name}.${method.key.name ?? method.key.value}`, { e: route.replace(/\{[^}]+\}/g, '{}'), p: 0, k: pathKeys });
    }
  }
  return table;
}

// ── stripe-node: each resource class calls this._makeRequest(METHOD, path).
function stripe(dir) {
  const table = {};
  const root = join(dir, 'src');
  const registry = ts(join(root, 'resources.ts'));
  const fileOf = new Map(); // local import name → resource file
  for (const node of registry.program.body) {
    if (node.type === 'ImportDeclaration') for (const spec of node.specifiers) fileOf.set(spec.local.name, resolve(root, node.source.value.replace(/\.js$/, '.ts')));
  }
  const resources = []; // [chain prefix, file]
  for (const node of registry.program.body) {
    if (node.type === 'ExportNamedDeclaration' && node.source)
      for (const spec of node.specifiers) resources.push([lowerFirst(spec.exported.name), resolve(root, node.source.value.replace(/\.js$/, '.ts'))]);
    const declarator = node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'VariableDeclaration' ? node.declaration.declarations[0] : null;
    const call = declarator?.init;
    if (call?.type === 'CallExpression' && call.callee.name === 'resourceNamespace') {
      const prefix = call.arguments[0].value;
      for (const property of call.arguments[1].properties) {
        const file = property.value.type === 'Identifier' ? fileOf.get(property.value.name) : null;
        if (file) resources.push([`${prefix}.${lowerFirst(property.key.name)}`, file]);
      }
    }
  }
  for (const [prefix, file] of resources) {
    if (!existsSync(file)) continue;
    for (const node of ts(file).program.body) {
      const klass = node.type === 'ExportNamedDeclaration' ? node.declaration : node;
      if (klass?.type !== 'ClassDeclaration') continue;
      for (const method of klass.body.body) {
        if (method.type !== 'ClassMethod' || !method.body) continue;
        let request = null;
        walk(method.body, item => {
          if (!request && item.type === 'CallExpression' && item.callee.type === 'MemberExpression' && item.callee.property.name === '_makeRequest') request = item;
        });
        if (!request) continue;
        const verb = request.arguments[0]?.value;
        const path = templatePath(request.arguments[1]);
        if (!verb || !path) continue;
        const positional = method.params.filter(param => param.typeAnnotation?.typeAnnotation?.type === 'TSStringKeyword').length;
        add(table, `${prefix}.${method.key.name}`, { e: `${verb} ${path.path}`, p: positional, k: [] });
      }
    }
  }
  return table;
}

// ── openai-node: resource classes nest (client.chat.completions) and each
// method calls this._client.get/post/...(path).
function openai(dir) {
  const root = join(dir, 'src');
  const cache = new Map();
  const moduleOf = file => {
    const real = [file, `${file}.ts`, join(file, 'index.ts')].find(path => existsSync(path) && statSync(path).isFile());
    if (!real) return null;
    if (cache.has(real)) return cache.get(real);
    const syntax = ts(real);
    const info = { file: real, namespaces: new Map(), named: new Map(), classes: new Map(), reexports: [], starExports: [] };
    cache.set(real, info);
    for (const node of syntax.program.body) {
      if (node.type === 'ImportDeclaration') {
        const target = resolve(dirname(real), node.source.value);
        for (const spec of node.specifiers) {
          if (spec.type === 'ImportNamespaceSpecifier') info.namespaces.set(spec.local.name, target);
          else if (spec.type === 'ImportSpecifier') info.named.set(spec.local.name, [target, spec.imported.name]);
        }
      }
      if (node.type === 'ExportAllDeclaration') info.starExports.push(resolve(dirname(real), node.source.value));
      if (node.type === 'ExportNamedDeclaration' && node.source)
        for (const spec of node.specifiers) info.reexports.push([spec.exported.name, resolve(dirname(real), node.source.value), spec.local.name]);
      const klass = node.type === 'ExportNamedDeclaration' ? node.declaration : node;
      if (klass?.type === 'ClassDeclaration') info.classes.set(klass.id.name, klass);
    }
    return info;
  };
  const findClass = (file, name, depth = 0) => {
    const info = moduleOf(file);
    if (!info || depth > 6) return null;
    if (info.classes.has(name)) return [info, info.classes.get(name)];
    for (const [exported, target, local] of info.reexports) if (exported === name) return findClass(target, local, depth + 1);
    for (const target of info.starExports) { const hit = findClass(target, name, depth + 1); if (hit) return hit; }
    return null;
  };
  const table = {};
  const visit = (info, klass, chain, seen) => {
    if (seen.has(klass) || chain.length > 6) return;
    seen = new Set(seen).add(klass);
    for (const member of klass.body.body) {
      if (member.type === 'ClassProperty' && member.value?.type === 'NewExpression' && member.key.type === 'Identifier') {
        const callee = member.value.callee;
        let hit = null;
        if (callee.type === 'MemberExpression' && info.namespaces.has(callee.object.name)) hit = findClass(info.namespaces.get(callee.object.name), callee.property.name);
        else if (callee.type === 'Identifier' && info.named.has(callee.name)) hit = findClass(...info.named.get(callee.name));
        else if (callee.type === 'Identifier' && info.classes.has(callee.name)) hit = [info, info.classes.get(callee.name)];
        if (hit) visit(hit[0], hit[1], [...chain, member.key.name], seen);
      }
      if (member.type !== 'ClassMethod' || !member.body || chain.length === 0) continue;
      let request = null;
      walk(member.body, item => {
        if (request || item.type !== 'CallExpression' || item.callee.type !== 'MemberExpression') return;
        const object = item.callee.object;
        const verb = item.callee.property.name;
        if (object.type === 'MemberExpression' && object.property.name === '_client' && /^(get|post|put|patch|delete|getAPIList)$/.test(verb)) request = item;
      });
      if (!request) continue;
      const verb = request.callee.property.name === 'getAPIList' ? 'GET' : request.callee.property.name.toUpperCase();
      const path = templatePath(request.arguments[0]);
      if (!path) continue;
      const stringParams = member.params.filter(param => param.typeAnnotation?.typeAnnotation?.type === 'TSStringKeyword').map(param => param.name);
      const pathKeys = path.names.filter(name => name && !stringParams.includes(name));
      add(table, [...chain, member.key.name].join('.'), { e: `${verb} ${path.path.split('?')[0]}`, p: stringParams.length, k: pathKeys });
    }
  };
  const client = moduleOf(join(root, 'client.ts'));
  visit(client, client.classes.get('OpenAI'), [], new Set());
  return table;
}

function walk(node, visit) {
  const stack = [node];
  while (stack.length) {
    const item = stack.pop();
    visit(item);
    for (const [key, value] of Object.entries(item)) {
      if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue;
      if (Array.isArray(value)) for (const child of value) { if (child && typeof child.type === 'string') stack.push(child); }
      else if (value && typeof value.type === 'string') stack.push(value);
    }
  }
}

const sort = table => Object.fromEntries(Object.keys(table).sort().map(key => [key, table[key]]));
const tables = {};
if (values.octokit) tables['github-rest'] = sort(octokit(values.octokit));
if (values.stripe) tables.stripe = sort(stripe(values.stripe));
if (values.openai) tables.openai = sort(openai(values.openai));
for (const [id, table] of Object.entries(tables)) console.log(`${id}: ${Object.keys(table).length} method chains`);

const header = `// Generated by scripts/generate-sdk-methods.mjs from the official SDK sources.
// Do not edit by hand. Each chain maps to the operations it can call:
//   e: "METHOD /path" with path parameters written {}
//   p: leading positional string arguments that fill path parameters
//   k: request-object keys that fill path parameters (not body fields)
export type SdkMethod = { e: string; p: number; k: string[] };
export const sdkMethods: Record<string, Record<string, SdkMethod[]>> = `;
writeFileSync(values.out, `${header}${JSON.stringify(tables)};\n`);
