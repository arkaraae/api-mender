// End-to-end: `mender check` on the GitHub issues pilot with the official
// GitHub REST contract slices, a self-hosted model endpoint (the gateway in
// front of the labelled test double) and the isolated runner.
//
// Also proves the data boundaries: every request leaving the CLI process is
// recorded, the model sees only the excerpt, a hosted AI endpoint is never
// contacted, and the metadata report carries no source.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createGateway, loadConfig as loadGatewayConfig } from '../../model-service/gateway/server.mjs';
import { createStandin } from '../../model-service/standin/server.mjs';
import { check } from '../src/check.mjs';
import { probeNamespace } from '../src/runner/sandbox.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const FIXTURES = path.join(ROOT, 'web/tests/fixtures/github-rest');
const TOKEN = 'e2e-test-token-not-a-secret-0123456789';
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

let standin, standinPort, gateway, gatewayPort, work, isolated, contracts;
const outbound = [];
const realFetch = globalThis.fetch;

before(async () => {
  standin = createStandin();
  standinPort = await listen(standin);
  const config = loadGatewayConfig({
    MENDER_UPSTREAM_URL: `http://127.0.0.1:${standinPort}/v1`,
    MENDER_GATEWAY_TOKENS_SHA256: `e2e:${createHash('sha256').update(TOKEN).digest('hex')}`,
    MENDER_ALLOWED_MODELS: 'mender-test-double',
  });
  gateway = createGateway(config, { log: () => {} });
  gatewayPort = await listen(gateway);
  // Record every request the CLI process makes, by host.
  globalThis.fetch = (input, init) => {
    outbound.push(new URL(typeof input === 'string' || input instanceof URL ? input : input.url).host);
    return realFetch(input, init);
  };
  isolated = (await probeNamespace()).ok;
  // The fixtures are operation slices cut from the official documents; each
  // holds a self-contained OpenAPI document, which is what the CLI reads.
  contracts = mkdtempSync(path.join(tmpdir(), 'mender-contracts-'));
  for (const version of ['2022-11-28', '2026-03-10']) {
    const slice = JSON.parse(readFileSync(path.join(FIXTURES, `issues-create.${version}.json`), 'utf8'));
    writeFileSync(path.join(contracts, `${version}.json`), JSON.stringify(slice.document));
  }
});

after(() => {
  globalThis.fetch = realFetch;
  standin?.close(); gateway?.close();
  if (work) rmSync(work, { recursive: true, force: true });
  if (contracts) rmSync(contracts, { recursive: true, force: true });
});

function pilotRepo() {
  work = mkdtempSync(path.join(tmpdir(), 'mender-e2e-'));
  const repo = path.join(work, 'repo');
  cpSync(path.join(ROOT, 'examples/github-issues-consumer'), repo, { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  git('init', '-q'); git('add', '-A');
  git('-c', 'user.name=pilot', '-c', 'user.email=pilot@example.invalid', 'commit', '-qm', 'pilot');
  return repo;
}

const flags = (repo, extra = {}) => ({
  repo, out: path.join(work, `out-${Math.random().toString(36).slice(2)}`), provider: 'github-rest',
  from: '2022-11-28', to: '2026-03-10',
  oldContract: path.join(contracts, '2022-11-28.json'),
  newContract: path.join(contracts, '2026-03-10.json'),
  modelEndpoint: `http://127.0.0.1:${gatewayPort}/v1`, model: 'mender-test-double',
  ...(isolated ? {} : { unsafeNoIsolation: true }), ...extra,
});

test('scan → finding → self-hosted model patch → isolated checks → patch file and reports', async t => {
  if (!isolated) t.diagnostic('namespace runner unavailable here; checks run with --unsafe-no-isolation');
  const repo = pilotRepo();
  const original = readFileSync(path.join(repo, 'src/issues.mjs'), 'utf8');
  process.env.MENDER_MODEL_API_KEY = TOKEN;
  outbound.length = 0;
  const { report, metadata, out } = await check(flags(repo));
  delete process.env.MENDER_MODEL_API_KEY;

  // Integrated Services: the GitHub call is discovered.
  const github = report.services.find(service => service.providerId === 'github-rest');
  assert.deepEqual([github.callCount, github.pinnedVersions, github.files], [1, ['2022-11-28'], ['src/issues.mjs']]);

  // Evidence-backed finding at the exact call.
  assert.equal(report.results.length, 1);
  const [{ finding, repair, validation, patchFile }] = report.results;
  assert.equal(finding.change.kind, 'request-property-removed');
  assert.deepEqual(finding.change.fields, ['assignee']);
  assert.deepEqual([finding.location.file, finding.location.line], ['src/issues.mjs', 3]);
  assert.equal(finding.evidence.pinnedVersion, '2022-11-28');
  assert.equal(finding.evidence.applicability, 'on-upgrade');
  assert.equal(finding.verification, 'static-inferred');

  // Bounded patch from the self-hosted endpoint, every gate passed.
  assert.equal(repair.method, 'self-hosted-model');
  assert.equal(repair.model, 'mender-test-double');
  assert.ok(repair.policy.length >= 10 && repair.policy.every(check => check.passed));
  assert.match(repair.diff, /^-    body: JSON\.stringify\(\{ title, body: details, assignee: onCall, labels: \['bug'\] \}\),$/m);
  assert.match(repair.diff, /^\+    body: JSON\.stringify\(\{ title, body: details, assignees: \[onCall\], labels: \['bug'\] \}\),$/m);
  assert.equal(readFileSync(path.resolve(patchFile), 'utf8'), repair.diff);
  execFileSync('git', ['apply', '--check', path.resolve(patchFile)], { cwd: repo });
  assert.equal(readFileSync(path.join(repo, 'src/issues.mjs'), 'utf8'), original, 'the working tree is never modified');

  // Isolated validation: the next-version check fails before and passes after.
  assert.equal(validation.patchApplied, true);
  assert.equal(validation.isolation.network, isolated ? 'none' : 'host');
  assert.deepEqual(validation.before.map(c => [c.name, c.passed]), [['unit', true], ['unit-next-api-version', false]]);
  assert.deepEqual(validation.after.map(c => [c.name, c.passed]), [['unit', true], ['unit-next-api-version', true]]);
  assert.equal(validation.breakReproduced, true);
  assert.equal(validation.checksPassed, true);
  assert.match(validation.statement, /does not prove behavior is correct/);

  // Only the local gateway was contacted (and, because it runs in this test
  // process, its own call to the model server behind it). No hosted AI API,
  // no contract download, no upload.
  assert.deepEqual([...new Set(outbound)].sort(), [`127.0.0.1:${gatewayPort}`, `127.0.0.1:${standinPort}`].sort());

  // The model saw the excerpt around the call and nothing else of the file.
  const prompt = JSON.stringify(standin.requests.at(-1));
  assert.match(prompt, /assignee: onCall/);
  assert.doesNotMatch(prompt, /assignedTo/, 'line outside the excerpt was sent');
  assert.doesNotMatch(prompt, /installFakeGitHub|octocat/, 'test files were sent');
  assert.equal(standin.requests.at(-1).tools, undefined);

  // The metadata report has hashes and outcomes, never code.
  const serialized = JSON.stringify(metadata);
  for (const forbidden of ['onCall', 'JSON.stringify', 'fetch(', 'Bearer', 'assignedTo', 'node --test'])
    assert.ok(!serialized.includes(forbidden), `metadata report contains ${forbidden}`);
  assert.equal(metadata.findings[0].status, 'checks-passed');
  assert.equal(metadata.findings[0].verification, 'test-confirmed');
  assert.equal(metadata.findings[0].file, undefined, 'filePaths is not enabled in the pilot config');
  assert.deepEqual(JSON.parse(readFileSync(path.join(out, 'metadata-report.json'), 'utf8')), metadata);
});

test('a hosted AI endpoint is refused before any request is made', async () => {
  const repo = pilotRepo();
  for (const endpoint of ['https://api.openai.com/v1', 'https://api.anthropic.com/v1', 'https://openrouter.ai/api/v1']) {
    outbound.length = 0;
    const { report } = await check(flags(repo, { modelEndpoint: endpoint, allowRemoteModel: true }));
    const [{ repair, validation }] = report.results;
    assert.equal(repair.abstained, true, endpoint);
    assert.equal(repair.stage, 'model-unavailable', endpoint);
    assert.equal(validation, undefined);
    assert.deepEqual(outbound, [], `${endpoint} was contacted`);
  }
});

test('a remote model endpoint needs an explicit operator flag in customer-managed mode', async () => {
  const repo = pilotRepo();
  outbound.length = 0;
  const { report } = await check(flags(repo, { modelEndpoint: 'https://models.example.com/v1' }));
  assert.equal(report.results[0].repair.stage, 'model-unavailable');
  assert.deepEqual(outbound, []);
});

test('a file that is not an OpenAPI document is refused, not read as "no operations"', async () => {
  const repo = pilotRepo();
  await assert.rejects(check(flags(repo, { oldContract: path.join(FIXTURES, 'issues-create.2022-11-28.json') })),
    /not an OpenAPI 3\.0\/3\.1 document/);
});

test('without a model the finding is still reported and the repair abstains', async () => {
  const repo = pilotRepo();
  outbound.length = 0;
  const { report, metadata } = await check(flags(repo, { noModel: true }));
  assert.equal(report.results[0].repair.stage, 'unsupported');
  assert.equal(metadata.findings[0].status, 'abstained');
  assert.deepEqual(outbound, []);
});
