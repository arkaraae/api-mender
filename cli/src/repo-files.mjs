// Reads the repository's source files for static analysis. Nothing is
// executed. Files are listed by git when the directory is a work tree (so
// ignored files stay out), otherwise by a bounded walk.
import { spawnSync } from 'node:child_process';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

const SOURCE = /\.(?:[cm]?[jt]sx?|py)$/;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'vendor', '.next', 'coverage', '.venv', 'venv', '__pycache__', 'site-packages']);
export const MAX_FILES = 5_000;
export const MAX_FILE_BYTES = 300_000;
export const MAX_TOTAL_BYTES = 50_000_000;

function gitList(root) {
  const result = spawnSync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 30_000,
    // No hooks, pager or user config can run code during a listing.
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', HOME: root },
  });
  if (result.status !== 0) return null;
  return result.stdout.toString('utf8').split('\0').filter(Boolean);
}

async function walk(root) {
  const found = [];
  const pending = [''];
  while (pending.length && found.length < MAX_FILES * 4) {
    const dir = pending.pop();
    for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) pending.push(rel); }
      else if (entry.isFile()) found.push(rel);
    }
  }
  return found;
}

/** Commit of the work tree, or null when it is not a git checkout. */
export function headCommit(root) {
  const result = spawnSync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', 'rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 10_000,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', HOME: root } });
  const sha = result.status === 0 ? result.stdout.trim() : '';
  return /^[a-f0-9]{40}$/.test(sha) ? sha : null;
}

/**
 * @returns {Promise<{ root: string, files: { path: string, source: string }[], skipped: string[] }>}
 */
export async function readRepositorySources(repoRoot) {
  const root = await realpath(repoRoot);
  const listed = (gitList(root) ?? await walk(root))
    .filter(rel => SOURCE.test(rel) && !rel.split('/').some(part => SKIP_DIRS.has(part) || part === '..'))
    .sort();
  const files = [];
  const skipped = [];
  let total = 0;
  for (const rel of listed) {
    if (files.length >= MAX_FILES) { skipped.push(`stopped after ${MAX_FILES} files`); break; }
    const full = path.join(root, rel);
    const stats = await lstat(full).catch(() => null);
    // Symlinks are not followed: a link could point outside the repository.
    if (!stats?.isFile()) continue;
    if (stats.size > MAX_FILE_BYTES) { skipped.push(`${rel}: larger than ${MAX_FILE_BYTES} bytes`); continue; }
    if (total + stats.size > MAX_TOTAL_BYTES) { skipped.push(`stopped at ${MAX_TOTAL_BYTES} bytes of source`); break; }
    total += stats.size;
    files.push({ path: rel, source: await readFile(full, 'utf8') });
  }
  return { root, files, skipped };
}
