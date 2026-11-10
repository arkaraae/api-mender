#!/usr/bin/env node
// Mender CLI. Runs entirely in the environment it is started in; see
// docs/data-boundaries.md for exactly what (if anything) leaves it.
import { parseArgs } from 'node:util';
import { CLI_VERSION, check, scan } from '../src/check.mjs';

const HELP = `mender ${CLI_VERSION}

Usage
  mender scan  [--repo DIR] [--json]
  mender check [--repo DIR] [--out DIR] [options]

scan    List the external APIs this repository calls (Integrated Services).
check   Compare each recognised provider's contract versions against the code,
        report findings, propose bounded patches, and run the checks from
        mender.config.json in an isolated runner. Patches are written to
        <out>/patches; nothing is committed, pushed or merged.

check options
  --provider ID            Only this provider (e.g. github-rest).
  --from VERSION           Contract version to compare from (default: the
                           oldest version the code pins, else the provider default).
  --to VERSION             Version to compare to (default: newest known).
  --old-contract FILE      Use a local contract file for --from (needs --provider).
  --new-contract FILE      Use a local contract file for --to (needs --provider).
  --offline                Use cached contracts only.
  --model-endpoint URL     OpenAI-compatible endpoint of YOUR model server
                           (env MENDER_MODEL_ENDPOINT). Key: env MENDER_MODEL_API_KEY.
  --model NAME             Model name on that server (env MENDER_MODEL_NAME).
  --allow-remote-model     Allow a non-local model endpoint. Hosted AI providers
                           (OpenAI, Anthropic, ...) are refused regardless.
  --no-model               Deterministic repairs only.
  --backend NAME           auto | container | namespace (checks always isolated).
  --unsafe-no-isolation    Run checks as plain processes (host network and files).
  --allow-check-network    Give isolated checks network access.
  --upload                 Send the metadata report (needs report.upload: true in
                           the config, plus MENDER_REPORT_URL and MENDER_REPORT_TOKEN).
  --upload-url URL         Overrides MENDER_REPORT_URL.
  --label TEXT             Repository label used in the metadata report.
  --json                   Print the full local report as JSON.

Exit status: 0 no findings, 1 findings reported, 2 error.
`;

const options = {
  repo: { type: 'string' }, out: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  provider: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' },
  'old-contract': { type: 'string' }, 'new-contract': { type: 'string' }, offline: { type: 'boolean' },
  'model-endpoint': { type: 'string' }, model: { type: 'string' }, 'allow-remote-model': { type: 'boolean' },
  'no-model': { type: 'boolean' }, backend: { type: 'string' }, 'unsafe-no-isolation': { type: 'boolean' },
  'allow-check-network': { type: 'boolean' }, upload: { type: 'boolean' }, 'upload-url': { type: 'string' },
  label: { type: 'string' }, version: { type: 'boolean' },
};

const camel = key => key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());

function summarizeScan(inventory) {
  const lines = [`Integrated services (${inventory.services.length}):`];
  for (const service of inventory.services) {
    lines.push(`  ${service.providerName}  ${service.origin}  ${service.callCount} call${service.callCount === 1 ? '' : 's'} in ${service.files.length} file${service.files.length === 1 ? '' : 's'}`
      + (service.pinnedVersions.length ? `  pinned ${service.pinnedVersions.join(', ')}` : ''));
    for (const operation of service.operations.slice(0, 20)) lines.push(`      ${operation}`);
  }
  return lines.join('\n');
}

function summarizeCheck({ out, report, upload }) {
  const lines = [];
  for (const provider of report.providers)
    lines.push(provider.skipped ? `${provider.id}: ${provider.from} → ${provider.to}: ${provider.skipped}`
      : `${provider.name}: compared ${provider.from} → ${provider.to} for ${provider.operationsChecked.length} operation(s) the code uses; ${provider.changes} contract change(s).`);
  lines.push(`Findings: ${report.results.length}`);
  for (const [index, { finding, repair, validation, patchFile, logFile }] of report.results.entries()) {
    lines.push('', `${index + 1}. ${finding.title}`,
      `   Upstream:   ${finding.change.summary}`,
      `   Location:   ${finding.location.file}:${finding.location.line}`,
      `   Impact:     ${finding.impact.summary}`,
      `   Confidence: ${finding.confidence} · ${finding.evidence.applicability} · ${validation?.breakReproduced && validation.checksPassed ? 'test-confirmed' : finding.verification}`);
    if (!repair) lines.push('   Repair:     none (not repairable by Mender)');
    else if ('abstained' in repair) lines.push(`   Repair:     abstained (${repair.stage}): ${repair.reason}`);
    else {
      lines.push(`   Repair:     ${repair.method}${repair.model ? ` (${repair.model})` : ''}; ${repair.policy.length} policy gates passed`,
        `   Patch:      ${patchFile}`, ...repair.diff.trimEnd().split('\n').map(line => `      ${line}`));
      if (validation) {
        lines.push(`   Checks:     ${validation.isolation.backend} runner, network ${validation.isolation.network}`);
        for (const phase of ['before', 'after'])
          for (const result of validation[phase])
            lines.push(`      ${phase.padEnd(6)} ${result.passed ? 'PASS' : 'FAIL'}  ${result.name}  (${result.command.join(' ')}; exit ${result.exitCode ?? 'none'}${result.timedOut ? ', timed out' : ''})`);
        lines.push(`   Result:     ${validation.statement}`, `   Logs:       ${logFile} (local only)`);
      } else lines.push('   Checks:     none configured; the patch was not validated');
      lines.push(...repair.uncertainty.map(item => `   Uncertain:  ${item}`));
    }
  }
  lines.push('', `Local report: ${out}/report.json`,
    `Metadata report (the only data that may be uploaded): ${out}/metadata-report.json — ${upload.sent ? 'uploaded' : `not uploaded (${upload.reason})`}`);
  return lines.join('\n');
}

async function main(argv) {
  const { values, positionals } = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  const flags = Object.fromEntries(Object.entries(values).map(([key, value]) => [camel(key), value]));
  if (flags.version) { console.log(CLI_VERSION); return 0; }
  const [command] = positionals;
  if (flags.help || !command) { console.log(HELP); return command || flags.help ? 0 : 2; }
  if ((flags.oldContract || flags.newContract) && !flags.provider) throw new Error('--old-contract/--new-contract need --provider');
  if (command === 'scan') {
    const { inventory } = await scan({ repo: flags.repo ?? '.' });
    console.log(flags.json ? JSON.stringify(inventory, null, 2) : summarizeScan(inventory));
    return 0;
  }
  if (command === 'check') {
    const result = await check(flags);
    console.log(flags.json ? JSON.stringify(result.report, null, 2) : summarizeCheck(result));
    return result.report.results.length ? 1 : 0;
  }
  throw new Error(`unknown command ${command}; run mender --help`);
}

main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
  console.error(`mender: ${error?.problems ? error.message : error?.message ?? error}`);
  process.exitCode = 2;
});
