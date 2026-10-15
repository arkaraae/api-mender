# Quotes API consumer

This is a separate test codebase that calls the public Quotes API. Run `MENDER_TEST_API_URL=https://apimender.com npm test` from this directory. Its old request intentionally fails with the active v2 contract until the consumer sends `accountId`.

The fixture uses a dummy identity and no credentials or production data.
