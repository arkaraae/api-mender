# Postgres production database evidence: first backend slice

API Mender's first database connector is a customer-run metadata probe. It
connects from the customer's network to PostgreSQL, queries `pg_catalog` for
the names, types, and nullability of columns in `public` tables, and saves a
local JSON evidence file. It does not select from customer tables, copy row
values, change schema, or send database credentials to API Mender. The file is
created with owner-only permissions and is not uploaded automatically.

Use a dedicated login with `CONNECT` and no table read/write, schema-create, database-create,
superuser, or bypass-RLS privileges. Run it against a read replica when one is
available. The probe also forces a read-only session, verifies the role's
privileges before accepting a result, requires TLS hostname verification, and
limits query time and output size. These are layered controls, not a substitute
for the customer's database access review.

```bash
export PGHOST=db.example.com
export PGPORT=5432
export PGDATABASE=customer_app
export PGUSER=mender_probe
export PGPASSFILE=/secure/path/to/pgpass
export PGSSLROOTCERT=/secure/path/to/ca.pem
node scripts/postgres-schema-probe.mjs --output /secure/path/schema-evidence.json
```

The password file must be readable only by its owner. A secret manager can
provide `PGPASSWORD` instead; do not put the password in shell history. The probe
will not overwrite an existing output file. Keep the evidence file in the
customer's environment until its contents and sharing have been approved.

After the backend foundation migration, apply
`supabase/migrations/20261022170000_database_schema_evidence.sql` and deploy
`POST /api/live/database-schemas`. A signed-in workspace owner or editor can
submit `{ "workspaceId": "…", "label": "orders-prod", "evidence": { … } }`
with the JSON from the probe and a Supabase bearer token. This is an explicit
customer upload; the probe does not transmit anything. The endpoint rejects
unknown fields, row-shaped data, stale reports, altered fingerprints, and
oversized input. It checks editor membership before storing the columns as
**customer-attested** evidence. Direct browser inserts are denied; reads use
workspace row-level security. `GET /api/live/database-schemas?workspaceId=…`
lists fingerprints and timestamps without returning the column inventory.

## What this evidence can and cannot establish

A database schema snapshot can confirm, for example, whether a column that
customer code writes exists and whether it is nullable. It cannot, by itself,
show which upstream API fields customer code reads, whether a deployed code
path ran, or whether a request actually failed. A verified API break needs a
chain of evidence: pinned old and new API contracts, the affected repository
call and mapping into a database operation, a failing pre-fix test or trace,
and a passing post-fix test. Production rows should not be used as AI prompt
context or as a default test fixture.

## Declared API-to-database mapping

Staging can now associate a scanned request field with a customer-attested
Postgres column. After uploading a fresh schema snapshot, a signed-in workspace
editor calls `POST /api/live/database-mappings` with:

```json
{
  "workspaceId": "WORKSPACE_UUID",
  "sourceId": "CONNECTED_OPENAPI_SOURCE_UUID",
  "repositoryId": "CONNECTED_CONSUMER_REPOSITORY_UUID",
  "endpoint": "POST /quotes",
  "requestField": "accountId",
  "schemaLabel": "orders-prod",
  "table": "quotes",
  "column": "account_id"
}
```

Use the same Supabase bearer token as for schema evidence ingestion. The route
requires an active source-to-consumer binding and confirms that the column is
in the latest snapshot under that label. `GET /api/live/database-mappings?workspaceId=…`
lists mappings; `DELETE /api/live/database-mappings` accepts `workspaceId` and
`mappingId`. A later schema upload under the same label is picked up by the next
repository scan. The finding records the matched column, its nullability,
snapshot fingerprint, capture time, and whether the snapshot is fresh. It says
**customer-declared mapping** and **runtime unverified**. It does not infer a
database dependency just because an API field resembles a column name.

## Remaining product integration

1. Verify with a customer-run probe that a workspace editor can submit
   evidence and a viewer or unrelated user cannot. Collect only columns needed
   for impact analysis in a later probe revision; this first version includes
   all `public` columns and has a 5,000-column limit.
2. Prove the dependency from a pinned consumer call through the code path that
   reads or writes the declared table column. A declared mapping and schema
   presence alone establish possible impact only.
3. Run old-versus-new integration tests in an isolated customer-controlled
   runner or staging database. Generated patches must never run against the
   production database. Keep the failing and passing logs, the contract and
   repository SHAs, and a draft repair PR for review.
4. For a managed direct connection later, use a private network path and a
   dedicated read-only role. Do not expose a customer database to the public
   internet to make API Mender work.

The probe remains customer-run. API Mender does not connect to or query a
customer production database, and the staging workspace has no real customer
schema snapshot yet.
