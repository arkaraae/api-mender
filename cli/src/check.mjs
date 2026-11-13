// `mender scan` and `mender check`: the whole pipeline in the customer's
// environment.
//
//   repository files → usage inventory → provider contracts (official URL or
//   local file) → per-operation diff → impact → findings → bounded repair
//   (rules, then the customer's own model endpoint) → isolated checks →
//   patch files + local report (+ an opt-in metadata report)
//
// Source code, excerpts, prompts, model output, diffs and check output stay
// on this machine. The only thing that can leave is the metadata report from
// web/lib/engine/boundary.ts, and only when both the repository config and
// the operator's flag allow it.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  buildMetadataReport, contractEndpoint, discoverApiUsage, findProviderImpact, getProvider, listOperations, listProviders,
  matchOperationKey, proposeRepair, repairContractFor, withLatestSnapshot,
} from '../../web/lib/engine/index.ts';
import { loadConfig, resolveRunnerOptions } from './config.mjs';
import { loadContract } from './contracts.mjs';
import { headCommit, readRepositorySources } from './repo-files.mjs';
import { runValidation } from './runner/index.mjs';

export const CLI_VERSION = '0.1.0';

async function prepareOut(dir) {
  await mkdir(path.join(dir, 'patches'), { recursive: true, mode: 0o700 });
  await mkdir(path.join(dir, 'logs'), { recursive: true, mode: 0o700 });
  // Keep results out of git (and out of the runner's copy of the tree).
  await writeFile(path.join(dir, '.gitignore'), '*\n');
}

const write = (file, value) => writeFile(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });

/**
 * Model settings: flags, then environment, then the repository config. The
 * key only ever comes from the operator's MENDER_MODEL_API_KEY. An endpoint
 * taken from the repository config is repository content: it must be local or
 * private (--allow-remote-model does not extend to it) and no key is sent to it.
 */
export function resolveModel(flags, config, env = process.env) {
  const operatorEndpoint = flags.modelEndpoint ?? env.MENDER_MODEL_ENDPOINT;
  const endpoint = operatorEndpoint ?? config.model?.endpoint;
  const model = flags.model ?? env.MENDER_MODEL_NAME ?? config.model?.model;
  if (!endpoint || !model) return null;
  const fromOperator = operatorEndpoint !== undefined;
  return { endpoint, model, apiKey: fromOperator ? env.MENDER_MODEL_API_KEY || undefined : undefined,
    mode: 'customer-managed', allowRemote: fromOperator && flags.allowRemoteModel === true, timeoutMs: 120_000 };
}

export async function scan({ repo }) {
  const { files, skipped } = await readRepositorySources(repo);
  const inventory = discoverApiUsage(files);
  return { inventory, skipped };
}

function versionsFor(provider, service, flags) {
  const known = provider.contractSources.map(source => source.version);
  const to = flags.to ?? known.at(-1);
  // Snapshot providers: everything published since the baseline.
  if (provider.versioning === 'snapshot') return { from: flags.from ?? known[0], to };
  // The oldest version the code actually selects is the one to compare from.
  const pinned = [...(service?.pinnedVersions ?? [])].sort();
  const from = flags.from ?? pinned[0] ?? provider.defaultVersion ?? known[0];
  return { from, to };
}

export async function check(flags) {
  const repo = path.resolve(flags.repo ?? '.');
  const out = path.resolve(flags.out ?? path.join(repo, '.mender'));
  const config = await loadConfig(repo);
  const runnerOptions = resolveRunnerOptions(config, {
    backend: flags.unsafeNoIsolation ? 'process' : flags.backend,
    network: flags.allowCheckNetwork ? 'host' : undefined,
  });
  const model = resolveModel(flags, config);
  await prepareOut(out);

  const { files, skipped } = await readRepositorySources(repo);
  const sources = new Map(files.map(file => [file.path, file.source]));
  const inventory = discoverApiUsage(files);
  const wanted = flags.provider ? [getProvider(flags.provider)] : listProviders()
    .filter(provider => inventory.services.some(service => service.providerId === provider.id));
  if (wanted.includes(null)) throw new Error(`unknown provider ${flags.provider}; known: ${listProviders().map(p => p.id).join(', ')}`);

  const results = [];
  const providers = [];
  const operationKeys = new Map();
  for (const listed of wanted) {
    // Snapshot providers: look up the newest published contract (or use the
    // baseline only when offline).
    const provider = listed.versioning === 'snapshot' && !flags.offline && !flags.newContract
      ? await withLatestSnapshot(listed, fetch, process.env.GITHUB_TOKEN) : listed;
    const service = inventory.services.find(item => item.providerId === provider.id);
    const { from, to } = versionsFor(provider, service, flags);
    if (from === to) { providers.push({ id: provider.id, from, to, skipped: 'already on the newest known version' }); continue; }
    const oldContract = await loadContract(provider, from, { file: flags.oldContract, offline: flags.offline });
    const newContract = await loadContract(provider, to, { file: flags.newContract, offline: flags.offline });
    operationKeys.set(provider.id, listOperations(oldContract.document));
    const found = await findProviderImpact({ provider, oldDocument: oldContract.document, newDocument: newContract.document,
      fromVersion: from, toVersion: to, files });
    providers.push({ id: provider.id, name: provider.name, from, to,
      contracts: { from: { sha256: oldContract.sha256, url: oldContract.url, origin: oldContract.origin },
        to: { sha256: newContract.sha256, url: newContract.url, origin: newContract.origin } },
      operationsChecked: found.slices.old.map(slice => slice.operation), changes: found.changes.length });

    for (const finding of found.findings) {
      const entry = { finding };
      results.push(entry);
      if (!finding.repairable) continue;
      const newSlice = found.slices.new.find(slice => slice.operation === finding.change.operation) ?? null;
      const contract = repairContractFor(finding.change, newSlice);
      entry.repair = await proposeRepair({ finding, source: sources.get(finding.location.file) ?? '', contract,
        model: model ?? undefined, allowModel: flags.noModel !== true });
      if ('abstained' in entry.repair) continue;
      const patchFile = path.join(out, 'patches', `${finding.id.slice(0, 16)}.patch`);
      await write(patchFile, entry.repair.diff);
      entry.patchFile = path.relative(process.cwd(), patchFile);
      if (!config.checks.length) continue;
      const run = await runValidation({ repoRoot: repo, patch: entry.repair.diff, file: finding.location.file,
        checks: config.checks, options: runnerOptions });
      entry.validation = run.report;
      entry.enforcement = run.enforcement;
      // Check output stays here; it is never part of either report.
      const logFile = path.join(out, 'logs', `${finding.id.slice(0, 16)}.log`);
      await write(logFile, run.logs.map(log => `### ${log.phase} / ${log.name}\n${log.output}\n`).join('\n'));
      entry.logFile = path.relative(process.cwd(), logFile);
    }
  }

  const report = { schemaVersion: 1, mode: 'customer-managed', cliVersion: CLI_VERSION, repository: repo,
    commitSha: headCommit(repo), generatedAt: new Date().toISOString(),
    model: model ? { endpoint: new URL(model.endpoint).origin, model: model.model } : null,
    runner: { backend: runnerOptions.backend, network: runnerOptions.network },
    services: inventory.services, inventoryLimitations: [...inventory.limitations, ...skipped], providers, results };
  await write(path.join(out, 'report.json'), report);

  const metadata = await buildMetadataReport({
    cliVersion: CLI_VERSION, repositoryLabel: flags.label ?? (path.basename(repo).replace(/[^A-Za-z0-9 _./@-]/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 100) || 'repository'),
    commitSha: report.commitSha, fields: config.report.fields, services: inventory.services,
    operationTemplate: (providerId, endpoint) => {
      const keys = operationKeys.get(providerId);
      const provider = getProvider(providerId);
      return keys ? matchOperationKey(keys, provider ? contractEndpoint(provider, endpoint) : endpoint) : null;
    },
    results,
  });
  await write(path.join(out, 'metadata-report.json'), metadata);

  let upload = { sent: false, reason: 'upload is off' };
  if (flags.upload) {
    if (!config.report.upload) upload = { sent: false, reason: 'report.upload is false in mender.config.json' };
    else upload = await sendMetadata(metadata, flags);
  }
  return { out, report, metadata, upload };
}

/**
 * The single network call that carries customer-derived data to API Mender.
 * Destination and token come from the operator (flag/env), never the repo.
 */
async function sendMetadata(metadata, flags, env = process.env) {
  const url = flags.uploadUrl ?? env.MENDER_REPORT_URL;
  const token = env.MENDER_REPORT_TOKEN;
  if (!url || !token) return { sent: false, reason: 'MENDER_REPORT_URL and MENDER_REPORT_TOKEN must be set to upload' };
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.username || target.password) return { sent: false, reason: 'upload URL must be https' };
  const response = await fetch(target, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(metadata) });
  return response.ok ? { sent: true, status: response.status } : { sent: false, reason: `server answered HTTP ${response.status}` };
}
