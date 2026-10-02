import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import { analyze, currentHead, db, getFinding, getPatch, getValidation, persistValidation, savePatch, snapshot, source, stripeAdapter, transition, type IntegrationInventory, type PatchProposal, type Validation } from '../lib/core';

const project = resolve(import.meta.dirname, '..');
const consumer = join(project, 'testbed/quotes-consumer');
const artifacts = join(project, 'artifacts');
const tenantId = 'tenant_quotes_testbed';
const repoId = 'repo_quotes_consumer';
const provider = 'quotes-testbed';
const apiBaseUrl = process.env.MENDER_TEST_API_URL || 'http://127.0.0.1:4178';
const sourceUrl = `${apiBaseUrl}/api/testbed/openapi.json`;

function scanConsumer(): IntegrationInventory {
  const file = 'src/client.mjs';
  const code = readFileSync(join(consumer, file), 'utf8');
  if (!code.includes('/api/testbed/quotes')) throw new Error('Consumer does not call the Quotes API');
  const tree = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let fields: string[] = [];
  let line = 0;
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === 'JSON.stringify' && node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])) {
      fields = node.arguments[0].properties.map(property => property.name?.getText(tree).replace(/["']/g, '') || '').filter(Boolean);
      line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  if (!fields.length) throw new Error('Consumer request fields were not statically discoverable');
  return { provider, sdkVersion: null, apiVersion: null, files: [file], calls: [{ file, line, symbol: 'createQuote', endpoint: 'POST /api/testbed/quotes', fields, uncertain: false }], tests: ['tests/quotes.test.mjs'], limitations: ['Controlled testbed only; this parser does not cover arbitrary repositories'] };
}

function testConsumer(root: string) {
  const result = spawnSync(process.execPath, ['--test', 'tests/quotes.test.mjs'], { cwd: root, encoding: 'utf8', timeout: 15_000, env: { ...process.env, MENDER_TEST_API_URL: apiBaseUrl } });
  return { ok: result.status === 0, output: `${result.stdout || ''}${result.stderr || ''}`.slice(-4000) };
}

function generateFix(inventory: IntegrationInventory): PatchProposal {
  const call = inventory.calls[0];
  if (call.endpoint !== 'POST /api/testbed/quotes' || !call.fields.includes('customerId') || call.fields.includes('accountId')) return { files: [], assumptions: [], model: 'deterministic-quotes-v1', needsDecision: 'No supported request shape' };
  const path = 'src/client.mjs';
  const before = readFileSync(join(consumer, path), 'utf8');
  const needle = 'body: JSON.stringify({ customerId, amountCents })';
  if (before.split(needle).length !== 2) return { files: [], assumptions: [], model: 'deterministic-quotes-v1', needsDecision: 'Consumer changed; manual review required' };
  return { files: [{ path, before, after: before.replace(needle, 'body: JSON.stringify({ accountId: customerId, amountCents })') }], assumptions: ['The existing customer identifier is the correct account identifier in this controlled fixture.'], model: 'deterministic-quotes-v1' };
}

function writePatch(proposal: PatchProposal): string {
  mkdirSync(artifacts, { recursive: true });
  const original = join(artifacts, 'quotes-before.tmp');
  const changed = join(artifacts, 'quotes-after.tmp');
  const path = join(artifacts, 'quotes-fix.patch');
  try {
    writeFileSync(original, proposal.files[0].before);
    writeFileSync(changed, proposal.files[0].after);
    const result = spawnSync('git', ['diff', '--no-index', '--', original, changed], { encoding: 'utf8' });
    if (result.status !== 1 || !result.stdout) throw new Error('Could not create the fix patch');
    const diff = result.stdout.replaceAll(`a${original}`, 'a/testbed/quotes-consumer/src/client.mjs').replaceAll(`b${changed}`, 'b/testbed/quotes-consumer/src/client.mjs');
    writeFileSync(path, diff);
    return path;
  } finally {
    rmSync(original, { force: true });
    rmSync(changed, { force: true });
  }
}

async function main() {
  const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(15_000), cache: 'no-store' });
  if (!response.ok) throw new Error(`Quotes API contract returned ${response.status}`);
  const body = await response.text();
  if (body.length > 100_000) throw new Error('Quotes API contract exceeded the limit');
  const spec = JSON.parse(body);
  if (spec?.paths?.['/api/testbed/quotes']?.post?.operationId !== 'createQuote') throw new Error('Unexpected Quotes API contract');
  const database = db();
  const baselineFile = process.env.MENDER_BASELINE_SPEC_FILE;
  if (baselineFile) {
    const baseline = JSON.parse(readFileSync(baselineFile, 'utf8'));
    if (baseline?.paths?.['/api/testbed/quotes']?.post?.operationId !== 'createQuote') throw new Error('Invalid baseline Quotes API contract');
    snapshot(provider, 'openapi', sourceUrl, JSON.stringify(baseline), true);
  }
  database.prepare('INSERT OR IGNORE INTO tenants(id,name) VALUES(?,?)').run(tenantId, 'Quotes testbed');
  const head = currentHead(consumer);
  database.prepare('INSERT OR IGNORE INTO repositories(id,tenant_id,name,path,branch,head,provider,created_at) VALUES(?,?,?,?,?,?,?,?)').run(repoId, tenantId, 'arkaraae/api-mender:testbed/quotes-consumer', consumer, 'main', head, provider, new Date().toISOString());
  database.prepare('UPDATE repositories SET head=? WHERE id=?').run(head, repoId);
  const inventory = scanConsumer();
  database.prepare('INSERT INTO inventories(repo_id,body,scanned_at) VALUES(?,?,?) ON CONFLICT(repo_id) DO UPDATE SET body=excluded.body,scanned_at=excluded.scanned_at').run(repoId, JSON.stringify(inventory), new Date().toISOString());
  const previousRow = database.prepare('SELECT id FROM sources WHERE provider=? AND kind=? AND url=? ORDER BY retrieved_at DESC LIMIT 1').get(provider, 'openapi', sourceUrl) as { id: string } | undefined;
  const before = previousRow ? source(previousRow.id) : undefined;
  const after = snapshot(provider, 'openapi', sourceUrl, JSON.stringify(spec), true);
  const result: Record<string, unknown> = { state: !before ? 'baseline' : before.hash === after.hash ? 'unchanged' : 'changed', sourceHash: after.hash, repositoryHead: head, inventory };
  if (before && before.hash !== after.hash) {
    const changes = stripeAdapter.diff(before, after).filter(change => change.endpoint === 'POST /api/testbed/quotes');
    result.changes = changes;
    for (const rawChange of changes) {
      const change = { ...rawChange, applicability: 'applies' as const };
      const finding = analyze(tenantId, repoId, change, after, head);
      if (finding.status === 'Detected') transition(finding, 'Analyzing', null);
      result.findingId = finding.id;
      if (change.kind !== 'required_request_field' || change.field !== 'accountId' || !finding.affected.some(call => !call.fields.includes('accountId'))) continue;
      if (finding.status === 'Analyzing') transition(finding, 'Patching', 'Supported Quotes fixture recipe');
      else if (finding.status === 'Action required' || finding.status === 'Failed') transition(finding, 'Patching', 'Regenerate fixture patch');
      const proposal = generateFix(inventory);
      if (proposal.needsDecision) throw new Error(proposal.needsDecision);
      const failing = testConsumer(consumer);
      const sandbox = mkdtempSync(join(tmpdir(), 'mender-quotes-'));
      try {
        cpSync(consumer, sandbox, { recursive: true });
        const target = join(sandbox, proposal.files[0].path);
        writeFileSync(target, proposal.files[0].after);
        const passing = testConsumer(sandbox);
        const validation: Validation = { id: `v_${createHash('sha256').update(finding.id + Date.now()).digest('hex').slice(0, 16)}`, findingId: finding.id, status: !failing.ok && passing.ok ? 'passed' : 'failed', checks: [{ name: 'Old consumer fails against changed API', ok: !failing.ok, output: failing.output }, { name: 'Patched consumer passes against changed API', ok: passing.ok, output: passing.output }], baseCommit: head, sourceHash: after.hash, model: proposal.model, configuration: 'isolated Quotes fixture test', createdAt: new Date().toISOString() };
        persistValidation(tenantId, validation);
        if (finding.status === 'Patching') transition(finding, 'Validating', null);
        if (validation.status !== 'passed') { transition(finding, 'Failed', 'Fix did not pass the consumer test'); throw new Error('Generated fix failed validation'); }
        const patchPath = writePatch(proposal);
        savePatch(tenantId, finding.id, proposal, patchPath, null);
        transition(finding, 'Action required', 'Validated patch ready for review');
        result.validation = validation;
        result.patch = getPatch(tenantId, finding.id);
        result.finding = getFinding(tenantId, finding.id);
        result.state = 'fix_ready';
      } finally { rmSync(sandbox, { recursive: true, force: true }); }
    }
  }
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(join(artifacts, 'quotes-mender-report.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ state: result.state, sourceHash: result.sourceHash, findingId: result.findingId, validation: result.validation ? getValidation(tenantId, String(result.findingId))?.status : null, report: 'artifacts/quotes-mender-report.json', patch: result.patch ? 'artifacts/quotes-fix.patch' : null }));
}

await main();
