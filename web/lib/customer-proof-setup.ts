import yaml from 'js-yaml';

export const proofWorkflowPath = '.github/workflows/mender-repair-proof.yml';
export const proofAction = 'arkaraae/api-mender/.github/actions/mender-repair-proof@fe445c6dcb90e3558280d72547211ca337f52a14';

function singleLine(value: unknown, limit: number) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= limit
    && !/[\r\n\0]/.test(value) && !value.includes('${{');
}

export function renderCustomerProofWorkflow(testCommand: unknown, expectedBeforeOutput: unknown) {
  if (!singleLine(testCommand, 300) || !singleLine(expectedBeforeOutput, 200))
    throw new Error('Enter a single-line test command and expected old failure; do not include GitHub expressions');
  return `name: Mender repair proof

on:
  pull_request:
    types: [opened, reopened, synchronize]

permissions:
  contents: read

jobs:
  mender-repair-proof:
    if: startsWith(github.event.pull_request.head.ref, 'mender/repair-')
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
      - uses: ${proofAction}
        with:
          test-command: ${JSON.stringify(testCommand)}
          expected-before-output: ${JSON.stringify(expectedBeforeOutput)}
`;
}

/** Detect the required structure, not the quality of a customer's test command. */
export function proofWorkflowStructurePresent(source: string) {
  if (source.length > 64_000) return false;
  try {
    const document = yaml.load(source) as any;
    const job = document?.jobs?.['mender-repair-proof'];
    const steps = job?.steps;
    return !!document?.on?.pull_request && document?.permissions?.contents === 'read'
      && typeof job?.if === 'string' && job.if.includes('mender/repair-')
      && Array.isArray(steps)
      && steps.some((step: any) => step?.uses === 'actions/checkout@v4'
        && step.with?.['fetch-depth'] === 0 && step.with?.['persist-credentials'] === false)
      && steps.some((step: any) => step?.uses === proofAction
        && typeof step.with?.['test-command'] === 'string'
        && typeof step.with?.['expected-before-output'] === 'string');
  } catch { return false; }
}
