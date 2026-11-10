#!/usr/bin/env bash
# Connect the model on this Mac to the API Mender staging Worker.
#
#   bash ~/api-mender-local/scripts/connect-local-model.sh            # set up (safe to rerun)
#   bash ~/api-mender-local/scripts/connect-local-model.sh --rotate   # new gateway token
#   bash ~/api-mender-local/scripts/connect-local-model.sh status
#   bash ~/api-mender-local/scripts/connect-local-model.sh stop
#
# Run scripts/local-model-mac.sh first (it installs Ollama and mender-coder).
#
#   staging Worker ──HTTPS──▶ Cloudflare Tunnel ──▶ gateway 127.0.0.1:8787 ──▶ Ollama 127.0.0.1:11434
#                    (bearer token checked by the gateway)
#
# Nothing listens on a public interface: the tunnel is an outbound connection
# from this Mac. Every request needs the gateway token, and the gateway gives
# the model no tools and logs no prompts or completions. The repair excerpt
# (the lines around one API call) is processed here and nowhere else.
#
# Repairs work only while this Mac is awake and online. That is the point of
# this stage; move to a hosted GPU before real customers depend on it.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST="${MENDER_TUNNEL_HOST:-model-staging.apimender.com}"
TUNNEL="${MENDER_TUNNEL_NAME:-mender-model-staging}"
MODEL="${MENDER_MODEL_NAME:-mender-coder}"
WORKER_ENV="${MENDER_WORKER_ENV:-staging}"
STATE="$HOME/.mender"
GATEWAY_LABEL="com.apimender.gateway"
TUNNEL_LABEL="com.apimender.tunnel"
AGENTS="$HOME/Library/LaunchAgents"
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { printf '\n\033[31mmender: %s\033[0m\n' "$*" >&2; exit 1; }
unload() {
  launchctl bootout "gui/$(id -u)/$1" 2>/dev/null || launchctl unload "$AGENTS/$1.plist" 2>/dev/null || true
  # bootout returns before launchd has finished; wait so bootstrap does not hit "Input/output error".
  for _ in $(seq 20); do launchctl print "gui/$(id -u)/$1" >/dev/null 2>&1 || return 0; sleep 0.5; done
}
load() {
  local plist="$AGENTS/$1"
  plutil -lint "$plist" >/dev/null || die "$plist is not a valid property list"
  launchctl bootstrap "gui/$(id -u)" "$plist" 2>/dev/null && return 0
  sleep 1
  launchctl bootstrap "gui/$(id -u)" "$plist" 2>/dev/null && return 0
  # Older loading path; works where bootstrap is refused (e.g. some Terminal sessions).
  launchctl load -w "$plist" 2>/dev/null && return 0
  launchctl print "gui/$(id -u)/${1%.plist}" 2>&1 | head -20 || true
  die "macOS would not start ${1%.plist}. Check System Settings → General → Login Items & Extensions that background items for node/cloudflared are allowed, then rerun"
}

case "${1:-}" in
  stop)
    unload "$GATEWAY_LABEL"; unload "$TUNNEL_LABEL"
    echo "Stopped the gateway and tunnel. Staging repairs will report the model as unavailable."
    exit 0;;
  status)
    launchctl print "gui/$(id -u)/$GATEWAY_LABEL" >/dev/null 2>&1 && echo "gateway: running" || echo "gateway: stopped"
    launchctl print "gui/$(id -u)/$TUNNEL_LABEL" >/dev/null 2>&1 && echo "tunnel:  running" || echo "tunnel:  stopped"
    curl -fsS -m 10 "https://$HOST/healthz" && echo " ← https://$HOST/healthz" || echo "https://$HOST/healthz: not reachable"
    exit 0;;
  ""|--rotate) ;;
  *) die "unknown option $1";;
esac

for candidate in /opt/homebrew/bin/brew /usr/local/bin/brew "$HOME/.homebrew/bin/brew"; do
  command -v brew >/dev/null || { [[ -x "$candidate" ]] && eval "$("$candidate" shellenv)"; }
done
command -v brew >/dev/null || die "Homebrew not found"
[[ -s "$HOME/.nvm/nvm.sh" ]] && { set +u; source "$HOME/.nvm/nvm.sh"; nvm use 22 >/dev/null 2>&1 || true; set -u; }
NODE="$(command -v node)" || die "Node.js not found; run scripts/local-model-mac.sh first"

say "Ollama and $MODEL"
command -v ollama >/dev/null || die "Ollama not installed; run scripts/local-model-mac.sh first"
# Start Ollama at login as a background service (loopback only by default).
brew services start ollama >/dev/null 2>&1 || true
for _ in $(seq 30); do curl -fsS http://127.0.0.1:11434/api/version >/dev/null 2>&1 && break; sleep 1; done
ollama show "$MODEL" >/dev/null 2>&1 || die "$MODEL is missing; run scripts/local-model-mac.sh first"
echo "ok"

say "Gateway token"
mkdir -p "$STATE" && chmod 700 "$STATE"
if [[ "${1:-}" == --rotate || ! -s "$STATE/gateway.tokens" ]]; then
  output="$("$NODE" "$ROOT/model-service/gateway/token.mjs" new "worker-$WORKER_ENV")"
  TOKEN="$(sed -n '3p' <<<"$output" | tr -d ' ')"
  # Only the hash is kept on disk; the token itself goes straight into the Worker secret.
  tail -n1 <<<"$output" | tr -d ' ' > "$STATE/gateway.tokens"
  chmod 600 "$STATE/gateway.tokens"
  NEW_TOKEN=1
  echo "new token minted (only its SHA-256 is stored, in $STATE/gateway.tokens)"
else
  NEW_TOKEN=0
  echo "keeping the existing token (pass --rotate for a new one)"
fi

say "Gateway as a login item (127.0.0.1:8787)"
mkdir -p "$AGENTS"
cat > "$AGENTS/$GATEWAY_LABEL.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$GATEWAY_LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$ROOT/model-service/gateway/server.mjs</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>MENDER_GATEWAY_LISTEN</key><string>127.0.0.1:8787</string>
    <key>MENDER_UPSTREAM_URL</key><string>http://127.0.0.1:11434/v1</string>
    <key>MENDER_ALLOWED_MODELS</key><string>$MODEL</string>
    <key>MENDER_GATEWAY_TOKENS_SHA256</key><string>$(cat "$STATE/gateway.tokens")</string>
    <key>MENDER_RATE_LIMIT_PER_MINUTE</key><string>20</string>
    <key>MENDER_MAX_CONCURRENCY</key><string>1</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$STATE/gateway.log</string>
  <key>StandardErrorPath</key><string>$STATE/gateway.log</string>
</dict></plist>
PLIST
chmod 600 "$AGENTS/$GATEWAY_LABEL.plist"
unload "$GATEWAY_LABEL"; load "$GATEWAY_LABEL.plist"
for _ in $(seq 20); do curl -fsS http://127.0.0.1:8787/healthz >/dev/null 2>&1 && break; sleep 0.5; done
curl -fsS http://127.0.0.1:8787/healthz || die "gateway did not start; see $STATE/gateway.log"
echo

say "Cloudflare Tunnel → https://$HOST"
command -v cloudflared >/dev/null || brew install cloudflared
if [[ ! -s "$HOME/.cloudflared/cert.pem" ]]; then
  echo "A browser window will open: log in to Cloudflare and pick the zone that holds ${HOST#*.}."
  cloudflared tunnel login
fi
cloudflared tunnel info "$TUNNEL" >/dev/null 2>&1 || cloudflared tunnel create "$TUNNEL"
TUNNEL_ID="$(cloudflared tunnel info "$TUNNEL" 2>/dev/null | grep -Eo '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)"
[[ -n "$TUNNEL_ID" ]] || die "could not read the tunnel id"
cloudflared tunnel route dns --overwrite-dns "$TUNNEL" "$HOST" \
  || die "could not create DNS for $HOST. Log in to the account that owns ${HOST#*.} (delete ~/.cloudflared/cert.pem and rerun), or set MENDER_TUNNEL_HOST to a hostname in a zone you control"
cat > "$STATE/tunnel.yml" <<YAML
tunnel: $TUNNEL_ID
credentials-file: $HOME/.cloudflared/$TUNNEL_ID.json
ingress:
  # Only the gateway is exposed, and only these two paths.
  - hostname: $HOST
    path: ^/(v1/chat/completions|healthz)$
    service: http://127.0.0.1:8787
  - service: http_status:404
YAML
cat > "$AGENTS/$TUNNEL_LABEL.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$TUNNEL_LABEL</string>
  <key>ProgramArguments</key><array><string>$(command -v cloudflared)</string><string>tunnel</string><string>--no-autoupdate</string><string>--config</string><string>$STATE/tunnel.yml</string><string>run</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$STATE/tunnel.log</string>
  <key>StandardErrorPath</key><string>$STATE/tunnel.log</string>
</dict></plist>
PLIST
unload "$TUNNEL_LABEL"; load "$TUNNEL_LABEL.plist"
echo "waiting for https://$HOST (DNS can take a minute the first time)…"
for _ in $(seq 60); do curl -fsS -m 5 "https://$HOST/healthz" >/dev/null 2>&1 && break; sleep 3; done
curl -fsS -m 10 "https://$HOST/healthz" || die "https://$HOST is not reachable yet; check $STATE/tunnel.log, then rerun"
echo

say "Staging Worker secrets ($WORKER_ENV)"
cd "$ROOT/web"
npx --yes wrangler@4.92.0 whoami >/dev/null 2>&1 || npx --yes wrangler@4.92.0 login
printf '%s' "https://$HOST/v1" | npx --yes wrangler@4.92.0 secret put MENDER_MODEL_ENDPOINT --env "$WORKER_ENV"
printf '%s' "$MODEL" | npx --yes wrangler@4.92.0 secret put MENDER_MODEL_NAME --env "$WORKER_ENV"
if [[ "$NEW_TOKEN" == 1 ]]; then
  printf '%s' "$TOKEN" | npx --yes wrangler@4.92.0 secret put MENDER_MODEL_API_KEY --env "$WORKER_ENV"
  unset TOKEN
else
  echo "MENDER_MODEL_API_KEY unchanged (the Worker already has the current token)"
fi

say "End-to-end check through the tunnel"
# A request without the token must be refused...
code="$(curl -s -o /dev/null -w '%{http_code}' -m 20 -X POST "https://$HOST/v1/chat/completions" -H 'content-type: application/json' -d '{}')"
[[ "$code" == 401 ]] && echo "unauthenticated request refused (401) ✓" || die "expected 401 without a token, got $code"
# ...and anything outside the two exposed paths is not routed to the gateway.
code="$(curl -s -o /dev/null -w '%{http_code}' -m 20 "https://$HOST/v1/models")"
[[ "$code" == 404 ]] && echo "other paths not exposed (404) ✓" || echo "note: /v1/models returned $code"

printf '\n\033[32mConnected: staging repairs now use %s on this Mac via https://%s\033[0m\n' "$MODEL" "$HOST"
echo "Status: bash $0 status    Stop: bash $0 stop    New token: bash $0 --rotate"
