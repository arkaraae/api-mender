# Quotes API breaking-change test

The hosted API at `https://api-mender.aom31905.chatgpt.site/api/testbed/quotes` reads `contract.json` from this repository. Version 1 accepts `customerId`; version 2 requires `accountId`. The separate consumer in `testbed/quotes-consumer` intentionally sends the old field until Mender fixes it.

On a contract push to `main`, `.github/workflows/quotes-contract.yml` compares the previous OpenAPI snapshot with the hosted contract, scans the consumer call site, records the finding and validation in a SQLite database, and uploads the database and report as run artifacts. For the supported v1-to-v2 change it tests the old consumer failure, tests a deterministic patch, and pushes a review branch. The branch includes `mender-status.json` for the Site's live testbed view. GitHub Actions pull request creation must be enabled in repository settings to open the PR automatically; the branch and evidence are still produced if that setting is disabled.

This is a controlled fixture, not an arbitrary API repair engine. Do not merge the fix until its identifier mapping has been reviewed.
