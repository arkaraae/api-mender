import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { proveWithSchemas, rulesFromOpenApi } from '../mender/src/openapi.js';
import { fixConsumer } from '../mender/src/codefix.js';
import { generateAiFix } from './ai-fix-provider.mjs';

const root = resolve(import.meta.dirname, '..');
const consumer = join(root, 'examples/quote-api-consumer');
const sourcePath = join(consumer, 'src/client.mjs');
const reportDir = join(root, 'artifacts/managed-api');
const baseUrl = (process.env.MENDER_TEST_API_URL || 'https://apimender.com').replace(/\/$/, '');
const reportPath = join(reportDir, 'report.json');
mkdirSync(reportDir, { recursive: true });

function report(state, details = {}) {
  const value = { state, checkedAt: new Date().toISOString(), api: baseUrl, ...details };
  writeFileSync(reportPath, JSON.stringify(value, null, 2) + '\n');
  console.log(JSON.stringify(value));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Managed Quote API: ${state}\n\nVersion ${details.version ?? 'unknown'}. ${details.reason || ''}\n\n`);
  return value;
}

function output(key, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${String(value)}\n`);
}

async function spec(version) {
  const query = version ? `?version=${version}` : '';
  const response = await fetch(`${baseUrl}/api/managed/openapi.json${query}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Could not fetch published contract: HTTP ${response.status}`);
  const body = await response.json();
  const parsedVersion = Number.parseInt(body.info?.version, 10);
  const required = body.paths?.['/api/managed/quotes']?.post?.requestBody?.content?.['application/json']?.schema?.required;
  if (!Number.isInteger(parsedVersion) || !Array.isArray(required) || !required.every(item => typeof item === 'string')) throw new Error('Invalid published OpenAPI contract');
  return { body, version: parsedVersion, required };
}

function runConsumer(clientSource) {
  const dir = mkdtempSync(join(tmpdir(), 'api-mender-consumer-'));
  try {
    mkdirSync(join(dir, 'src'));
    mkdirSync(join(dir, 'tests'));
    writeFileSync(join(dir, 'src/client.mjs'), clientSource);
    copyFileSync(join(consumer, 'tests/quotes.test.mjs'), join(dir, 'tests/quotes.test.mjs'));
    const child = spawnSync(process.execPath, ['--test', join(dir, 'tests/quotes.test.mjs')], {
      cwd: dir, encoding: 'utf8', timeout: 30000,
      env: { PATH: process.env.PATH || '/usr/bin:/bin', MENDER_TEST_API_URL: baseUrl, HOME: dir, NODE_ENV: 'test' },
    });
    return { passed: child.status === 0, exitCode: child.status, output: `${child.stdout || ''}\n${child.stderr || ''}`.slice(0, 5000) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

function noSecrets(text) {
  return !/sk_(?:live|test|proj)_[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9_]+|(?:api[_-]?key|secret|token)\s*[:=]\s*['"][^'"]+/i.test(text);
}

// First choice: read the change out of the two contracts and rewrite the request from those
// rules. This needs no model and no key. It returns null whenever the rules are not proven or
// do not cover the whole change, and the AI path below takes over.
function menderFix(oldSpec, newSpec, before) {
  const found = rulesFromOpenApi(oldSpec, newSpec);
  if (!found.rules.length || !proveWithSchemas(oldSpec, newSpec, found.rules).ok) return null;
  const fix = fixConsumer(before, found.rules, { paths: ['/api/managed/quotes'] });
  if (fix.after === before || fix.needsDecision) return null;
  return { after: fix.after, summary: fix.summary, needsDecision: null, model: 'Mender rules (no AI)' };
}

async function generateFix(oldSpec, newSpec, before, failure) {
  if (before.length > 30000 || !noSecrets(before)) return { needsDecision: 'Consumer file exceeds the model input limit or may contain a secret.' };
  return generateAiFix({ oldContract: oldSpec, newContract: newSpec, file: 'examples/quote-api-consumer/src/client.mjs', before, failingTest: failure });
}

try {
  const latest = await spec();
  const version = latest.version;
  output('version', version);
  if (version < 2) { report('baseline', { version, reason: 'No newer API version has been published.' }); process.exit(0); }
  const previous = await spec(version - 1);
  const removed = previous.required.filter(field => !latest.required.includes(field));
  const added = latest.required.filter(field => !previous.required.includes(field));
  if (!removed.length && !added.length) { report('no_contract_break', { version, reason: 'The required request fields did not change.' }); process.exit(0); }
  const branch = `codex/managed-quote-v${version}`;
  if (process.env.GITHUB_ACTIONS === 'true') {
    const existing = spawnSync('git', ['ls-remote', '--exit-code', '--heads', 'origin', branch], { cwd: root, encoding: 'utf8', timeout: 15000 });
    if (existing.status === 0) { report('already_proposed', { version, branch }); process.exit(0); }
    if (existing.status !== 2) throw new Error(`Could not inspect existing fix branch: ${existing.stderr}`);
  }
  const before = readFileSync(sourcePath, 'utf8');
  const failing = runConsumer(before);
  if (failing.passed || !failing.output.includes('422')) {
    report('needs_review', { version, removed, added, baselineTest: failing, reason: 'The old consumer did not fail with the expected contract error.' });
    process.exit(0);
  }
  const forceAi = process.env.MENDER_FORCE_AI === '1';
  if (forceAi && (process.env.MENDER_STAGING_RUN !== '1' || !/^http:\/\/127\.0\.0\.1:\d+$/.test(baseUrl))) {
    throw new Error('Forced AI is allowed only against the local staging API.');
  }
  const proposal = (forceAi ? null : menderFix(previous.body, latest.body, before)) ?? await generateFix(previous.body, latest.body, before, failing.output);
  if (proposal.needsDecision) { report('needs_review', { version, removed, added, baselineTest: failing, reason: proposal.needsDecision }); process.exit(0); }
  if (proposal.after === before || proposal.after.length > 30000 || !noSecrets(proposal.after)) {
    report('needs_review', { version, removed, added, reason: 'The proposed fix was empty, unchanged, too large, or contained a possible secret.' });
    process.exit(0);
  }
  const fixed = runConsumer(proposal.after);
  if (!fixed.passed) { report('validation_failed', { version, removed, added, baselineTest: failing, patchedTest: fixed, model: proposal.model }); process.exitCode = 1; }
  else {
    writeFileSync(join(reportDir, 'client.mjs'), proposal.after);
    writeFileSync(join(reportDir, 'pull-request.md'), `## Managed Quote API fix\n\nPublished API contract v${version} changed required request fields: removed ${removed.join(', ') || 'none'}; added ${added.join(', ') || 'none'}.\n\nThe existing consumer failed against the live database-backed API with HTTP 422. The proposed client passed the same live test.\n\nFix written by: ${proposal.model}. Summary: ${proposal.summary}\n\nReview the field mapping before merging. No tests or API server files were changed.\n`);
    report('fix_ready', { version, removed, added, branch, baselineTest: { passed: false, exitCode: failing.exitCode }, patchedTest: { passed: true, exitCode: fixed.exitCode }, model: proposal.model, summary: proposal.summary, usage: proposal.usage });
    output('fix_ready', 'true');
  }
} catch (error) {
  report('error', { reason: error instanceof Error ? error.message : 'Unknown error' });
  process.exitCode = 1;
}
