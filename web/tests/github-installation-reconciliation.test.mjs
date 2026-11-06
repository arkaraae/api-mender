import assert from 'node:assert/strict';
import { test } from 'node:test';
import { removedConnectedRepositoryIds } from '../lib/github-installation-reconciliation.ts';

test('a complete GitHub selection removes only repositories no longer granted', () => {
  const connected = [
    { id: 'consumer', github_repo_id: 11 },
    { id: 'denied', github_repo_id: 22 },
    { id: 'legacy', github_repo_id: null },
  ];
  assert.deepEqual(removedConnectedRepositoryIds(connected, [11]), ['denied', 'legacy']);
  assert.deepEqual(removedConnectedRepositoryIds(connected, [11, 22]), ['legacy']);
  assert.deepEqual(removedConnectedRepositoryIds([], []), []);
});
