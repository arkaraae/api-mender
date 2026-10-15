# API Mender check

Comments on every pull request that changes an API description, in plain words: what changed for
the people who call the API, whether Mender can keep old callers working, and a link that opens
the change on [apimender.com/check](https://apimender.com/check) with the fix for a caller's code.

```yaml
name: API Mender check
on:
  pull_request:
    paths: ['openapi.yaml']
permissions:
  contents: read
  pull-requests: write
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
      - uses: arkaraae/api-mender/.github/actions/mender-check@main
        with:
          specs: openapi.yaml
          fail-on: never   # or: breaks, to fail when old callers lose something
```

`specs` takes one or more paths, separated by spaces or new lines. OpenAPI 3 and Swagger 2, JSON
or YAML. `fetch-depth: 0` lets the check read the description as it is on the base branch.
