import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { checkBreakingChanges, editBetween, scanApis, validateFix } from '../src/tools.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const FIXTURES = path.join(ROOT, 'web/tests/fixtures/github-rest');
let work, repo, contracts, file;

before(() => {
  work = mkdtempSync(path.join(tmpdir(), 'mender-mcp-'));
  repo = path.join(work, 'repo');
  cpSync(path.join(ROOT, 'examples/github-issues-consumer'), repo, { recursive: true });
  contracts = {};
  for (const [name, version] of [['old', '2022-11-28'], ['new', '2026-03-10']]) {
    const slice = JSON.parse(readFileSync(path.join(FIXTURES, `issues-create.${version}.json`), 'utf8'));
    contracts[name] = path.join(work, `${version}.json`);
    writeFileSync(contracts[name], JSON.stringify(slice.document));
  }
  file = path.join(repo, 'src/issues.mjs');
});
after(() => rmSync(work, { recursive: true, force: true }));

test('scan_apis lists the services and call sites', async () => {
  const result = await scanApis({ path: repo });
  assert.deepEqual(result.services.map(service => [service.provider, service.name, service.watchedByMend]), [['github-rest', 'GitHub REST API', true]]);
  assert.equal(result.calls[0].endpoint, 'POST /repos/{}/{}/issues');
  assert.match(result.calls[0].location, /^src\/issues\.mjs:\d+$/);
  await assert.rejects(scanApis({ path: path.join(work, 'missing') }), /Not a directory/);
});

test('check → edit → validate: a correct fix passes every gate, a wrong one does not', async () => {
  const original = readFileSync(file, 'utf8');
  const result = await checkBreakingChanges({ path: repo, provider: 'github-rest', contractFiles: contracts });
  const finding = result.findings.find(item => item.change.fields.includes('assignee'));
  assert.ok(finding, JSON.stringify(result.findings.map(item => item.title)));
  assert.equal(finding.change.kind, 'request-property-removed');
  assert.ok(finding.fix, finding.whyNoFix);
  assert.match(finding.fix.rules[0], /^Edit only lines \d+-\d+ of src\/issues\.mjs\.$/);
  assert.ok(finding.fix.contract.acceptedFields.includes('assignees'));

  // A wrong edit: drops the value instead of moving it.
  writeFileSync(file, original.replace('assignee: onCall, ', ''));
  const dropped = await validateFix({ findingId: finding.id });
  assert.equal(dropped.passed, false);
  assert.ok(dropped.checks.some(check => !check.passed));

  // The right edit: the value moves to the new field.
  writeFileSync(file, original.replace('assignee: onCall', 'assignees: [onCall]'));
  const fixed = await validateFix({ findingId: finding.id });
  assert.equal(fixed.passed, true, JSON.stringify(fixed.checks.filter(check => !check.passed)));

  // Editing outside the call is refused.
  writeFileSync(file, `${original.replace('assignee: onCall', 'assignees: [onCall]')}\nexport const extra = () => fetch('https://evil.example/x');\n`);
  assert.equal((await validateFix({ findingId: finding.id })).passed, false);
  writeFileSync(file, original);
  assert.match((await validateFix({ findingId: finding.id })).reason, /has not changed/);
  await assert.rejects(validateFix({ findingId: 'nope' }), /Run check_breaking_changes first/);
});

test('editBetween finds the one changed region', () => {
  assert.deepEqual(editBetween('a\nb\nc\n', 'a\nB\nc\n'), { startLine: 2, endLine: 2, replacement: 'B' });
  assert.equal(editBetween('a\n', 'a\n'), null);
});
