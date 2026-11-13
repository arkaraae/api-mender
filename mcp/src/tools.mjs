// What the MCP tools do, kept apart from the protocol so it can be tested.
//
// Everything runs on the developer's machine. Repository files are read here
// and never sent anywhere; the only network requests download providers'
// public API contracts (GitHub, Stripe, OpenAI, Twilio). The developer's own
// coding agent makes code edits; Mend supplies the evidence and checks the
// result with the same gates its hosted repairs use.
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  applyLineEdits, buildRepairTask, discoverApiUsage, evaluatePatch, findProviderImpact, getProvider, listProviders,
  repairContractFor, withLatestSnapshot,
} from '../../web/lib/engine/index.ts';
import { loadContract } from '../../cli/src/contracts.mjs';
import { readRepositorySources } from '../../cli/src/repo-files.mjs';

const MAX_CALLS_LISTED = 200;
// Findings from the last check, so a fix can be validated against them.
const checked = new Map();

async function repositoryRoot(input) {
  const root = path.resolve(input || process.cwd());
  const info = await stat(root).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`Not a directory: ${root}`);
  return root;
}

/** Every external API the code calls, by service, with each call site. */
export async function scanApis({ path: input } = {}) {
  const root = await repositoryRoot(input);
  const { files, skipped } = await readRepositorySources(root);
  const inventory = discoverApiUsage(files);
  return {
    repository: root,
    filesScanned: files.length,
    services: inventory.services.map(service => ({
      provider: service.providerId ?? null, name: service.providerName, origin: service.origin, files: service.files.slice(0, 20),
      watchedByMend: service.recognition === 'catalog', calls: service.callCount,
      operations: service.operations, pinnedVersions: service.pinnedVersions,
    })),
    calls: inventory.calls.slice(0, MAX_CALLS_LISTED).map(call => ({
      location: `${call.file}:${call.line}`, call: call.symbol, endpoint: call.endpoint, origin: call.origin,
      ...(call.sdk ? { sdkMethod: call.sdk } : {}),
      requestFields: call.fieldsComplete ? call.fields : null,
    })),
    ...(inventory.calls.length > MAX_CALLS_LISTED ? { callsOmitted: inventory.calls.length - MAX_CALLS_LISTED } : {}),
    limitations: [...inventory.limitations, ...skipped].slice(0, 20),
  };
}

function versionsFor(provider, service) {
  const known = provider.contractSources.map(source => source.version);
  const to = known.at(-1);
  if (provider.versioning === 'snapshot') return { from: known[0], to };
  const pinned = [...(service?.pinnedVersions ?? [])].sort();
  return { from: pinned[0] ?? provider.defaultVersion ?? known[0], to };
}

const fixGuide = (task, contract, finding) => ({
  file: task.file,
  editableLines: task.editableRange,
  currentCode: task.excerpt.map(line => `${String(line.line).padStart(5)}  ${line.text}`).join('\n'),
  contract: {
    operation: finding.change.operation,
    removedFields: contract.removed,
    requiredFields: contract.required,
    acceptedFields: contract.acceptedProperties,
  },
  rules: [
    `Edit only lines ${task.editableRange.start}-${task.editableRange.end} of ${task.file}.`,
    'Change only the request object sent to this operation; keep the URL, method, path parameters, headers and client unchanged.',
    'Keep every value the call already sends: move a value to its new field rather than dropping it.',
    contract.acceptedProperties ? `Send only fields the new contract accepts: ${contract.acceptedProperties.slice(0, 40).join(', ')}.` : 'The new contract does not list its accepted fields.',
    'Do not add new imports, network calls or secrets.',
    'Then call validate_fix with this finding id.',
  ],
});

/**
 * Provider changes that break calls in this code. Each finding cites the
 * provider's contract and the line it affects; repairable ones include the
 * exact bounds for a fix.
 */
export async function checkBreakingChanges({ path: input, provider: only, offline = false, contractFiles } = {}) {
  const root = await repositoryRoot(input);
  const { files } = await readRepositorySources(root);
  const sources = new Map(files.map(file => [file.path, file.source]));
  const inventory = discoverApiUsage(files);
  const listed = only ? [getProvider(only)] : listProviders().filter(provider => inventory.services.some(service => service.providerId === provider.id));
  if (listed.includes(null)) throw new Error(`Unknown provider ${only}. Known: ${listProviders().map(provider => provider.id).join(', ')}`);
  const providers = [];
  const findings = [];
  for (const entry of listed) {
    const provider = entry.versioning === 'snapshot' && !offline ? await withLatestSnapshot(entry, fetch, process.env.GITHUB_TOKEN) : entry;
    const service = inventory.services.find(item => item.providerId === provider.id);
    const { from, to } = versionsFor(provider, service);
    if (from === to) { providers.push({ provider: provider.id, from, to, note: 'already on the newest known version' }); continue; }
    // contractFiles: local copies of both contracts (tests; not offered to agents).
    const oldContract = await loadContract(provider, from, { offline, file: contractFiles?.old });
    const newContract = await loadContract(provider, to, { offline, file: contractFiles?.new });
    const found = await findProviderImpact({ provider, oldDocument: oldContract.document, newDocument: newContract.document,
      fromVersion: from, toVersion: to, files });
    providers.push({ provider: provider.id, name: provider.name, from, to, changesInContract: found.changes.length,
      contractUrls: { from: oldContract.url, to: newContract.url } });
    for (const finding of found.findings) {
      const newSlice = found.slices.new.find(slice => slice.operation === finding.change.operation) ?? null;
      const contract = repairContractFor(finding.change, newSlice);
      const source = sources.get(finding.location.file) ?? '';
      const task = finding.repairable ? buildRepairTask(finding, source, contract) : null;
      checked.set(finding.id, { root, finding, contract, source, task: task?.supported ? task : null });
      findings.push({
        id: finding.id, title: finding.title, severity: finding.severity, confidence: finding.confidence,
        location: `${finding.location.file}:${finding.location.line}`,
        change: { kind: finding.change.kind, operation: finding.change.operation, fields: finding.change.fields,
          fromVersion: finding.change.fromVersion, toVersion: finding.change.toVersion, summary: finding.change.summary },
        applicability: finding.evidence.applicability,
        evidence: finding.evidence.staticChecks,
        notEstablished: finding.evidence.notEstablished,
        ...(task?.supported ? { fix: fixGuide(task, contract, finding) } : { fix: null, whyNoFix: task?.reason ?? 'This change is flagged for review; Mend has no bounded fix for it.' }),
      });
    }
  }
  const unwatched = inventory.services.filter(service => service.recognition !== 'catalog').map(service => service.providerName);
  return {
    repository: root, providers, findings,
    ...(unwatched.length ? { notChecked: `These APIs are called but their contracts are not checked locally: ${unwatched.slice(0, 20).join(', ')}. Connect the repository at apimender.com to watch APIs Mend discovers automatically.` } : {}),
    note: findings.length ? 'Static analysis: findings show where a provider change reaches the code; run the project tests after any fix.' : 'No breaking provider changes found for the checked providers.',
  };
}

// The one changed region between two versions of a file, as a line edit.
export function editBetween(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  if (start === a.length && start === b.length) return null;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) { endA--; endB--; }
  // A pure insertion is expressed as replacing the line before it.
  if (endA < start) { start = Math.max(0, start - 1); }
  return { startLine: start + 1, endLine: Math.max(endA, start) + 1, replacement: b.slice(start, endB + 1).join('\n') };
}

/** Check the developer's edit for a finding against Mend's repair gates. */
export async function validateFix({ findingId } = {}) {
  const entry = checked.get(findingId);
  if (!entry) throw new Error('Unknown finding id. Run check_breaking_changes first, in this session.');
  if (!entry.task) return { findingId, passed: false, reason: 'This finding has no bounded fix to validate; review it by hand.' };
  const file = path.join(entry.root, entry.finding.location.file);
  const after = await readFile(file, 'utf8');
  const edit = editBetween(entry.source, after);
  if (!edit) return { findingId, passed: false, reason: `${entry.finding.location.file} has not changed since the check.` };
  const result = evaluatePatch({ finding: entry.finding, task: entry.task, contract: entry.contract, source: entry.source, edits: [edit] });
  const rebuilt = applyLineEdits(entry.source, [edit]);
  return {
    findingId, file: entry.finding.location.file, passed: result.passed && rebuilt === after,
    checks: result.checks.map(check => ({ gate: check.name, passed: check.passed, ...(check.detail ? { detail: check.detail } : {}) })),
    next: result.passed ? 'All gates passed. Run the project tests against the new API version before merging.'
      : 'Some gates failed: change only the request object within the editable lines, keep existing values, and send only accepted fields.',
  };
}
