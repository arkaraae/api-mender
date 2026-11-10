#!/usr/bin/env bash
# Roll the private-AI pipeline out to STAGING (never production):
#
#   1. database: open the staging Supabase SQL editor with the new migration on
#      the clipboard, then verify the new tables exist
#   2. provider catalog: diff the official GitHub REST contracts and write the
#      catalog into the staging database
#   3. Worker: build this branch for staging and deploy api-mender-staging
#   4. check: the staging site and its model endpoint answer
#
#   bash ~/api-mender-local/scripts/staging-rollout.sh
#
# Secrets are typed into hidden prompts and kept only in this process. They
# are never written to disk or printed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT_REF="xedurkvshpszwevmhkzx"                     # staging Supabase (web/wrangler.jsonc env.staging)
SUPABASE_URL="https://$PROJECT_REF.supabase.co"
SITE="https://api-mender-staging.amorales8.workers.dev"
MIGRATION="$ROOT/supabase/migrations/20261109210000_provider_pipeline_and_private_ai.sql"
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { printf '\n\033[31mmender: %s\033[0m\n' "$*" >&2; exit 1; }
[[ -s "$HOME/.nvm/nvm.sh" ]] && { set +u; source "$HOME/.nvm/nvm.sh"; nvm use 22 >/dev/null 2>&1 || true; set -u; }
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)' \
  || die "need Node.js 22.18+; run scripts/local-model-mac.sh first"

say "Staging Supabase service key"
echo "Supabase dashboard → project $PROJECT_REF → Project Settings → API Keys → secret key (sb_secret_…)."
printf 'Paste it (hidden): '; read -rs SUPABASE_SECRET_KEY; echo
[[ "$SUPABASE_SECRET_KEY" =~ ^(sb_secret_|eyJ) ]] || die "that does not look like a Supabase secret key"
rest() { curl -sS -o /dev/null -w '%{http_code}' -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" "$SUPABASE_URL/rest/v1/$1"; }
[[ "$(rest 'repair_jobs?select=id&limit=1')" == 200 ]] || die "key rejected, or this project lacks repair_jobs (wrong project?)"
echo "key accepted for $PROJECT_REF"

say "1. Database migration"
if [[ "$(rest 'cli_reports?select=id&limit=1')" == 200 && "$(rest 'provider_contract_versions?select=version&limit=1')" == 200 ]]; then
  echo "already applied"
else
  pbcopy < "$MIGRATION"
  open "https://supabase.com/dashboard/project/$PROJECT_REF/sql/new"
  echo "The migration is on your clipboard and the STAGING SQL editor is opening."
  echo "Paste it (⌘V), click Run, and check it says Success."
  printf 'Press Return when it has run… '; read -r _
  for table in provider_contract_versions provider_contract_slices cli_tokens cli_reports audit_events; do
    [[ "$(rest "$table?select=*&limit=1")" == 200 ]] || die "$table is missing; the migration did not apply"
  done
  echo "tables present ✓"
fi

say "2. Provider catalog (official GitHub REST contracts)"
cd "$ROOT/web"
npm ci --no-audit --no-fund --silent
NEXT_PUBLIC_SUPABASE_URL="$SUPABASE_URL" SUPABASE_SECRET_KEY="$SUPABASE_SECRET_KEY" \
  node scripts/sync-provider-contracts.mjs --provider github-rest --write
unset SUPABASE_SECRET_KEY

say "3. Deploy api-mender-staging from $(git -C "$ROOT" rev-parse --short HEAD)"
npx --yes wrangler@4.92.0 whoami >/dev/null 2>&1 || npx --yes wrangler@4.92.0 login
npm run build:staging
npx --yes wrangler@4.92.0 deploy --config dist/server/wrangler.json
secrets="$(npx --yes wrangler@4.92.0 secret list --env staging 2>/dev/null || true)"
for name in MENDER_MODEL_ENDPOINT MENDER_MODEL_NAME MENDER_MODEL_API_KEY; do
  grep -q "$name" <<<"$secrets" || echo "warning: $name is not set on staging; run scripts/connect-local-model.sh --rotate"
done

say "4. Checks"
code="$(curl -s -o /dev/null -w '%{http_code}' -m 20 "$SITE/live")"
[[ "$code" == 200 ]] && echo "$SITE/live answers ✓" || echo "warning: $SITE/live returned $code"
curl -fsS -m 20 https://model-staging.apimender.com/healthz >/dev/null && echo "model endpoint answers ✓" \
  || echo "warning: model endpoint not reachable; run scripts/connect-local-model.sh status"

printf '\n\033[32mStaging is on the private-AI pipeline.\033[0m\n'
echo "Next: install the staging GitHub App (api-mender-scanner) on the pilot repository and scan it from $SITE/live"
