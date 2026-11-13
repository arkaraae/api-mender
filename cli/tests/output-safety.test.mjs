import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareOut, write } from '../src/check.mjs';
import { redactSecrets as redact } from '../src/runner/redact.mjs';

test('output folder refuses a symlink planted by the repository', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mender-out-'));
  try {
    const victim = path.join(root, 'victim');
    mkdirSync(victim);
    symlinkSync(victim, path.join(root, '.mender'));
    await assert.rejects(prepareOut(path.join(root, '.mender')), /symlink/);

    const real = path.join(root, 'real');
    mkdirSync(real);
    symlinkSync(victim, path.join(real, 'patches'));
    await assert.rejects(prepareOut(real), /symlink/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('writing a report replaces a planted file symlink instead of following it', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mender-out-'));
  try {
    const target = path.join(root, 'bashrc');
    writeFileSync(target, 'original\n');
    const out = path.join(root, 'out');
    await prepareOut(out);
    symlinkSync(target, path.join(out, 'report.json'));
    await write(path.join(out, 'report.json'), { ok: true });
    assert.equal(readFileSync(target, 'utf8'), 'original\n');
    assert.deepEqual(JSON.parse(readFileSync(path.join(out, 'report.json'), 'utf8')), { ok: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('redaction stays fast on long credential-like runs', () => {
  const started = Date.now();
  redact('token'.repeat(20000) + ' x');
  redact('a'.repeat(50000) + 'secret' + 'b'.repeat(50000));
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started}ms`);
  assert.match(redact('API_KEY = "abcdef123456"'), /\[REDACTED\]/);
});
