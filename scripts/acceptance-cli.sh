#!/usr/bin/env bash
# End-to-end acceptance run for the customer-managed (CLI) path.
#
#   1. a fresh git copy of examples/github-issues-consumer (a real call to
#      POST https://api.github.com/repos/{owner}/{repo}/issues, pinned to
#      X-GitHub-Api-Version 2022-11-28, sending the deprecated `assignee`)
#   2. the private model gateway on 127.0.0.1, in front of either
#        - YOUR open-weight model server:  MENDER_UPSTREAM_URL=http://127.0.0.1:8080/v1 MENDER_MODEL_NAME=qwen2.5-coder-7b
#        - or, when MENDER_UPSTREAM_URL is unset, the labelled test double
#          (model-service/standin; NOT a model) so the plumbing can be exercised without a GPU
#   3. `mender check` with the official GitHub REST contracts 2022-11-28 and
#      2026-03-10 (downloaded from github/rest-api-description, or local files
#      via GITHUB_CONTRACTS_DIR)
#   4. checks from the consumer's mender.config.json in the isolated runner
#
# Every outbound request made by the CLI and gateway is to 127.0.0.1 or to
# raw.githubusercontent.com for the public contracts. No hosted AI API is
# configured anywhere; the gateway refuses to start if pointed at one.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
GATEWAY_PORT="${GATEWAY_PORT:-18787}"
STANDIN_PORT="${STANDIN_PORT:-18799}"
pids=()
cleanup() { for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done; rm -rf "$WORK"; }
trap cleanup EXIT

# 1. Customer repository: a fresh git repo so the run never touches this checkout.
cp -r "$ROOT/examples/github-issues-consumer" "$WORK/repo"
git -C "$WORK/repo" init -q && git -C "$WORK/repo" add -A
git -C "$WORK/repo" -c user.name=pilot -c user.email=pilot@example.invalid commit -qm "pilot consumer"

# 2. Model: your server, or the test double.
if [[ -z "${MENDER_UPSTREAM_URL:-}" ]]; then
  echo "== No MENDER_UPSTREAM_URL: using the TEST DOUBLE (not a model) behind the gateway"
  STANDIN_PORT="$STANDIN_PORT" node "$ROOT/model-service/standin/server.mjs" & pids+=($!)
  export MENDER_UPSTREAM_URL="http://127.0.0.1:$STANDIN_PORT/v1"
  export MENDER_MODEL_NAME="mender-test-double"
fi
: "${MENDER_MODEL_NAME:?set MENDER_MODEL_NAME to the model name your server serves}"
token_output="$(node "$ROOT/model-service/gateway/token.mjs" new acceptance)"
TOKEN="$(sed -n '3p' <<<"$token_output" | tr -d ' ')"
TOKEN_ENTRY="$(tail -n1 <<<"$token_output" | tr -d ' ')"
MENDER_GATEWAY_LISTEN="127.0.0.1:$GATEWAY_PORT" MENDER_GATEWAY_TOKENS_SHA256="$TOKEN_ENTRY" \
  MENDER_ALLOWED_MODELS="$MENDER_MODEL_NAME" node "$ROOT/model-service/gateway/server.mjs" > "$WORK/gateway.log" & pids+=($!)
for _ in $(seq 50); do curl -fsS "http://127.0.0.1:$GATEWAY_PORT/healthz" >/dev/null 2>&1 && break; sleep 0.2; done

# 3 + 4. Mender check.
contract_flags=()
if [[ -n "${GITHUB_CONTRACTS_DIR:-}" ]]; then
  contract_flags=(--old-contract "$GITHUB_CONTRACTS_DIR/api.github.com.2022-11-28.json"
                  --new-contract "$GITHUB_CONTRACTS_DIR/api.github.com.2026-03-10.json")
fi
set +e
MENDER_MODEL_API_KEY="$TOKEN" node "$ROOT/cli/bin/mender.mjs" check --repo "$WORK/repo" --out "$WORK/out" \
  --provider github-rest --from 2022-11-28 --to 2026-03-10 "${contract_flags[@]}" \
  --model-endpoint "http://127.0.0.1:$GATEWAY_PORT/v1" --model "$MENDER_MODEL_NAME" ${MENDER_CHECK_FLAGS:-}
status=$?
set -e

echo
echo "== Gateway log (metadata only; no prompts or completions are ever logged)"
cat "$WORK/gateway.log"
mkdir -p "${ACCEPTANCE_OUT:-$ROOT/.mender-acceptance}"
cp -r "$WORK/out/." "${ACCEPTANCE_OUT:-$ROOT/.mender-acceptance}/"
cp "$WORK/gateway.log" "${ACCEPTANCE_OUT:-$ROOT/.mender-acceptance}/gateway.log"
echo "== Results copied to ${ACCEPTANCE_OUT:-$ROOT/.mender-acceptance}"
# `mender check` exits 1 when it reports findings, which is the expected outcome here.
[[ $status -le 1 ]]
