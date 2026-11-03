import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const sha = /^[a-f0-9]{40}$/;
const command = process.env.MENDER_TEST_COMMAND || '';
const expected = process.env.MENDER_EXPECTED_BEFORE_OUTPUT || '';
const eventFile = process.env.GITHUB_EVENT_PATH;
if (!eventFile || command.length < 1 || command.length > 500
  || expected.length < 1 || expected.length > 200)
  throw new Error('Mender proof needs a focused test command and expected failure text');

const event = JSON.parse(readFileSync(eventFile, 'utf8'));
const pr = event.pull_request;
const base = pr?.base?.sha;
const head = pr?.head?.sha;
if (!sha.test(base || '') || !sha.test(head || '')
  || !pr?.head?.ref?.startsWith('mender/repair-')
  || pr.head.repo?.id !== pr.base.repo?.id)
  throw new Error('Mender proof must run on a same-repository repair pull request');

const repo = process.env.GITHUB_WORKSPACE || process.cwd();
const temporary = mkdtempSync(join(tmpdir(), 'mender-proof-'));
const before = join(temporary, 'before');
const after = join(temporary, 'after');

function git(...args) {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 60_000, maxBuffer: 2_000_000 });
  if (result.error || result.status !== 0) throw new Error(`Git operation failed: ${args[0]}`);
}

function testAt(path, phase) {
  const result = spawnSync('bash', ['-lc', command], {
    cwd: path, encoding: 'utf8', timeout: 300_000, maxBuffer: 2_000_000,
    env: { ...process.env, MENDER_PROOF_PHASE: phase },
  });
  if (result.error) throw new Error(`${phase} test could not finish`);
  return { code: result.status, output: `${result.stdout || ''}\n${result.stderr || ''}` };
}

try {
  git('fetch', '--no-tags', 'origin', base, head);
  git('worktree', 'add', '--detach', before, base);
  git('worktree', 'add', '--detach', after, head);
  const original = testAt(before, 'before');
  if (original.code === 0 || !original.output.includes(expected))
    throw new Error('Before test did not reproduce the expected API failure');
  const repaired = testAt(after, 'after');
  if (repaired.code !== 0) throw new Error('After test did not pass on the repair commit');
  console.log('Mender proof: expected API failure reproduced on base; focused test passed on repair commit.');
} finally {
  for (const path of [before, after]) {
    try { git('worktree', 'remove', '--force', path); } catch { /* directory may not exist */ }
  }
  rmSync(temporary, { recursive: true, force: true });
}
