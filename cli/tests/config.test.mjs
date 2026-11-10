import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ConfigError, loadConfig, resolveRunnerOptions, validateConfig, validateChecks } from '../src/config.mjs';

const FULL = {
  checks: [{ name: 'unit', command: ['npm', 'test'], env: { GITHUB_API_VERSION: '2026-03-10' } }],
  runner: { backend: 'auto', wallSeconds: 120, cpuSeconds: 60, memoryMb: 1024, pids: 256, network: 'none' },
  model: { endpoint: 'http://127.0.0.1:8080/v1', model: 'qwen2.5-coder:7b' },
  report: { upload: false, fields: ['providers', 'findingStatus', 'filePaths', 'hashes', 'validation'] },
};
const clone = (value) => JSON.parse(JSON.stringify(value));
const withChange = (mutate) => {
  const copy = clone(FULL);
  mutate(copy);
  return copy;
};
const rejects = (raw, pattern) =>
  assert.throws(() => validateConfig(raw), (error) => error instanceof ConfigError && pattern.test(error.message), `${pattern}`);

test('accepts the documented example and returns a frozen, normalised config', () => {
  const config = validateConfig(FULL);
  assert.deepEqual(clone(config), FULL);
  assert.ok(Object.isFrozen(config) && Object.isFrozen(config.checks) && Object.isFrozen(config.checks[0].command));
  assert.ok(Object.isFrozen(config.checks[0].env) && Object.isFrozen(config.runner) && Object.isFrozen(config.report.fields));
});

test('an empty object yields safe defaults', () => {
  const config = validateConfig({});
  assert.deepEqual(clone(config), {
    checks: [],
    runner: { backend: 'auto', wallSeconds: 120, cpuSeconds: 60, memoryMb: 1024, pids: 256, network: 'none' },
    model: null,
    report: { upload: false, fields: ['providers', 'findingStatus', 'filePaths', 'hashes', 'validation'] },
  });
});

test('rejects non-objects and unknown keys at every level', () => {
  for (const raw of [null, [], 'x', 3]) rejects(raw, /top level/);
  rejects({ extra: 1 }, /config: unknown key "extra"/);
  rejects(withChange((c) => (c.checks[0].shell = true)), /checks\[0\]: unknown key "shell"/);
  rejects(withChange((c) => (c.runner.image = 'evil')), /runner: unknown key "image"/);
  rejects(withChange((c) => (c.model.temperature = 1)), /model: unknown key "temperature"/);
  rejects(withChange((c) => (c.report.endpoint = 'https://evil.example')), /report: unknown key "endpoint"/);
  rejects(withChange((c) => (c.report.token = 'x')), /report: unknown key "token"/);
  rejects(JSON.parse('{"__proto__": {"checks": []}}'), /unknown key "__proto__"/);
});

test('reports every problem at once', () => {
  try {
    validateConfig({ bogus: 1, checks: [{ name: 'bad name', command: 'npm test' }], runner: { pids: 1 } });
    assert.fail('should have thrown');
  } catch (error) {
    assert.equal(error.problems.length, 4);
  }
});

test('checks: count, names and uniqueness', () => {
  const check = (i) => ({ name: `c${i}`, command: ['true'] });
  validateConfig({ checks: Array.from({ length: 10 }, (_, i) => check(i)) });
  rejects({ checks: Array.from({ length: 11 }, (_, i) => check(i)) }, /more than 10/);
  rejects({ checks: {} }, /checks must be an array/);
  rejects({ checks: ['npm test'] }, /checks\[0\] must be an object/);
  for (const name of ['', 'has space', 'a/b', 'x'.repeat(41), 7, undefined]) {
    rejects({ checks: [{ name, command: ['true'] }] }, /name must match/);
  }
  rejects({ checks: [check(1), check(1)] }, /used more than once/);
});

test('checks: command must be an argv array, never a shell string', () => {
  rejects({ checks: [{ name: 'a', command: 'npm test && curl evil' }] }, /not a shell string/);
  rejects({ checks: [{ name: 'a' }] }, /array of 1 to 20/);
  rejects({ checks: [{ name: 'a', command: [] }] }, /array of 1 to 20/);
  rejects({ checks: [{ name: 'a', command: Array(21).fill('x') }] }, /array of 1 to 20/);
  rejects({ checks: [{ name: 'a', command: ['npm', 1] }] }, /command\[1\] must be a string/);
  rejects({ checks: [{ name: 'a', command: ['x'.repeat(201)] }] }, /longer than 200/);
  rejects({ checks: [{ name: 'a', command: ['ok', 'nul\0byte'] }] }, /NUL/);
  rejects({ checks: [{ name: 'a', command: [''] }] }, /must not be empty/);
  // Shell metacharacters are legal argv DATA; they are never interpreted.
  assert.deepEqual(validateConfig({ checks: [{ name: 'a', command: ['echo', '$(id); rm -rf /'] }] }).checks[0].command, ['echo', '$(id); rm -rf /']);
});

test('checks: env names, sizes and forbidden variables', () => {
  const withEnv = (env) => ({ checks: [{ name: 'a', command: ['true'], env }] });
  validateConfig(withEnv({ A: '', _B9: 'x'.repeat(500) }));
  rejects(withEnv([]), /env must be an object/);
  rejects(withEnv({ lower: 'x' }), /must match/);
  rejects(withEnv({ '1A': 'x' }), /must match/);
  rejects(withEnv({ ['A'.repeat(65)]: 'x' }), /must match/);
  rejects(withEnv({ A: 'x'.repeat(501) }), /longer than 500/);
  rejects(withEnv({ A: 1 }), /must be a string/);
  rejects(withEnv({ A: 'a\0b' }), /NUL/);
  rejects(withEnv(Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`V${i}`, 'x']))), /more than 20/);
  for (const name of ['PATH', 'HOME', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'NODE_OPTIONS', 'NODE_PATH',
    'GIT_SSH_COMMAND', 'GIT_DIR', 'SSH_AUTH_SOCK', 'BASH_ENV', 'ENV']) {
    rejects(withEnv({ [name]: 'x' }), new RegExp(`${name} may not be set`));
  }
  assert.throws(() => validateChecks([{ name: 'a', command: ['true'], env: { LD_PRELOAD: '/x.so' } }]), ConfigError);
});

test('runner: backend, bounds and network', () => {
  for (const backend of ['auto', 'container', 'namespace']) validateConfig({ runner: { backend } });
  // No isolation can only come from the operator, never from the repository.
  rejects({ runner: { backend: 'process' } }, /cannot be set in the config file/);
  assert.equal(resolveRunnerOptions({ runner: {} }, { backend: 'process' }).backend, 'process');
  assert.throws(() => resolveRunnerOptions({ runner: { backend: 'process' } }), /cannot be set in the config file/);
  rejects({ runner: { backend: 'vm' } }, /backend must be one of/);
  rejects({ runner: [] }, /runner must be an object/);
  const bounds = { wallSeconds: [1, 1800], cpuSeconds: [1, 1800], memoryMb: [64, 16384], pids: [16, 4096] };
  for (const [key, [min, max]] of Object.entries(bounds)) {
    validateConfig({ runner: { [key]: min } });
    validateConfig({ runner: { [key]: max } });
    for (const bad of [min - 1, max + 1, 1.5, '60', null]) rejects({ runner: { [key]: bad } }, new RegExp(`runner.${key} must be an integer`));
  }
  rejects({ runner: { network: 'host' } }, /cannot be set in the config file/);
  rejects({ runner: { network: 'bridge' } }, /network must be "none"/);
});

test('model: endpoint must be a URL and the key must never be in the file', () => {
  rejects(withChange((c) => (c.model.apiKey = 'sk-secret')), /model\.apiKey: do not put a credential/);
  rejects(withChange((c) => (c.model.endpoint = 'not a url')), /valid URL/);
  rejects(withChange((c) => (c.model.endpoint = 'file:///etc/passwd')), /http: or https:/);
  rejects(withChange((c) => (c.model.endpoint = 'https://user:pw@models.example/v1')), /must not contain credentials/);
  rejects(withChange((c) => delete c.model.endpoint), /endpoint must be a URL string/);
  rejects(withChange((c) => (c.model.model = '')), /model\.model/);
  // The repository cannot choose which secret becomes the bearer token.
  rejects(withChange((c) => (c.model.apiKeyEnv = 'GITHUB_TOKEN')), /not read from the repository/);
  rejects({ model: 'gpt' }, /model must be an object/);
  assert.equal(validateConfig(clone(FULL)).model.apiKeyEnv, undefined);
});

test('report: upload defaults to false and fields are a subset of the allowed list', () => {
  assert.equal(validateConfig({ report: {} }).report.upload, false);
  assert.deepEqual(validateConfig({ report: { fields: ['hashes', 'providers'] } }).report.fields, ['providers', 'hashes']);
  assert.deepEqual(validateConfig({ report: { fields: [] } }).report.fields, []);
  rejects({ report: { upload: 'yes' } }, /upload must be true or false/);
  rejects({ report: { fields: ['providers', 'sourceCode'] } }, /"sourceCode"\] not allowed/);
  rejects({ report: { fields: ['hashes', 'hashes'] } }, /must not repeat/);
  rejects({ report: { fields: 'all' } }, /must be an array/);
});

test('resolveRunnerOptions: host network only through an explicit override', () => {
  const config = validateConfig({ runner: { wallSeconds: 30 } });
  assert.deepEqual({ ...resolveRunnerOptions(config) }, { backend: 'auto', wallSeconds: 30, cpuSeconds: 60, memoryMb: 1024, pids: 256, network: 'none' });
  const overridden = resolveRunnerOptions(config, { network: 'host', backend: 'namespace', pids: 64, image: 'node:22-alpine', memoryMb: undefined });
  assert.deepEqual({ ...overridden }, { backend: 'namespace', wallSeconds: 30, cpuSeconds: 60, memoryMb: 1024, pids: 64, network: 'host', image: 'node:22-alpine' });
  assert.ok(Object.isFrozen(overridden));
  // A hand-built "config" cannot smuggle host network in.
  assert.throws(() => resolveRunnerOptions({ runner: { network: 'host' } }), /cannot be set in the config file/);
  assert.throws(() => resolveRunnerOptions(config, { wallSeconds: 99999 }), /overrides.wallSeconds/);
  assert.throws(() => resolveRunnerOptions(config, { shell: true }), /unknown key "shell"/);
  assert.throws(() => resolveRunnerOptions(config, { image: 'bad image; rm' }), /image/);
  assert.equal(resolveRunnerOptions(null).network, 'none');
});

test('loadConfig: missing file gives defaults; file is read as JSON only', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mender-config-'));
  try {
    const defaults = await loadConfig(dir);
    assert.equal(defaults.source, 'defaults');
    assert.equal(defaults.path, null);
    assert.deepEqual([...defaults.checks], []);
    assert.equal(defaults.report.upload, false);

    writeFileSync(path.join(dir, 'mender.config.json'), JSON.stringify(FULL));
    const loaded = await loadConfig(dir);
    assert.equal(loaded.source, 'file');
    assert.equal(loaded.path, path.join(dir, 'mender.config.json'));
    assert.deepEqual(clone(loaded.checks), FULL.checks);
    assert.ok(Object.isFrozen(loaded));

    writeFileSync(path.join(dir, 'other.json'), '{"checks": [}');
    await assert.rejects(loadConfig(dir, { fileName: 'other.json' }), /other\.json is not valid JSON/);
    writeFileSync(path.join(dir, 'other.json'), JSON.stringify({ runner: { network: 'host' }, model: { apiKey: 'x' } }));
    await assert.rejects(loadConfig(dir, { fileName: 'other.json' }), (error) =>
      error instanceof ConfigError && /Invalid other\.json/.test(error.message) && error.problems.length >= 2);

    await assert.rejects(loadConfig(dir, { fileName: 'mender.config.js' }), /plain \*\.json/);
    await assert.rejects(loadConfig(dir, { fileName: '../x.json' }), /plain \*\.json/);
    writeFileSync(path.join(dir, 'big.json'), `{"checks": [], "pad": "${'x'.repeat(70 * 1024)}"}`);
    await assert.rejects(loadConfig(dir, { fileName: 'big.json' }), /larger than/);
    symlinkSync('/etc/hostname', path.join(dir, 'link.json'));
    await assert.rejects(loadConfig(dir, { fileName: 'link.json' }), /regular file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
