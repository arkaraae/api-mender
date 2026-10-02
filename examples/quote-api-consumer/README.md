# Quote API consumer

This is a separate Node application with its own package and tests. It calls the published API Mender Quote API. Product data and contract versions come from the owner-controlled Supabase database.

Run `MENDER_TEST_API_URL=https://api-mender.aom31905.chatgpt.site npm test` in this directory. When the API owner publishes a breaking contract version, this test fails against the live API until the consumer is updated.
