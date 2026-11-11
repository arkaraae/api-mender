// External API calls in Python source, read by a bounded tokenizer (the
// Worker has no Python parser and must never run repository code):
//
//   requests.post("https://api.github.com/repos/o/r/issues", json={"title": t}, headers={...})
//   httpx.Client(base_url="https://api.openai.com").post("/v1/files", ...)
//   client = OpenAI(); client.chat.completions.create(model=..., messages=...)
//   client = StripeClient(key); client.v1.customers.create(params={"email": e})
//   stripe.Customer.create(email=e)                      (legacy Stripe bindings)
//   client = Client(sid, token); client.messages.create(to=..., from_=..., body=...)
//
// Only literal https origins and recognised SDK clients are reported. Field
// names are known only when every keyword or dict key is literal. Findings in
// Python are never repairable: the repair gates parse JavaScript.
import type { ApiCall } from '../types.ts';
import { getProvider } from '../providers/registry.ts';
import { sdkMethods, type SdkMethod } from './methods.generated.ts';
import { twilioMethods } from './twilio.ts';

type Token = { t: 'name' | 'str' | 'num' | 'op'; v: string; line: number; fstring?: boolean };
const PARAM = '\u0000';
const NL = '\n';
const maxTokens = 200_000;

export function isPythonSource(path: string): boolean {
  return /\.py$/.test(path);
}

/** Cheap text test before tokenizing. */
export function mentionsPythonApi(source: string): boolean {
  return /\b(requests|httpx|aiohttp|openai|stripe|twilio|OpenAI|StripeClient)\b/.test(source) && /https:\/\/|import/.test(source);
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let depth = 0;
  const length = source.length;
  while (i < length && tokens.length < maxTokens) {
    const c = source[i];
    if (c === '\n') {
      // A logical line ends only outside brackets.
      if (depth === 0 && tokens.length && tokens[tokens.length - 1].v !== NL) tokens.push({ t: 'op', v: NL, line });
      line++; i++; continue;
    }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f') { i++; continue; }
    if (c === '\\' && source[i + 1] === '\n') { i += 2; line++; continue; }
    if (c === '#') { while (i < length && source[i] !== '\n') i++; continue; }
    // String, with optional prefix (r, b, u, f and combinations).
    const prefix = /^[rRbBuUfF]{0,2}(?=['"])/.exec(source.slice(i, i + 3))?.[0];
    if (prefix !== undefined && (source[i + prefix.length] === '"' || source[i + prefix.length] === "'")) {
      const start = line;
      const raw = /r/i.test(prefix);
      const fstring = /f/i.test(prefix);
      let j = i + prefix.length;
      const quote = source[j];
      const triple = source.slice(j, j + 3) === quote.repeat(3);
      const close = triple ? quote.repeat(3) : quote;
      j += close.length;
      let value = '';
      let depth = 0;
      while (j < length) {
        if (source.startsWith(close, j) && depth === 0) { j += close.length; break; }
        const d = source[j];
        if (d === '\n') { if (!triple) break; line++; }
        if (d === '\\' && !raw) { const next = source[j + 1]; value += next === 'n' ? '\n' : next === 't' ? '\t' : next ?? ''; if (next === '\n') line++; j += 2; continue; }
        if (fstring && d === '{') {
          if (source[j + 1] === '{' && depth === 0) { value += '{'; j += 2; continue; }
          if (depth === 0) value += PARAM;
          depth++; j++; continue;
        }
        if (fstring && d === '}') {
          if (depth === 0 && source[j + 1] === '}') { value += '}'; j += 2; continue; }
          if (depth > 0) { depth--; j++; continue; }
        }
        if (depth === 0) value += d;
        j++;
      }
      tokens.push({ t: 'str', v: value, line: start, ...(fstring ? { fstring: true } : {}) });
      i = j;
      continue;
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i, i + 128));
    if (name) { tokens.push({ t: 'name', v: name[0], line }); i += name[0].length; continue; }
    const number = /^\d[\d_.eExXa-fA-F]*/.exec(source.slice(i, i + 64));
    if (number) { tokens.push({ t: 'num', v: number[0], line }); i += number[0].length; continue; }
    const op = /^(\*\*|==|!=|<=|>=|->|:=|[-+*/%@&|^~<>()[\]{},:.;=])/.exec(source.slice(i, i + 2));
    const v = op ? op[0] : c;
    if (v === '(' || v === '[' || v === '{') depth++;
    else if ((v === ')' || v === ']' || v === '}') && depth > 0) depth--;
    tokens.push({ t: 'op', v, line });
    i += op ? op[0].length : 1;
  }
  return tokens;
}

// Partner index of every bracket, matched once in a linear pass, so
// argument and chain lookups never rescan the file.
function matchBrackets(tokens: Token[]): Int32Array {
  const partner = new Int32Array(tokens.length).fill(-1);
  const stack: number[] = [];
  for (let k = 0; k < tokens.length; k++) {
    if (tokens[k].t !== 'op') continue;
    const v = tokens[k].v;
    if (v === '(' || v === '[' || v === '{') stack.push(k);
    else if ((v === ')' || v === ']' || v === '}') && stack.length) { const open = stack.pop()!; partner[open] = k; partner[k] = open; }
  }
  return partner;
}
let partner: Int32Array = new Int32Array(0);
const closing = (_tokens: Token[], open: number) => partner[open] ?? -1;

type Arg = { name?: string; from: number; to: number; star?: boolean };

function argsOf(tokens: Token[], open: number, close: number): Arg[] {
  const args: Arg[] = [];
  let start = open + 1;
  let depth = 0;
  const push = (end: number) => {
    if (end <= start) return;
    const first = tokens[start];
    if (first.t === 'op' && (first.v === '*' || first.v === '**')) args.push({ from: start + 1, to: end, star: true });
    else if (first.t === 'name' && tokens[start + 1]?.t === 'op' && tokens[start + 1].v === '=' ) args.push({ name: first.v, from: start + 2, to: end });
    else args.push({ from: start, to: end });
  };
  for (let k = open + 1; k < close; k++) {
    const v = tokens[k].t === 'op' ? tokens[k].v : '';
    if (v === '(' || v === '[' || v === '{') depth++;
    else if (v === ')' || v === ']' || v === '}') depth--;
    else if (v === ',' && depth === 0) { push(k); start = k + 1; }
  }
  push(close);
  return args.slice(0, 50);
}

// Adjacent string tokens concatenate; anything else makes the value dynamic.
function stringValue(tokens: Token[], arg: Arg | undefined): string | null {
  if (!arg || arg.to <= arg.from) return null;
  let value = '';
  for (let k = arg.from; k < arg.to; k++) { if (tokens[k].t !== 'str') return null; value += tokens[k].v; }
  return value;
}

// Keys of a dict literal ({"a": 1}) or dict(a=1); null when any key is dynamic.
function dictKeys(tokens: Token[], arg: Arg | undefined): { keys: string[]; line: number; values: Map<string, string | null> } | null {
  if (!arg) return null;
  const first = tokens[arg.from];
  if (first?.t === 'op' && first.v === '{') {
    const end = closing(tokens, arg.from);
    if (end !== arg.to - 1) return null;
    const keys: string[] = [];
    const values = new Map<string, string | null>();
    for (const entry of argsOf(tokens, arg.from, end)) {
      if (entry.star || entry.name) return null;
      let colon = -1;
      for (let k = entry.from, depth = 0; k < entry.to; k++) {
        const v = tokens[k].t === 'op' ? tokens[k].v : '';
        if (v === '(' || v === '[' || v === '{') depth++;
        else if (v === ')' || v === ']' || v === '}') depth--;
        else if (v === ':' && depth === 0) { colon = k; break; }
      }
      if (colon < 0) return null;
      const key = stringValue(tokens, { from: entry.from, to: colon });
      if (key === null || tokens[entry.from].fstring) return null;
      keys.push(key);
      values.set(key, stringValue(tokens, { from: colon + 1, to: entry.to }));
    }
    return { keys, line: first.line, values };
  }
  if (first?.t === 'name' && first.v === 'dict' && tokens[arg.from + 1]?.v === '(') {
    const end = closing(tokens, arg.from + 1);
    if (end !== arg.to - 1) return null;
    const entries = argsOf(tokens, arg.from + 1, end);
    if (entries.some(entry => !entry.name)) return null;
    return { keys: entries.map(entry => entry.name!), line: first.line, values: new Map(entries.map(entry => [entry.name!, stringValue(tokens, entry)])) };
  }
  return null;
}

// Dotted name ending at token `end` (inclusive), allowing x(...) accessor steps.
function chainBefore(tokens: Token[], end: number): { root: string; steps: string[]; start: number } | null {
  const steps: string[] = [];
  let k = end;
  for (let guard = 0; guard < 12 && k >= 0; guard++) {
    const token = tokens[k];
    if (token.t === 'op' && token.v === ')') {
      // An accessor call such as messages(sid)
      const open = partner[k] ?? -1;
      if (open < 1 || tokens[open - 1].t !== 'name') return null;
      steps.push(`${tokens[open - 1].v}()`);
      k = open - 2;
    } else if (token.t === 'name') {
      steps.push(token.v);
      k -= 1;
    } else return null;
    if (k >= 0 && tokens[k].t === 'op' && tokens[k].v === '.') { k--; continue; }
    break;
  }
  const names = steps.reverse();
  if (!names.length || names[0].endsWith('()')) return null;
  // self.client.x → root 'self.client'
  if (names[0] === 'self' && names.length > 1 && !names[1].endsWith('()')) return { root: `self.${names[1]}`, steps: names.slice(2), start: k + 1 };
  return { root: names[0], steps: names.slice(1), start: k + 1 };
}

type PySdk = { provider: string; methods: Record<string, SdkMethod[]>; prefix?: RegExp };
type PyClient = { kind: 'http'; origin?: string } | { kind: 'sdk'; sdk: PySdk; headers: Record<string, string> } | { kind: 'stripe-module' };

const camelSteps = (chain: string) => chain.split('.').map(step => step.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase())).join('.');
const pascal = (name: string) => name.replace(/_+$/, '').replace(/(^|_)([a-z0-9])/g, (_, __, c) => c.toUpperCase());
const sdkOptionKwargs = new Set(['extra_headers', 'extra_query', 'extra_body', 'timeout', 'idempotency_key', 'stripe_account', 'stripe_version',
  'api_key', 'options', 'request_options', 'stream_options_override']);

const pySdks: Record<string, PySdk> = {
  openai: { provider: 'openai', methods: sdkMethods.openai },
  stripe: { provider: 'stripe', methods: sdkMethods.stripe, prefix: /^v1\./ },
  twilio: { provider: 'twilio', methods: twilioMethods, prefix: /^(api\.(v2010\.)?)?(accounts\(\)\.)?/ },
};

// Legacy stripe-python: stripe.Customer.create(...) → customers.create.
let legacyStripe: Map<string, string> | null = null;
function legacyStripeChain(steps: string[]): string | null {
  if (!legacyStripe) {
    legacyStripe = new Map();
    for (const chain of Object.keys(sdkMethods.stripe ?? {})) {
      const parts = chain.split('.');
      const resource = parts.at(-2);
      if (!resource) continue;
      const singular = resource.endsWith('ies') ? `${resource.slice(0, -3)}y` : /(ss|x|ch|sh)es$/.test(resource) ? resource.slice(0, -2) : resource.replace(/s$/, '');
      const key = [...parts.slice(0, -2), singular[0].toUpperCase() + singular.slice(1)].join('.');
      if (!legacyStripe.has(key)) legacyStripe.set(key, parts.slice(0, -1).join('.'));
    }
  }
  const method = steps.at(-1);
  const resource = legacyStripe.get(camelSteps(steps.slice(0, -1).join('.')));
  if (!method || !resource) return null;
  const mapped = method === 'modify' ? 'update' : method === 'delete' ? 'del' : method;
  return `${resource}.${mapped}`;
}

function endpointFromUrl(address: string): { origin: string; path: string } | null {
  if (address.length > 2048) return null;
  const literalPrefix = address.split(PARAM)[0];
  let origin: URL;
  try { origin = new URL(literalPrefix.length ? literalPrefix : 'invalid:'); } catch { return null; }
  if (origin.protocol !== 'https:' || origin.username || origin.password) return null;
  const afterHost = address.slice(origin.origin.length);
  if (address.slice(0, origin.origin.length) !== origin.origin) return null;
  if (literalPrefix.length < origin.origin.length + (afterHost.startsWith('/') || afterHost === '' ? 0 : 1)) return null;
  const path = (afterHost.split(/[?#]/)[0] || '/').split(PARAM).join('{}');
  return { origin: origin.origin, path: path.startsWith('/') ? path : `/${path}` };
}

const httpVerbs = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);

/** Every external API call the tokenizer can attribute in one Python file. */
export function parsePythonCalls(file: string, source: string): ApiCall[] {
  if (source.length > 300_000) return [];
  const tokens = tokenize(source);
  partner = matchBrackets(tokens);
  const modules = new Map<string, string>(); // local name → module ('requests', 'httpx', 'openai', 'stripe', 'twilio.rest')
  const constructors = new Map<string, { sdk?: PySdk; http?: boolean }>(); // local class/factory name → what it builds
  for (let k = 0; k < tokens.length; k++) {
    const token = tokens[k];
    if (token.t !== 'name' || (k > 0 && tokens[k - 1].t === 'op' && tokens[k - 1].v === '.')) continue;
    if (token.v === 'import' && (k === 0 || tokens[k - 1].v === NL)) {
      // import a.b as c, d
      let m = k + 1;
      while (m < tokens.length) {
        let dotted = '';
        while (tokens[m]?.t === 'name') { dotted += tokens[m].v; m++; if (tokens[m]?.v !== '.') break; dotted += '.'; m++; }
        let local = dotted.split('.')[0];
        if (tokens[m]?.v === 'as' && tokens[m + 1]?.t === 'name') { local = tokens[m + 1].v; m += 2; }
        if (dotted) modules.set(local, dotted);
        if (tokens[m]?.v !== ',') break;
        m++;
      }
    }
    if (token.v === 'from') {
      let m = k + 1;
      let dotted = '';
      while ((tokens[m]?.t === 'name' && tokens[m].v !== 'import') || tokens[m]?.v === '.') { dotted += tokens[m].v; m++; }
      if (tokens[m]?.v !== 'import') continue;
      m++;
      if (tokens[m]?.v === '(') m++;
      while (tokens[m]?.t === 'name') {
        const imported = tokens[m].v;
        let local = imported;
        if (tokens[m + 1]?.v === 'as' && tokens[m + 2]?.t === 'name') { local = tokens[m + 2].v; m += 2; }
        const root = dotted.split('.')[0];
        if (root === 'openai' && /^(Async)?OpenAI$/.test(imported)) constructors.set(local, { sdk: pySdks.openai });
        if (root === 'stripe' && /^StripeClient$/.test(imported)) constructors.set(local, { sdk: pySdks.stripe });
        if (dotted === 'twilio.rest' && imported === 'Client') constructors.set(local, { sdk: pySdks.twilio });
        if ((root === 'requests' && imported === 'Session') || (root === 'httpx' && /^(Async)?Client$/.test(imported))) constructors.set(local, { http: true });
        if ((root === 'requests' || root === 'httpx') && (httpVerbs.has(imported) || imported === 'request')) modules.set(local, `${root}.${imported}`);
        m++;
        if (tokens[m]?.v !== ',') break;
        m++;
      }
    }
  }
  const moduleIs = (name: string, module: string) => modules.get(name) === module;
  if (![...modules.values()].some(module => /^(requests|httpx|aiohttp|openai|stripe|twilio)/.test(module)) && !constructors.size) return [];

  // Client assignments: name = Ctor(...), with httpx base_url read when literal.
  const clients = new Map<string, PyClient>();
  for (const [local, module] of modules) if (module === 'stripe') clients.set(local, { kind: 'stripe-module' });
  for (let k = 0; k + 2 < tokens.length; k++) {
    if (tokens[k + 1]?.v !== '=' || tokens[k + 1].t !== 'op') continue;
    const target = chainBefore(tokens, k);
    if (!target || target.steps.length) continue;
    // Right side: Ctor(...) or module.Ctor(...)
    let m = k + 2;
    let ctor = '';
    while (tokens[m]?.t === 'name' || (tokens[m]?.v === '.' && ctor)) { ctor += tokens[m].v; m++; }
    if (tokens[m]?.v !== '(' || !ctor) continue;
    const close = closing(tokens, m);
    if (close < 0) continue;
    const args = argsOf(tokens, m, close);
    const [head, ...rest] = ctor.split('.');
    const member = rest.join('.');
    let built: PyClient | null = null;
    const local = constructors.get(ctor);
    if (local?.sdk) built = { kind: 'sdk', sdk: local.sdk, headers: {} };
    else if (local?.http || (moduleIs(head, 'requests') && member === 'Session') || (moduleIs(head, 'httpx') && /^(Async)?Client$/.test(member))
      || (moduleIs(head, 'aiohttp') && member === 'ClientSession')) {
      const base = stringValue(tokens, args.find(arg => arg.name === 'base_url'));
      const parsed = base ? endpointFromUrl(base) : null;
      built = { kind: 'http', ...(parsed ? { origin: parsed.origin + (parsed.path === '/' ? '' : parsed.path) } : {}) };
    } else if (moduleIs(head, 'openai') && /^(Async)?OpenAI$/.test(member)) built = { kind: 'sdk', sdk: pySdks.openai, headers: {} };
    else if (moduleIs(head, 'stripe') && member === 'StripeClient') built = { kind: 'sdk', sdk: pySdks.stripe, headers: {} };
    else if (modules.get(head) === 'twilio.rest' && member === 'Client') built = { kind: 'sdk', sdk: pySdks.twilio, headers: {} };
    if (built?.kind === 'sdk') {
      // A client aimed at another host is not this provider.
      const base = args.find(arg => arg.name === 'base_url');
      if (base) {
        const value = stringValue(tokens, base);
        const provider = getProvider(built.sdk.provider);
        if (!value || !provider?.origins.some(origin => value.startsWith(origin))) built = null;
      }
    }
    if (built) clients.set(target.root, built);
  }

  const calls: ApiCall[] = [];
  for (let k = 1; k < tokens.length && calls.length < 200; k++) {
    if (tokens[k].t !== 'op' || tokens[k].v !== '(' || tokens[k - 1].t !== 'name') continue;
    const chain = chainBefore(tokens, k - 1);
    if (!chain) continue;
    const close = closing(tokens, k);
    if (close < 0) continue;
    const args = argsOf(tokens, k, close);
    const line = tokens[chain.start]?.line ?? tokens[k].line;
    const endLine = tokens[close].line;
    const call = (endpoint: string, origin: string, symbol: string, fields: string[], fieldsComplete: boolean, bodyLine?: number,
      headers?: Record<string, string>, headersComplete = false, sdk?: string): ApiCall => ({
      file, line, ...(endLine >= line ? { endLine } : {}), symbol: symbol.slice(0, 120), endpoint, origin,
      fields: [...new Set(fields)].slice(0, 100), fieldsComplete, ...(bodyLine ? { bodyLine } : {}),
      ...(headers ? { headers } : {}), headersComplete, ...(sdk ? { sdk } : {}),
    });

    // HTTP: requests.post(url, json=...), session.get(url), requests.request("POST", url)
    const client = clients.get(chain.root);
    const module = modules.get(chain.root);
    const viaFunction = !chain.steps.length && module && /^(requests|httpx)\.(get|post|put|patch|delete|head|options|request)$/.test(module);
    const viaModule = chain.steps.length === 1 && module && /^(requests|httpx)$/.test(module) && (httpVerbs.has(chain.steps[0]) || chain.steps[0] === 'request');
    const viaSession = chain.steps.length === 1 && client?.kind === 'http' && (httpVerbs.has(chain.steps[0]) || chain.steps[0] === 'request');
    if (viaFunction || viaModule || viaSession) {
      const verb = viaFunction ? module!.split('.')[1] : chain.steps[0];
      const positional = args.filter(arg => !arg.name && !arg.star);
      let method = verb.toUpperCase();
      let urlArg = positional[0] ?? args.find(arg => arg.name === 'url');
      if (verb === 'request') {
        const named = stringValue(tokens, positional[0] ?? args.find(arg => arg.name === 'method'));
        if (!named || !httpVerbs.has(named.toLowerCase())) continue;
        method = named.toUpperCase();
        urlArg = positional[1] ?? args.find(arg => arg.name === 'url');
      }
      const address = stringValue(tokens, urlArg);
      if (address === null) continue;
      let target = endpointFromUrl(address);
      if (!target && viaSession && client?.kind === 'http' && client.origin && address.startsWith('/')) {
        target = endpointFromUrl(`${client.origin}${address}`);
      }
      if (!target) continue;
      const body = dictKeys(tokens, args.find(arg => arg.name === 'json')) ?? dictKeys(tokens, args.find(arg => arg.name === 'data'));
      const bodyArg = args.find(arg => arg.name === 'json' || arg.name === 'data');
      const headerArg = args.find(arg => arg.name === 'headers');
      const headerDict = dictKeys(tokens, headerArg);
      let headers: Record<string, string> | undefined;
      let headersComplete = !headerArg && !viaSession && !args.some(arg => arg.star);
      if (headerDict) {
        headers = {};
        headersComplete = true;
        for (const key of headerDict.keys) {
          const value = headerDict.values.get(key);
          if (typeof value === 'string' && !value.includes(PARAM)) headers[key.toLowerCase()] = value;
          else headersComplete = false;
        }
      }
      const symbol = [chain.root, ...chain.steps].join('.');
      calls.push(call(`${method} ${target.path}`, target.origin, symbol, body?.keys ?? [], bodyArg ? body !== null : !args.some(arg => arg.star), body?.line, headers, headersComplete));
      continue;
    }

    // SDK clients.
    let sdk: PySdk | undefined;
    let lookup: string | null = null;
    if (client?.kind === 'sdk') {
      sdk = client.sdk;
      const steps = chain.steps.join('.');
      lookup = camelSteps(sdk.prefix ? steps.replace(sdk.prefix, '') : steps).replace(/\.delete$/, sdk.provider === 'stripe' ? '.del' : '.delete');
    } else if (client?.kind === 'stripe-module' && chain.steps.length >= 2 && /^[A-Z]/.test(chain.steps.at(-2)!.replace(/^.*\./, ''))) {
      sdk = pySdks.stripe;
      lookup = legacyStripeChain(chain.steps);
    }
    if (!sdk || !lookup) continue;
    const methods = Object.hasOwn(sdk.methods, lookup) ? sdk.methods[lookup] : undefined;
    const provider = getProvider(sdk.provider);
    if (!Array.isArray(methods) || !methods.length || !provider) continue;
    const positional = args.filter(arg => !arg.name && !arg.star);
    const method = methods.find(item => item.p === positional.length) ?? (methods.length === 1 ? methods[0] : undefined);
    if (!method) continue;
    // Stripe's client takes params={...}; other SDKs take keyword arguments.
    const paramsArg = args.find(arg => arg.name === 'params');
    let fields: string[];
    let complete: boolean;
    let bodyLine: number | undefined;
    if (paramsArg) {
      const dict = dictKeys(tokens, paramsArg);
      fields = dict?.keys ?? [];
      complete = dict !== null;
      bodyLine = dict?.line;
    } else {
      const keywords = args.filter(arg => arg.name && !sdkOptionKwargs.has(arg.name) && !method.k.includes(arg.name)
        && !(method.p > positional.length && /_id$/.test(arg.name)));
      fields = keywords.map(arg => arg.name!);
      complete = !args.some(arg => arg.star);
      bodyLine = keywords[0] ? tokens[keywords[0].from - 2]?.line : undefined;
    }
    if (provider.fieldCase === 'pascal') fields = fields.map(pascal);
    const space = method.e.indexOf(' ');
    const endpoint = provider.basePath ? `${method.e.slice(0, space)} ${provider.basePath}${method.e.slice(space + 1)}` : method.e;
    calls.push(call(endpoint, provider.origins[0], [chain.root, ...chain.steps].join('.'), fields, complete, bodyLine,
      client?.kind === 'sdk' && Object.keys(client.headers).length ? client.headers : undefined, false, lookup));
  }
  return calls.sort((a, b) => a.line - b.line);
}
