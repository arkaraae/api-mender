// Copies a repository working tree into a private workspace.
//
// Checks never run in the real working tree. What gets copied:
//   * with a `.git` present: tracked files plus untracked files that are not
//     ignored (`git ls-files --cached --others --exclude-standard`);
//   * otherwise: every file found by walking the directory.
//   * `.git` itself is never copied (it can hold credentials in its config
//     and hooks that later tooling might run).
//   * top-level `node_modules` is copied separately when `copyNodeModules`
//     is on, because checks usually need it and the sandbox has no network
//     to install it. Symlinks in it are copied verbatim, never followed.
//
// Symlinks are copied as symlinks only when their resolved target stays
// inside the repository; anything else is skipped and recorded, so the copy
// cannot be used to pull in (or later write through to) outside files.

import { execFile } from 'node:child_process';
import { copyFile, cp, lstat, mkdir, readdir, readlink, realpath, symlink } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_MAX_FILES = 20_000;
export const DEFAULT_MAX_BYTES = 500 * 1024 * 1024;
/** node_modules is bounded by entry count only (it is installed code, not sources). */
export const DEFAULT_MAX_NODE_MODULES_ENTRIES = 300_000;

export class WorkspaceLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WorkspaceLimitError';
    this.code = 'EMENDERWORKSPACELIMIT';
  }
}

const isGitSegment = (segment) => segment.toLowerCase() === '.git';

/** True for a relative, normalised path with no `..` and no `.git` component. */
export function isSafeRelativePath(rel) {
  if (typeof rel !== 'string' || rel.length === 0 || rel.includes('\0') || path.isAbsolute(rel)) return false;
  const segments = rel.split('/');
  return segments.every((s) => s !== '' && s !== '.' && s !== '..' && !isGitSegment(s));
}

function gitListFiles(repoRoot) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      // The repository's own git config must not get to run anything here.
      ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      {
        cwd: repoRoot,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0', LANG: 'C.UTF-8' },
        maxBuffer: 64 * 1024 * 1024,
        timeout: 60_000,
        killSignal: 'SIGKILL',
      },
      (error, stdout) => (error ? reject(error) : resolve([...new Set(stdout.split('\0').filter(Boolean))])),
    );
  });
}

async function walkFiles(repoRoot, maxFiles) {
  const files = [];
  const pending = [''];
  while (pending.length > 0) {
    const dir = pending.pop();
    for (const entry of await readdir(path.join(repoRoot, dir), { withFileTypes: true })) {
      if (isGitSegment(entry.name)) continue;
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (rel === 'node_modules') continue;
      if (entry.isDirectory()) pending.push(rel);
      else files.push(rel);
      if (files.length > maxFiles) throw tooManyFiles(maxFiles);
    }
  }
  return files;
}

const tooManyFiles = (maxFiles) =>
  new WorkspaceLimitError(`the repository has more than ${maxFiles} files to copy; raise maxFiles or add build output to .gitignore`);

/**
 * @param {string} repoRoot real path of the repository
 * @returns {Promise<{ files: string[], notes: string[] }>}
 */
async function listFiles(repoRoot, maxFiles) {
  let hasGit = false;
  try {
    await lstat(path.join(repoRoot, '.git'));
    hasGit = true;
  } catch {
    /* not a git checkout */
  }
  if (hasGit) {
    try {
      return { files: await gitListFiles(repoRoot), notes: [] };
    } catch (error) {
      const files = await walkFiles(repoRoot, maxFiles);
      return { files, notes: [`git could not list files (${String(error.message).split('\n')[0]}); copied every file found, including git-ignored ones`] };
    }
  }
  return { files: await walkFiles(repoRoot, maxFiles), notes: ['not a git checkout; copied every file found'] };
}

/** Copies one symlink if its target resolves inside the repository. Returns a skip reason or null. */
async function copySymlink(repoRoot, rel, dest) {
  const source = path.join(repoRoot, rel);
  let target;
  try {
    target = await realpath(source);
  } catch {
    return 'dangling symlink';
  }
  if (target !== repoRoot && !target.startsWith(`${repoRoot}/`)) return 'symlink points outside the repository';
  const link = await readlink(source);
  // An absolute link would keep pointing at the ORIGINAL tree; re-express it
  // relative to its own location so it resolves inside the copy.
  const text = path.isAbsolute(link) ? path.relative(path.dirname(source), target) || '.' : link;
  await symlink(text, dest);
  return null;
}

/**
 * Copies the working tree at `repoRoot` into the (new) directory `destRoot`.
 *
 * @param {string} repoRoot
 * @param {string} destRoot
 * @param {{ maxFiles?: number, maxBytes?: number, copyNodeModules?: boolean, maxNodeModulesEntries?: number }} [options]
 * @returns {Promise<{ files: number, bytes: number, skipped: Array<{ path: string, reason: string }>, notes: string[] }>}
 */
export async function copyRepository(repoRoot, destRoot, options = {}) {
  const {
    maxFiles = DEFAULT_MAX_FILES,
    maxBytes = DEFAULT_MAX_BYTES,
    copyNodeModules = true,
    maxNodeModulesEntries = DEFAULT_MAX_NODE_MODULES_ENTRIES,
  } = options;
  const root = await realpath(repoRoot);
  const listing = await listFiles(root, maxFiles);
  const notes = [...listing.notes];
  const skipped = [];
  let files = 0;
  let bytes = 0;
  const madeDirs = new Set();

  await mkdir(destRoot, { recursive: true, mode: 0o700 });
  for (const rel of listing.files) {
    if (rel === 'node_modules' || rel.startsWith('node_modules/')) continue; // handled below
    if (!isSafeRelativePath(rel)) {
      skipped.push({ path: rel, reason: 'unsafe path' });
      continue;
    }
    let stats;
    try {
      stats = await lstat(path.join(root, rel));
    } catch {
      continue; // tracked but deleted in the working tree
    }
    if (!stats.isFile() && !stats.isSymbolicLink()) {
      skipped.push({ path: rel, reason: stats.isDirectory() ? 'directory entry (submodule?) not copied' : 'not a regular file' });
      continue;
    }
    files += 1;
    if (files > maxFiles) throw tooManyFiles(maxFiles);
    const dest = path.join(destRoot, rel);
    const destDir = path.dirname(dest);
    if (!madeDirs.has(destDir)) {
      await mkdir(destDir, { recursive: true });
      madeDirs.add(destDir);
    }
    if (stats.isSymbolicLink()) {
      const reason = await copySymlink(root, rel, dest);
      if (reason) {
        files -= 1;
        skipped.push({ path: rel, reason });
      }
      continue;
    }
    bytes += stats.size;
    if (bytes > maxBytes) {
      throw new WorkspaceLimitError(`the repository working files exceed ${Math.round(maxBytes / (1024 * 1024))} MB; raise maxBytes or ignore large files`);
    }
    await copyFile(path.join(root, rel), dest);
  }

  if (copyNodeModules) {
    const source = path.join(root, 'node_modules');
    const stats = await lstat(source).catch(() => null);
    if (stats?.isDirectory()) {
      let entries = 0;
      await cp(source, path.join(destRoot, 'node_modules'), {
        recursive: true,
        dereference: false, // never follow a symlink out of node_modules
        verbatimSymlinks: true,
        filter: () => {
          entries += 1;
          if (entries > maxNodeModulesEntries) {
            throw new WorkspaceLimitError(`node_modules has more than ${maxNodeModulesEntries} entries; pass copyNodeModules: false or raise the limit`);
          }
          return true;
        },
      });
      notes.push(`node_modules copied (${entries} entries, symlinks kept verbatim and not followed)`);
    } else if (stats) {
      skipped.push({ path: 'node_modules', reason: 'not a real directory' });
    }
  }
  return { files, bytes, skipped, notes };
}

/** Duplicates an already-sanitised workspace tree (symlinks verbatim). */
export async function cloneTree(source, dest) {
  await cp(source, dest, { recursive: true, dereference: false, verbatimSymlinks: true });
}
