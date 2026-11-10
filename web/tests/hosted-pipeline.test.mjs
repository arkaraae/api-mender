// Hosted pipeline wiring: catalog ingestion, provider findings from a scan,
// provider repairs, Integrated Services, the self-hosted field selector and
// the customer-managed metadata boundary.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildMetadataReport, isReportRejection, validateMetadataReport } from '../lib/engine/boundary.ts';
import { buildCatalogDelta } from '../lib/engine/provider-sync.ts';
import { getProvider } from '../lib/engine/providers/registry.ts';
import { proposeRepair } from '../lib/engine/repair/index.ts';
import { hostedModel, selectRepairFieldSelfHosted } from '../lib/hosted-model.ts';
import { asApiCalls, plannedComparisons, processProviderFindings } from '../lib/provider-findings.ts';
import { loadProviderRepairContext, recheckSavedEdits, RepairConflict, repairJobColumns } from '../lib/provider-repair.ts';
import { deriveProviderServices } from '../lib/provider-services.ts';
import { recheckProviderFindings } from '../lib/provider-recheck.ts';
import { summarizeActivity } from '../lib/activity-summary.ts';
import { extractCalls } from '../lib/public-scan.ts';
import { fakeModel } from './fixtures/repair/reference.mjs';

const github = getProvider('github-rest');
const ISSUES = 'POST /repos/{owner}/{repo}/issues';
const slice = (name, version) => JSON.parse(readFileSync(new URL(`./fixtures/github-rest/${name}.${version}.json`, import.meta.url), 'utf8'));
const consumer = `export async function fileBug({ owner, repo, title, details, onCall, token }) {
  const response = await fetch(\`https://api.github.com/repos/\${owner}/\${repo}/issues\`, {
    method: 'POST',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: \`Bearer \${token}\`,
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ title, body: details, assignee: onCall, labels: ['bug'] }),
  });
  return response.json();
}
`;
const HEAD = 'c'.repeat(40);

// The catalog the sync job would write for the issues operation.
function catalog() {
  const before = slice('issues-create', '2022-11-28');
  const after = slice('issues-create', '2026-03-10');
  const keys = [ISSUES, 'GET /repos/{owner}/{repo}/issues', 'PATCH /repos/{owner}/{repo}/issues/{issue_number}'];
  return {
    provider_contract_versions: [
      { provider_id: 'github-rest', version: '2022-11-28', operation_keys: keys },
      { provider_id: 'github-rest', version: '2026-03-10', operation_keys: keys },
    ],
    provider_contract_slices: [before, after].map(item => ({ provider_id: item.providerId, version: item.version,
      operation: item.operation, sha256: item.sha256, document: item.document, source_url: item.sourceUrl })),
  };
}

// A small in-memory stand-in for the Supabase query builder: supports the
// filters these modules use and records writes.
function fakeDatabase(tables) {
  const writes = [];
  return { writes, from(table) {
    const filters = [];
    let operation = 'select';
    let payload;
    const rows = () => (tables[table] ?? []).filter(row => filters.every(test => test(row)));
    const builder = {
      select() { return builder; }, limit() { return builder; }, order() { return builder; },
      eq(column, value) { filters.push(row => row[column] === value); return builder; },
      in(column, values) { filters.push(row => values.includes(row[column])); return builder; },
      is(column, value) { filters.push(row => row[column] === value); return builder; },
      not(column, operator, value) { filters.push(row => !(operator === 'is' && value === null ? row[column] === null || row[column] === undefined : row[column] === value)); return builder; },
      upsert(row, options) { operation = 'upsert'; payload = row; writes.push({ table, operation, row, options }); return builder; },
      update(row) { operation = 'update'; payload = row; writes.push({ table, operation, row }); return builder; },
      insert(row) { operation = 'insert'; payload = row; writes.push({ table, operation, row }); return builder; },
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      single: async () => ({ data: rows()[0] ?? null, error: null }),
      then(resolve, reject) { return Promise.resolve({ data: operation === 'select' ? rows() : payload, error: null }).then(resolve, reject); },
    };
    return builder;
  } };
}

test('catalog sync keeps every operation key and only the changed slices', async () => {
  const before = slice('issues-create', '2022-11-28').document;
  const after = slice('issues-create', '2026-03-10').document;
  const unchanged = slice('issue-comment-create', '2022-11-28').document;
  const merged = (doc, extra) => ({ ...doc, paths: { ...doc.paths, ...extra.paths } });
  const delta = await buildCatalogDelta({ provider: github, fromVersion: '2022-11-28', toVersion: '2026-03-10',
    oldDocument: merged(before, unchanged), newDocument: merged(after, slice('issue-comment-create', '2026-03-10').document),
    oldSha256: 'a'.repeat(64), newSha256: 'b'.repeat(64) });
  assert.deepEqual(delta.versions.map(v => v.operationKeys.length), [2, 2]);
  assert.deepEqual(delta.changes.map(c => [c.operation, c.kind, c.fields]), [[ISSUES, 'request-property-removed', ['assignee']]]);
  assert.deepEqual(delta.slices.map(s => `${s.version} ${s.operation}`), [`2022-11-28 ${ISSUES}`, `2026-03-10 ${ISSUES}`]);
});

test('a hosted scan turns a pinned GitHub call into an evidence-backed provider finding', async () => {
  const calls = asApiCalls(extractCalls('src/issues.mjs', consumer));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers['x-github-api-version'], '2022-11-28');
  assert.equal(calls[0].endpoint, 'POST /repos/{}/{}/issues', 'template-literal URLs are now discovered by the hosted scanner');
  const database = fakeDatabase(catalog());
  const repository = { id: 'repo-1', workspace_id: 'ws-1', full_name: 'acme/checkout', target_sha: HEAD };
  assert.deepEqual(await processProviderFindings(database, repository, HEAD, calls), { findings: 1 });
  const row = database.writes.find(write => write.table === 'findings' && write.operation === 'upsert').row;
  assert.equal(row.evidence.kind, 'provider-change');
  assert.equal(row.evidence.codeUrl, `https://github.com/acme/checkout/blob/${HEAD}/src/issues.mjs#L10`);
  assert.equal(row.evidence.finding.change.kind, 'request-property-removed');
  assert.equal(row.evidence.finding.evidence.applicability, 'on-upgrade');
  assert.equal(row.confidence, 'probable', 'static findings are never stored as confirmed');
  assert.equal(row.fingerprint, row.evidence.finding.id);
  // A rescan updates scan-owned fields only, so dismissal survives.
  const update = database.writes.find(write => write.table === 'findings' && write.operation === 'update').row;
  assert.equal('status' in update, false);
});

test('calls already on the newest version, or to unknown hosts, are not compared', () => {
  const versions = new Map([['github-rest', catalog().provider_contract_versions.map(row => ({ version: row.version, operationKeys: row.operation_keys }))]]);
  const pinnedNew = asApiCalls(extractCalls('a.mjs', consumer.replace("'2022-11-28'", "'2026-03-10'")));
  assert.deepEqual(plannedComparisons(pinnedNew, versions), []);
  const lookalike = asApiCalls(extractCalls('a.mjs', consumer.replace('api.github.com', 'api.github.com.evil.example')));
  assert.deepEqual(plannedComparisons(lookalike, versions), []);
  // No header: the provider default (2022-11-28) applies, so it is compared.
  const unpinned = asApiCalls(extractCalls('a.mjs', consumer.replace("      'x-github-api-version': '2022-11-28',\n", '')));
  assert.equal(plannedComparisons(unpinned, versions)[0].from, '2022-11-28');
});

test('a provider repair is re-derived from the pinned file and re-checked before publishing', async () => {
  const calls = asApiCalls(extractCalls('src/issues.mjs', consumer));
  const scanDb = fakeDatabase(catalog());
  await processProviderFindings(scanDb, { id: 'repo-1', workspace_id: 'ws-1', full_name: 'acme/checkout', target_sha: HEAD }, HEAD, calls);
  const findingRow = { ...scanDb.writes.find(write => write.table === 'findings').row, id: '11111111-1111-4111-8111-111111111111', status: 'Detected' };
  const database = fakeDatabase({ ...catalog(), findings: [findingRow],
    monitored_repositories: [{ id: 'repo-1', workspace_id: 'ws-1', full_name: 'acme/checkout', branch: 'main', github_repo_id: 1,
      github_installation_id: 2, head_sha: HEAD, target_sha: HEAD, paused: false }] });
  // A valid workspace id that does not own the finding gets nothing.
  await assert.rejects(loadProviderRepairContext(database, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', findingRow.id),
    error => error instanceof RepairConflict && /cannot produce a provider repair/.test(error.message));
  const owned = await loadProviderRepairContext(fakeDatabase({ ...catalog(),
    findings: [{ ...findingRow, workspace_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }],
    monitored_repositories: [{ id: 'repo-1', workspace_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', full_name: 'acme/checkout', branch: 'main',
      github_repo_id: 1, github_installation_id: 2, head_sha: HEAD, target_sha: HEAD, paused: false }] }),
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', findingRow.id);
  assert.deepEqual(owned.contract.removed, ['assignee']);
  assert.ok(owned.contract.acceptedProperties.includes('assignees'));
  assert.ok(!owned.contract.acceptedProperties.includes('assignee'));

  const line = '    body: JSON.stringify({ title, body: details, assignees: [onCall], labels: [\'bug\'] }),';
  const model = fakeModel({ decision: 'patch', reason: 'assignees takes a list', edits: [{ start_line: 10, end_line: 10, replacement: line }] });
  const proposal = await proposeRepair({ finding: owned.finding, source: consumer, contract: owned.contract, model: model.config });
  assert.equal(proposal.method, 'self-hosted-model');
  const { afterSource } = recheckSavedEdits(owned, consumer, proposal.edits);
  const columns = repairJobColumns(owned, proposal, consumer, afterSource);
  assert.deepEqual([columns.old_field, columns.new_field, columns.generation_method], ['assignee', 'assignees', 'self_hosted_model']);
  assert.ok(columns.before_snippet.includes('assignee: onCall') && columns.after_snippet.includes('assignees: [onCall]'));
  assert.equal(JSON.stringify(columns).includes('Bearer'), false, 'only the edited line is stored, not the file');
  // Saved edits that no longer pass (the file changed under them) are refused.
  assert.throws(() => recheckSavedEdits(owned, consumer.replace('assignee: onCall', 'assignee: onCall, milestone: 1'), proposal.edits), RepairConflict);
  assert.throws(() => recheckSavedEdits(owned, consumer, [{ startLine: 10, endLine: 10, replacement: `${line} fetch('https://evil.example');` }]), RepairConflict);
});

test('Integrated Services lists third-party APIs from scans and CLI reports, with open findings', () => {
  const calls = extractCalls('src/issues.mjs', consumer);
  const services = deriveProviderServices(
    [{ id: 'r1', full_name: 'acme/checkout', call_sites: [...calls, { origin: 'https://internal.example', endpoint: 'GET /x' }], scanned_at: 'now' }],
    [{ id: 'f1', status: 'Detected', title: 'assignee removed', evidence: { kind: 'provider-change', finding: { provider: { id: 'github-rest' } } } },
      { id: 'f2', status: 'Dismissed', title: 'old', evidence: { kind: 'provider-change', finding: { provider: { id: 'github-rest' } } } }],
    [{ repository_label: 'billing', received_at: 'now', report: { providers: [{ providerId: 'github-rest', providerName: 'GitHub REST API', operations: [ISSUES], callCount: 2 }] } }]);
  assert.equal(services.length, 1, 'unknown hosts are not presented as integrations');
  assert.deepEqual([services[0].name, services[0].status, services[0].callCount], ['GitHub REST API', 'Needs review', 3]);
  assert.deepEqual(services[0].repositories, ['acme/checkout', 'billing (CLI)']);
  assert.deepEqual(services[0].pinnedVersions, ['2022-11-28']);
  assert.deepEqual(services[0].openFindings.map(f => f.id), ['f1']);
});

test('the self-hosted field selector sends field names only and refuses hosted AI endpoints', async () => {
  assert.equal(hostedModel({}), null);
  assert.throws(() => hostedModel({ MENDER_MODEL_ENDPOINT: 'https://api.anthropic.com/v1', MENDER_MODEL_NAME: 'x', MENDER_MODEL_API_KEY: 'k' }));
  assert.throws(() => hostedModel({ MENDER_MODEL_ENDPOINT: 'https://api.openai.com/v1', MENDER_MODEL_NAME: 'x', MENDER_MODEL_API_KEY: 'k' }));
  const model = fakeModel({ decision: 'select', oldField: 'customerId' });
  const config = hostedModel({ MENDER_MODEL_ENDPOINT: model.config.endpoint, MENDER_MODEL_NAME: 'qwen2.5-coder', MENDER_MODEL_API_KEY: 'gateway-key' }, model.config.fetcher);
  const input = { endpoint: 'POST /api/managed/quotes', missingField: 'accountId', candidates: ['customerId', 'metadata'] };
  assert.equal(await selectRepairFieldSelfHosted(config, input), 'customerId');
  const sent = model.requests[0].body;
  assert.equal(sent.tools, undefined);
  assert.deepEqual(JSON.parse(sent.messages[1].content), { operation: input.endpoint, newRequiredField: 'accountId', previousFields: ['customerId', 'metadata'] });
  assert.equal(await selectRepairFieldSelfHosted({ ...config, fetcher: fakeModel({ decision: 'abstain', oldField: '' }).config.fetcher }, input), null);
  await assert.rejects(selectRepairFieldSelfHosted({ ...config, fetcher: fakeModel({ decision: 'select', oldField: 'password' }).config.fetcher }, input));
});

const baseReport = () => ({ schemaVersion: 1, mode: 'customer-managed', cliVersion: '0.1.0', repositoryLabel: 'billing',
  commitSha: null, generatedAt: '2026-11-09T00:00:00.000Z', fields: ['findingStatus'], findings: [{
    id: 'a'.repeat(64), providerId: 'github-rest', operation: ISSUES, kind: 'request-property-removed', fields: ['assignee'],
    fromVersion: '2022-11-28', toVersion: '2026-03-10', confidence: 'high', verification: 'static-inferred',
    applicability: 'on-upgrade', failureMode: 'value-silently-ignored', status: 'open' }] });

test('the metadata boundary accepts exactly the documented report and nothing that could carry code', () => {
  assert.deepEqual(validateMetadataReport(baseReport()), baseReport());
  const rejected = mutate => { const report = baseReport(); mutate(report); assert.throws(() => validateMetadataReport(report), isReportRejection); };
  rejected(r => { r.findings[0].source = 'const token = 1;'; });                                 // unknown field
  rejected(r => { r.findings[0].diff = '--- a/x'; });                                             // diff smuggled
  rejected(r => { r.findings[0].file = 'src/a.js'; r.findings[0].line = 3; });                    // filePaths not enabled
  rejected(r => { r.fields.push('filePaths'); r.findings[0].file = '../../etc/passwd'; r.findings[0].line = 1; });
  rejected(r => { r.fields.push('providers'); r.providers = [{ providerId: 'github-rest', providerName: 'GitHub', origin: 'https://api.github.com',
    operations: ['POST /repos/acme/secret-repo/issues?token=abc'], callCount: 1, pinnedVersions: [] }]; });
  rejected(r => { r.findings[0].fields = ['assignee: login; process.env.X']; });
  rejected(r => { r.repositoryLabel = 'x\nconst y = 1'; });
  rejected(r => { r.findings[0].validation = { backend: 'namespace', network: 'none', patchApplied: true, checksPassed: true,
    breakReproduced: true, checks: [] }; });                                                      // validation not enabled
  rejected(r => { r.fields = ['findingStatus', 'validation']; r.findings[0].validation = { backend: 'namespace', network: 'none',
    patchApplied: true, checksPassed: true, breakReproduced: true, checks: [{ name: 'unit', phase: 'after', passed: true,
      exitCode: 0, timedOut: false, output: 'secret test output' }] }; });                       // check output
  rejected(r => { r.__proto__ = { polluted: true }; r.extra = 1; });
  // Free-text smuggling through loosely checked fields (independent review).
  rejected(r => { r.generatedAt = '2026 (k="sk-1";\n{x:1}<b>)'; });
  rejected(r => { r.repositoryLabel = 'const token (process.env.GITHUB_TOKEN) fetch(https://x/y)'; });
  rejected(r => { r.fields.push('providers'); r.providers = [{ providerId: 'github-rest', providerName: 'GitHub (token=ghs_x)',
    origin: 'https://api.github.com', operations: [], callCount: 1, pinnedVersions: [] }]; });
  rejected(r => { r.fields.push('providers'); r.providers = [{ providerId: 'github-rest', providerName: 'GitHub REST API',
    origin: 'https://collector.example', operations: [], callCount: 1, pinnedVersions: [] }]; });
  rejected(r => { r.findings[0].providerId = 'made-up'; });
  assert.equal(validateMetadataReport({ ...baseReport(), generatedAt: '2026-11-09T00:00:00Z' }).generatedAt, '2026-11-09T00:00:00.000Z');
});

test('buildMetadataReport reports operation templates, never literal request paths', async () => {
  const report = await buildMetadataReport({ cliVersion: '0.1.0', repositoryLabel: 'billing', fields: ['providers'],
    services: [{ providerId: 'github-rest', providerName: 'GitHub REST API', origin: 'https://api.github.com',
      operations: ['POST /repos/acme/secret-repo/issues'], callCount: 1, files: ['src/secret-file.js'], pinnedVersions: [], recognition: 'catalog' },
    { providerId: 'unknown:internal.example', providerName: 'internal.example', origin: 'https://internal.example',
      operations: ['GET /x'], callCount: 1, files: ['a.js'], pinnedVersions: [], recognition: 'unknown-origin' }],
    operationTemplate: () => ISSUES, results: [] });
  assert.deepEqual(report.providers[0].operations, [ISSUES]);
  assert.equal(report.unrecognizedOriginCount, 1);
  const text = JSON.stringify(report);
  for (const leak of ['secret-repo', 'secret-file', 'internal.example']) assert.ok(!text.includes(leak), leak);
});

test('the hourly recheck flags a newly published change on a repository nobody pushed to', async () => {
  const calls = extractCalls('src/issues.mjs', consumer);
  const repositories = [
    { id: 'r1', workspace_id: 'w1', full_name: 'acme/checkout', head_sha: HEAD, target_sha: HEAD, paused: false, call_sites: calls },
    // A scan in flight (target moved) and a paused repository are skipped.
    { id: 'r2', workspace_id: 'w1', full_name: 'acme/moving', head_sha: HEAD, target_sha: 'd'.repeat(40), paused: false, call_sites: calls },
    { id: 'r3', workspace_id: 'w2', full_name: 'other/paused', head_sha: HEAD, target_sha: HEAD, paused: true, call_sites: calls },
  ];
  // Before the catalog has the change: the repository is checked (and counted), nothing is flagged.
  const empty = fakeDatabase({ monitored_repositories: repositories, provider_contract_versions: [], provider_contract_slices: [] });
  assert.deepEqual(await recheckProviderFindings(empty), { workspaces: 1, failures: 0 });
  assert.equal(empty.writes.filter(w => w.table === 'findings').length, 0);
  assert.equal(empty.writes.find(w => w.table === 'audit_events').row[0].detail.findings, 0);
  // The sync job publishes the change; the next hourly run flags it with no push and no GitHub access.
  const database = fakeDatabase({ monitored_repositories: repositories, ...catalog() });
  const now = new Date('2026-11-10T20:17:00Z');
  assert.deepEqual(await recheckProviderFindings(database, now), { workspaces: 1, failures: 0 });
  const flagged = database.writes.filter(w => w.table === 'findings' && w.operation === 'upsert').map(w => w.row);
  assert.deepEqual(flagged.map(row => [row.repository_id, row.evidence.finding.change.fields[0]]), [['r1', 'assignee']]);
  const audit = database.writes.find(w => w.table === 'audit_events').row;
  assert.deepEqual(audit, [{ workspace_id: 'w1', actor_type: 'system', action: 'provider.recheck',
    detail: { repositories: 1, findings: 1, at: now.toISOString() } }]);
});

test('activity summary counts real scans, checks and flagged changes per day and month', () => {
  const now = new Date('2026-11-10T20:00:00Z');
  const summary = summarizeActivity({ now, days: 3,
    scans: [
      { created_at: '2026-11-10T09:00:00Z', finished_at: '2026-11-10T09:01:00Z', status: 'succeeded' },
      { created_at: '2026-11-09T09:00:00Z', finished_at: null, status: 'dead' },
      { created_at: '2026-10-20T09:00:00Z', finished_at: '2026-10-20T09:01:00Z', status: 'succeeded' },
    ],
    rechecks: [{ created_at: '2026-11-09T17:17:00Z', detail: { repositories: 4 } }],
    findings: [{ created_at: '2026-11-10T09:01:00Z', evidence: { kind: 'provider-change' } }],
    repairs: [{ created_at: '2026-11-10T10:00:00Z', status: 'validated' }, { created_at: '2026-11-10T11:00:00Z', status: 'proposed' }],
    repositories: [{ scanned_at: '2026-11-10T09:01:00Z' }, { scanned_at: null }] });
  assert.deepEqual(summary.days, [
    { date: '2026-11-08', scans: 0, checks: 0, flagged: 0 },
    { date: '2026-11-09', scans: 0, checks: 4, flagged: 0 },
    { date: '2026-11-10', scans: 1, checks: 0, flagged: 1 },
  ]);
  assert.deepEqual(summary.totals, { scans: 1, checks: 4, flagged: 1 });
  assert.deepEqual(summary.thisMonth, { changesChecked: 5, changesFlagged: 1, repairsProposed: 2, repairsValidated: 1,
    previousMonthChangesChecked: 1 });
  assert.deepEqual(summary.repositories, { connected: 2, lastScanAt: '2026-11-10T09:01:00Z' });
});
