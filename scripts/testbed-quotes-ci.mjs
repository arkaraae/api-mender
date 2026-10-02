import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { toOpenApi } from '../testbed/quotes-api/openapi.mjs';

const root = resolve(import.meta.dirname, '..');
const baseUrl = 'https://api-mender.aom31905.chatgpt.site';
const dataDir = join(root, 'artifacts/quotes-db');
const baselinePath = join(root, 'artifacts/quotes-baseline.json');
const current = JSON.parse(readFileSync(join(root, 'testbed/quotes-api/contract.json'), 'utf8'));
const previousCommit = process.env.MENDER_PREVIOUS_COMMIT;
if (!previousCommit || !/^[a-f0-9]{40}$/.test(previousCommit) || /^0+$/.test(previousCommit)) throw new Error('A previous main commit is required to compare the contract');
const previous = spawnSync('git', ['show', `${previousCommit}:testbed/quotes-api/contract.json`], { cwd: root, encoding: 'utf8' });
if (previous.status !== 0) throw new Error(`Could not read the previous contract: ${previous.stderr}`);
mkdirSync(join(root, 'artifacts'), { recursive: true });
writeFileSync(baselinePath, JSON.stringify(toOpenApi(JSON.parse(previous.stdout))));

let liveVersion;
for (let attempt = 0; attempt < 30; attempt++) {
  const response = await fetch(`${baseUrl}/api/testbed/openapi.json`, { cache: 'no-store', signal: AbortSignal.timeout(12_000) }).catch(() => null);
  if (response?.ok) {
    const published = await response.json();
    liveVersion = published.info?.version;
    if (liveVersion === `${current.version}.0.0`) break;
  }
  if (attempt < 29) await delay(5_000);
}
if (liveVersion !== `${current.version}.0.0`) throw new Error(`The hosted Quotes API has not loaded contract v${current.version}`);

const run = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/testbed-quotes.ts'], { cwd: root, encoding: 'utf8', timeout: 60_000, env: { ...process.env, DATA_DIR: dataDir, MENDER_TEST_API_URL: baseUrl, MENDER_BASELINE_SPEC_FILE: baselinePath } });
process.stdout.write(run.stdout || '');
process.stderr.write(run.stderr || '');
if (run.status !== 0) throw new Error(`Mender contract check failed with exit ${run.status}`);

const report = JSON.parse(readFileSync(join(root, 'artifacts/quotes-mender-report.json'), 'utf8'));
const fixReady = report.state === 'fix_ready' && report.validation?.status === 'passed' && report.finding?.confidence === 'confirmed';
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `fix_ready=${fixReady}\n`);
if (fixReady) {
  const branch = `codex/quotes-fix-${process.env.GITHUB_SHA?.slice(0, 12) || 'local'}`;
  mkdirSync(join(root, 'testbed/quotes-api'), { recursive: true });
  writeFileSync(join(root, 'testbed/quotes-api/mender-status.json'), JSON.stringify({
    contractCommit: process.env.GITHUB_SHA || null,
    contractVersion: current.version,
    findingId: report.findingId,
    findingStatus: report.finding.status,
    validation: report.validation.status,
    oldConsumer: report.validation.checks[0].ok ? 'failed as expected' : 'unexpected result',
    patchedConsumer: report.validation.checks[1].ok ? 'passed' : 'failed',
    sourceHash: report.sourceHash,
    runUrl: process.env.GITHUB_RUN_ID ? `https://github.com/arkaraae/api-mender/actions/runs/${process.env.GITHUB_RUN_ID}` : null,
    fixBranchUrl: `https://github.com/arkaraae/api-mender/tree/${branch}`,
  }, null, 2) + '\n');
  const body = `## API Mender testbed fix\n\nThe Quotes API contract added required \`accountId\` on \`POST /api/testbed/quotes\`. The consumer at ${report.repositoryHead} still sent \`customerId\`.\n\n- Source snapshot SHA-256: \`${report.sourceHash}\`\n- Finding: \`${report.findingId}\` (${report.finding.confidence})\n- Old consumer against the changed API: failed as expected\n- Patched consumer against the changed API: passed\n- Fix generator: deterministic Quotes fixture recipe; no OpenAI API request\n\nThis is a controlled test API. Review the request mapping before merging.\n`;
  writeFileSync(join(root, 'artifacts/quotes-pr.md'), body);
}
