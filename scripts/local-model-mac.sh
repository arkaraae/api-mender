#!/usr/bin/env bash
# Run Mender's model locally on an Apple Silicon Mac and prove it end to end.
#
#   curl -fsSL https://raw.githubusercontent.com/arkaraae/api-mender/mender/private-ai-mvp/scripts/local-model-mac.sh | bash
#
# 1. installs Ollama (Homebrew) and starts it on 127.0.0.1:11434 (local only)
# 2. downloads Qwen2.5-Coder-7B (about 4.7 GB, once) and creates `mender-coder`
#    with an 8K context and temperature 0
# 3. checks out the mender/private-ai-mvp branch into ~/api-mender-local
# 4. runs scripts/acceptance-cli.sh against the real model: discovery, the
#    GitHub `assignee` finding, a patch from the local model, the policy gates
#    and the pilot's checks before/after
#
# Nothing is sent to any hosted AI provider. Network use: Homebrew, the model
# download, GitHub (repo + official API contracts) and npm.
set -euo pipefail

DIR="${MENDER_LOCAL_DIR:-$HOME/api-mender-local}"
BRANCH="mender/private-ai-mvp"
BASE_MODEL="${MENDER_BASE_MODEL:-qwen2.5-coder:7b}"
MODEL="${MENDER_MODEL_NAME:-mender-coder}"
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { printf '\n\033[31mmender: %s\033[0m\n' "$*" >&2; exit 1; }

[[ "$(uname -s)" == Darwin ]] || die "this script is for macOS"
[[ "$(uname -m)" == arm64 ]] || echo "note: not Apple Silicon; the model will run on the CPU and be slow"

say "Homebrew"
if ! command -v brew >/dev/null; then
  for candidate in /opt/homebrew/bin/brew /usr/local/bin/brew "$HOME/.homebrew/bin/brew"; do
    [[ -x "$candidate" ]] && eval "$("$candidate" shellenv)" && break
  done
fi
command -v brew >/dev/null || die "Homebrew not found; install it from https://brew.sh and rerun"

say "Node.js 22.18+ (the CLI runs TypeScript directly)"
node_ok() { command -v node >/dev/null && node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)'; }
if ! node_ok && [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  set +u; source "$HOME/.nvm/nvm.sh"; nvm install 22 >/dev/null; nvm use 22 >/dev/null; set -u
fi
node_ok || { brew install node@22 >/dev/null; export PATH="$(brew --prefix node@22)/bin:$PATH"; }
node_ok || die "need Node.js 22.18 or newer"
echo "node $(node -v)"

say "Ollama"
command -v ollama >/dev/null || brew install ollama
if ! curl -fsS http://127.0.0.1:11434/api/version >/dev/null 2>&1; then
  # Bound to loopback: nothing outside this Mac can reach the model.
  OLLAMA_HOST=127.0.0.1:11434 nohup ollama serve >"$HOME/.mender-ollama.log" 2>&1 &
  for _ in $(seq 60); do curl -fsS http://127.0.0.1:11434/api/version >/dev/null 2>&1 && break; sleep 1; done
fi
curl -fsS http://127.0.0.1:11434/api/version || die "Ollama did not start; see ~/.mender-ollama.log"

say "Model $BASE_MODEL (about 4.7 GB the first time)"
ollama pull "$BASE_MODEL"
# Ollama's default context (2K tokens) is too small for a repair task.
modelfile="$(mktemp)"
printf 'FROM %s\nPARAMETER num_ctx 8192\nPARAMETER temperature 0\n' "$BASE_MODEL" >"$modelfile"
ollama create "$MODEL" -f "$modelfile" >/dev/null
rm -f "$modelfile"
echo "model ready: $MODEL"

say "API Mender ($BRANCH) in $DIR"
if [[ -d "$DIR/.git" ]]; then
  git -C "$DIR" fetch -q origin "$BRANCH" && git -C "$DIR" checkout -q -B "$BRANCH" FETCH_HEAD
else
  git clone -q --depth 1 --branch "$BRANCH" https://github.com/arkaraae/api-mender "$DIR"
fi
(cd "$DIR/web" && npm ci --no-audit --no-fund --silent)

say "Checks isolation"
if docker info >/dev/null 2>&1; then
  flags=""
  echo "Docker is running: checks run in a container with no network"
else
  # The checks here are the pilot repository's own tests, written by us.
  # Never use this flag on code you do not trust.
  flags="--unsafe-no-isolation"
  echo "Docker is not running: the pilot's checks run as plain processes (fine for our own pilot repo)"
fi

say "Acceptance test with the real model"
cd "$DIR"
started=$(date +%s)
set +e
MENDER_UPSTREAM_URL=http://127.0.0.1:11434/v1 MENDER_MODEL_NAME="$MODEL" MENDER_CHECK_FLAGS="$flags" \
  ACCEPTANCE_OUT="$DIR/.mender-acceptance" bash scripts/acceptance-cli.sh 2>&1 | tee "$DIR/.mender-acceptance-run.log"
status=${PIPESTATUS[0]}
set -e
echo
echo "took $(( $(date +%s) - started ))s; full output in $DIR/.mender-acceptance-run.log"
if [[ $status -eq 0 ]] && grep -q 'self-hosted-model' "$DIR/.mender-acceptance-run.log" \
   && grep -q 'after  PASS  unit-next-api-version' "$DIR/.mender-acceptance-run.log"; then
  printf '\n\033[32mPASS: the local model produced a patch that passed every gate and the checks.\033[0m\n'
else
  printf '\n\033[33mNOT PASSED: see the output above (the model may have abstained or a gate rejected its patch).\033[0m\n'
fi
