// Isolated validation runner.
//
// Runs the customer's explicitly configured checks against a COPY of the
// repository, before and after applying one proposed patch, each check in a
// fresh sandbox, and reports exactly what ran and how it exited.
//
// What a result means — and does not mean:
//   * `checksPassed`    the configured checks exit 0 on the patched copy.
//   * `breakReproduced` some check failed before the patch and passed after.
//   Neither is proof that behavior is correct; they only speak for what the
//   checks cover. `report.statement` always says so in a fixed sentence.
//
// Isolation depends on the backend; see the header of ./sandbox.mjs for the
// precise list. In short: `container` isolates filesystem, network and
// resources; `namespace` isolates network/PIDs/IPC, bounds resources and
// makes the host read-only but does NOT hide the host filesystem from
// reads; `process` isolates nothing and is never chosen automatically.
//
// Everything here runs on the machine that invokes it (the customer's
// laptop or CI in customer-managed mode). Check output is returned in `logs`,
// separately from the report, and this module never sends anything anywhere.

import { rmSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { RUNNER_BOUNDS, RUNNER_DEFAULTS, validateChecks } from '../config.mjs';
import { applyValidatedDiff, assertRegularFileInTree, PatchValidationError, validateDiff } from './patch.mjs';
import { redactSecrets } from './redact.mjs';
import { DEFAULT_IMAGE, probeContainer, probeNamespace, runInSandbox } from './sandbox.mjs';
import { cloneTree, copyRepository } from './workspace.mjs';

export { runInSandbox } from './sandbox.mjs';
export { redactSecrets } from './redact.mjs';
export { PatchValidationError, validateDiff } from './patch.mjs';
export { WorkspaceLimitError } from './workspace.mjs';

/** @typedef {import('../../../web/lib/engine/types.ts').ValidationReport} ValidationReport */
/** @typedef {import('../../../web/lib/engine/types.ts').CheckResult} CheckResult */
/** @typedef {import('../config.mjs').Check} Check */
/**
 * @typedef {{
 *   backend?: 'auto' | 'container' | 'namespace' | 'process',
 *   wallSeconds?: number, cpuSeconds?: number, memoryMb?: number, pids?: number,
 *   network?: 'none' | 'host',
 *   image?: string,
 *   copyNodeModules?: boolean,
 *   maxFiles?: number, maxBytes?: number,
 *   tmpRoot?: string,
 *   signal?: AbortSignal,
 *   handleSignals?: boolean,
 * }} ValidationOptions
 * @typedef {{ phase: 'before' | 'after', name: string, output: string }} CheckLog
 * @typedef {{ report: ValidationReport, logs: CheckLog[], enforcement: string[], notes: string[] }} ValidationResult
 */

/** Per-check output kept in `logs` (bytes, before redaction). */
export const MAX_LOG_BYTES = 20 * 1024;

const NOT_PROOF = 'Passing checks are not proof of correct behavior.';

/** The only sentences `report.statement` can contain. */
export const STATEMENTS = Object.freeze({
  reproduced:
    'A configured check failed before the patch and passed after it. This confirms the patch changes the checked behavior; it does not prove behavior is correct beyond what the checks cover.',
  notReproduced: `All configured checks passed on the patched code, and they also passed before the patch. The checks do not exercise the upstream change, so the fix is not confirmed by a test. ${NOT_PROOF}`,
  noChecks: `No checks are configured; the patch was not validated. ${NOT_PROOF}`,
  notApplied: `The patch did not apply cleanly to a copy of the repository; no checks were run. ${NOT_PROOF}`,
  /** @param {number} failed @param {number} total */
  failed: (failed, total) => `${failed} of ${total} configured checks failed on the patched code. ${NOT_PROOF}`,
});

export class NoIsolationAvailableError extends Error {
  constructor(reasons) {
    super(
      `No isolated runner is available on this machine, so the configured checks were NOT run.\n` +
        reasons.map((r) => `  - ${r}`).join('\n') +
        `\nTo fix this, either start a container runtime (docker) or enable unprivileged user namespaces ` +
        `(Linux: \`sysctl kernel.unprivileged_userns_clone=1\`, and allow \`unshare\` under AppArmor/seccomp). ` +
        `To run the checks with NO isolation — full network and filesystem access for repository code — ` +
        `pass backend: 'process' explicitly (CLI: --unsafe-no-isolation).`,
    );
    this.name = 'NoIsolationAvailableError';
    this.code = 'EMENDERNOISOLATION';
  }
}

/**
 * Picks a sandbox backend.
 *
 *   'auto'      → 'container' when a docker daemon answers, else 'namespace'
 *                 when an unshare probe succeeds, else THROWS
 *                 `NoIsolationAvailableError`. It never returns 'process'.
 *   'container' / 'namespace' → verified, or throws with the reason.
 *   'process'   → returned as asked. No isolation; callers must only pass
 *                 this on an explicit operator decision.
 *
 * @param {'auto' | 'container' | 'namespace' | 'process'} [preferred]
 * @returns {Promise<{ backend: 'container' | 'namespace' | 'process', reason: string }>}
 */
export async function detectBackend(preferred = 'auto') {
  if (preferred === 'process') {
    return { backend: 'process', reason: 'explicitly requested; NO isolation (host network and filesystem)' };
  }
  if (preferred === 'container') {
    const probe = await probeContainer();
    if (!probe.ok) throw new NoIsolationAvailableError([`container backend requested: ${probe.reason}`]);
    return { backend: 'container', reason: probe.reason };
  }
  if (preferred === 'namespace') {
    const probe = await probeNamespace();
    if (!probe.ok) throw new NoIsolationAvailableError([`namespace backend requested: ${probe.reason}`]);
    return { backend: 'namespace', reason: probe.reason };
  }
  if (preferred !== 'auto') throw new TypeError(`unknown backend: ${preferred}`);

  const container = await probeContainer();
  if (container.ok) return { backend: 'container', reason: container.reason };
  const namespace = await probeNamespace();
  if (namespace.ok) return { backend: 'namespace', reason: `${namespace.reason}; ${container.reason}` };
  throw new NoIsolationAvailableError([`container: ${container.reason}`, `namespace: ${namespace.reason}`]);
}

function resolveLimits(options) {
  const limits = {};
  for (const key of Object.keys(RUNNER_BOUNDS)) {
    const value = options[key] ?? RUNNER_DEFAULTS[key];
    const [min, max] = RUNNER_BOUNDS[key];
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new TypeError(`options.${key} must be an integer between ${min} and ${max}`);
    }
    limits[key] = value;
  }
  return limits;
}

function truncateLog(output) {
  const buffer = Buffer.from(output, 'utf8');
  if (buffer.length <= MAX_LOG_BYTES) return output;
  return `${buffer.subarray(0, MAX_LOG_BYTES).toString('utf8')}\n[... truncated ...]`;
}

/**
 * While a validation is running, turn SIGINT/SIGTERM/SIGHUP into an abort so
 * the `finally` that removes the workspace gets to run, then restore the
 * signal's normal effect. A synchronous exit hook covers `process.exit()`.
 */
function installCleanupHooks(controller, getWorkspace) {
  const received = [];
  const handlers = ['SIGINT', 'SIGTERM', 'SIGHUP'].map((name) => {
    const handler = () => {
      received.push(name);
      controller.abort();
    };
    process.on(name, handler);
    return [name, handler];
  });
  const onExit = () => {
    const workspace = getWorkspace();
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  };
  process.on('exit', onExit);
  return () => {
    process.removeListener('exit', onExit);
    for (const [name, handler] of handlers) process.removeListener(name, handler);
    // If we were the only listener, the signal would have ended the process;
    // deliver it again now that cleanup is done.
    const first = received[0];
    if (first && process.listenerCount(first) === 0) process.kill(process.pid, first);
  };
}

function abortError() {
  const error = new Error('validation was aborted');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

/**
 * Validates one proposed patch by running the configured checks before and
 * after it, in an isolated runner, on a private copy of the repository.
 *
 * Resolves to `{ report, logs, enforcement, notes }`:
 *   * `report`       a `ValidationReport` exactly as in web/lib/engine/types.ts.
 *                    It contains commands, exit codes and durations — never
 *                    stdout/stderr.
 *   * `logs`         `[{ phase: 'before' | 'after', name, output }]`, output
 *                    truncated to 20 KB per check and passed through
 *                    `redactSecrets`. The caller decides whether to write
 *                    them to a local file. They must not be uploaded.
 *   * `enforcement`  plain-language notes on which limits and isolation
 *                    measures were ACTUALLY enforced by the backend on this
 *                    machine (`report.isolation.limits` only records what was
 *                    requested).
 *   * `notes`        what was skipped or assumed while copying the tree.
 *
 * Throws (and runs nothing) when: the checks are malformed, the diff fails
 * structural validation (`PatchValidationError`), no isolated backend is
 * available (`NoIsolationAvailableError`), the tree exceeds the copy caps, or
 * the run is aborted. A structurally valid diff that does not apply cleanly
 * is NOT an error: the report has `patchApplied: false` and no check results.
 *
 * The original working tree is never written to by this function. The
 * temporary workspace is always removed, including on timeout, abort and
 * SIGINT/SIGTERM/SIGHUP.
 *
 * @param {{ repoRoot: string, patch: string, file: string, checks: Check[], options?: ValidationOptions }} input
 * @returns {Promise<ValidationResult>}
 */
export async function runValidation({ repoRoot, patch, file, checks, options = {} }) {
  const validChecks = validateChecks(checks ?? []);
  const limits = resolveLimits(options);
  const requestedNetwork = options.network ?? 'none';
  if (requestedNetwork !== 'none' && requestedNetwork !== 'host') throw new TypeError('options.network must be "none" or "host"');

  // Reject a malformed or out-of-bounds diff before touching the disk.
  validateDiff(patch, file);
  const root = await realpath(repoRoot);
  if (!(await lstat(root)).isDirectory()) throw new TypeError('repoRoot must be a directory');
  await assertRegularFileInTree(root, file);

  const { backend } = await detectBackend(options.backend ?? 'auto');
  // The process backend cannot block the network, whatever was requested.
  const network = backend === 'process' ? 'host' : requestedNetwork;

  /** @type {ValidationReport} */
  const report = {
    schemaVersion: 1,
    isolation: { backend, network, limits },
    patchApplied: false,
    before: [],
    after: [],
    checksPassed: false,
    breakReproduced: false,
    statement: STATEMENTS.notApplied,
  };
  /** @type {CheckLog[]} */
  const logs = [];
  const enforcement = new Set();
  const notes = [];

  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  if (options.signal?.aborted) throw abortError();
  options.signal?.addEventListener('abort', forwardAbort, { once: true });
  let workspace = null;
  const removeHooks = options.handleSignals === false ? () => {} : installCleanupHooks(controller, () => workspace);

  try {
    workspace = await mkdtemp(path.join(await realpath(options.tmpRoot ?? os.tmpdir()), 'mender-validate-'));
    await chmod(workspace, 0o700);
    const beforeDir = path.join(workspace, 'before');
    const afterDir = path.join(workspace, 'after');
    const scratchRoot = path.join(workspace, 'scratch');
    await mkdir(scratchRoot, { mode: 0o700 });

    const copied = await copyRepository(root, beforeDir, {
      maxFiles: options.maxFiles,
      maxBytes: options.maxBytes,
      copyNodeModules: options.copyNodeModules ?? true,
    });
    notes.push(...copied.notes, ...copied.skipped.map((s) => `not copied: ${s.path} (${s.reason})`));
    notes.push('.git is not copied; checks that need git history will not work in the sandbox');
    if (controller.signal.aborted) throw abortError();
    await cloneTree(beforeDir, afterDir);

    const gitHome = path.join(scratchRoot, 'git-home');
    await mkdir(gitHome, { mode: 0o700 });
    const applied = await applyValidatedDiff({ treeDir: afterDir, diff: patch, file, ceilingDir: workspace, homeDir: gitHome });
    if (!applied.applied) {
      notes.push(`git apply: ${redactSecrets(applied.detail).slice(0, 500) || 'failed'}`);
      return { report, logs, enforcement: [], notes };
    }
    report.patchApplied = true;

    let counter = 0;
    const runPhase = async (phase, cwd) => {
      /** @type {CheckResult[]} */
      const results = [];
      for (const check of validChecks) {
        if (controller.signal.aborted) throw abortError();
        // Fresh HOME/TMPDIR per invocation so one check cannot leave things for the next.
        const scratchDir = path.join(scratchRoot, `${phase}-${(counter += 1)}`);
        await mkdir(scratchDir, { mode: 0o700 });
        const result = await runInSandbox({
          backend,
          cwd,
          argv: [...check.command],
          env: check.env,
          limits,
          network,
          scratchDir,
          image: options.image ?? DEFAULT_IMAGE,
          maxOutputBytes: MAX_LOG_BYTES,
          signal: controller.signal,
        });
        for (const note of result.enforcement) enforcement.add(note);
        results.push({
          name: check.name,
          command: [...check.command],
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          durationMs: result.durationMs,
          passed: result.exitCode === 0 && !result.timedOut,
        });
        logs.push({ phase, name: check.name, output: redactSecrets(truncateLog(result.output)) });
      }
      return results;
    };

    report.before = await runPhase('before', beforeDir);
    report.after = await runPhase('after', afterDir);

    const failed = report.after.filter((r) => !r.passed).length;
    // Zero checks is "not validated", not a vacuous pass.
    report.checksPassed = report.after.length > 0 && failed === 0;
    report.breakReproduced = report.after.some((after, i) => after.passed && !report.before[i].passed);
    if (report.after.length === 0) report.statement = STATEMENTS.noChecks;
    else if (failed > 0) report.statement = STATEMENTS.failed(failed, report.after.length);
    else report.statement = report.breakReproduced ? STATEMENTS.reproduced : STATEMENTS.notReproduced;

    return { report, logs, enforcement: [...enforcement], notes };
  } finally {
    options.signal?.removeEventListener('abort', forwardAbort);
    if (workspace) {
      await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      workspace = null;
    }
    removeHooks();
  }
}
