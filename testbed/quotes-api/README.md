# Quotes API test contract

`contract.json` is the active contract for API Mender's controlled integration test. The hosted API reads it from this repository's `main` branch at a pinned commit. Version 1 accepts `customerId`; version 2 in `versions/v2.json` requires `accountId` and rejects the old request. The endpoint is a test fixture and does not process payments or store customer data.

To exercise a breaking push after the monitor is connected, replace `contract.json` with the v2 file and push to `main`. The consumer in `../quotes-consumer` should fail until Mender's proposed patch is applied.
