// Structural validation and application of a single-file unified diff.
//
// The diff may have been written by a model. `git apply` is a capable tool
// (renames, mode changes, binary patches, new files, symlinks), so we do not
// hand it anything until we have parsed the diff ourselves against a strict
// grammar and know that it can only edit the text of the ONE expected file:
//
//   [diff --git a/<file> b/<file>]
//   [index <hex>..<hex>[ <mode>]]
//   --- a/<file>
//   +++ b/<file>
//   one or more hunks, each fully accounted for by its @@ line counts
//
// Anything else — a second file, extended headers, /dev/null, trailing
// content after the last hunk — is rejected. Counting hunk lines is what
// lets us tell a removed line that reads "-- a/other" from a real header.

import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import path from 'node:path';

import { isSafeRelativePath } from './workspace.mjs';

export const MAX_DIFF_BYTES = 1024 * 1024;

export class PatchValidationError extends Error {
  constructor(message) {
    super(`patch rejected: ${message}`);
    this.name = 'PatchValidationError';
    this.code = 'EMENDERPATCH';
  }
}

const reject = (message) => {
  throw new PatchValidationError(message);
};

/** Validates the path a patch is allowed to touch. */
export function validatePatchPath(file) {
  if (typeof file !== 'string' || file.length === 0 || file.length > 1000) reject('file path must be a non-empty string');
  if (file.startsWith('/') || /^[A-Za-z]:/.test(file)) reject(`absolute path not allowed: ${JSON.stringify(file)}`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f"\\]/.test(file)) reject('file path contains control characters, quotes or backslashes');
  const segments = file.split('/');
  if (segments.includes('..')) reject(`path traversal ("..") not allowed: ${JSON.stringify(file)}`);
  if (segments.some((s) => s.toLowerCase() === '.git')) reject(`paths under .git are not allowed: ${JSON.stringify(file)}`);
  if (!isSafeRelativePath(file)) reject(`not a normalised relative path: ${JSON.stringify(file)}`);
}

const FORBIDDEN_HEADERS = [
  [/^(old|new) mode /, 'mode changes are not allowed'],
  [/^(deleted|new) file mode /, 'creating or deleting files is not allowed'],
  [/^(rename|copy) (from|to) /, 'renames and copies are not allowed'],
  [/^(dis)?similarity index /, 'renames and copies are not allowed'],
  [/^GIT binary patch/, 'binary patches are not allowed'],
  [/^Binary files /, 'binary patches are not allowed'],
];

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function checkFileHeader(line, marker, prefix, file) {
  const rest = line.slice(4).replace(/\t$/, ''); // git appends a tab when the name has spaces
  if (rest === '/dev/null') reject('creating or deleting files (/dev/null) is not allowed');
  if (rest !== `${prefix}/${file}`) {
    reject(`the diff's "${marker}" header names ${JSON.stringify(rest)}, expected ${JSON.stringify(`${prefix}/${file}`)}`);
  }
}

/** Consumes one hunk starting at lines[i] (the @@ line); returns the index after it. */
function consumeHunk(lines, i) {
  const match = HUNK_HEADER.exec(lines[i]);
  if (!match) reject(`expected a hunk header at line ${i + 1}`);
  let oldLeft = match[2] === undefined ? 1 : Number(match[2]);
  let newLeft = match[4] === undefined ? 1 : Number(match[4]);
  if (oldLeft > 100_000 || newLeft > 100_000) reject('hunk is implausibly large');
  let cursor = i + 1;
  while (oldLeft > 0 || newLeft > 0) {
    const line = lines[cursor];
    if (line === undefined) reject('diff ends in the middle of a hunk');
    const tag = line[0];
    if (tag === ' ' || line === '') {
      oldLeft -= 1;
      newLeft -= 1;
    } else if (tag === '-') oldLeft -= 1;
    else if (tag === '+') newLeft -= 1;
    else if (tag !== '\\') reject(`unexpected line ${cursor + 1} inside a hunk`);
    if (oldLeft < 0 || newLeft < 0) reject(`hunk line counts do not match its header (line ${cursor + 1})`);
    cursor += 1;
  }
  if (lines[cursor]?.startsWith('\\')) cursor += 1; // "\ No newline at end of file"
  return cursor;
}

/**
 * Throws `PatchValidationError` unless `diff` is a plain text edit of exactly
 * `file`. Does not touch the filesystem.
 *
 * @param {string} diff
 * @param {string} file repository-relative path, forward slashes
 */
export function validateDiff(diff, file) {
  validatePatchPath(file);
  if (typeof diff !== 'string' || diff.length === 0) reject('the diff is empty');
  if (Buffer.byteLength(diff) > MAX_DIFF_BYTES) reject(`the diff is larger than ${MAX_DIFF_BYTES} bytes`);
  if (diff.includes('\0')) reject('the diff contains a NUL byte');

  const lines = diff.split('\n');
  if (lines.at(-1) === '') lines.pop();
  let i = 0;

  if (lines[i]?.startsWith('diff ')) {
    if (lines[i] !== `diff --git a/${file} b/${file}`) {
      reject(`the "diff --git" header does not name only ${JSON.stringify(file)}`);
    }
    i += 1;
  }
  // Explicit messages for the dangerous extended headers, wherever they sit before the hunks.
  for (let j = i; j < lines.length && !lines[j].startsWith('@@'); j += 1) {
    for (const [pattern, message] of FORBIDDEN_HEADERS) if (pattern.test(lines[j])) reject(message);
  }
  if (/^index [0-9a-f]+\.\.[0-9a-f]+( [0-7]{6})?$/.test(lines[i] ?? '')) i += 1;

  if (!lines[i]?.startsWith('--- ')) reject(`expected "--- a/${file}" at line ${i + 1}`);
  checkFileHeader(lines[i], '---', 'a', file);
  i += 1;
  if (!lines[i]?.startsWith('+++ ')) reject(`expected "+++ b/${file}" at line ${i + 1}`);
  checkFileHeader(lines[i], '+++', 'b', file);
  i += 1;

  if (!lines[i]?.startsWith('@@')) reject('the diff has no hunks');
  while (i < lines.length) {
    if (!lines[i].startsWith('@@')) {
      reject(
        lines[i].startsWith('diff ') || lines[i].startsWith('--- ')
          ? 'the diff touches more than one file; exactly one is allowed'
          : `unexpected content after the last hunk (line ${i + 1})`,
      );
    }
    i = consumeHunk(lines, i);
  }
}

/**
 * Throws unless `file` under `root` is a regular file reached only through
 * real directories. A symlink anywhere on the path could redirect the edit
 * outside the tree.
 */
export async function assertRegularFileInTree(root, file) {
  const segments = file.split('/');
  let current = root;
  for (let i = 0; i < segments.length; i += 1) {
    current = path.join(current, segments[i]);
    const stats = await lstat(current).catch(() => null);
    const isLast = i === segments.length - 1;
    if (!stats) reject(`${JSON.stringify(file)} does not exist in the repository copy`);
    if (stats.isSymbolicLink()) reject(`${JSON.stringify(segments.slice(0, i + 1).join('/'))} is a symbolic link; patches may only edit regular files`);
    if (isLast ? !stats.isFile() : !stats.isDirectory()) reject(`${JSON.stringify(file)} is not a regular file`);
  }
}

function git(args, { cwd, env, input }) {
  return new Promise((resolve) => {
    const child = spawn('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.stderr.on('data', (c) => {
      if (stderr.length < 4000) stderr += c;
    });
    child.stdout.resume();
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, detail: `could not run git: ${error.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, detail: stderr.trim() });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

/**
 * Applies an already-validated diff inside `treeDir` with `git apply`.
 *
 * git runs with a scrubbed environment, no system/global config, a ceiling
 * that stops it discovering any enclosing repository, the diff on stdin, and
 * without `--unsafe-paths`, so it refuses anything outside `treeDir`.
 *
 * @returns {Promise<{ applied: boolean, detail: string }>}
 */
export async function applyValidatedDiff({ treeDir, diff, file, ceilingDir, homeDir }) {
  validateDiff(diff, file);
  await assertRegularFileInTree(treeDir, file);
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: homeDir,
    LANG: 'C.UTF-8',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CEILING_DIRECTORIES: ceilingDir,
  };
  const input = diff.endsWith('\n') ? diff : `${diff}\n`;
  const common = ['apply', '--whitespace=nowarn', '-p1'];
  const check = await git([...common, '--check', '-'], { cwd: treeDir, env, input });
  if (!check.ok) return { applied: false, detail: check.detail };
  const apply = await git([...common, '-'], { cwd: treeDir, env, input });
  return { applied: apply.ok, detail: apply.detail };
}
