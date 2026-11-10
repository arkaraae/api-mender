#!/usr/bin/env bash
set -euo pipefail

# Upload the new version without touching the live Worker's existing custom domains.
output=$(npx wrangler versions upload --config dist/server/wrangler.json --keep-vars --message 'Publish Mend website' 2>&1)
printf '%s\n' "$output"
version_id=$(printf '%s\n' "$output" | sed -nE 's/.*Worker Version ID: ([0-9a-f-]+).*/\1/p' | tail -1)
if [[ -z "$version_id" ]]; then
  echo 'Could not read the uploaded Worker version ID.' >&2
  exit 1
fi
npx wrangler versions deploy "${version_id}@100" --name api-mender-live --message 'Publish Mend website' --yes
