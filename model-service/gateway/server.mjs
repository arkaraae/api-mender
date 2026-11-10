// API Mender model gateway.
//
// A small, zero-dependency HTTP gateway that sits in front of an inference
// server YOU host (vLLM, llama.cpp `llama-server`, Ollama's OpenAI-compatible
// API). It exists so that the inference server never has to be reachable by
// anything except this process, and so that the only thing a caller can do with
// the model is one narrow operation: a tool-less, non-streaming, JSON-schema
// constrained chat completion.
//
// Invariants this file is responsible for:
//   * The client's JSON is never forwarded. The upstream request is REBUILT
//     from an allow-list of validated fields; so is the response.
//   * Nothing is persisted. There is no file I/O in the request path at all;
//     rate-limit and concurrency state live in memory and die with the process.
//   * Request and response bodies, bearer tokens and Authorization headers are
//     never logged. The log line is built from a fixed set of scalar fields.
//   * The upstream is static configuration, never client input, and the
//     gateway refuses to start when it points at a hosted AI provider.

import http from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Hosted AI providers the gateway must never proxy to. Matching is by DNS
 * suffix on the lower-cased hostname, so `api.openai.com` and
 * `eu.api.openai.com` both match `openai.com`.
 *
 * This is a guard against misconfiguration ("just point it at a vendor for
 * now"), not a network control: an operator who fronts a vendor with their own
 * hostname or a raw IP defeats it. The network-level control is that the
 * inference server runs on an egress-less network (see docker-compose.yml).
 */
export const DENIED_UPSTREAM_SUFFIXES = Object.freeze([
  'openai.com',
  'anthropic.com',
  'generativelanguage.googleapis.com',
  'aiplatform.googleapis.com',
  'openai.azure.com',
  'mistral.ai',
  'cohere.com',
  'cohere.ai',
  'groq.com',
  'together.xyz',
  'together.ai',
  'fireworks.ai',
  'openrouter.ai',
  'deepseek.com',
  'x.ai',
  'perplexity.ai',
  'replicate.com',
  'huggingface.co',
  'deepinfra.com',
  'cerebras.ai',
  'sambanova.ai',
  'chatgpt.com',
  'claude.ai',
  'claude.com',
  'cognitiveservices.azure.com',
  'services.ai.azure.com',
  'inference.ai.azure.com',
  'openai.azure.us',
  'models.github.ai',
  'githubcopilot.com',
  'inference.net',
  'ai21.com',
  'novita.ai',
  'hyperbolic.xyz',
  'anyscale.com',
  'lepton.ai',
  // AI gateways and proxies that forward to hosted providers.
  'gateway.ai.cloudflare.com',
  'helicone.ai',
  'portkey.ai',
  'ai-gateway.vercel.sh',
  'dashscope.aliyuncs.com',
  'dashscope-intl.aliyuncs.com',
  'moonshot.ai',
  'moonshot.cn',
  'bigmodel.cn',
]);

const DEFAULTS = Object.freeze({
  listen: '127.0.0.1:8787',
  maxBodyBytes: 65536,
  maxOutputTokens: 1024,
  requestTimeoutMs: 120000,
  rateLimitPerMinute: 60,
  maxConcurrency: 4,
  maxPromptChars: 49152,
});

// Fixed protocol limits. These are properties of the Mender repair protocol,
// not deployment knobs, so they are not configurable.
const MAX_MESSAGES = 4;
const MAX_SCHEMA_BYTES = 8192;
const MAX_CONTENT_BYTES = 65536;
const MAX_TEMPERATURE = 0.2;
// 64 KiB of content can expand ~6x when JSON-escaped (\uXXXX); anything bigger
// than this is not a response we would accept anyway.
const MAX_UPSTREAM_RESPONSE_BYTES = 1024 * 1024;
// A presented bearer token longer than this is never one of ours; refuse to
// spend a hash on it.
const MAX_TOKEN_CHARS = 512;
// After rejecting a request early we keep discarding its body so the client
// can read the error, but only up to this many bytes before dropping the
// connection.
const DISCARD_BUDGET_BYTES = 1024 * 1024;
// Time allowed for a client to deliver headers + body. Bounds slow-body abuse.
const CLIENT_RECEIVE_TIMEOUT_MS = 30000;
const SHUTDOWN_GRACE_MS = 10000;

const TOKEN_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
// Model ids as used by vLLM / llama.cpp / Ollama: `Qwen/Qwen2.5-Coder-7B-Instruct`,
// `qwen2.5-coder:7b`. Restricting the alphabet keeps the value safe to log.
const MODEL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;
const SCHEMA_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const UPSTREAM_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export class ConfigError extends Error {
  /** @param {string[]} problems */
  constructor(problems) {
    super(`Invalid gateway configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

/** Lower-cased hostname without IPv6 brackets or a trailing root dot. */
function normaliseHost(hostname) {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
}

/**
 * Returns the deny-list entry a hostname falls under, or null.
 * @param {string} hostname
 * @returns {string | null}
 */
export function deniedUpstreamReason(hostname) {
  const host = normaliseHost(hostname);
  for (const suffix of DENIED_UPSTREAM_SUFFIXES) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return suffix;
  }
  // Vertex AI regional endpoints are `<region>-aiplatform.googleapis.com`: a
  // hyphenated prefix, not a subdomain, so the label-suffix match misses them.
  if (host.endsWith('-aiplatform.googleapis.com')) return 'aiplatform.googleapis.com';
  // AWS Bedrock: bedrock.<region>.amazonaws.com, bedrock-runtime.<region>...,
  // and VPC endpoint names where the bedrock label is not the first one.
  // Other amazonaws.com hosts (an ALB in front of your own GPU box) are fine.
  if (host === 'amazonaws.com' || host.endsWith('.amazonaws.com')) {
    if (host.split('.').some((label) => label.startsWith('bedrock'))) {
      return 'bedrock*.amazonaws.com';
    }
  }
  return null;
}

function parseUpstreamUrl(raw, problems) {
  if (!raw) {
    problems.push('MENDER_UPSTREAM_URL is required (e.g. http://inference:8000/v1).');
    return null;
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    problems.push('MENDER_UPSTREAM_URL is not a valid URL.');
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    problems.push('MENDER_UPSTREAM_URL must use http or https.');
    return null;
  }
  if (url.username || url.password) {
    problems.push('MENDER_UPSTREAM_URL must not embed credentials; use MENDER_UPSTREAM_API_KEY.');
    return null;
  }
  if (url.search || url.hash) {
    problems.push('MENDER_UPSTREAM_URL must not contain a query string or fragment.');
    return null;
  }
  const denied = deniedUpstreamReason(url.hostname);
  if (denied) {
    problems.push(
      `MENDER_UPSTREAM_URL points at a hosted AI provider (${denied}). ` +
        'This gateway fronts a model you host; it must not proxy customer code to a vendor.',
    );
    return null;
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

function parseListen(raw, problems) {
  const match = /^(?:\[([0-9A-Fa-f:.]+)\]|([^:\s]+)):(\d{1,5})$/.exec(raw);
  const port = match ? Number(match[3]) : NaN;
  if (!match || port > 65535) {
    problems.push('MENDER_GATEWAY_LISTEN must be host:port (e.g. 127.0.0.1:8787 or [::1]:8787).');
    return null;
  }
  return { host: match[1] ?? match[2], port };
}

function parseTokens(raw, problems) {
  const entries = splitList(raw);
  if (entries.length === 0) {
    problems.push(
      'MENDER_GATEWAY_TOKENS_SHA256 is required: comma-separated name:sha256hex pairs ' +
        '(mint one with `node gateway/token.mjs new <name>`). The gateway never runs unauthenticated.',
    );
    return [];
  }
  const tokens = [];
  const seen = new Set();
  entries.forEach((entry, index) => {
    // Never echo the entry itself: a confused operator may have pasted a
    // plaintext token here, and startup errors end up in logs.
    const where = `MENDER_GATEWAY_TOKENS_SHA256 entry ${index + 1}`;
    const colon = entry.indexOf(':');
    const name = colon === -1 ? '' : entry.slice(0, colon);
    const hex = colon === -1 ? '' : entry.slice(colon + 1).toLowerCase();
    if (!TOKEN_NAME_RE.test(name)) {
      problems.push(`${where}: expected name:sha256hex with a name matching ${TOKEN_NAME_RE}.`);
    } else if (!SHA256_HEX_RE.test(hex)) {
      problems.push(`${where} ("${name}"): the hash must be 64 hex characters (SHA-256 of the token).`);
    } else if (seen.has(name)) {
      problems.push(`${where}: duplicate token name "${name}".`);
    } else {
      seen.add(name);
      tokens.push({ name, hash: Buffer.from(hex, 'hex') });
    }
  });
  return tokens;
}

function parseModels(raw, problems) {
  const models = splitList(raw);
  if (models.length === 0) {
    problems.push('MENDER_ALLOWED_MODELS is required: comma-separated model names clients may request.');
  }
  for (const model of models) {
    if (!MODEL_NAME_RE.test(model)) {
      problems.push(`MENDER_ALLOWED_MODELS: "${model}" is not a valid model name.`);
    }
  }
  return [...new Set(models)];
}

function parsePositiveInt(env, key, fallback, max, problems) {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  if (!/^\d+$/.test(raw.trim())) {
    problems.push(`${key} must be a positive integer.`);
    return fallback;
  }
  const value = Number(raw.trim());
  if (value < 1 || value > max) {
    problems.push(`${key} must be between 1 and ${max}.`);
    return fallback;
  }
  return value;
}

function splitList(raw) {
  return (raw ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Parse and validate configuration. Pure: reads only the object it is given
 * and throws a ConfigError listing every problem, so a bad deployment fails at
 * startup instead of on the first request.
 *
 * @param {Record<string, string | undefined>} env
 */
export function loadConfig(env) {
  const problems = [];
  const listen = parseListen(env.MENDER_GATEWAY_LISTEN?.trim() || DEFAULTS.listen, problems);
  const upstreamUrl = parseUpstreamUrl(env.MENDER_UPSTREAM_URL?.trim(), problems);
  const tokens = parseTokens(env.MENDER_GATEWAY_TOKENS_SHA256, problems);
  const allowedModels = parseModels(env.MENDER_ALLOWED_MODELS, problems);

  const upstreamApiKey = env.MENDER_UPSTREAM_API_KEY?.trim() || null;
  if (upstreamApiKey && /[^\x21-\x7e]/.test(upstreamApiKey)) {
    problems.push('MENDER_UPSTREAM_API_KEY contains whitespace or non-ASCII characters.');
  }

  const int = (key, fallback, max) => parsePositiveInt(env, key, fallback, max, problems);
  const config = {
    listen,
    upstreamUrl,
    upstreamApiKey,
    tokens,
    allowedModels,
    maxBodyBytes: int('MENDER_MAX_BODY_BYTES', DEFAULTS.maxBodyBytes, 1024 * 1024),
    maxOutputTokens: int('MENDER_MAX_OUTPUT_TOKENS', DEFAULTS.maxOutputTokens, 8192),
    requestTimeoutMs: int('MENDER_REQUEST_TIMEOUT_MS', DEFAULTS.requestTimeoutMs, 600000),
    rateLimitPerMinute: int('MENDER_RATE_LIMIT_PER_MINUTE', DEFAULTS.rateLimitPerMinute, 100000),
    maxConcurrency: int('MENDER_MAX_CONCURRENCY', DEFAULTS.maxConcurrency, 1024),
    maxPromptChars: int('MENDER_MAX_PROMPT_CHARS', DEFAULTS.maxPromptChars, 1024 * 1024),
  };
  if (problems.length > 0) throw new ConfigError(problems);
  return Object.freeze(config);
}

// ---------------------------------------------------------------------------
// Authentication, rate limiting
// ---------------------------------------------------------------------------

/**
 * Resolve a presented Authorization header to a configured token name.
 *
 * Tokens are compared as SHA-256 digests with timingSafeEqual, and every
 * configured hash is checked (no early exit) so timing does not reveal which
 * entry, if any, was close. Plaintext tokens are never held beyond this call.
 *
 * @returns {string | null}
 */
function authenticate(header, tokens) {
  if (typeof header !== 'string') return null;
  const match = /^Bearer ([\x21-\x7e]+)$/i.exec(header);
  if (!match || match[1].length > MAX_TOKEN_CHARS) return null;
  const presented = createHash('sha256').update(match[1], 'utf8').digest();
  let name = null;
  for (const token of tokens) {
    if (timingSafeEqual(presented, token.hash)) name = token.name;
  }
  return name;
}

/**
 * Fixed one-minute window per token name. Memory is bounded by the number of
 * configured tokens because only authenticated requests are counted.
 */
function createRateLimiter(limitPerMinute, now) {
  const windows = new Map();
  return (tokenName) => {
    const t = now();
    let window = windows.get(tokenName);
    if (!window || t - window.start >= 60000) {
      window = { start: t, count: 0 };
      windows.set(tokenName, window);
    }
    if (window.count >= limitPerMinute) {
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((window.start + 60000 - t) / 1000)) };
    }
    window.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  };
}

// ---------------------------------------------------------------------------
// Request validation: build the upstream request from an allow-list
// ---------------------------------------------------------------------------

/** An error whose message is safe to return to the client (never echoes input). */
class RequestError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const bad = (message) => new RequestError(400, 'invalid_request', message);

// Fields that would hand the model capabilities or widen the response. Their
// mere presence is rejected (even `tool_choice: "none"`): a caller that sends
// them is not speaking the Mender protocol, and silently dropping them would
// hide that.
const FORBIDDEN_FIELDS = ['tools', 'tool_choice', 'functions', 'function_call'];

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function validateMessages(raw, maxPromptChars) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_MESSAGES) {
    throw bad(`messages must be an array of 1 to ${MAX_MESSAGES} items.`);
  }
  let totalChars = 0;
  const messages = raw.map((message) => {
    if (!isPlainObject(message)) throw bad('each message must be an object.');
    // No assistant turns (prefill / fabricated history) and no tool results.
    if (message.role !== 'system' && message.role !== 'user') {
      throw bad('message roles must be "system" or "user".');
    }
    if (typeof message.content !== 'string') throw bad('message content must be a string.');
    totalChars += message.content.length;
    return { role: message.role, content: message.content };
  });
  if (totalChars > maxPromptChars) throw bad('messages exceed the total size limit.');
  if (messages[messages.length - 1].role !== 'user') throw bad('the last message must have role "user".');
  return messages;
}

function validateResponseFormat(raw) {
  // Required: constrained decoding is part of the safety story. Free-form
  // output is never something a Mender caller wants.
  if (!isPlainObject(raw) || raw.type !== 'json_schema' || !isPlainObject(raw.json_schema)) {
    throw bad('response_format is required and must be {type:"json_schema", json_schema:{name, schema}}.');
  }
  const { name, strict, schema } = raw.json_schema;
  if (typeof name !== 'string' || !SCHEMA_NAME_RE.test(name)) {
    throw bad('response_format.json_schema.name must match [A-Za-z0-9_-]{1,64}.');
  }
  if (strict !== undefined && typeof strict !== 'boolean') {
    throw bad('response_format.json_schema.strict must be a boolean.');
  }
  if (!isPlainObject(schema)) throw bad('response_format.json_schema.schema must be an object.');
  if (Buffer.byteLength(JSON.stringify(schema), 'utf8') > MAX_SCHEMA_BYTES) {
    throw bad(`response_format.json_schema.schema must be at most ${MAX_SCHEMA_BYTES} bytes.`);
  }
  const jsonSchema = strict === undefined ? { name, schema } : { name, strict, schema };
  return { type: 'json_schema', json_schema: jsonSchema };
}

function validateTemperature(raw) {
  if (raw === undefined || raw === null) return 0;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) throw bad('temperature must be a number.');
  return Math.min(Math.max(raw, 0), MAX_TEMPERATURE);
}

function validateMaxTokens(body, maxOutputTokens) {
  // Newer OpenAI SDKs send max_completion_tokens; accept it as an alias but
  // always forward the widely supported max_tokens.
  const raw = body.max_tokens ?? body.max_completion_tokens;
  if (raw === undefined || raw === null) return maxOutputTokens;
  if (!Number.isInteger(raw) || raw < 1) throw bad('max_tokens must be a positive integer.');
  return Math.min(raw, maxOutputTokens);
}

/**
 * Validate a client body and return the request to send upstream.
 *
 * The return value is constructed field by field; nothing is copied from the
 * client object wholesale, so unknown fields (seed, user, logit_bias, vendor
 * extensions...) cannot reach the inference server.
 *
 * @param {unknown} body parsed client JSON
 * @param {ReturnType<typeof loadConfig>} config
 */
export function buildUpstreamRequest(body, config) {
  if (!isPlainObject(body)) throw bad('request body must be a JSON object.');
  for (const field of FORBIDDEN_FIELDS) {
    if (has(body, field)) throw bad(`"${field}" is not supported: this model is never given tools.`);
  }
  if (body.stream !== undefined && body.stream !== false) throw bad('streaming is not supported.');
  if (body.n !== undefined && body.n !== null && body.n !== 1) throw bad('n must be 1.');
  for (const field of ['logprobs', 'top_logprobs']) {
    if (body[field] !== undefined && body[field] !== null && body[field] !== false) {
      throw bad(`"${field}" is not supported.`);
    }
  }
  if (typeof body.model !== 'string' || !config.allowedModels.includes(body.model)) {
    // Deliberately does not echo the requested value or list what is allowed.
    throw new RequestError(400, 'model_not_allowed', 'model is not allowed by this gateway.');
  }
  return {
    model: body.model,
    messages: validateMessages(body.messages, config.maxPromptChars),
    response_format: validateResponseFormat(body.response_format),
    temperature: validateTemperature(body.temperature),
    max_tokens: validateMaxTokens(body, config.maxOutputTokens),
    stream: false,
  };
}

// ---------------------------------------------------------------------------
// Upstream call and response rebuilding
// ---------------------------------------------------------------------------

/** Upstream failure. `message` is a fixed string; upstream bodies are never included. */
class UpstreamError extends Error {
  constructor(status, code, message, upstreamStatus = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.upstreamStatus = upstreamStatus;
  }
}

const ACCEPTED_FINISH_REASONS = new Set(['stop', 'length', 'content_filter']);

async function readCapped(response, limit) {
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body ?? []) {
    total += chunk.byteLength;
    if (total > limit) throw new UpstreamError(502, 'upstream_invalid_response', 'upstream response was too large.', response.status);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function tokenCount(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function rebuildUsage(raw) {
  if (!isPlainObject(raw)) return null;
  const prompt = tokenCount(raw.prompt_tokens);
  const completion = tokenCount(raw.completion_tokens);
  if (prompt === null || completion === null) return null;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

/**
 * Reduce an upstream completion to the minimal shape callers need. Anything
 * unexpected (tool calls, non-string content, unknown finish reasons) fails
 * closed as a 502 instead of being passed along.
 */
function rebuildCompletion(payload, model, requestId, upstreamStatus) {
  const invalid = () =>
    new UpstreamError(502, 'upstream_invalid_response', 'upstream returned an unexpected response.', upstreamStatus);
  const choice = isPlainObject(payload) && Array.isArray(payload.choices) ? payload.choices[0] : null;
  if (!isPlainObject(choice) || !isPlainObject(choice.message)) throw invalid();
  const { message } = choice;
  if (message.role !== undefined && message.role !== 'assistant') throw invalid();
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) throw invalid();
  if (isPlainObject(message.function_call)) throw invalid();
  if (typeof message.content !== 'string') throw invalid();
  if (Buffer.byteLength(message.content, 'utf8') > MAX_CONTENT_BYTES) throw invalid();
  if (!ACCEPTED_FINISH_REASONS.has(choice.finish_reason)) throw invalid();
  return {
    // Upstream ids are opaque strings; only pass one through when it has a
    // boring shape, otherwise mint our own.
    id: typeof payload.id === 'string' && UPSTREAM_ID_RE.test(payload.id) ? payload.id : `chatcmpl-${requestId}`,
    // Report the allow-listed name the client asked for, not whatever string
    // the inference server chose to identify itself with.
    model,
    choices: [
      {
        index: 0,
        finish_reason: choice.finish_reason,
        message: { role: 'assistant', content: message.content },
      },
    ],
    usage: rebuildUsage(payload.usage),
  };
}

async function callUpstream(upstreamRequest, config, requestId, clientGone, record) {
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  if (config.upstreamApiKey) headers.authorization = `Bearer ${config.upstreamApiKey}`;
  const timeout = AbortSignal.timeout(config.requestTimeoutMs);
  let response;
  try {
    response = await fetch(`${config.upstreamUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(upstreamRequest),
      // A redirect could send the prompt somewhere that is not the configured
      // upstream (including a hosted provider). Never follow one.
      redirect: 'error',
      // The timeout covers headers AND body; clientGone frees the GPU when the
      // caller has hung up.
      signal: AbortSignal.any([timeout, clientGone]),
    });
    record.upstreamStatus = response.status;
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new UpstreamError(502, 'upstream_error', 'upstream returned an error.', response.status);
    }
    const raw = await readCapped(response, MAX_UPSTREAM_RESPONSE_BYTES);
    let payload;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new UpstreamError(502, 'upstream_invalid_response', 'upstream returned an unexpected response.', response.status);
    }
    return rebuildCompletion(payload, upstreamRequest.model, requestId, response.status);
  } catch (error) {
    if (error instanceof UpstreamError) throw error;
    if (timeout.aborted) throw new UpstreamError(504, 'upstream_timeout', 'upstream timed out.', record.upstreamStatus);
    // Connection refused, DNS failure, refused redirect, reset mid-body, or
    // the client went away. The cause is intentionally not surfaced.
    throw new UpstreamError(502, 'upstream_unreachable', 'upstream request failed.', record.upstreamStatus);
  }
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

/**
 * Keep discarding an unread request body so the client can finish sending and
 * read our error response, but drop the connection if it keeps going past the
 * budget. Without this an early `res.end()` would either reset the connection
 * under the client or let it stream to us indefinitely.
 */
function discardRequestBody(req, record, alreadyRead = 0) {
  let seen = alreadyRead;
  req.removeAllListeners('data');
  req.on('data', (chunk) => {
    seen += chunk.length;
    record.requestBytes = seen;
    if (seen > DISCARD_BUDGET_BYTES) req.destroy();
  });
  req.on('error', () => {});
  req.resume();
}

/** Read the body into memory with a hard cap. Rejects with 413 past the cap. */
function readBody(req, maxBytes, record) {
  return new Promise((resolve, reject) => {
    const tooLarge = () => new RequestError(413, 'request_too_large', 'request body is too large.');
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      // Reject before reading a single body byte.
      discardRequestBody(req, record);
      reject(tooLarge());
      return;
    }
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      record.requestBytes = total;
      if (total > maxBytes) {
        chunks.length = 0;
        discardRequestBody(req, record, total);
        reject(tooLarge());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => reject(new RequestError(400, 'invalid_request', 'request body could not be read.')));
    req.on('aborted', () => reject(new RequestError(400, 'invalid_request', 'request body could not be read.')));
  });
}

function parseJsonBody(buffer) {
  try {
    // fatal: reject invalid UTF-8 instead of silently replacing bytes.
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
  } catch {
    throw bad('request body must be valid UTF-8 JSON.');
  }
}

function isJsonContentType(header) {
  return typeof header === 'string' && header.split(';')[0].trim().toLowerCase() === 'application/json';
}

function send(res, record, status, payload, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  record.status = status;
  record.responseBytes = body.length;
  if (res.destroyed || res.headersSent) return;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-request-id': record.requestId,
    ...extraHeaders,
  });
  res.end(body);
}

function sendError(res, record, status, code, message, extraHeaders) {
  send(res, record, status, { error: { message, type: 'mender_gateway_error', code } }, extraHeaders);
}

/**
 * The ONLY place a request log line is produced. It takes the record's scalar
 * fields explicitly; there is no code path by which a body, header or token
 * value can end up in the line.
 */
function formatLogLine(record, now) {
  return JSON.stringify({
    ts: new Date(now()).toISOString(),
    request_id: record.requestId,
    token: record.tokenName,
    model: record.model,
    request_bytes: record.requestBytes,
    response_bytes: record.responseBytes,
    status: record.status,
    latency_ms: Math.max(0, Math.round(now() - record.startedAt)),
    upstream_status: record.upstreamStatus,
  });
}

/**
 * Create the gateway. Returns an un-started `node:http` server; call
 * `.listen(port, host)` (port 0 for an ephemeral port in tests).
 *
 * @param {ReturnType<typeof loadConfig>} config result of loadConfig()
 * @param {{ log?: (line: string) => void, now?: () => number }} [options]
 *   `log` receives one JSON line per request (default: stdout); `now` is an
 *   injectable clock in epoch milliseconds for tests.
 * @returns {import('node:http').Server}
 */
export function createGateway(config, options = {}) {
  const log = options.log ?? ((line) => process.stdout.write(`${line}\n`));
  const now = options.now ?? Date.now;
  const checkRate = createRateLimiter(config.rateLimitPerMinute, now);
  const healthBody = { ok: true, model: config.allowedModels[0] };
  let inFlight = 0;

  async function handleCompletion(req, res, record) {
    // 1. Authenticate before touching the body, with one indistinguishable
    //    failure for missing, malformed and wrong credentials.
    record.tokenName = authenticate(req.headers.authorization, config.tokens);
    if (record.tokenName === null) {
      discardRequestBody(req, record);
      sendError(res, record, 401, 'unauthorized', 'missing or invalid credentials.', {
        'www-authenticate': 'Bearer',
      });
      return;
    }

    // 2. Per-token rate limit, then global concurrency. Both are checked
    //    before the body is read so a throttled client costs almost nothing.
    const rate = checkRate(record.tokenName);
    if (!rate.allowed) {
      discardRequestBody(req, record);
      sendError(res, record, 429, 'rate_limited', 'rate limit exceeded.', {
        'retry-after': String(rate.retryAfterSeconds),
      });
      return;
    }
    if (inFlight >= config.maxConcurrency) {
      discardRequestBody(req, record);
      sendError(res, record, 429, 'too_many_concurrent_requests', 'the gateway is at capacity.', {
        'retry-after': '1',
      });
      return;
    }

    inFlight += 1;
    const clientGone = new AbortController();
    const onClose = () => {
      if (!res.writableFinished) clientGone.abort();
    };
    res.on('close', onClose);
    try {
      if (!isJsonContentType(req.headers['content-type'])) {
        discardRequestBody(req, record);
        throw new RequestError(415, 'unsupported_media_type', 'content-type must be application/json.');
      }
      const raw = await readBody(req, config.maxBodyBytes, record);
      const upstreamRequest = buildUpstreamRequest(parseJsonBody(raw), config);
      record.model = upstreamRequest.model;
      const completion = await callUpstream(upstreamRequest, config, record.requestId, clientGone.signal, record);
      send(res, record, 200, completion);
    } catch (error) {
      if (error instanceof RequestError) {
        // A request that failed validation after its model passed the
        // allow-list is not attributed to that model: record.model is only
        // set once the whole request is valid.
        sendError(res, record, error.status, error.code, error.message);
      } else if (error instanceof UpstreamError) {
        record.upstreamStatus = error.upstreamStatus ?? record.upstreamStatus;
        sendError(res, record, error.status, error.code, error.message);
      } else {
        // Unknown failure: say nothing about it, to the client or the log
        // (the error object could carry request data).
        sendError(res, record, 500, 'internal_error', 'internal error.');
      }
    } finally {
      inFlight -= 1;
      res.off('close', onClose);
    }
  }

  async function route(req, res, record) {
    const path = (req.url ?? '').split('?')[0];
    if (path === '/healthz') {
      if (req.method !== 'GET') {
        discardRequestBody(req, record);
        sendError(res, record, 405, 'method_not_allowed', 'method not allowed.', { allow: 'GET' });
        return;
      }
      // Static by design: probing the upstream here would turn an
      // unauthenticated endpoint into an oracle for upstream state.
      send(res, record, 200, healthBody);
      return;
    }
    if (path === '/v1/chat/completions') {
      if (req.method !== 'POST') {
        discardRequestBody(req, record);
        sendError(res, record, 405, 'method_not_allowed', 'method not allowed.', { allow: 'POST' });
        return;
      }
      await handleCompletion(req, res, record);
      return;
    }
    discardRequestBody(req, record);
    sendError(res, record, 404, 'not_found', 'not found.');
  }

  const server = http.createServer((req, res) => {
    const record = {
      requestId: randomUUID(),
      startedAt: now(),
      tokenName: null,
      model: null,
      requestBytes: 0,
      responseBytes: 0,
      status: 0,
      upstreamStatus: null,
    };
    let logged = false;
    const writeLog = () => {
      if (logged) return;
      logged = true;
      // 499: the client went away before a response was fully written.
      if (!res.writableFinished) record.status = 499;
      try {
        log(formatLogLine(record, now));
      } catch {
        // A broken log sink must not take request handling down with it.
      }
    };
    res.on('close', writeLog);
    route(req, res, record).catch(() => {
      sendError(res, record, 500, 'internal_error', 'internal error.');
    });
  });

  // Bound how long a client may take to deliver a request, and do not hold
  // idle connections open for long.
  server.headersTimeout = 10000;
  server.requestTimeout = CLIENT_RECEIVE_TIMEOUT_MS;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 64;
  // Malformed HTTP: answer tersely and never echo what was received.
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\ncontent-length: 0\r\n\r\n');
    else socket.destroy();
  });
  return server;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function isLoopback(host) {
  return host === 'localhost' || host === '::1' || host.startsWith('127.');
}

function main() {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    // ConfigError messages are written to be safe to print; anything else is
    // reduced to its name.
    process.stderr.write(`${error instanceof ConfigError ? error.message : `startup failed: ${error?.name}`}\n`);
    process.exit(1);
  }

  const server = createGateway(config);
  // Operational messages go to stderr so stdout carries nothing but the
  // one-line-per-request JSON log.
  const info = (message) => process.stderr.write(`[mender-gateway] ${message}\n`);

  server.on('error', (error) => {
    info(`listen failed: ${error.code ?? error.name}`);
    process.exit(1);
  });
  server.listen(config.listen.port, config.listen.host, () => {
    const address = server.address();
    info(
      `listening on ${config.listen.host}:${address.port}; upstream ${new URL(config.upstreamUrl).host}; ` +
        `models ${config.allowedModels.join(', ')}; tokens ${config.tokens.map((t) => t.name).join(', ')}`,
    );
    if (!isLoopback(config.listen.host)) {
      info(
        'WARNING: listening on a non-loopback address. This process speaks plain HTTP; ' +
          'terminate TLS in front of it and do not expose it to the public internet directly.',
      );
    }
  });

  let stopping = false;
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    info(`${signal} received; draining in-flight requests`);
    // Stop accepting, let in-flight requests finish, then exit. If they do
    // not finish within the grace period, cut them off.
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => {
      server.closeAllConnections();
      process.exit(0);
    }, SHUTDOWN_GRACE_MS).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

function isExecutedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isExecutedDirectly()) main();
