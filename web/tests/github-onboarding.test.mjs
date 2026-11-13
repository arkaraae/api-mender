import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canConnectRepositories, matchingInstallation, validAccessibleRepositories } from '../lib/github-onboarding-policy.ts';

test('a GitHub return cannot bind a different App installation', () => {
  const installations = [
    { id: 42, app_id: 100, account: { login: 'customer' } },
    { id: 43, app_id: 200, account: { login: 'customer' } },
  ];
  assert.equal(matchingInstallation(installations, 42, '200'), undefined);
  assert.equal(matchingInstallation(installations, 43, '200')?.id, 43);
  assert.equal(matchingInstallation([{ ...installations[1], suspended_at: '2026-10-24' }], 43, '200'), undefined);
});

test('only the complete set of user-accessible GitHub repositories is accepted', () => {
  const repos = [{ id: 99, full_name: 'customer/orders', default_branch: 'main', private: true }];
  assert.equal(validAccessibleRepositories(repos, 1), true);
  assert.equal(validAccessibleRepositories(repos, 2), false);
  assert.equal(validAccessibleRepositories([{ ...repos[0], full_name: '../other' }], 1), false);
  assert.equal(validAccessibleRepositories(Array.from({ length: 26 }, (_, index) => ({ ...repos[0], id: index + 1 })), 26), false);
});

test('only someone who can write to every selected repository, and administer one, can connect them', () => {
  const repo = permissions => ({ id: 1, full_name: 'acme/a', permissions });
  assert.equal(canConnectRepositories([repo({ admin: true, push: true }), repo({ push: true })]), true);
  assert.equal(canConnectRepositories([repo({ push: true })]), false, 'no admin anywhere');
  assert.equal(canConnectRepositories([repo({ admin: true }), repo({ pull: true })]), false, 'read-only on one');
  assert.equal(canConnectRepositories([repo(undefined)]), false, 'permissions missing: refused');
  assert.equal(canConnectRepositories([]), false);
});
