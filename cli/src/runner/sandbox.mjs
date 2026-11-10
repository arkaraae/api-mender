// Sandbox backends for running one configured check against a COPY of a
// repository. The repository (and the patch under test) is untrusted code.
//
// WHAT EACH BACKEND DOES AND DOES NOT ISOLATE — keep this accurate.
//
// `container` (docker; recommended for untrusted repositories)
//   + Own filesystem: only the workspace copy and a scratch dir are mounted;
//     the image's root filesystem is read-only; /tmp is a tmpfs.
//   + `--network none`, all capabilities dropped, no-new-privileges.
//   + Memory, pids and CPU-count limits by cgroup; CPU seconds by ulimit.
//   - Shares the host kernel (it is a container, not a VM).
//   - Not exercised by this project's tests on machines without a daemon.
//
// `namespace` (Linux; unshare + prlimit, no daemon needed)
//   + Network: a new, empty network namespace. No interface is up — not even
//     loopback — so a check cannot bind or connect to 127.0.0.1 either.
//     Checks that need a local server must stub `fetch`.
//   + PIDs/IPC/UTS: new namespaces; the check cannot see or signal host
//     processes, and when its PID 1 dies the kernel kills every descendant.
//   + Resource limits: see `enforcement` notes returned with every run; what
//     can really be enforced depends on the machine (root vs. not, cgroups).
//   + Filesystem, best effort: every host mount is remounted READ-ONLY in the
//     sandbox's mount namespace except the workspace copy and its scratch
//     dir; the caller's home, /root and /home are covered by empty tmpfs; and
//     all capabilities are dropped (setpriv) so the check cannot undo this.
//   - The rest of the host filesystem REMAINS READABLE with the caller's
//     permissions (/etc, /tmp, other projects outside the hidden dirs…).
//     This backend does not give the check its own root filesystem.
//   - Same kernel, same user id; no seccomp filter.
//   - RLIMIT_CPU and RLIMIT_AS are per process, not per process tree.
//
// `process` (opt-in only; NO isolation)
//   A plain child process in the workspace copy with a scrubbed environment
//   and a wall-clock timeout. Full network, full filesystem access as the
//   caller. Never chosen automatically.
//
// All backends: the command is an argv array spawned WITHOUT a shell, and the
// environment is built from EMPTY (see `buildSandboxEnv`).
//
// One fixed `sh` script is used inside the namespace backend to set up
// mounts. The check's argv reaches it only as positional parameters that are
// passed on with `exec "$@"`, which the shell never parses or expands.

import { execFile, spawn } from 'node:child_process';
import { accessSync, constants as fsConstants, existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { createLimitCgroups } from './cgroup.mjs';

/** @typedef {{ cpuSeconds: number, memoryMb: number, wallSeconds: number, pids: number }} Limits */
/** @typedef {{ exitCode: number | null, timedOut: boolean, durationMs: number, output: string, enforcement: string[] }} SandboxResult */

export const SAFE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
export const DEFAULT_IMAGE = 'node:22-bookworm-slim';
export const DEFAULT_MAX_OUTPUT_BYTES = 20 * 1024;

/** Largest file a check may create (RLIMIT_FSIZE); not configurable from the repository. */
const MAX_FILE_BYTES = 1024 * 1024 * 1024;
/** V8 reserves a large virtual address range at startup; RLIMIT_AS below this crashes node. */
const MIN_ADDRESS_SPACE_LIMIT_MB = 4096;
/** Kernel minimum for a per-namespace kernel.pid_max. */
const MIN_PID_MAX = 301;

const UNSHARE_FLAGS = ['--user', '--map-root-user', '--pid', '--fork', '--mount-proc', '--ipc', '--uts', '--kill-child=SIGKILL'];
const SETPRIV_ARGS = ['--bounding-set=-all', '--inh-caps=-all', '--no-new-privs', '--'];

// Runs as (user-namespace) root inside fresh mount/pid namespaces, BEFORE the
// check. Reports what it managed to do on fd 3, which is closed before exec
// so the check can neither see nor forge it.
//   $1 cwd  $2 scratch  $3 pid_max (0 = skip)  $4 harden (1/0)
//   then: <n> <cgroup.procs>...   <n> <dir to hide>...   <command>...
const WRAPPER_SCRIPT = `
status() { echo "$1" >&3; }
cwd=$1; scratch=$2; pidmax=$3; harden=$4; shift 4
n=$1; shift
while [ "$n" -gt 0 ]; do
  if { echo 0 > "$1"; } 2>/dev/null; then status "cgroup-ok $1"; else status "cgroup-fail $1"; fi
  shift; n=$((n-1))
done
n=$1; shift
while [ "$n" -gt 0 ]; do
  if mount -t tmpfs -o size=64k,mode=0755 tmpfs "$1" 2>/dev/null; then status "hide-ok $1"; else status "hide-fail $1"; fi
  shift; n=$((n-1))
done
if [ "$pidmax" != 0 ]; then
  if { echo "$pidmax" > /proc/sys/kernel/pid_max; } 2>/dev/null; then status pidmax-ok; else status pidmax-fail; fi
fi
if [ "$harden" = 1 ]; then
  if mount --bind "$cwd" "$cwd" 2>/dev/null && mount --bind "$scratch" "$scratch" 2>/dev/null; then
    status bind-ok
    while read -r _a _b _c _d mp _rest; do
      case "$mp" in
        *\\\\*) status "ro-fail $mp"; continue;;
        /proc) continue;;
      esac
      [ "$mp" = "$cwd" ] && continue
      [ "$mp" = "$scratch" ] && continue
      mount -o remount,bind,ro "$mp" 2>/dev/null || status "ro-fail $mp"
    done < /proc/self/mountinfo
    mount -o remount,bind,ro /proc 2>/dev/null || status "ro-fail /proc"
  else
    status bind-fail
  fi
fi
cd "$cwd" || exit 125
exec 3>&-
exec "$@"
`;

/**
 * Builds the environment a check sees. It starts from EMPTY: nothing from
 * the caller's environment (tokens, cloud credentials, proxy settings) is
 * inherited. `checkEnv` is applied last but can never replace the entries
 * that keep the sandbox honest (config validation rejects those names too;
 * this is the second gate for callers that bypass the config loader).
 *
 * @param {{ homeDir: string, tmpDir?: string, checkEnv?: Record<string,string>, memoryMb?: number, pathValue?: string }} input
 * @returns {Record<string, string>}
 */
export function buildSandboxEnv({ homeDir, tmpDir, checkEnv = {}, memoryMb, pathValue }) {
  const base = {
    PATH: pathValue ?? `${SAFE_PATH}:${path.dirname(process.execPath)}`,
    HOME: homeDir,
    CI: '1',
    NODE_ENV: 'test',
    LANG: 'C.UTF-8',
    npm_config_offline: 'true',
    npm_config_update_notifier: 'false',
  };
  // The host root is read-only in the namespace backend, so point temp files
  // at the scratch dir.
  if (tmpDir) base.TMPDIR = tmpDir;
  // Bounds the V8 heap of node children. This is cooperative (a non-node
  // program ignores it), which is why enforcement notes call it out.
  if (memoryMb) base.NODE_OPTIONS = `--max-old-space-size=${memoryMb}`;
  const protectedNames = new Set(['PATH', 'HOME', 'NODE_OPTIONS', 'TMPDIR']);
  const env = { ...base };
  for (const [name, value] of Object.entries(checkEnv)) {
    if (protectedNames.has(name) || /^(LD_|DYLD_|GIT_|SSH_)/.test(name) || ['NODE_PATH', 'BASH_ENV', 'ENV'].includes(name)) {
      throw new Error(`check env may not set ${name}`);
    }
    if (typeof value !== 'string' || value.includes('\0') || name.includes('=') || name.includes('\0')) {
      throw new Error(`check env ${JSON.stringify(name)} is not a valid variable`);
    }
    env[name] = value;
  }
  return env;
}

/** Keeps the first quarter and the last three quarters of a byte budget. */
class BoundedOutput {
  constructor(limit) {
    this.headLimit = Math.floor(limit / 4);
    this.tailLimit = limit - this.headLimit;
    this.head = [];
    this.headBytes = 0;
    this.tail = Buffer.alloc(0);
    this.dropped = 0;
  }

  push(chunk) {
    let rest = chunk;
    if (this.headBytes < this.headLimit) {
      const take = rest.subarray(0, this.headLimit - this.headBytes);
      this.head.push(take);
      this.headBytes += take.length;
      rest = rest.subarray(take.length);
    }
    if (rest.length === 0) return;
    const joined = Buffer.concat([this.tail, rest]);
    const excess = Math.max(0, joined.length - this.tailLimit);
    this.dropped += excess;
    this.tail = joined.subarray(excess);
  }

  toString() {
    const head = Buffer.concat(this.head).toString('utf8');
    const gap = this.dropped > 0 ? `\n[... ${this.dropped} bytes of output truncated ...]\n` : '';
    return head + gap + this.tail.toString('utf8');
  }
}

function killGroup(pid) {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}

/**
 * Spawns argv with NO shell in its own process group, captures bounded
 * stdout+stderr, and enforces a wall-clock limit by SIGKILLing the group.
 *
 * @returns {Promise<{ exitCode: number|null, timedOut: boolean, aborted: boolean, durationMs: number, output: string, status: string, spawnError: Error|null }>}
 */
function spawnCapture(command, args, { cwd, env, wallMs, maxOutputBytes, signal, onKill, statusFd = false }) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const output = new BoundedOutput(maxOutputBytes);
    let status = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let drainTimer = null;

    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      detached: true, // own process group, so the whole group can be killed
      stdio: ['ignore', 'pipe', 'pipe', ...(statusFd ? ['pipe'] : [])],
      windowsHide: true,
    });

    const kill = () => {
      if (child.pid) killGroup(child.pid);
      onKill?.();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, wallMs);
    const onAbort = () => {
      aborted = true;
      kill();
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (exitCode, spawnError = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drainTimer);
      signal?.removeEventListener('abort', onAbort);
      // Sweep anything left in the group (matters for the `process` backend,
      // where no PID namespace reaps background children).
      if (child.pid) killGroup(child.pid);
      resolve({
        exitCode: timedOut || aborted ? null : exitCode,
        timedOut,
        aborted,
        durationMs: Number((process.hrtime.bigint() - started) / 1_000_000n),
        output: output.toString(),
        status,
        spawnError,
      });
    };

    child.stdout.on('data', (chunk) => output.push(chunk));
    child.stderr.on('data', (chunk) => output.push(chunk));
    child.stdio[3]?.on('data', (chunk) => {
      if (status.length < 64 * 1024) status += chunk.toString('utf8');
    });
    child.on('error', (error) => finish(null, error));
    let exitCode = null;
    child.on('exit', (code) => {
      exitCode = code;
      // A grandchild that escaped the group could hold the pipes open
      // forever; do not wait for it.
      drainTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        child.stdio[3]?.destroy();
        finish(exitCode);
      }, 1000);
    });
    child.on('close', (code) => finish(code ?? exitCode));
  });
}

function run(command, args, { timeoutMs = 15_000, env } = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, env, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, detail: error ? String(stderr || error.message).trim().slice(0, 300) : String(stdout) });
    });
  });
}

function toolEnv() {
  return { PATH: SAFE_PATH, LANG: 'C.UTF-8' };
}

function onSafePath(tool) {
  return SAFE_PATH.split(':').some((dir) => {
    try {
      accessSync(path.join(dir, tool), fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

let namespaceProbe = null;
/**
 * Checks (once per process) that the namespace backend really works here.
 * @returns {Promise<{ ok: boolean, reason: string, setpriv: boolean }>}
 */
export function probeNamespace() {
  namespaceProbe ??= (async () => {
    if (process.platform !== 'linux') return { ok: false, reason: 'the namespace backend needs Linux', setpriv: false };
    const base = await run('unshare', [...UNSHARE_FLAGS, '--net', '--', 'prlimit', '--nofile=1024', '--', 'true'], { env: toolEnv() });
    if (!base.ok) {
      return { ok: false, reason: `unprivileged user namespaces are not usable (unshare/prlimit failed: ${base.detail})`, setpriv: false };
    }
    const drop = onSafePath('setpriv')
      ? await run('unshare', [...UNSHARE_FLAGS, '--net', '--', 'setpriv', ...SETPRIV_ARGS, 'true'], { env: toolEnv() })
      : { ok: false };
    return { ok: true, reason: 'unshare can create user, network and PID namespaces', setpriv: drop.ok };
  })();
  return namespaceProbe;
}

/**
 * True when a docker daemon answers. Uses the caller's docker client
 * settings (the client is trusted; the check never sees them).
 * @returns {Promise<{ ok: boolean, reason: string }>}
 */
export async function probeContainer() {
  const result = await run('docker', ['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 8000, env: dockerClientEnv() });
  return result.ok
    ? { ok: true, reason: `docker daemon ${result.detail.trim()} is reachable` }
    : { ok: false, reason: `docker daemon is not reachable (${result.detail.split('\n')[0]})` };
}

/** Environment for the docker CLIENT only; none of it is passed into the container. */
function dockerClientEnv() {
  const env = { PATH: process.env.PATH ?? SAFE_PATH };
  for (const name of ['HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY', 'XDG_RUNTIME_DIR']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return env;
}

const isInside = (parent, child) => child === parent || child.startsWith(parent.endsWith('/') ? parent : `${parent}/`);

/** Directories to cover with an empty tmpfs, and those we must leave visible (with the reason). */
function planHiddenDirs(mustStayVisible) {
  const hide = [];
  const kept = [];
  const candidates = new Set();
  for (const dir of [os.homedir(), '/root', '/home']) {
    try {
      if (statSync(dir).isDirectory()) candidates.add(realpathSync(dir));
    } catch {
      /* does not exist */
    }
  }
  for (const dir of candidates) {
    const blocker = mustStayVisible.find((needed) => isInside(dir, needed));
    if (blocker) kept.push(`${dir} (contains ${blocker})`);
    else hide.push(dir);
  }
  return { hide, kept };
}

function describeNamespaceRun({ status, limits, network, features, plan, cgroupGroups, useAddressSpace }) {
  const lines = status.split('\n').filter(Boolean);
  const has = (line) => lines.includes(line);
  const withPrefix = (prefix) => lines.filter((l) => l.startsWith(prefix)).map((l) => l.slice(prefix.length));
  const notes = [];

  notes.push(
    network === 'none'
      ? 'network: blocked by an empty network namespace (no interface is up, not even loopback)'
      : 'network: NOT blocked (host network, explicit operator override)',
  );
  notes.push(`wall clock: ${limits.wallSeconds}s per check, enforced by SIGKILL of the process group; the PID namespace takes every descendant with it`);
  notes.push(`cpu: RLIMIT_CPU ${limits.cpuSeconds}s per process (not summed over child processes; the wall-clock limit bounds the total)`);

  const joined = new Set(cgroupGroups.filter((g) => has(`cgroup-ok ${g.procsFile}`)).flatMap((g) => g.covers));
  const memory = [];
  if (joined.has('memory')) memory.push(`cgroup limit ${limits.memoryMb} MB for the whole process tree`);
  if (useAddressSpace) memory.push(`RLIMIT_AS ${limits.memoryMb} MB per process`);
  memory.push('V8 heap flag for node processes (advisory; other programs ignore it)');
  notes.push(
    `memory: ${memory.join(' + ')}${joined.has('memory') || useAddressSpace ? '' : ' ONLY — no cgroup could be created and RLIMIT_AS is not applied below 4096 MB because it crashes node; a non-node program is not memory-limited'}`,
  );

  const pidNotes = [];
  if (joined.has('pids')) pidNotes.push(`cgroup pids.max ${limits.pids} (threads count)`);
  if (process.getuid?.() !== 0) pidNotes.push(`RLIMIT_NPROC ${limits.pids}`);
  if (has('pidmax-ok')) {
    const pidMax = Math.max(MIN_PID_MAX, limits.pids + 1);
    pidNotes.push(`PID namespace pid_max ${pidMax}${pidMax - 1 > limits.pids ? ' (kernel minimum; looser than requested)' : ''}`);
  }
  notes.push(
    pidNotes.length > 0
      ? `pids: ${pidNotes.join(' + ')}`
      : `pids: NOT enforced (requested ${limits.pids}; the kernel ignores RLIMIT_NPROC for root, and neither a pids cgroup nor a per-namespace pid_max is available)`,
  );

  notes.push(
    features.setpriv
      ? 'capabilities: all dropped with no-new-privileges before the check starts'
      : 'capabilities: NOT dropped (setpriv unavailable) — the check is root inside its user namespace and can undo the read-only mounts and hidden directories below',
  );

  const hidden = withPrefix('hide-ok ');
  const roFailures = withPrefix('ro-fail ').filter((mp) => !hidden.some((dir) => mp !== dir && isInside(dir, mp)));
  if (has('bind-ok')) {
    notes.push(
      roFailures.length === 0
        ? 'filesystem writes: host mounts are read-only inside the sandbox; only the workspace copy and its scratch dir are writable'
        : `filesystem writes: host mounts are read-only inside the sandbox EXCEPT ${roFailures.join(', ')} (could not be remounted)`,
    );
  } else {
    notes.push('filesystem writes: NOT restricted (could not set up read-only mounts); the check can write wherever the caller can');
  }
  const notHidden = [...withPrefix('hide-fail '), ...plan.kept];
  notes.push(
    `filesystem reads: the host filesystem is NOT hidden; files readable by the caller stay readable${hidden.length > 0 ? `, except ${hidden.join(', ')} (covered by empty tmpfs)` : ''}${notHidden.length > 0 ? `; could not hide ${notHidden.join(', ')}` : ''}. Use the container backend for untrusted repositories`,
  );
  return notes;
}

async function runNamespace({ cwd, scratchDir, argv, env, limits, network, maxOutputBytes, signal }) {
  const features = await probeNamespace();
  if (!features.ok) throw new Error(`namespace backend unavailable: ${features.reason}`);

  const realCwd = realpathSync(cwd);
  const realScratch = realpathSync(scratchDir);
  const plan = planHiddenDirs([realCwd, realScratch, realpathSync(path.dirname(process.execPath))]);
  const cgroups = createLimitCgroups(limits);
  const useAddressSpace = limits.memoryMb >= MIN_ADDRESS_SPACE_LIMIT_MB;

  const prlimit = [
    'prlimit',
    `--cpu=${limits.cpuSeconds}`,
    `--nproc=${limits.pids}`,
    `--fsize=${MAX_FILE_BYTES}`,
    '--nofile=1024',
    ...(useAddressSpace ? [`--as=${limits.memoryMb * 1024 * 1024}`] : []),
    '--',
  ];
  const args = [
    ...UNSHARE_FLAGS,
    ...(network === 'none' ? ['--net'] : []),
    '--',
    'sh', '-c', WRAPPER_SCRIPT, 'mender-sandbox',
    realCwd, realScratch, String(Math.max(MIN_PID_MAX, limits.pids + 1)), '1',
    String(cgroups.groups.length), ...cgroups.groups.map((g) => g.procsFile),
    String(plan.hide.length), ...plan.hide,
    ...(features.setpriv ? ['setpriv', ...SETPRIV_ARGS] : []),
    ...prlimit,
    ...argv,
  ];

  try {
    const result = await spawnCapture('unshare', args, {
      cwd: realCwd,
      env,
      wallMs: limits.wallSeconds * 1000,
      maxOutputBytes,
      signal,
      statusFd: true,
    });
    if (result.spawnError) throw new Error(`could not start unshare: ${result.spawnError.message}`);
    return {
      ...result,
      enforcement: describeNamespaceRun({ status: result.status, limits, network, features, plan, cgroupGroups: cgroups.groups, useAddressSpace }),
    };
  } finally {
    await cgroups.cleanup();
  }
}

async function runContainer({ cwd, scratchDir, argv, env, limits, network, image, cpus, maxOutputBytes, signal }) {
  const name = `mender-check-${randomBytes(8).toString('hex')}`;
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  // PATH comes from the image; HOME points at the mounted scratch dir.
  const { PATH: _hostPath, TMPDIR: _hostTmp, ...containerEnv } = env;
  containerEnv.HOME = '/mender-scratch/home';
  const args = [
    'run', '--rm', '--name', name,
    ...(network === 'none' ? ['--network', 'none'] : []),
    '--cpus', String(cpus),
    '--memory', `${limits.memoryMb}m`, '--memory-swap', `${limits.memoryMb}m`,
    '--pids-limit', String(limits.pids),
    '--ulimit', `cpu=${limits.cpuSeconds}`,
    '--ulimit', `fsize=${MAX_FILE_BYTES}`,
    '--read-only', '--tmpfs', '/tmp',
    '--security-opt', 'no-new-privileges',
    '--cap-drop', 'ALL',
    '--user', `${uid}:${gid}`,
    '-v', `${realpathSync(cwd)}:/work`,
    '-v', `${realpathSync(scratchDir)}:/mender-scratch`,
    '-w', '/work',
    ...Object.entries(containerEnv).flatMap(([k, v]) => ['--env', `${k}=${v}`]),
    image,
    ...argv,
  ];
  const result = await spawnCapture('docker', args, {
    cwd,
    env: dockerClientEnv(),
    wallMs: limits.wallSeconds * 1000,
    maxOutputBytes,
    signal,
    // Killing the client does not stop the container; ask the daemon.
    onKill: () => {
      const killer = spawn('docker', ['kill', name], { env: dockerClientEnv(), stdio: 'ignore', detached: true });
      killer.on('error', () => {});
      killer.unref();
    },
  });
  if (result.spawnError) throw new Error(`could not start docker: ${result.spawnError.message}`);
  return {
    ...result,
    enforcement: [
      network === 'none' ? 'network: container started with --network none' : 'network: NOT blocked (default container network, explicit operator override)',
      `wall clock: ${limits.wallSeconds}s per check, enforced with docker kill`,
      `cpu: ulimit ${limits.cpuSeconds}s per process and ${cpus} CPUs for the container`,
      `memory: container cgroup limit ${limits.memoryMb} MB (no swap) + V8 heap flag`,
      `pids: container cgroup limit ${limits.pids}`,
      `filesystem: image ${image} read-only root, tmpfs /tmp; only the workspace copy and its scratch dir are mounted; all capabilities dropped`,
      'kernel: shared with the host (a container is not a virtual machine)',
    ],
  };
}

async function runProcess({ cwd, argv, env, limits, maxOutputBytes, signal }) {
  const result = await spawnCapture(argv[0], argv.slice(1), { cwd, env, wallMs: limits.wallSeconds * 1000, maxOutputBytes, signal });
  const enforcement = [
    'isolation: NONE — the process backend runs the check as a plain child process of the caller',
    'network: NOT blocked',
    `wall clock: ${limits.wallSeconds}s per check, enforced by SIGKILL of the process group (a child that leaves the group survives)`,
    'cpu: NOT enforced',
    'memory: V8 heap flag for node processes only (advisory)',
    'pids: NOT enforced',
    'filesystem: NOT restricted; the check can read and write whatever the caller can, including the original working tree',
    'environment: built from empty, so the caller\'s environment variables are not passed (files holding credentials remain readable)',
  ];
  if (result.spawnError) {
    // Same shape as "command not found" in the other backends: a failed check, not a crash.
    return { ...result, exitCode: 127, output: `could not start ${argv[0]}: ${result.spawnError.code ?? result.spawnError.message}\n`, enforcement };
  }
  return { ...result, enforcement };
}

/**
 * Runs one argv in one fresh sandbox.
 *
 * `env` is the check's EXPLICIT environment only; the base environment is
 * built here from empty (see `buildSandboxEnv`). HOME (and TMPDIR) are fresh
 * directories under `scratchDir`; when `scratchDir` is omitted a temporary
 * one is created and removed.
 *
 * `network: 'host'` must only ever come from an explicit operator override.
 * The `process` backend always has host network regardless of this value.
 *
 * @param {{
 *   backend: 'container' | 'namespace' | 'process',
 *   cwd: string,
 *   argv: string[],
 *   env?: Record<string, string>,
 *   limits: Limits,
 *   network?: 'none' | 'host',
 *   scratchDir?: string,
 *   image?: string,
 *   cpus?: number,
 *   maxOutputBytes?: number,
 *   signal?: AbortSignal,
 * }} input
 * @returns {Promise<SandboxResult>} `exitCode` is null when the check timed
 *   out. `enforcement` lists, in plain words, what was really enforced.
 */
export async function runInSandbox({
  backend,
  cwd,
  argv,
  env = {},
  limits,
  network = 'none',
  scratchDir,
  image = DEFAULT_IMAGE,
  cpus = 2,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  signal,
}) {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((a) => typeof a !== 'string' || a.includes('\0')) || argv[0] === '') {
    throw new TypeError('argv must be a non-empty array of strings');
  }
  if (network !== 'none' && network !== 'host') throw new TypeError('network must be "none" or "host"');
  for (const key of ['cpuSeconds', 'memoryMb', 'wallSeconds', 'pids']) {
    if (!Number.isInteger(limits?.[key]) || limits[key] <= 0) throw new TypeError(`limits.${key} must be a positive integer`);
  }
  if (!existsSync(cwd)) throw new Error(`sandbox cwd does not exist: ${cwd}`);

  const ownScratch = scratchDir ? null : await mkdtemp(path.join(os.tmpdir(), 'mender-scratch-'));
  const scratch = scratchDir ?? ownScratch;
  try {
    const homeDir = path.join(scratch, 'home');
    const tmpDir = path.join(scratch, 'tmp');
    mkdirSync(homeDir, { recursive: true, mode: 0o700 });
    mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
    const sandboxEnv = buildSandboxEnv({ homeDir, tmpDir, checkEnv: env, memoryMb: limits.memoryMb });
    const input = { cwd, scratchDir: scratch, argv, env: sandboxEnv, limits, network, image, cpus, maxOutputBytes, signal };

    let result;
    if (backend === 'namespace') result = await runNamespace(input);
    else if (backend === 'container') result = await runContainer(input);
    else if (backend === 'process') result = await runProcess(input);
    else throw new TypeError(`unknown sandbox backend: ${backend}`);

    if (result.aborted) {
      const error = new Error('validation was aborted');
      error.name = 'AbortError';
      error.code = 'ABORT_ERR';
      throw error;
    }
    return {
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      output: result.output,
      enforcement: result.enforcement,
    };
  } finally {
    if (ownScratch) await rm(ownScratch, { recursive: true, force: true, maxRetries: 3 });
  }
}
