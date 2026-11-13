// Calls made through official provider SDKs in JavaScript and TypeScript:
//
//   const stripe = new Stripe(key, { apiVersion: '2024-06-20' });
//   await stripe.customers.create({ email, name });          → POST /v1/customers
//   await octokit.rest.issues.create({ owner, repo, title }); → POST /repos/{}/{}/issues
//   await octokit.request('POST /repos/{owner}/{repo}/issues', { owner, repo, title });
//   await openai.chat.completions.create({ model, messages }); → POST /v1/chat/completions
//   await client.messages.create({ to, from, body });          → POST /2010-04-01/Accounts/{}/Messages.json
//
// A client is recognised only when its binding comes from the provider's own
// package (an import or require in the same file, or a client another
// scanned file exports). The method chain is looked up in tables generated
// from the SDK sources; unknown chains are not guessed. Repository content is
// parsed, never run.
import { parse } from '@babel/parser';
import type { ApiCall, ProviderAdapter } from '../types.ts';
import { getProvider } from '../providers/registry.ts';
import { sdkMethods, type SdkMethod } from './methods.generated.ts';
import { twilioMethods } from './twilio.ts';

export type Node = { type?: string; loc?: { start?: { line?: number }; end?: { line?: number } }; [key: string]: any };

type Sdk = {
  provider: string;
  /** package → exported names that construct (or, `call`, are called to make) a client. */
  packages: Record<string, { classes?: string[]; factories?: string[]; defaultIs?: 'class' | 'callable' | 'both' }>;
  methods: Record<string, SdkMethod[]>;
  /** Chain prefixes the SDK accepts in front of a method (Octokit's `rest.`). */
  prefixes?: RegExp;
  /** Request-object keys that are SDK options, not request properties. */
  optionKeys?: string[];
  /** Client option that moves the base URL away from the provider origin. */
  baseUrlOption?: string;
  /** Client option holding the API version pin, sent as the provider's version header. */
  versionOption?: string;
  /** Client options that can add default request headers. */
  headerOptions?: string[];
};

const sdks: Sdk[] = [
  { provider: 'github-rest',
    packages: { '@octokit/rest': { classes: ['Octokit'] }, octokit: { classes: ['Octokit'] }, '@octokit/core': { classes: ['Octokit'] },
      '@actions/github': { factories: ['getOctokit'] } },
    methods: sdkMethods['github-rest'], prefixes: /^rest\./, optionKeys: ['headers', 'mediaType', 'request', 'baseUrl'],
    baseUrlOption: 'baseUrl', headerOptions: ['request', 'headers', 'previews', 'userAgent'] },
  { provider: 'stripe', packages: { stripe: { classes: ['Stripe'], defaultIs: 'both' } }, methods: sdkMethods.stripe,
    baseUrlOption: 'host', versionOption: 'apiVersion' },
  { provider: 'openai', packages: { openai: { classes: ['OpenAI'], defaultIs: 'class' } }, methods: sdkMethods.openai,
    baseUrlOption: 'baseURL', headerOptions: ['defaultHeaders'] },
  { provider: 'twilio', packages: { twilio: { classes: ['Twilio'], defaultIs: 'callable' } }, methods: twilioMethods,
    prefixes: /^(api\.(v2010\.)?)?(accounts\(\)\.)?/, optionKeys: [] },
];

type Binding = { sdk: Sdk; kind: 'class' | 'callable' | 'factory' | 'namespace' };
type Client = { sdk: Sdk; headers: Record<string, string>; headersComplete: boolean };
/** Clients other files export, by module path without extension, then export name. */
export type SharedClients = Map<string, Map<string, string>>;

export function unwrap(node: Node | undefined): Node | undefined {
  while (node && ['TSAsExpression', 'TSTypeAssertion', 'TSNonNullExpression', 'ParenthesizedExpression', 'TSSatisfiesExpression', 'AwaitExpression'].includes(node.type || '')) node = node.argument ?? node.expression;
  return node;
}

function literal(node: Node | undefined): string | null {
  node = unwrap(node);
  if (node?.type === 'StringLiteral') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions?.length === 0) return node.quasis?.[0]?.value?.cooked ?? null;
  return null;
}

function keyOf(node: Node): string | null {
  if (node.type !== 'ObjectProperty' && node.type !== 'ObjectMethod') return null;
  if (node.key?.type === 'Identifier' && !node.computed) return node.key.name;
  return literal(node.key);
}

function requireOf(node: Node | undefined): string | null {
  node = unwrap(node);
  return node?.type === 'CallExpression' && node.callee?.type === 'Identifier' && node.callee.name === 'require'
    && node.arguments?.length === 1 ? literal(node.arguments[0]) : null;
}

const sdkFor = (pkg: string | null) => (pkg ? sdks.find(sdk => Object.hasOwn(sdk.packages, pkg)) : undefined);

/** A cheap text test: could this file use a provider SDK at all? */
export function mentionsSdk(source: string): boolean {
  return /['"](@octokit\/(rest|core)|octokit|@actions\/github|stripe|openai|twilio)['"]/.test(source);
}

// Module-level names bound to SDK packages: imports and requires.
function packageBindings(nodes: Node[]): Map<string, Binding> {
  const bindings = new Map<string, Binding>();
  const bindNamed = (sdk: Sdk, pkg: string, imported: string, local: string) => {
    const shape = sdk.packages[pkg];
    if (imported === 'default') {
      if (shape.defaultIs) bindings.set(local, { sdk, kind: shape.defaultIs === 'callable' ? 'callable' : 'class' });
      else bindings.set(local, { sdk, kind: 'namespace' });
    } else if (shape.classes?.includes(imported)) bindings.set(local, { sdk, kind: 'class' });
    else if (shape.factories?.includes(imported)) bindings.set(local, { sdk, kind: 'factory' });
  };
  for (const node of nodes) {
    if (node.type === 'ImportDeclaration') {
      const pkg = literal(node.source);
      const sdk = sdkFor(pkg);
      if (!sdk || !pkg || node.importKind === 'type') continue;
      for (const spec of node.specifiers || []) {
        if (spec.importKind === 'type') continue;
        if (spec.type === 'ImportDefaultSpecifier') bindNamed(sdk, pkg, 'default', spec.local.name);
        else if (spec.type === 'ImportNamespaceSpecifier') bindings.set(spec.local.name, { sdk, kind: 'namespace' });
        else if (spec.type === 'ImportSpecifier') bindNamed(sdk, pkg, spec.imported?.name ?? literal(spec.imported) ?? '', spec.local.name);
      }
    }
    if (node.type === 'VariableDeclarator') {
      const pkg = requireOf(node.init);
      const sdk = sdkFor(pkg);
      if (!sdk || !pkg) continue;
      if (node.id?.type === 'Identifier') bindNamed(sdk, pkg, 'default', node.id.name);
      if (node.id?.type === 'ObjectPattern')
        for (const property of node.id.properties || []) {
          const name = keyOf(property);
          if (name && property.value?.type === 'Identifier') bindNamed(sdk, pkg, name === 'default' ? 'default' : name, property.value.name);
        }
    }
  }
  return bindings;
}

// What a constructor or factory expression makes, when it makes a client.
function clientFrom(init: Node | undefined, bindings: Map<string, Binding>): Client | null {
  init = unwrap(init);
  if (!init || (init.type !== 'NewExpression' && init.type !== 'CallExpression')) return null;
  const callee = unwrap(init.callee);
  let sdk: Sdk | undefined;
  let optionsAt = 0;
  if (callee?.type === 'Identifier') {
    const binding = bindings.get(callee.name);
    if (binding && (binding.kind === 'class' || (init.type === 'CallExpression' && (binding.kind === 'callable' || binding.kind === 'factory'))
      || (init.type === 'NewExpression' && binding.kind === 'callable'))) sdk = binding.sdk;
  } else if (callee?.type === 'MemberExpression' && !callee.computed && callee.object?.type === 'Identifier') {
    const binding = bindings.get(callee.object.name);
    const name = callee.property?.name;
    const shape = binding && Object.values(binding.sdk.packages).find(item => item.classes?.includes(name) || item.factories?.includes(name));
    if (binding?.kind === 'namespace' || (binding && shape)) sdk = shape ? binding.sdk : undefined;
  } else if (init.type === 'CallExpression' && requireOf(callee)) {
    // require('stripe')(key)
    const pkg = requireOf(callee);
    const found = sdkFor(pkg);
    if (found && pkg && found.packages[pkg].defaultIs && found.packages[pkg].defaultIs !== 'class') sdk = found;
  }
  if (!sdk) return null;
  // Stripe and Twilio take credentials first, options after.
  const args = (init.arguments || []).map((arg: Node) => unwrap(arg));
  optionsAt = args.findIndex((arg: Node | undefined) => arg?.type === 'ObjectExpression');
  const options = optionsAt >= 0 ? args[optionsAt] : undefined;
  const headers: Record<string, string> = {};
  let headersComplete = true;
  const provider = getProvider(sdk.provider);
  for (const property of (options?.properties || []) as Node[]) {
    const name = keyOf(property);
    if (name === null) { headersComplete = false; continue; }
    if (name === sdk.baseUrlOption) {
      // A client pointed at another host is not this provider.
      const value = literal(property.value);
      if (value === null || !provider?.origins.some(origin => value.replace(/\/+$/, '').startsWith(origin))) return null;
    }
    if (name === sdk.versionOption && provider?.versionHeader) {
      const value = literal(property.value);
      if (value === null) headersComplete = false;
      else headers[provider.versionHeader] = value;
    }
    if (sdk.headerOptions?.includes(name)) headersComplete = false;
  }
  if (args.length > (optionsAt >= 0 ? optionsAt + 1 : args.length)) headersComplete = false;
  return { sdk, headers, headersComplete };
}

// `client.a.b(x).c` → { root: 'client', chain: 'a.b().c' }. `this.stripe.x` roots at 'this.stripe'.
function chainOf(callee: Node | undefined): { root: string; steps: string[]; stepCalls: Node[] } | null {
  const steps: string[] = [];
  const stepCalls: Node[] = [];
  let node = unwrap(callee);
  for (let depth = 0; depth < 12 && node; depth++) {
    if (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') {
      if (node.computed || node.property?.type !== 'Identifier') return null;
      const object = unwrap(node.object);
      if (object?.type === 'ThisExpression') return { root: `this.${node.property.name}`, steps: steps.reverse(), stepCalls };
      steps.push(node.property.name);
      node = object;
    } else if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') {
      // A resource accessor such as messages(sid): marked on the step before it.
      const inner = unwrap(node.callee);
      if (inner?.type !== 'MemberExpression' || inner.computed || inner.property?.type !== 'Identifier') return null;
      steps.push(`${inner.property.name}()`);
      stepCalls.push(node);
      node = unwrap(inner.object);
    } else if (node.type === 'Identifier') {
      return { root: node.name, steps: steps.reverse(), stepCalls };
    } else return null;
  }
  return null;
}

// Own keys only: a chain such as `hasOwnProperty` must not reach Object.prototype.
const lookup = (table: Record<string, SdkMethod[]>, key: string) => (Object.hasOwn(table, key) ? table[key] : undefined);

const pascal = (name: string) => name.replace(/_+$/, '').replace(/(^|_)([a-z0-9])/g, (_, __, c) => c.toUpperCase());

export type SdkCallDescription = {
  provider: ProviderAdapter;
  node: Node;
  chain: string;
  endpoint: string;
  /** The request object passed to the method, when there is one. */
  params?: Node;
  /** Keys of `params` that fill path parameters or SDK options. */
  ignoredKeys: string[];
  headers?: Record<string, string>;
  headersComplete: boolean;
};

type Context = { bindings: Map<string, Binding>; clients: Map<string, Client> };

/**
 * Bindings and clients for one parsed file. `nodes` is every node of the
 * file; `shared` lists clients exported by other scanned files.
 */
export function sdkContext(file: string, nodes: Node[], shared?: SharedClients, assumed?: { root: string; providerId: string }): Context {
  const bindings = packageBindings(nodes);
  const clients = new Map<string, Client>();
  // A client a finding already attributed (built in another file).
  const assumedSdk = assumed && sdks.find(item => item.provider === assumed.providerId);
  if (assumed && assumedSdk && /^(this\.)?[A-Za-z_$][\w$]*$/.test(assumed.root)) clients.set(assumed.root, { sdk: assumedSdk, headers: {}, headersComplete: false });
  for (const node of nodes) {
    if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier') {
      const client = clientFrom(node.init, bindings);
      if (client) clients.set(node.id.name, client);
    }
    // this.stripe = new Stripe(...) and class fields stripe = new Stripe(...)
    if (node.type === 'AssignmentExpression' && node.left?.type === 'MemberExpression' && unwrap(node.left.object)?.type === 'ThisExpression'
      && node.left.property?.type === 'Identifier') {
      const client = clientFrom(node.right, bindings);
      if (client) clients.set(`this.${node.left.property.name}`, client);
    }
    if ((node.type === 'ClassProperty' || node.type === 'PropertyDefinition') && node.key?.type === 'Identifier') {
      const client = clientFrom(node.value, bindings);
      if (client) clients.set(`this.${node.key.name}`, client);
    }
  }
  if (shared?.size) {
    for (const node of nodes) {
      if (node.type !== 'ImportDeclaration') continue;
      const exports = shared.get(resolveModule(file, literal(node.source) ?? '') ?? '');
      if (!exports) continue;
      for (const spec of node.specifiers || []) {
        const name = spec.type === 'ImportDefaultSpecifier' ? 'default' : spec.imported?.name;
        const providerId = name && exports.get(name);
        const sdk = providerId && sdks.find(item => item.provider === providerId);
        // Headers set where the client was built are not visible here.
        if (sdk) clients.set(spec.local.name, { sdk, headers: {}, headersComplete: false });
      }
    }
  }
  return { bindings, clients };
}

/** Clients this file exports (`export const stripe = new Stripe(...)`, `export default new OpenAI()`). */
export function exportedClients(nodes: Node[]): Map<string, string> {
  const bindings = packageBindings(nodes);
  const exported = new Map<string, string>();
  const local = new Map<string, string>();
  for (const node of nodes) {
    if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier') {
      const client = clientFrom(node.init, bindings);
      if (client) local.set(node.id.name, client.sdk.provider);
    }
  }
  for (const node of nodes) {
    if (node.type === 'ExportNamedDeclaration') {
      for (const declarator of node.declaration?.declarations || []) {
        const provider = declarator.id?.type === 'Identifier' ? local.get(declarator.id.name) : undefined;
        if (provider) exported.set(declarator.id.name, provider);
      }
      for (const spec of node.specifiers || []) {
        const provider = spec.local?.type === 'Identifier' ? local.get(spec.local.name) : undefined;
        if (provider) exported.set(spec.exported?.name ?? spec.local.name, provider);
      }
    }
    if (node.type === 'ExportDefaultDeclaration') {
      const declaration = unwrap(node.declaration);
      const provider = declaration?.type === 'Identifier' ? local.get(declaration.name) : clientFrom(declaration, bindings)?.sdk.provider;
      if (provider) exported.set('default', provider);
    }
  }
  return exported;
}

// './lib/stripe' from 'src/pay/checkout.ts' → 'src/pay/lib/stripe'. Only relative specifiers.
export function resolveModule(file: string, specifier: string): string | null {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return null;
  const parts = file.split('/').slice(0, -1);
  for (const part of specifier.split('/')) {
    if (part === '.' || part === '') continue;
    if (part === '..') { if (!parts.length) return null; parts.pop(); } else parts.push(part);
  }
  return parts.join('/').replace(/\.[cm]?[jt]sx?$/, '').replace(/\/index$/, '');
}

export function moduleKey(file: string): string {
  return file.replace(/\.[cm]?[jt]sx?$/, '').replace(/\/index$/, '');
}

/** Describes one call expression when it is a recognised SDK method call. */
export function describeSdkCall(node: Node, context: Context): SdkCallDescription | null {
  if (node.type !== 'CallExpression' && node.type !== 'OptionalCallExpression') return null;
  const found = chainOf(node.callee);
  if (!found || !found.steps.length) return null;
  const client = context.clients.get(found.root);
  if (!client) return null;
  const { sdk } = client;
  const provider = getProvider(sdk.provider);
  if (!provider) return null;
  const args = ((node.arguments || []) as Node[]).map(arg => unwrap(arg));
  let chain = found.steps.join('.');
  let methods: SdkMethod[] | undefined;
  let endpoint: string | null = null;
  let params: Node | undefined;
  let pathKeys: string[] = [];
  // octokit.request('POST /repos/{owner}/{repo}/issues', params)
  if (sdk.provider === 'github-rest' && (chain === 'request' || chain === 'paginate')) {
    const route = literal(args[0]);
    const reference = chain === 'paginate' && !route ? chainOf(args[0]) : null;
    if (route && /^(GET|POST|PUT|PATCH|DELETE|HEAD) \/\S*$/.test(route)) {
      endpoint = route.replace(/\{[^}]+\}/g, '{}');
      pathKeys = [...route.matchAll(/\{([^}]+)\}/g)].map(match => match[1]);
      params = args[1];
    } else if (reference && reference.root === found.root) {
      chain = reference.steps.join('.').replace(sdk.prefixes ?? /^$/, '');
      methods = lookup(sdk.methods, chain);
      params = args[1];
    } else return null;
  } else {
    const normalized = sdk.prefixes ? chain.replace(sdk.prefixes, '') : chain;
    methods = lookup(sdk.methods, normalized);
    chain = normalized;
  }
  if (Array.isArray(methods) && methods.length) {
    // Leading string arguments fill path parameters; the next object is the request.
    const positional = args.findIndex(arg => arg?.type === 'ObjectExpression' || (arg?.type === 'Identifier' && !/(id|sid|ID|Id)$/.test(arg.name)));
    const leading = positional < 0 ? args.length : positional;
    const method = methods.find(item => item.p === leading) ?? (methods.length === 1 ? methods[0] : undefined);
    if (!method) return null;
    endpoint = method.e;
    pathKeys = method.k;
    params = args[method.p];
  }
  if (!endpoint) return null;
  const space = endpoint.indexOf(' ');
  const fullEndpoint = provider.basePath ? `${endpoint.slice(0, space)} ${provider.basePath}${endpoint.slice(space + 1)}` : endpoint;
  // Per-request headers (Octokit: { headers: { 'x-github-api-version': ... } }).
  let headers: Record<string, string> | undefined = Object.keys(client.headers).length ? { ...client.headers } : undefined;
  let headersComplete = client.headersComplete;
  if (params?.type === 'ObjectExpression') {
    const headerProperty = (params.properties as Node[]).find(item => keyOf(item) === 'headers');
    if (headerProperty) {
      const object = unwrap(headerProperty.value);
      if (object?.type !== 'ObjectExpression') headersComplete = false;
      else for (const item of object.properties as Node[]) {
        const name = keyOf(item);
        const value = item.type === 'ObjectProperty' ? literal(item.value) : null;
        if (name === null || value === null) { headersComplete = false; continue; }
        (headers ??= {})[name.toLowerCase()] = value;
      }
    }
  } else if (params) headersComplete = false;
  return { provider, node, chain, endpoint: fullEndpoint, params, ignoredKeys: [...pathKeys, ...(sdk.optionKeys ?? [])], headers, headersComplete };
}

/** The ApiCall for a described SDK call. */
export function sdkApiCall(file: string, root: string, described: SdkCallDescription): ApiCall | null {
  const line = described.node.loc?.start?.line;
  const endLine = described.node.loc?.end?.line;
  if (typeof line !== 'number') return null;
  const params = described.params;
  let fields: string[] = [];
  let fieldsComplete = true;
  if (params?.type === 'ObjectExpression') {
    for (const property of params.properties as Node[]) {
      const name = keyOf(property);
      if (name === null || property.type !== 'ObjectProperty') { fieldsComplete = false; continue; }
      if (described.ignoredKeys.includes(name)) continue;
      fields.push(described.provider.fieldCase === 'pascal' ? pascal(name) : name);
    }
  } else if (params) fieldsComplete = false;
  fields = [...new Set(fields)].slice(0, 100);
  const origin = described.provider.origins[0];
  return {
    file, line, ...(typeof endLine === 'number' && endLine >= line ? { endLine } : {}),
    symbol: `${root}.${described.chain}`.slice(0, 120), endpoint: described.endpoint, origin,
    fields, fieldsComplete,
    ...(params?.loc?.start?.line ? { bodyLine: params.loc.start.line } : {}),
    ...(described.headers ? { headers: described.headers } : {}),
    headersComplete: described.headersComplete,
    sdk: described.chain,
  };
}

/** Every recognised SDK call in a parsed file. */
export function sdkCallsIn(file: string, nodes: Node[], shared?: SharedClients): ApiCall[] {
  const context = sdkContext(file, nodes, shared);
  if (!context.clients.size) return [];
  const calls: ApiCall[] = [];
  for (const node of nodes) {
    if (calls.length >= 200) break;
    const described = describeSdkCall(node, context);
    if (!described) continue;
    const root = chainOf(node.callee)?.root ?? 'client';
    const call = sdkApiCall(file, root, described);
    if (call) calls.push(call);
  }
  return calls;
}

/** Every node of a JS/TS file (bounded), or null when it does not parse. */
export function parseNodes(source: string): Node[] | null {
  let syntax: Node;
  try { syntax = parse(source, { sourceType: 'unambiguous', plugins: ['typescript', 'jsx'], errorRecovery: false }) as Node; }
  catch { return null; }
  const nodes: Node[] = [];
  const stack: Node[] = [syntax];
  while (stack.length && nodes.length < 100_000) {
    const node = stack.pop()!;
    nodes.push(node);
    for (const [key, value] of Object.entries(node)) {
      if (key === 'loc' || key === 'tokens' || key === 'comments' || key === 'extra' || key === 'leadingComments' || key === 'trailingComments') continue;
      if (Array.isArray(value)) {
        for (const child of value) if (child && typeof child === 'object' && typeof child.type === 'string') stack.push(child);
      } else if (value && typeof value === 'object' && typeof value.type === 'string') stack.push(value);
    }
  }
  return nodes;
}

const relativeImport = /(from\s*|require\s*\(\s*|import\s*\(\s*)['"]\.\.?\//;

/** SDK calls in one JS/TS file's source. */
export function parseSdkCalls(file: string, source: string, shared?: SharedClients): ApiCall[] {
  if (!mentionsSdk(source) && !(shared?.size && relativeImport.test(source))) return [];
  const nodes = parseNodes(source);
  return nodes ? sdkCallsIn(file, nodes, shared) : [];
}

/** Clients one JS/TS file exports, for SharedClients. */
export function sdkClientExports(source: string): Map<string, string> {
  if (!mentionsSdk(source)) return new Map();
  const nodes = parseNodes(source);
  return nodes ? exportedClients(nodes) : new Map();
}
