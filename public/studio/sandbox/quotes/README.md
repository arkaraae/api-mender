# Quotes API specs

The two OpenAPI descriptions of the team's Quotes test API (`testbed/quotes-api` on `main`),
produced with that folder's own `openapi.mjs`:

- `openapi-v1.json`: contract version 1, where requests carry `customerId`
- `openapi-v2.json`: contract version 2, where requests must carry `accountId`

`openapi-v2.json` is what the deployed API serves at `/api/testbed/openapi.json`.
Mender reads the two files, finds the change, and runs an adapter so a caller that still
sends `customerId` keeps working.
