import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveWatchedServices } from '../lib/live-services.ts';

const repo = { id: 'api', full_name: 'team/quotes', head_sha: 'a'.repeat(40), target_sha: 'a'.repeat(40),
  scanned_at: '2026-11-03T20:00:00Z', paused: false, github_installation_id: 123 };
const consumer = { id: 'client', full_name: 'team/consumer', head_sha: 'b'.repeat(40), target_sha: 'b'.repeat(40),
  scanned_at: '2026-11-03T20:00:00Z', paused: false, github_installation_id: 123 };
const source = { id: 'contract', repository_id: 'api', path: 'openapi.json', paused: false };
const version = { source_id: 'contract', head_sha: 'a'.repeat(40), created_at: '2026-11-03T20:00:00Z' };
const snapshot = { id: 'snapshot', provider: 'github-openapi', metadata: { sourceId: 'contract', head: 'a'.repeat(40) } };
const finding = { id: 'finding', source_id: 'snapshot', title: 'Missing accountId', status: 'Action required', created_at: '2026-11-03T20:00:00Z' };
const input = { repositories: [repo, consumer], sources: [source], versions: [version],
  consumers: [{ source_id: 'contract', repository_id: 'client', paused: false }], snapshots: [snapshot], findings: [finding] };

test('connected contract reports only its own unresolved findings and consumer', () => {
  const [service] = deriveWatchedServices({ ...input, snapshots: [...input.snapshots,
    { id: 'other', provider: 'github-openapi', metadata: { sourceId: 'other-source' } }],
    findings: [...input.findings, { ...finding, id: 'other-finding', source_id: 'other' }] });
  assert.equal(service.status, 'Needs review');
  assert.equal(service.tone, 'alert');
  assert.deepEqual(service.findings.map(item => item.id), ['finding']);
  assert.deepEqual(service.consumerNames, ['team/consumer']);
});

test('scan state and resolved findings never claim a healthy watch too early', () => {
  assert.equal(deriveWatchedServices({ ...input, versions: [] })[0].status, 'Waiting for scan');
  assert.equal(deriveWatchedServices({ ...input, repositories: [{ ...repo, target_sha: 'c'.repeat(40) }, consumer] })[0].status, 'Needs review');
  assert.equal(deriveWatchedServices({ ...input, findings: [], repositories: [{ ...repo, target_sha: 'c'.repeat(40) }, consumer] })[0].status, 'Scan pending');
  assert.equal(deriveWatchedServices({ ...input, findings: [{ ...finding, status: 'Resolved' }] })[0].status, 'Watching');
  assert.equal(deriveWatchedServices({ ...input, sources: [{ ...source, paused: true }] })[0].status, 'Paused');
  assert.equal(deriveWatchedServices({ ...input, snapshots: [{ ...snapshot, metadata: { sourceId: 'contract', head: 'd'.repeat(40) } }] })[0].status, 'Watching');
});
