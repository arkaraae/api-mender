import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const useClaude = process.argv.includes('--claude');
if (useClaude && !process.env.ANTHROPIC_API_KEY) throw new Error('Set ANTHROPIC_API_KEY in your environment; do not paste it into source or chat.');
const dir = mkdtempSync(join(tmpdir(), 'api-mender-stage-'));
const dbPath = join(dir, 'stage.sqlite');
const server = spawn(process.execPath, ['testbed/managed-stage/server.mjs'], {
  cwd: root, env: { PATH: process.env.PATH || '/usr/bin:/bin', MENDER_STAGE_DB: dbPath, PORT: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverError = '';
server.stderr.on('data', chunk => { serverError += chunk.toString(); });

function command(args, env = {}) {
  const child = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 120000, env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: process.env.HOME || dir, ...env } });
  if (child.error) throw child.error;
  return { code: child.status, output: `${child.stdout || ''}${child.stderr || ''}` };
}

async function address() {
  return new Promise((resolveUrl, reject) => {
    const timeout = setTimeout(() => reject(new Error('Staging API did not start.')), 10000);
    let output = '';
    server.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/MENDER_STAGE_URL=(http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timeout); resolveUrl(match[1]); }
    });
    server.once('exit', code => { clearTimeout(timeout); reject(new Error(`Staging API exited with ${code}: ${serverError}`)); });
  });
}

try {
  const baseUrl = await address();
  const consumer = ['--test', 'examples/quote-api-consumer/tests/quotes.test.mjs'];
  const baseline = command(consumer, { MENDER_TEST_API_URL: baseUrl });
  if (baseline.code !== 0) throw new Error(`The v1 consumer did not pass before the change:\n${baseline.output}`);
  const publish = command(['testbed/managed-stage/publish.mjs', 'v2'], { MENDER_STAGE_DB: dbPath });
  if (publish.code !== 0) throw new Error(publish.output);
  const broken = command(consumer, { MENDER_TEST_API_URL: baseUrl });
  if (broken.code === 0 || !broken.output.includes('422')) throw new Error(`The v1 consumer did not fail with HTTP 422 after the change:\n${broken.output}`);
  const repair = command(['scripts/managed-api-mender.mjs'], {
    MENDER_TEST_API_URL: baseUrl,
    MENDER_STAGING_RUN: '1',
    MENDER_FORCE_AI: useClaude ? '1' : '0',
    MENDER_FIX_PROVIDER: useClaude ? 'anthropic' : 'openai',
    GITHUB_ACTIONS: 'false',
    ...(useClaude ? { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6' } : {}),
  });
  const report = JSON.parse(readFileSync(join(root, 'artifacts/managed-api/report.json'), 'utf8'));
  if (repair.code !== 0 || report.state !== 'fix_ready' || report.patchedTest?.passed !== true || (useClaude && !report.model?.startsWith('claude-'))) {
    throw new Error(`The repair was not proven:\n${repair.output}`);
  }
  console.log(JSON.stringify({ stage: 'passed', before: 'v1 consumer passed', after: 'v1 consumer failed with HTTP 422', repair: report.model, patchedTest: 'passed', usage: report.usage ?? null }, null, 2));
} finally {
  server.kill('SIGTERM');
  rmSync(dir, { recursive: true, force: true });
}
