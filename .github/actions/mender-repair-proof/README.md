# Customer CI proof for a Mender draft repair PR

Add this job to the customer's repository. Choose a focused test command that
calls a **test API or safe read-only endpoint** and fails with a distinctive
message when the old request shape is rejected. The same command must pass
after Mender's one-file patch. Never point a write test at production data.

```yaml
name: Mender repair proof
on: pull_request
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
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
      - uses: arkaraae/api-mender/.github/actions/mender-repair-proof@PIN_A_REVIEWED_COMMIT_SHA
        with:
          test-command: 'npm ci && npm run test:api-mender'
          expected-before-output: 'Quote API returned 422'
```

Pin the action to a reviewed commit SHA. Mender only treats the `mender-repair-proof`
GitHub Actions check on the saved patch commit as customer CI attestation. This
does not establish that every runtime path or data migration is safe. The draft
PR remains for human review and is never merged automatically.
