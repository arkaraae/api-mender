import assert from 'node:assert/strict';
import { test } from 'node:test';
import yaml from 'js-yaml';
import { proofAction, proofWorkflowStructurePresent, renderCustomerProofWorkflow } from '../lib/customer-proof-setup.ts';

test('customer proof setup pins the reviewed action and keeps inputs as YAML strings', () => {
  const command = 'npm ci && npm run test:quotes -- --name "account: id"';
  const expected = 'Old request failed: 422 # accountId';
  const workflow = renderCustomerProofWorkflow(command, expected);
  const document = yaml.load(workflow);
  const job = document.jobs['mender-repair-proof'];
  assert.equal(job.steps.at(-1).uses, proofAction);
  assert.equal(job.steps.at(-1).with['test-command'], command);
  assert.equal(job.steps.at(-1).with['expected-before-output'], expected);
  assert.equal(proofWorkflowStructurePresent(workflow), true);
  assert.equal(proofWorkflowStructurePresent(workflow.replace(proofAction, 'customer/unreviewed@main')), false);
});

test('proof setup refuses multiline YAML and expression injection', () => {
  assert.throws(() => renderCustomerProofWorkflow('npm test\npermissions: write-all', 'failure'), /single-line/);
  assert.throws(() => renderCustomerProofWorkflow('npm test', '${{ secrets.TOKEN }}'), /single-line/);
  assert.equal(proofWorkflowStructurePresent('jobs:\n  mender-repair-proof: {}'), false);
});
