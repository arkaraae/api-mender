import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileBug } from '../src/issues.mjs';
import { installFakeGitHub } from './fake-github.mjs';

test('a filed bug is assigned to the on-call engineer', async () => {
  const github = installFakeGitHub();
  try {
    const issue = await fileBug({ owner: 'acme', repo: 'checkout', title: 'Checkout total is wrong',
      details: 'Totals drift by a cent.', onCall: 'octocat', token: 'test-token' });
    assert.equal(issue.number, 101);
    assert.deepEqual(issue.assignedTo, ['octocat']);
    assert.deepEqual(github.requests[0].payload.labels, ['bug']);
  } finally { github.restore(); }
});
