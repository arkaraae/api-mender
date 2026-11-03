import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

function git(cwd, ...args) { return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim(); }

test('proof action requires a reproduced base failure and a passing repair commit', () => {
  const root = mkdtempSync(join(tmpdir(), 'mender-action-test-'));
  const origin = join(root, 'origin.git');
  const repo = join(root, 'repo');
  try {
    execFileSync('git', ['init', '--bare', origin], { stdio: 'ignore' });
    execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' });
    git(repo, 'config', 'user.email', 'test@example.invalid');
    git(repo, 'config', 'user.name', 'Mender Test');
    git(repo, 'remote', 'add', 'origin', origin);
    writeFileSync(join(repo, 'test.mjs'), "console.error('API returned 422'); process.exit(1);\n");
    git(repo, 'add', '.'); git(repo, 'commit', '-m', 'broken consumer');
    const base = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'push', 'origin', 'main');
    git(repo, 'checkout', '-b', 'mender/repair-test');
    writeFileSync(join(repo, 'test.mjs'), "console.log('API returned 200');\n");
    git(repo, 'add', '.'); git(repo, 'commit', '-m', 'repair consumer');
    const head = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'push', 'origin', 'mender/repair-test');
    git(repo, 'remote', 'remove', 'origin');
    const eventFile = join(root, 'event.json');
    writeFileSync(eventFile, JSON.stringify({ pull_request: { base: { sha: base, repo: { id: 1 } },
      head: { sha: head, ref: 'mender/repair-test', repo: { id: 1 } } } }));
    const env = { ...process.env, GITHUB_EVENT_PATH: eventFile, GITHUB_WORKSPACE: repo,
      MENDER_TEST_COMMAND: 'node test.mjs', MENDER_EXPECTED_BEFORE_OUTPUT: 'API returned 422' };
    const script = fileURLToPath(new URL('./verify.mjs', import.meta.url));
    const success = spawnSync(process.execPath, [script], { env, encoding: 'utf8' });
    assert.equal(success.status, 0, success.stderr);
    assert.match(success.stdout, /expected API failure reproduced/);
    const wrongFailure = spawnSync(process.execPath, [script], {
      env: { ...env, MENDER_EXPECTED_BEFORE_OUTPUT: 'different API error' }, encoding: 'utf8',
    });
    assert.notEqual(wrongFailure.status, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
