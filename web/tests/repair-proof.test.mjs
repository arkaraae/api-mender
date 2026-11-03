import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateRepairProof } from '../lib/repair-proof.ts';

const sha = 'a'.repeat(40);
const merge = 'b'.repeat(40);
const base = 'c'.repeat(40);
const context = { checkedSha: merge, patchSha: sha, baseSha: base, prNumber: 1 };
const check = { id: 41, name: 'mender-repair-proof', head_sha: merge,
  status: 'completed', conclusion: 'success', app: { slug: 'github-actions' },
  html_url: 'https://github.com/example/repo/actions/runs/41',
  pull_requests: [{ number: 1, head: { sha }, base: { sha: base } }] };

test('only a successful customer CI check for this PR merge, patch, and base validates a repair', () => {
  assert.equal(evaluateRepairProof([check], context).status, 'validated');
  assert.equal(evaluateRepairProof([{ ...check, head_sha: 'd'.repeat(40) }], context).status, 'proof_pending');
  assert.equal(evaluateRepairProof([{ ...check, app: { slug: 'some-other-app' } }], context).status, 'proof_pending');
  assert.equal(evaluateRepairProof([{ ...check, pull_requests: [] }], context).status, 'proof_pending');
  assert.equal(evaluateRepairProof([{ ...check, pull_requests: [{ number: 1, head: { sha }, base: { sha: 'd'.repeat(40) } }] }], context).status, 'proof_pending');
  assert.equal(evaluateRepairProof([{ ...check, conclusion: 'failure' }], context).status, 'proof_failed');
  assert.equal(evaluateRepairProof([{ ...check, status: 'in_progress', conclusion: null }], context).status, 'proof_pending');
});

test('the newest run wins after a customer reruns CI', () => {
  assert.equal(evaluateRepairProof([check, { ...check, id: 42, conclusion: 'failure' }], context).status, 'proof_failed');
  assert.throws(() => evaluateRepairProof([{ ...check, html_url: 'https://evil.example/41' }], context));
});
