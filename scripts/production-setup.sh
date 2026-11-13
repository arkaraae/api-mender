#!/usr/bin/env bash
# Bring apimender.com's backend up to date with main:
#
#   1. database: find which migrations the PRODUCTION Supabase project is
#      missing, put exactly those on the clipboard, open its SQL editor, and
#      check the tables exist afterwards
#   2. Worker secrets: list what api-mender-live has, generate the settings
#      encryption key, and ask only for the ones still missing (any can be
#      skipped and set later)
#   3. optional: write the provider contract catalog into production
#
#   bash ~/mend-deploy/scripts/production-setup.sh
#
# Secrets are typed into hidden prompts and passed straight to Wrangler.
# They are never written to disk or printed.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT_REF="eeejqyvtdvahofwoiicv"                      # production Supabase (web/wrangler.jsonc env.apimender)
SUPABASE_URL="https://$PROJECT_REF.supabase.co"
WRANGLER="npx --yes wrangler@4.92.0"
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { printf '\n\033[31mmender: %s\033[0m\n' "$*" >&2; exit 1; }
ask_yes() { local reply; printf '%s [y/N] ' "$1"; read -r reply; [[ "$reply" =~ ^[Yy] ]]; }

[[ -s "$HOME/.nvm/nvm.sh" ]] && { set +u; source "$HOME/.nvm/nvm.sh"; nvm use 22 >/dev/null 2>&1 || true; set -u; }
command -v node >/dev/null || die "Node.js is required"

say "Production Supabase secret key"
echo "Supabase dashboard → project $PROJECT_REF → Project Settings → API Keys → secret key (sb_secret_…)."
open "https://supabase.com/dashboard/project/$PROJECT_REF/settings/api-keys" 2>/dev/null || true
printf 'Paste it (hidden): '; read -rs SUPABASE_SECRET_KEY; echo
[[ "$SUPABASE_SECRET_KEY" =~ ^(sb_secret_|eyJ) ]] || die "that does not look like a Supabase secret key"
probe() { curl -sS -o /dev/null -w '%{http_code}' -m 20 -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" "$SUPABASE_URL/rest/v1/$1"; }
[[ "$(probe 'workspaces?select=id&limit=1')" =~ ^(200|404)$ ]] || die "key rejected by $PROJECT_REF"
echo "key accepted for $PROJECT_REF"

say "1. Database migrations"
# Each migration is recognised by a table it creates; the first missing one
# and everything after it are applied, in order.
first_missing=""
pending=()
for file in "$ROOT"/supabase/migrations/*.sql; do
  table="$(grep -oiE 'create table (if not exists )?(public\.)?[a-z_]+' "$file" | head -1 | awk '{print $NF}' | sed 's/public\.//' || true)"
  if [[ -z "$first_missing" ]]; then
    [[ -z "$table" ]] && continue
    if [[ "$(probe "$table?select=*&limit=1")" == 200 ]]; then continue; fi
    first_missing="$file"
  fi
  pending+=("$file")
done
if [[ ${#pending[@]} -eq 0 ]]; then
  echo "production already has every migration ✓"
else
  echo "missing in production (applied in this order):"
  for file in "${pending[@]}"; do echo "  $(basename "$file")"; done
  for file in "${pending[@]}"; do printf -- '-- %s\n' "$(basename "$file")"; cat "$file"; printf '\n\n'; done | pbcopy
  open "https://supabase.com/dashboard/project/$PROJECT_REF/sql/new"
  echo
  echo "They are on your clipboard and the PRODUCTION SQL editor is opening."
  echo "Paste (⌘V), click Run, and check it says Success."
  printf 'Press Return when it has run… '; read -r _
  for table in workspaces findings monitored_repositories repair_jobs provider_contract_versions cli_reports workspace_alert_settings workspace_billing api_hosts api_rate_limits; do
    code="$(probe "$table?select=*&limit=1")"
    [[ "$code" == 200 ]] || die "$table is missing (HTTP $code); the SQL did not fully apply. Re-run this script to see what is left."
  done
  echo "tables present ✓"
fi

say "2. Worker secrets on api-mender-live"
cd "$ROOT/web"
$WRANGLER whoami >/dev/null 2>&1 || $WRANGLER login
existing="$($WRANGLER secret list --env apimender 2>/dev/null || true)"
has() { grep -q "\"$1\"" <<<"$existing"; }
put() { printf '%s' "$2" | $WRANGLER secret put "$1" --env apimender >/dev/null && echo "  set $1 ✓"; }
ask_put() { # ask_put NAME "where to find it"
  local value
  if has "$1"; then echo "  $1 already set"; return; fi
  echo "  $1: $2"
  printf '    paste (hidden, Return to skip): '; read -rs value; echo
  [[ -n "$value" ]] && put "$1" "$value" || echo "    skipped"
}

has SUPABASE_SECRET_KEY && echo "  SUPABASE_SECRET_KEY already set" || put SUPABASE_SECRET_KEY "$SUPABASE_SECRET_KEY"
if has MENDER_SETTINGS_KEY; then echo "  MENDER_SETTINGS_KEY already set"
else put MENDER_SETTINGS_KEY "$(openssl rand -base64 32)"; fi

if has GITHUB_APP_PRIVATE_KEY; then echo "  GITHUB_APP_PRIVATE_KEY already set"
else
  echo "  GITHUB_APP_PRIVATE_KEY: the .pem file for the api-mender-connect GitHub App"
  echo "    (github.com/settings/apps/api-mender-connect → Private keys → Generate, if you have none)"
  printf '    path to the .pem file (Return to skip): '; read -r pem
  pem="${pem/#\~/$HOME}"
  if [[ -n "$pem" && -f "$pem" ]]; then $WRANGLER secret put GITHUB_APP_PRIVATE_KEY --env apimender < "$pem" >/dev/null && echo "  set GITHUB_APP_PRIVATE_KEY ✓"
  else echo "    skipped"; fi
fi
ask_put GITHUB_APP_CLIENT_SECRET "github.com/settings/apps/api-mender-connect → Client secrets"
ask_put GITHUB_WEBHOOK_SECRET "the webhook secret saved on the api-mender-connect GitHub App"
ask_put STRIPE_SECRET_KEY "dashboard.stripe.com → Developers → API keys → Secret key (sk_live_… or sk_test_…)"
ask_put STRIPE_PRICE_PRO "Stripe → Product catalog → your Pro product → price ID (price_…)"
ask_put STRIPE_WEBHOOK_SECRET "Stripe → Developers → Webhooks → endpoint https://apimender.com/api/billing/webhook → Signing secret (whsec_…)"
has MENDER_MODEL_ENDPOINT && echo "  model endpoint already set" \
  || echo "  model endpoint not set: fixes on apimender.com stay off until you run
    MENDER_TUNNEL_HOST=model.apimender.com MENDER_WORKER_ENV=apimender bash scripts/connect-local-model.sh"

say "3. Provider contract catalog (optional)"
if ask_yes "Write the GitHub, Stripe, OpenAI and Twilio contracts into production now?"; then
  npm ci --no-audit --no-fund --silent
  NEXT_PUBLIC_SUPABASE_URL="$SUPABASE_URL" SUPABASE_SECRET_KEY="$SUPABASE_SECRET_KEY" node scripts/sync-provider-contracts.mjs --write
fi
unset SUPABASE_SECRET_KEY

printf '\n\033[32mProduction backend is set up.\033[0m Secrets apply to the live site right away; no redeploy needed.\n'
