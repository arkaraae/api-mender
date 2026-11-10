// Client for a self-hosted, OpenAI-compatible chat-completions server (vLLM,
// llama.cpp server, Ollama). Customer source leaves the process only through
// this file, so the egress guard lives here and runs before every request.
import type { ModelConfig } from '../types.ts';
import { isHostedAiProviderHost } from './hosted-providers.ts';

export type ModelErrorKind = 'egress-blocked' | 'unavailable' | 'rejected' | 'rate-limited' | 'invalid-response';

/**
 * Messages are fixed strings chosen here. They never contain request or
 * response bodies, the API key, or any part of the endpoint URL, because
 * callers log them.
 */
export class ModelError extends Error {
  kind: ModelErrorKind;
  constructor(kind: ModelErrorKind, message: string) { super(message); this.name = 'ModelError'; this.kind = kind; }
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_CONTENT_CHARS = 32 * 1024;
const PRIVATE_SUFFIXES = ['.internal', '.local', '.lan', '.svc', '.cluster.local', '.localhost'];

const blocked = (detail: string) => new ModelError('egress-blocked', `Model endpoint refused: ${detail}`);

function ipv4(host: string): number[] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  const parts = match ? match.slice(1).map(Number) : null;
  return parts && parts.every(part => part <= 255) ? parts : null;
}

const loopbackV4 = (ip: number[]) => ip[0] === 127;
const privateV4 = (ip: number[]) => ip[0] === 10 || (ip[0] === 172 && ip[1] >= 16 && ip[1] <= 31)
  || (ip[0] === 192 && ip[1] === 168) || (ip[0] === 169 && ip[1] === 254);

// URL has already normalised the literal: lower-case hex, `::` compression,
// and an embedded IPv4 written as two hex groups.
function mappedV4(address: string): number[] | null {
  const match = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
  if (!match) return null;
  const high = parseInt(match[1], 16);
  const low = parseInt(match[2], 16);
  return [high >> 8, high & 255, low >> 8, low & 255];
}

type HostClass = 'loopback' | 'private' | 'public';

function classifyHost(hostname: string): HostClass {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[')) {
    const address = host.slice(1, -1);
    const mapped = mappedV4(address);
    if (mapped) return loopbackV4(mapped) ? 'loopback' : privateV4(mapped) ? 'private' : 'public';
    if (address === '::1') return 'loopback';
    // fc00::/7 unique local, fe80::/10 link local.
    return /^f[cd][0-9a-f]{2}:/.test(address) || /^fe[89ab][0-9a-f]:/.test(address) ? 'private' : 'public';
  }
  const ip = ipv4(host);
  if (ip) return loopbackV4(ip) ? 'loopback' : privateV4(ip) ? 'private' : 'public';
  if (host === 'localhost' || host.endsWith('.localhost')) return 'loopback';
  // Single-label and reserved-suffix names only resolve inside a private network.
  return !host.includes('.') || PRIVATE_SUFFIXES.some(suffix => host.endsWith(suffix)) ? 'private' : 'public';
}

/**
 * Refuse an endpoint that could carry source code to a hosted AI provider or
 * over an unprotected channel. Returns the parsed base URL.
 *
 * Limits: this checks the configured name, not what it resolves to (a Worker
 * cannot resolve DNS), and the provider deny-list is defence in depth. The
 * real control is that the operator points this at inference they run.
 */
export function assertPrivateModelEndpoint(config: ModelConfig): URL {
  let url: URL;
  try { url = new URL(config.endpoint); } catch { throw blocked('it is not a valid URL'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw blocked('only http and https are supported');
  if (url.username || url.password) throw blocked('credentials must not be embedded in the URL');
  if (url.hash) throw blocked('the URL must not have a fragment');
  if (isHostedAiProviderHost(url.hostname)) throw blocked('the host belongs to a hosted AI provider; customer code may only be sent to self-hosted inference');
  const hostClass = classifyHost(url.hostname);
  if (url.protocol === 'http:' && hostClass !== 'loopback') throw blocked('https is required unless the host is loopback');
  if (config.mode === 'customer-managed' && hostClass === 'public' && config.allowRemote !== true)
    throw blocked('customer-managed mode requires a loopback or private-network host unless allowRemote is set');
  if (config.mode !== 'customer-managed' && config.mode !== 'hosted') throw blocked('unknown endpoint mode');
  return url;
}

function completionsUrl(base: URL): string {
  const url = new URL(base.href);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/chat/completions`;
  return url.href;
}

// Stop reading at the cap instead of buffering whatever a server sends.
async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new ModelError('invalid-response', 'Model server response is too large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(bytes);
}

// Some servers wrap JSON in one markdown fence despite the schema. Remove
// exactly that; anything else odd is an invalid answer, not something to mend.
function stripFence(text: string): string {
  const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/.exec(text.trim());
  return fenced ? fenced[1] : text;
}

function decodeCompletion(text: string): unknown {
  let envelope: any;
  try { envelope = JSON.parse(text); }
  catch { throw new ModelError('invalid-response', 'Model server returned a response that is not JSON'); }
  const choice = envelope?.choices?.[0];
  if (!choice || typeof choice !== 'object') throw new ModelError('invalid-response', 'Model server returned no completion');
  // 'length' means the answer was cut off; a truncated patch must not be parsed.
  if (choice.finish_reason !== 'stop') throw new ModelError('invalid-response', 'Model did not finish its answer');
  // No tools were offered, so a tool call is a protocol violation.
  if (Array.isArray(choice.message?.tool_calls) && choice.message.tool_calls.length)
    throw new ModelError('invalid-response', 'Model attempted a tool call; none are available');
  const content = choice.message?.content;
  if (typeof content !== 'string' || content.length > MAX_CONTENT_CHARS)
    throw new ModelError('invalid-response', 'Model answer is missing or too large');
  try { return JSON.parse(stripFence(content)); }
  catch { throw new ModelError('invalid-response', 'Model answer is not JSON'); }
}

function timeoutMs(config: ModelConfig): number {
  const value = config.timeoutMs;
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.min(Math.floor(value), MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
}

/**
 * One structured chat completion: no tools, no streaming, temperature 0.
 * Returns the decoded JSON answer, still untrusted.
 */
export async function requestStructuredCompletion(
  config: ModelConfig, messages: { system: string; user: string }, schema: object,
): Promise<unknown> {
  const base = assertPrivateModelEndpoint(config);
  if (typeof config.model !== 'string' || !/^[A-Za-z0-9_.:/@-]{1,200}$/.test(config.model))
    throw new ModelError('rejected', 'Model name is not valid');
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
  if (config.apiKey !== undefined) {
    // A key with whitespace or control characters could split the header.
    if (!/^[\x21-\x7e]{1,4096}$/.test(config.apiKey)) throw new ModelError('rejected', 'Model API key is not a valid header value');
    headers.authorization = `Bearer ${config.apiKey}`;
  }
  let response: Response;
  let text: string;
  try {
    response = await (config.fetcher ?? fetch)(completionsUrl(base), {
      method: 'POST', headers,
      // A redirect could move the request body to a host the guard never saw.
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs(config)),
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: 'system', content: messages.system }, { role: 'user', content: messages.user }],
        temperature: 0, max_tokens: 700, stream: false,
        response_format: { type: 'json_schema', json_schema: { name: 'mender_repair', strict: true, schema } },
      }),
    });
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400))
      throw new ModelError('rejected', 'Model server answered with a redirect, which is not followed');
    if (response.status === 429) throw new ModelError('rate-limited', 'Model server rate limit reached');
    if (response.status >= 500) throw new ModelError('unavailable', 'Model server is unavailable');
    if (!response.ok) throw new ModelError('rejected', 'Model server rejected the request');
    text = await readCapped(response);
  } catch (error) {
    if (error instanceof ModelError) throw error;
    // The underlying error can quote the URL or headers; do not pass it on.
    throw new ModelError('unavailable', 'Model server could not be reached or timed out');
  }
  return decodeCompletion(text);
}
