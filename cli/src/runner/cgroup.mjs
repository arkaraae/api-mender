// Optional cgroup limits for the namespace backend (Linux only).
//
// rlimits are per-process and, for the real root user, RLIMIT_NPROC is not
// enforced by the kernel at all. A cgroup is the only mechanism that bounds
// the memory and task count of the WHOLE process tree of a check, so when
// the caller is able to create one we do, and when it is not we say so in the
// enforcement notes instead of pretending.
//
// Supported layouts:
//   * cgroup v2 (unified hierarchy at /sys/fs/cgroup) — a child of our own
//     cgroup, which works when that cgroup is delegated to us with the memory
//     and/or pids controllers enabled for children.
//   * cgroup v1 — a child of our own cgroup in the `memory` and `pids`
//     hierarchies, which in practice requires root.
//
// The check joins the cgroup from inside the sandbox wrapper (it writes "0"
// to cgroup.procs before exec), so every descendant is born inside it.

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const CGROUP_ROOT = '/sys/fs/cgroup';

/** Parses /proc/self/cgroup into { v2Path, v1: Map<controller, path> }. */
function readOwnCgroups() {
  const out = { v2Path: null, v1: new Map() };
  let text;
  try {
    text = readFileSync('/proc/self/cgroup', 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split('\n')) {
    const match = /^(\d+):([^:]*):(.*)$/.exec(line);
    if (!match) continue;
    const [, id, controllers, cgPath] = match;
    if (id === '0' && controllers === '') out.v2Path = cgPath;
    else for (const c of controllers.split(',')) out.v1.set(c, { dirName: controllers, cgPath });
  }
  return out;
}

/** mkdir + write the limit files; returns the directory or null if any step fails. */
function tryCreate(dir, files) {
  try {
    mkdirSync(dir, { mode: 0o755 });
  } catch {
    return null;
  }
  try {
    for (const [name, value, required] of files) {
      try {
        writeFileSync(path.join(dir, name), String(value));
      } catch (error) {
        if (required) throw error;
      }
    }
    return dir;
  } catch {
    try {
      rmdirSync(dir);
    } catch {
      /* nothing else to do */
    }
    return null;
  }
}

/**
 * Tries to create cgroups that bound memory and task count.
 *
 * @param {{ memoryMb: number, pids: number }} limits
 * @returns {{ groups: Array<{ procsFile: string, covers: Array<'memory'|'pids'> }>, cleanup: () => Promise<void> }}
 *   `groups` is empty when no cgroup could be created. A group only counts as
 *   enforced once the sandbox wrapper reports that it joined `procsFile`.
 */
export function createLimitCgroups({ memoryMb, pids }) {
  const groups = [];
  const dirs = [];
  if (process.platform !== 'linux') return { groups, cleanup: async () => {} };

  const name = `mender-${process.pid}-${randomBytes(6).toString('hex')}`;
  const memoryBytes = memoryMb * 1024 * 1024;
  const own = readOwnCgroups();

  if (own.v2Path !== null && existsSync(path.join(CGROUP_ROOT, 'cgroup.controllers'))) {
    const dir = path.join(CGROUP_ROOT, own.v2Path, name);
    try {
      mkdirSync(dir, { mode: 0o755 });
      const covers = [];
      // A controller's files exist only if the parent enabled it for children.
      for (const [kind, file, value] of [
        ['memory', 'memory.max', memoryBytes],
        ['pids', 'pids.max', pids],
      ]) {
        try {
          writeFileSync(path.join(dir, file), String(value));
          covers.push(kind);
        } catch {
          /* controller not delegated */
        }
      }
      if (covers.includes('memory')) {
        try {
          writeFileSync(path.join(dir, 'memory.swap.max'), '0');
        } catch {
          /* swap accounting may be off */
        }
      }
      dirs.push(dir);
      if (covers.length > 0) groups.push({ procsFile: path.join(dir, 'cgroup.procs'), covers });
    } catch {
      /* not delegated / read-only */
    }
  }

  const covered = new Set(groups.flatMap((g) => g.covers));
  const v1Plans = [
    ['memory', [['memory.limit_in_bytes', memoryBytes, true], ['memory.memsw.limit_in_bytes', memoryBytes, false]]],
    ['pids', [['pids.max', pids, true]]],
  ];
  for (const [kind, files] of v1Plans) {
    const entry = own.v1.get(kind);
    if (covered.has(kind) || !entry) continue;
    const dir = tryCreate(path.join(CGROUP_ROOT, entry.dirName, entry.cgPath, name), files);
    if (dir) {
      dirs.push(dir);
      groups.push({ procsFile: path.join(dir, 'cgroup.procs'), covers: [kind] });
    }
  }

  return {
    groups,
    // rmdir only succeeds once every task has exited; the kernel reaps the
    // killed tree asynchronously, so retry briefly.
    async cleanup() {
      for (const dir of dirs) {
        for (let attempt = 0; attempt < 20; attempt += 1) {
          try {
            rmdirSync(dir);
            break;
          } catch (error) {
            if (error.code === 'ENOENT') break;
            await sleep(50);
          }
        }
      }
    },
  };
}
