// Shared helpers for runner tests: tiny dependency-free fixture repositories
// created in temp dirs, tree hashing, and process-table inspection.
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SOURCE_FILE = 'src/api.mjs';

const SOURCE = `export function buildBody(name) {
  return { name, legacy_flag: true };
}
`;

/** Removes the field the "upstream API" no longer accepts. */
export const FIX_PATCH = `diff --git a/src/api.mjs b/src/api.mjs
--- a/src/api.mjs
+++ b/src/api.mjs
@@ -1,3 +1,3 @@
 export function buildBody(name) {
-  return { name, legacy_flag: true };
+  return { name };
 }
`;

/** Structurally valid, applies cleanly, but makes the module throw on import. */
export const BREAKING_PATCH = `--- a/src/api.mjs
+++ b/src/api.mjs
@@ -1,3 +1,3 @@
 export function buildBody(name) {
-  return { name, legacy_flag: true };
+  return undefinedVariable.name;
 }
`;

/** Structurally valid but its context does not match the file. */
export const STALE_PATCH = `--- a/src/api.mjs
+++ b/src/api.mjs
@@ -1,3 +1,3 @@
 export function buildBody(name) {
-  return { name, something_else: 1 };
+  return { name };
 }
`;

const files = {
  'package.json': JSON.stringify({ name: 'fixture', version: '1.0.0', private: true, type: 'module' }, null, 2) + '\n',
  [SOURCE_FILE]: SOURCE,
  // Fails while the removed field is still sent: reproduces the upstream break.
  'test/contract.test.mjs': `import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBody } from '../src/api.mjs';
test('does not send the removed field', () => {
  assert.equal('legacy_flag' in buildBody('x'), false);
});
`,
  // Passes before and after: does not exercise the change.
  'test/shape.test.mjs': `import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBody } from '../src/api.mjs';
test('keeps the name', () => {
  assert.equal(buildBody('x').name, 'x');
});
`,
};

export const CONTRACT_CHECK = { name: 'contract', command: ['node', '--test', 'test/contract.test.mjs'], env: {} };
export const SHAPE_CHECK = { name: 'shape', command: ['node', '--test', 'test/shape.test.mjs'], env: {} };

/** Creates a private temp root holding `repo/` (the fixture) and `tmp/` (workspace root). */
export function makeFixture(extraFiles = {}) {
  const base = mkdtempSync(path.join(os.tmpdir(), 'mender-test-'));
  const repo = path.join(base, 'repo');
  const tmpRoot = path.join(base, 'tmp');
  mkdirSync(tmpRoot);
  for (const [rel, content] of Object.entries({ ...files, ...extraFiles })) {
    mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    writeFileSync(path.join(repo, rel), content);
  }
  return { base, repo, tmpRoot, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

/** Stable hash of names, types, modes, link targets and contents of a tree. */
export function hashTree(root) {
  const hash = createHash('sha256');
  const visit = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const stats = lstatSync(full);
      hash.update(`${path.relative(root, full)}\0${stats.mode}\0`);
      if (stats.isSymbolicLink()) hash.update(readlinkSync(full));
      else if (stats.isDirectory()) visit(full);
      else hash.update(readFileSync(full));
    }
  };
  visit(root);
  return hash.digest('hex');
}

/** True if any process on the host has `needle` in its command line. */
export function processExists(needle) {
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
    try {
      if (readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ').includes(needle)) return true;
    } catch {
      /* raced with exit */
    }
  }
  return false;
}

export const LIMITS = { wallSeconds: 30, cpuSeconds: 20, memoryMb: 512, pids: 128 };
