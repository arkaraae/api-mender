// Configuration loader for the Mender CLI.
//
// TRUST MODEL — read this before changing anything here.
//
// `mender.config.json` is REPOSITORY CONTENT. Anyone who can open a pull
// request can change it, so nothing in it may widen what the CLI is allowed
// to do:
//
//   * It is JSON only. There is deliberately no YAML and no JS/TS config:
//     loading a config file must never execute code.
//   * `checks[].command` is an argv array. It is never a shell string and is
//     never handed to a shell, so the file cannot smuggle `$(...)`, `;` or
//     redirections into the runner.
//   * `runner.network` may only be "none" in the file. Network access for the
//     validation sandbox can only be granted by the person running the CLI,
//     through an explicit flag that reaches `resolveRunnerOptions` as an
//     override. If the file could say "host", a pull request could grant its
//     own checks network access and exfiltrate whatever they can read.
//   * `model.endpoint` from the file is only a REQUEST. The CLI passes it to
//     the engine, whose egress guard still decides whether that address may
//     be contacted (loopback/private only in customer-managed mode unless the
//     operator allows remote). This module only checks that it is a URL.
//   * The model API key is never in the file, and neither is the name of the
//     variable holding it: the CLI reads only the operator's MENDER_MODEL_API_KEY,
//     and never sends it to an endpoint taken from this file.
//   * `report.upload` and `report.fields` say what the repository is willing
//     to share. The upload DESTINATION and TOKEN are never read from this
//     file — they come from the operator's flags/environment — so a pull
//     request cannot redirect a report to another server.
//
// Unknown keys are rejected at every level so a typo cannot silently disable
// a safety setting, and every size is bounded.

import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_CONFIG_FILE = 'mender.config.json';
/** A config larger than this is not a config. */
export const MAX_CONFIG_BYTES = 64 * 1024;

export const REPORT_FIELDS = Object.freeze(['providers', 'findingStatus', 'filePaths', 'hashes', 'validation']);
export const BACKENDS = Object.freeze(['auto', 'container', 'namespace', 'process']);

export const RUNNER_DEFAULTS = Object.freeze({
  backend: 'auto',
  wallSeconds: 120,
  cpuSeconds: 60,
  memoryMb: 1024,
  pids: 256,
  network: 'none',
});

/** Inclusive bounds for every numeric runner limit. */
export const RUNNER_BOUNDS = Object.freeze({
  wallSeconds: Object.freeze([1, 1800]),
  cpuSeconds: Object.freeze([1, 1800]),
  memoryMb: Object.freeze([64, 16384]),
  pids: Object.freeze([16, 4096]),
});

const CHECK_NAME = /^[A-Za-z0-9_.-]{1,40}$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
const IMAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,199}$/;

const MAX_CHECKS = 10;
const MAX_ARGV = 20;
const MAX_ARG_CHARS = 200;
const MAX_ENV_ENTRIES = 20;
const MAX_ENV_VALUE_CHARS = 500;

// Variables that change how a loader, shell, git or ssh behaves BEFORE the
// check's own code runs. The sandbox sets PATH/HOME/NODE_OPTIONS itself; a
// config that could override them could point the wrapper tools (unshare,
// prlimit, sh) or the Node loader at attacker-chosen code or lift the V8 heap
// limit.
const FORBIDDEN_ENV_EXACT = new Set(['PATH', 'HOME', 'NODE_OPTIONS', 'NODE_PATH', 'BASH_ENV', 'ENV']);
const FORBIDDEN_ENV_PREFIXES = ['LD_', 'DYLD_', 'GIT_', 'SSH_'];

/** @param {string} name */
export function isForbiddenEnvName(name) {
  return FORBIDDEN_ENV_EXACT.has(name) || FORBIDDEN_ENV_PREFIXES.some((p) => name.startsWith(p));
}

export class ConfigError extends Error {
  /** @param {string[]} problems @param {string} [where] */
  constructor(problems, where = 'configuration') {
    super(`Invalid ${where}:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
    this.code = 'EMENDERCONFIG';
    this.problems = problems;
  }
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Records unknown keys. Uses own keys so a JSON "__proto__" member is caught too. */
function rejectUnknownKeys(obj, allowed, where, problems) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) problems.push(`${where}: unknown key ${JSON.stringify(key)}`);
  }
}

function checkInteger(value, [min, max], where, problems) {
  if (!Number.isInteger(value) || value < min || value > max) {
    problems.push(`${where} must be an integer between ${min} and ${max}`);
    return false;
  }
  return true;
}

function validateCommand(command, where, problems) {
  if (typeof command === 'string') {
    problems.push(
      `${where} must be an argv array such as ["npm", "test"], not a shell string; commands are never passed to a shell`,
    );
    return null;
  }
  if (!Array.isArray(command) || command.length < 1 || command.length > MAX_ARGV) {
    problems.push(`${where} must be an array of 1 to ${MAX_ARGV} strings`);
    return null;
  }
  let ok = true;
  command.forEach((arg, i) => {
    if (typeof arg !== 'string') {
      problems.push(`${where}[${i}] must be a string`);
      ok = false;
    } else if (arg.length > MAX_ARG_CHARS) {
      problems.push(`${where}[${i}] is longer than ${MAX_ARG_CHARS} characters`);
      ok = false;
    } else if (arg.includes('\0')) {
      problems.push(`${where}[${i}] contains a NUL byte`);
      ok = false;
    }
  });
  if (ok && command[0].length === 0) {
    problems.push(`${where}[0] (the program) must not be empty`);
    ok = false;
  }
  return ok ? [...command] : null;
}

function validateEnv(env, where, problems) {
  if (env === undefined) return {};
  if (!isPlainObject(env)) {
    problems.push(`${where} must be an object of NAME: "value" pairs`);
    return {};
  }
  const names = Object.keys(env);
  if (names.length > MAX_ENV_ENTRIES) problems.push(`${where} has more than ${MAX_ENV_ENTRIES} entries`);
  const out = {};
  for (const name of names) {
    const value = env[name];
    if (!ENV_NAME.test(name)) {
      problems.push(`${where}: name ${JSON.stringify(name)} must match ${ENV_NAME}`);
    } else if (isForbiddenEnvName(name)) {
      problems.push(`${where}: ${name} may not be set by a check; it could subvert the sandbox or the program loader`);
    } else if (typeof value !== 'string') {
      problems.push(`${where}.${name} must be a string`);
    } else if (value.length > MAX_ENV_VALUE_CHARS) {
      problems.push(`${where}.${name} is longer than ${MAX_ENV_VALUE_CHARS} characters`);
    } else if (value.includes('\0')) {
      problems.push(`${where}.${name} contains a NUL byte`);
    } else {
      out[name] = value;
    }
  }
  return out;
}

/** Appends problems; returns the normalised checks (meaningful only when no problems were added). */
function collectChecks(checks, problems) {
  if (checks === undefined) return [];
  if (!Array.isArray(checks)) {
    problems.push('checks must be an array');
    return [];
  }
  if (checks.length > MAX_CHECKS) problems.push(`checks has more than ${MAX_CHECKS} entries`);
  const seen = new Set();
  const out = [];
  checks.forEach((check, i) => {
    const where = `checks[${i}]`;
    if (!isPlainObject(check)) {
      problems.push(`${where} must be an object`);
      return;
    }
    rejectUnknownKeys(check, ['name', 'command', 'env'], where, problems);
    if (typeof check.name !== 'string' || !CHECK_NAME.test(check.name)) {
      problems.push(`${where}.name must match ${CHECK_NAME}`);
    } else if (seen.has(check.name)) {
      problems.push(`${where}.name ${JSON.stringify(check.name)} is used more than once`);
    } else {
      seen.add(check.name);
    }
    const command = validateCommand(check.command, `${where}.command`, problems);
    const env = validateEnv(check.env, `${where}.env`, problems);
    out.push({ name: check.name, command: command ?? [], env });
  });
  return out;
}

/**
 * Validates a list of checks on its own. The runner calls this again on
 * whatever it is handed, so the argv/env rules hold even for callers that
 * did not go through `loadConfig`.
 *
 * @param {unknown} checks
 * @returns {ReadonlyArray<Check>}
 */
export function validateChecks(checks) {
  const problems = [];
  const out = collectChecks(checks, problems);
  if (problems.length > 0) throw new ConfigError(problems, 'checks');
  return deepFreeze(out);
}

function collectRunner(runner, problems, { where = 'runner', allowHostNetwork = false, allowImage = false, allowProcess = false } = {}) {
  const out = {};
  if (runner === undefined) return out;
  if (!isPlainObject(runner)) {
    problems.push(`${where} must be an object`);
    return out;
  }
  const allowed = ['backend', 'wallSeconds', 'cpuSeconds', 'memoryMb', 'pids', 'network'];
  if (allowImage) allowed.push('image');
  rejectUnknownKeys(runner, allowed, where, problems);

  if (runner.backend !== undefined) {
    // 'process' runs repository code with NO isolation (host network and
    // filesystem). The file is repository content, so a pull request could
    // otherwise switch isolation off; only the operator's flag can.
    if (runner.backend === 'process' && !allowProcess) {
      problems.push(`${where}.backend: "process" (no isolation) cannot be set in the config file; the operator must pass --unsafe-no-isolation`);
    } else if (BACKENDS.includes(runner.backend)) out.backend = runner.backend;
    else problems.push(`${where}.backend must be one of ${BACKENDS.join(', ')}`);
  }
  for (const key of Object.keys(RUNNER_BOUNDS)) {
    if (runner[key] !== undefined && checkInteger(runner[key], RUNNER_BOUNDS[key], `${where}.${key}`, problems)) {
      out[key] = runner[key];
    }
  }
  if (runner.network !== undefined) {
    if (runner.network === 'none' || (allowHostNetwork && runner.network === 'host')) {
      out.network = runner.network;
    } else if (runner.network === 'host') {
      problems.push(
        `${where}.network: "host" cannot be set in the config file. The file is repository content, and a pull request must not be able to grant its own checks network access; pass the explicit CLI flag instead`,
      );
    } else {
      problems.push(`${where}.network must be "none"`);
    }
  }
  if (allowImage && runner.image !== undefined) {
    if (typeof runner.image === 'string' && IMAGE_NAME.test(runner.image)) out.image = runner.image;
    else problems.push(`${where}.image must be a container image reference`);
  }
  return out;
}

function collectModel(model, problems) {
  if (model === undefined) return null;
  if (!isPlainObject(model)) {
    problems.push('model must be an object');
    return null;
  }
  if (Object.hasOwn(model, 'apiKey')) {
    problems.push(
      'model.apiKey: do not put a credential in mender.config.json (it is committed to the repository). Set it in MENDER_MODEL_API_KEY where the CLI runs',
    );
  }
  rejectUnknownKeys(model, ['endpoint', 'model', 'apiKeyEnv', 'apiKey'], 'model', problems);

  let endpoint = null;
  if (typeof model.endpoint !== 'string' || model.endpoint.length > 2000) {
    problems.push('model.endpoint must be a URL string');
  } else {
    let url = null;
    try {
      url = new URL(model.endpoint);
    } catch {
      problems.push('model.endpoint must be a valid URL');
    }
    if (url && url.protocol !== 'http:' && url.protocol !== 'https:') {
      problems.push('model.endpoint must use http: or https:');
    } else if (url && (url.username || url.password)) {
      problems.push('model.endpoint must not contain credentials; set MENDER_MODEL_API_KEY where the CLI runs');
    } else if (url) {
      endpoint = model.endpoint;
    }
  }
  if (typeof model.model !== 'string' || model.model.length < 1 || model.model.length > 200) {
    problems.push('model.model must be a string of 1 to 200 characters');
  }
  // The key always comes from the operator's MENDER_MODEL_API_KEY. Letting the
  // repository name the variable would let a pull request choose which secret
  // (GITHUB_TOKEN, cloud keys…) is sent as the bearer token.
  if (model.apiKeyEnv !== undefined) {
    problems.push('model.apiKeyEnv is not read from the repository; set MENDER_MODEL_API_KEY where the CLI runs');
  }
  return { endpoint, model: model.model };
}

function collectReport(report, problems) {
  const out = { upload: false, fields: [...REPORT_FIELDS] };
  if (report === undefined) return out;
  if (!isPlainObject(report)) {
    problems.push('report must be an object');
    return out;
  }
  rejectUnknownKeys(report, ['upload', 'fields'], 'report', problems);
  if (report.upload !== undefined) {
    if (typeof report.upload === 'boolean') out.upload = report.upload;
    else problems.push('report.upload must be true or false');
  }
  if (report.fields !== undefined) {
    if (!Array.isArray(report.fields) || report.fields.length > REPORT_FIELDS.length) {
      problems.push(`report.fields must be an array drawn from ${JSON.stringify(REPORT_FIELDS)}`);
    } else {
      const bad = report.fields.filter((f) => !REPORT_FIELDS.includes(f));
      const unique = new Set(report.fields);
      if (bad.length > 0) {
        problems.push(`report.fields: ${JSON.stringify(bad)} not allowed; allowed fields are ${JSON.stringify(REPORT_FIELDS)}`);
      } else if (unique.size !== report.fields.length) {
        problems.push('report.fields must not repeat a field');
      } else {
        // Canonical order so reports do not depend on how the file was typed.
        out.fields = REPORT_FIELDS.filter((f) => unique.has(f));
      }
    }
  }
  return out;
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/**
 * Pure validation of a parsed config value. Returns a normalised, deeply
 * frozen config with every default filled in, or throws a `ConfigError`
 * whose `.problems` lists EVERY problem found (not just the first).
 *
 * @param {unknown} raw
 * @returns {MenderConfig}
 */
export function validateConfig(raw) {
  const problems = [];
  if (!isPlainObject(raw)) throw new ConfigError(['the top level must be a JSON object']);
  rejectUnknownKeys(raw, ['checks', 'runner', 'model', 'report'], 'config', problems);

  const checks = collectChecks(raw.checks, problems);
  const runner = { ...RUNNER_DEFAULTS, ...collectRunner(raw.runner, problems) };
  const model = collectModel(raw.model, problems);
  const report = collectReport(raw.report, problems);

  if (problems.length > 0) throw new ConfigError(problems);
  return deepFreeze({ checks, runner, model, report });
}

/**
 * Reads `<repoRoot>/<fileName>`. A missing file yields the defaults (no
 * checks, upload false) with `source: 'defaults'`.
 *
 * The file must be a regular file inside the repository: a symlink is
 * refused so a repository cannot make the CLI read (and echo validation
 * errors about) a file somewhere else on the machine.
 *
 * @param {string} repoRoot
 * @param {{ fileName?: string }} [options]
 * @returns {Promise<MenderConfig & { source: 'file' | 'defaults', path: string | null }>}
 */
export async function loadConfig(repoRoot, { fileName = DEFAULT_CONFIG_FILE } = {}) {
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) throw new TypeError('repoRoot must be a path');
  if (typeof fileName !== 'string' || path.basename(fileName) !== fileName || !fileName.endsWith('.json')) {
    throw new ConfigError([`config file name ${JSON.stringify(fileName)} must be a plain *.json file name`]);
  }
  const filePath = path.join(repoRoot, fileName);

  let stats;
  try {
    stats = await lstat(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return deepFreeze({ ...validateConfig({}), source: 'defaults', path: null });
    throw error;
  }
  if (!stats.isFile()) throw new ConfigError([`${fileName} must be a regular file (not a symlink or directory)`]);
  if (stats.size > MAX_CONFIG_BYTES) throw new ConfigError([`${fileName} is larger than ${MAX_CONFIG_BYTES} bytes`]);

  let parsed;
  try {
    parsed = JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    throw new ConfigError([`${fileName} is not valid JSON: ${error.message}`]);
  }
  let validated;
  try {
    validated = validateConfig(parsed);
  } catch (error) {
    if (error instanceof ConfigError) throw new ConfigError(error.problems, fileName);
    throw error;
  }
  return deepFreeze({ ...validated, checks: validated.checks, source: 'file', path: filePath });
}

/**
 * Merges the runner section of a validated config with explicit operator
 * overrides (CLI flags) and returns the options object for `runValidation`.
 *
 * This is the ONLY place `network: 'host'` can enter: the config file is
 * repository content and `validateConfig` refuses it there, because a pull
 * request must not be able to grant its own checks network access. An
 * override comes from the person or CI job invoking the CLI.
 *
 * Likewise `backend: 'process'` (no isolation) is accepted only from an
 * override (the CLI's `--unsafe-no-isolation`), never from the file, and
 * `detectBackend('auto')` never selects it.
 *
 * @param {{ runner?: Partial<RunnerOptions> } | null | undefined} config
 * @param {Partial<RunnerOptions>} [overrides]
 * @returns {Readonly<RunnerOptions>}
 */
export function resolveRunnerOptions(config, overrides = {}) {
  const problems = [];
  // Re-validate the config side with FILE rules so a hand-built config object
  // cannot carry network: 'host' past this function either.
  const fromConfig = collectRunner(config?.runner ?? undefined, problems, { where: 'config.runner' });
  const defined = Object.fromEntries(Object.entries(overrides ?? {}).filter(([, v]) => v !== undefined));
  const fromOverrides = collectRunner(defined, problems, {
    where: 'overrides',
    allowHostNetwork: true,
    allowImage: true,
    allowProcess: true,
  });
  if (problems.length > 0) throw new ConfigError(problems, 'runner options');
  return Object.freeze({ ...RUNNER_DEFAULTS, ...fromConfig, ...fromOverrides });
}

/**
 * @typedef {{ name: string, command: string[], env: Record<string, string> }} Check
 * @typedef {{ backend: 'auto'|'container'|'namespace'|'process', wallSeconds: number, cpuSeconds: number,
 *   memoryMb: number, pids: number, network: 'none'|'host', image?: string }} RunnerOptions
 * @typedef {{
 *   checks: ReadonlyArray<Check>,
 *   runner: Readonly<RunnerOptions>,
 *   model: Readonly<{ endpoint: string, model: string }> | null,
 *   report: Readonly<{ upload: boolean, fields: ReadonlyArray<string> }>,
 * }} MenderConfig
 */
