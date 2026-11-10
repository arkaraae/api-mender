// ============================================================================
//  THIS IS NOT A MODEL.
//
//  `mender-test-double` is a TEST DOUBLE for the inference server. It contains
//  no weights and no intelligence: it applies ONE hard-coded text rule (or
//  replays canned strings from a script file) so that other packages can
//  exercise the repair pipeline end to end on machines without a GPU.
//
//  Never deploy it, never point a real tenant at it, and never read anything
//  about model quality into its output. It listens on 127.0.0.1 only.
// ============================================================================
//
// Protocol: the same OpenAI-compatible subset the gateway speaks.
//   GET  /v1/models            -> one model, id `mender-test-double`
//   POST /v1/chat/completions  -> a chat.completion whose content is a JSON
//                                 string {decision, reason, edits}
//
// The one rule: for a `request-property-removed` change that removed exactly
// one field F, where the new contract has an array-typed property `Fs`
// (customer -> customers), rewrite the single editable source line holding the
// object-literal entry `F: <expr>` to `Fs: [<expr>]`. Anything else abstains.
//
// STANDIN_SCRIPT=<file.json> (or createStandin({ script: [...] })) replaces
// the rule with canned `content` strings returned in order, so security tests
// can make the "model" misbehave. Once the script is exhausted it abstains.

import http from 'node:http';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const STANDIN_MODEL_ID = 'mender-test-double';
const DEFAULT_PORT = 8799;
const MAX_BODY_BYTES = 1024 * 1024;

const IDENTIFIER = '[A-Za-z_$][\\w$]*';
const IDENTIFIER_RE = new RegExp(`^${IDENTIFIER}$`);

const ABSTAIN = Object.freeze({
  decision: 'abstain',
  reason: 'test double: no rule for this change',
  edits: [],
});

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The `after` map is field name -> schema; tolerate a JSON-Schema `properties` wrapper too. */
function arraySchemaFor(after, property) {
  if (!isPlainObject(after)) return false;
  const direct = after[property];
  const nested = isPlainObject(after.properties) ? after.properties[property] : undefined;
  return [direct, nested].some((schema) => isPlainObject(schema) && schema.type === 'array');
}

/**
 * The single hard-coded transformation. Pure and exported so tests in other
 * packages can predict exactly what the double will answer.
 *
 * @param {unknown} task the parsed JSON document from the last user message
 * @returns {{decision: 'patch' | 'abstain', reason: string, edits: Array<{start_line: number, end_line: number, replacement: string}>}}
 */
export function decide(task) {
  if (!isPlainObject(task)) return ABSTAIN;
  const change = task.contract_change;
  const lines = task.editable_lines;
  const excerpt = task.source_excerpt;
  if (!isPlainObject(change) || !isPlainObject(lines) || !Array.isArray(excerpt)) return ABSTAIN;
  if (change.kind !== 'request-property-removed') return ABSTAIN;
  if (!Array.isArray(change.fields) || change.fields.length !== 1) return ABSTAIN;
  const [field] = change.fields;
  if (typeof field !== 'string' || !IDENTIFIER_RE.test(field)) return ABSTAIN;
  const plural = `${field}s`;
  if (!arraySchemaFor(change.after, plural)) return ABSTAIN;
  if (!Number.isInteger(lines.start) || !Number.isInteger(lines.end)) return ABSTAIN;

  // `F: <identifier or member chain>` as an object-literal entry: not part of
  // a longer name, not the else-branch of a ternary, and followed by the end
  // of the entry.
  const entry = new RegExp(
    `(?<![\\w$.])(?<!\\?\\s*)${escapeRegExp(field)}(\\s*:\\s*)(${IDENTIFIER}(?:\\.${IDENTIFIER})*)(?=\\s*(?:[,})]|$))`,
    'g',
  );
  const candidates = [];
  for (const row of excerpt) {
    if (!isPlainObject(row) || !Number.isInteger(row.line) || typeof row.text !== 'string') continue;
    if (row.line < lines.start || row.line > lines.end) continue;
    const matches = [...row.text.matchAll(entry)];
    if (matches.length > 0) candidates.push({ row, matches });
  }
  // Exactly one line with exactly one entry, or the double does not guess.
  if (candidates.length !== 1 || candidates[0].matches.length !== 1) return ABSTAIN;

  const { row, matches } = candidates[0];
  const [match] = matches;
  const replacement =
    row.text.slice(0, match.index) +
    `${plural}${match[1]}[${match[2]}]` +
    row.text.slice(match.index + match[0].length);
  return {
    decision: 'patch',
    reason: `test double: "${field}" was removed; send "${plural}" as an array instead`,
    edits: [{ start_line: row.line, end_line: row.line, replacement }],
  };
}

function lastUserTask(body) {
  if (!isPlainObject(body) || !Array.isArray(body.messages)) return undefined;
  const user = body.messages.findLast((m) => isPlainObject(m) && m.role === 'user' && typeof m.content === 'string');
  if (!user) return undefined;
  try {
    return JSON.parse(user.content);
  } catch {
    return undefined;
  }
}

function loadScript(options) {
  let script = options.script;
  const scriptPath = options.scriptPath ?? process.env.STANDIN_SCRIPT;
  if (script === undefined && scriptPath) {
    script = JSON.parse(readFileSync(scriptPath, 'utf8'));
  }
  if (script === undefined) return null;
  if (!Array.isArray(script) || script.some((item) => typeof item !== 'string')) {
    throw new Error('stand-in script must be a JSON array of strings (each one a canned `content`).');
  }
  return [...script];
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-mender-test-double': 'true',
  });
  res.end(body);
}

/**
 * Create the test double. Returns an un-started `node:http` server; start it
 * with `server.listen(0, '127.0.0.1')` and read `server.address().port`.
 *
 * `server.requests` collects every parsed chat-completion body it received (in
 * memory, for assertions such as "the pipeline sent no more than the excerpt").
 *
 * @param {{ script?: string[], scriptPath?: string }} [options]
 *   `script`: canned content strings returned in order. `scriptPath`: JSON
 *   file holding such an array (default: env STANDIN_SCRIPT).
 * @returns {import('node:http').Server & { requests: unknown[] }}
 */
export function createStandin(options = {}) {
  const script = loadScript(options);
  let served = 0;

  const server = http.createServer(async (req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (req.method === 'GET' && path === '/v1/models') {
      sendJson(res, 200, {
        object: 'list',
        data: [{ id: STANDIN_MODEL_ID, object: 'model', owned_by: 'api-mender-test-double-not-a-model' }],
      });
      return;
    }
    if (req.method !== 'POST' || path !== '/v1/chat/completions') {
      sendJson(res, 404, { error: { message: 'test double: not found', type: 'test_double' } });
      return;
    }
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      sendJson(res, 400, { error: { message: 'test double: body must be JSON', type: 'test_double' } });
      return;
    }
    if (!isPlainObject(body) || !Array.isArray(body.messages)) {
      sendJson(res, 400, { error: { message: 'test double: messages are required', type: 'test_double' } });
      return;
    }
    server.requests.push(body);

    const content =
      script !== null
        ? (script.shift() ?? JSON.stringify(ABSTAIN))
        : JSON.stringify(decide(lastUserTask(body)));
    served += 1;
    sendJson(res, 200, {
      id: `chatcmpl-standin-${served}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: STANDIN_MODEL_ID,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  });
  server.requests = [];
  return server;
}

function main() {
  const port = Number(process.env.STANDIN_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    process.stderr.write('STANDIN_PORT must be a port number.\n');
    process.exit(1);
  }
  let server;
  try {
    server = createStandin();
  } catch (error) {
    process.stderr.write(`stand-in failed to start: ${error.message}\n`);
    process.exit(1);
  }
  // Loopback only, always: this process must never be reachable as a "model".
  server.listen(port, '127.0.0.1', () => {
    process.stdout.write(
      `[mender-test-double] NOT A MODEL. Test double "${STANDIN_MODEL_ID}" listening on ` +
        `http://127.0.0.1:${server.address().port}/v1 ` +
        `(${process.env.STANDIN_SCRIPT ? 'scripted replies' : 'one hard-coded rule'}). Do not deploy.\n`,
    );
  });
  const stop = () => {
    server.close(() => process.exit(0));
    server.closeAllConnections();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
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
