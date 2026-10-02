# Quotes API consumer

This is a separate test codebase that calls the public Quotes API. Run `MENDER_TEST_API_URL=https://api-mender.aom31905.chatgpt.site npm test` from this directory. The test passes with the active v1 contract and fails with v2 until the request sends `accountId`.

The fixture uses a dummy identity and no credentials or production data.
