import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateRepairProof } from '../lib/repair-proof.ts';

const sha = 'a'.repeat(40);
const check = { id: 41, name: 'mender-repair-proof', head_sha: sha,
  status: 'completed', conclusion: 'success', app: { slug: 'github-actions' },
  html_url: 'https://github.com/example/repo/actions/runs/41' };

test('only a successful customer CI check for the exact patch commit validates a repair', () => {
  assert.equal(evaluateRepairProof([check], sha).status, 'validated');
  assert.equal(evaluateRepairProof([{ ...check, head_sha: 'b'.repeat(40) }], sha).status, 'proof_pending');
  assert.equal(evaluateRepairProof([{ ...check, app: { slug: 'some-other-app' } }], sha).status, 'proof_pending');
  assert.equal(evaluateRepairProof([{ ...check, conclusion: 'failure' }], sha).status, 'proof_failed');
  assert.equal(evaluateRepairProof([{ ...check, status: 'in_progress', conclusion: null }], sha).status, 'proof_pending');
});

test('the newest run wins after a customer reruns CI', () => {
  assert.equal(evaluateRepairProof([check, { ...check, id: 42, conclusion: 'failure' }], sha).status, 'proof_failed');
  assert.throws(() => evaluateRepairProof([{ ...check, html_url: 'https://evil.example/41' }], sha));
});
