// Tests for the GitHub check (.github/actions/mender-check/check.mjs), run against a throwaway
// git repository whose API description changes between the base commit and the working copy.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const script = resolve(import.meta.dirname, '../../.github/actions/mender-check/check.mjs');

const description = (properties, required) => JSON.stringify({
  openapi: '3.0.3',
  info: { title: 'Quote API', version: '1.0.0' },
  paths: { '/quotes': { post: {
    requestBody: { content: { 'application/json': { schema: { type: 'object', required, properties } } } },
    responses: { 200: { description: 'ok', content: { 'application/json': { schema: { type: 'object', required: ['id', 'total'], properties: { id: { type: 'string' }, total: { type: 'integer' } } } } } } },
  } } },
}, null, 2);

function repository(before) {
  const dir = mkdtempSync(join(tmpdir(), 'mender-check-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  writeFileSync(join(dir, 'openapi.json'), before);
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  return dir;
}

function check(dir, env = {}) {
  const output = join(dir, 'report.md');
  const run = spawnSync(process.execPath, [script], { cwd: dir, encoding: 'utf8', env: { ...process.env, SPECS: 'openapi.json', BASE_SHA: 'HEAD', OUTPUT: output, ...env } });
  return { status: run.status, markdown: readFileSync(output, 'utf8') };
}

const str = { type: 'string' };

test('a renamed request field is reported as bridged, with a link to open it on API Mender', () => {
  const dir = repository(description({ customerId: str }, ['customerId']));
  try {
    writeFileSync(join(dir, 'openapi.json'), description({ accountId: str }, ['accountId']));
    const result = check(dir, { HEAD_SHA: 'abc', REPO: 'acme/quotes', FAIL_ON: 'breaks' });
    assert.equal(result.status, 0);
    assert.match(result.markdown, /### 🟢 `openapi.json`: Breaking changes that Mender can bridge/);
    assert.match(result.markdown, /\| warning \| `request-property-renamed` \| 🟢 Mender bridges this \| customerId is now accountId \| in requests \|/);
    assert.match(result.markdown, /\(0 errors, 1 warning, \d+ info\)/);
    assert.match(result.markdown, /check\?before=https%3A%2F%2Fraw\.githubusercontent\.com%2Facme%2Fquotes%2FHEAD%2Fopenapi\.json&after=/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a dropped answer field fails the check when asked to, and only reports otherwise', () => {
  const dir = repository(description({ customerId: str }, ['customerId']));
  try {
    const changed = JSON.parse(description({ customerId: str }, ['customerId']));
    const answer = changed.paths['/quotes'].post.responses[200].content['application/json'].schema;
    delete answer.properties.total;
    answer.required = ['id'];
    writeFileSync(join(dir, 'openapi.json'), JSON.stringify(changed));
    const strict = check(dir, { FAIL_ON: 'breaks' });
    assert.equal(strict.status, 1);
    assert.match(strict.markdown, /\| \*\*error\*\* \| `response-property-removed` \| 🔴 Old callers lose this \| total was dropped/);
    assert.equal(check(dir, { FAIL_ON: 'never' }).status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an unchanged description says so', () => {
  const dir = repository(description({ customerId: str }, ['customerId']));
  try {
    assert.match(check(dir).markdown, /No API description changed in this pull request/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
