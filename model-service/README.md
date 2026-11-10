# API Mender model service

The private model-serving component of API Mender. It serves an **open-weight**
coding model on infrastructure you control and puts a small authenticated
gateway in front of it.

**Hard rule this component exists to enforce:** customer source code, prompts
containing source, patches and test output are never sent to OpenAI, Anthropic
or any other hosted AI provider. The gateway refuses to start if its upstream
is one.

Contents:

| Path | What it is |
| --- | --- |
| `gateway/server.mjs` | Zero-dependency Node (>= 22) gateway in front of vLLM / llama.cpp / Ollama |
| `gateway/token.mjs` | Mint and hash gateway bearer tokens |
| `standin/server.mjs` | **Test double. NOT a model.** For integration tests on machines without a GPU |
| `docker-compose.yml` | `gpu` (vLLM), `cpu` (llama.cpp) and one-shot `weights` profiles |
| `Dockerfile` | Gateway image (node:22-alpine, non-root) |
| `.env.example` | Every variable, documented, no secrets |

## Two modes, and what each means for customer code

| | Mender-hosted | Customer-managed |
| --- | --- | --- |
| Where the model runs | Infrastructure API Mender controls | The customer's machine, CI runner or VPC |
| Who calls it | The Mender Cloudflare Worker | The Mender CLI |
| Does source leave the customer's environment? | **Yes.** A source excerpt (<= 4 KB per request) and the contract diff are sent to Mender-controlled infrastructure. | **No.** Nothing reaches API Mender. |
| Does source reach a third-party AI provider? | No | No |

Be accurate about this with customers: Mender-hosted inference is private from
AI vendors, but it is not "your code never leaves your environment". Only
customer-managed mode gives that property.

## Architecture

```
 Mender-hosted mode

  Cloudflare Worker                      host you control
 ┌───────────────────┐   HTTPS + bearer token    ┌──────────────────────────────────────────────┐
 │ repair pipeline   │ ────────────────────────▶ │ TLS termination                              │
 │ MENDER_MODEL_*    │   over one of:            │ (cloudflared / reverse proxy / WireGuard)    │
 │ secrets           │   - Cloudflare Tunnel     │            │ http://127.0.0.1:8787           │
 └───────────────────┘     + Access service token│            ▼                                 │
                           - mTLS reverse proxy  │  ┌──────────────────┐   network `front`      │
                           - WireGuard / private │  │ gateway          │                        │
                             networking          │  │ auth, limits,    │                        │
                           - IP allow-list       │  │ request rebuild  │                        │
                                                 │  └────────┬─────────┘                        │
                                                 │           │ network `model-internal`         │
                                                 │           │ (internal: true, no egress,      │
                                                 │           ▼  nothing published)              │
                                                 │  ┌──────────────────┐   ┌─────────────────┐  │
                                                 │  │ inference        │◀──│ weights volume  │  │
                                                 │  │ vLLM / llama.cpp │ ro│ (pre-downloaded)│  │
                                                 │  └──────────────────┘   └─────────────────┘  │
                                                 └──────────────────────────────────────────────┘

 Customer-managed mode

  developer machine / CI runner
 ┌────────────────────────────────────────────────────────────────┐
 │ mender CLI ──▶ http://127.0.0.1:8787/v1 (gateway) ──▶ inference │   nothing leaves this box
 │        or ──▶ http://127.0.0.1:11434/v1 (Ollama, directly)      │
 └────────────────────────────────────────────────────────────────┘
```

The model service is separate from the product's Cloudflare Worker: different
process, different host, its own credentials. The Worker holds a bearer token
for the gateway; the gateway holds only that token's SHA-256.

## The protocol the gateway accepts

One operation: `POST /v1/chat/completions` (OpenAI-compatible), plus an
unauthenticated `GET /healthz` returning only `{"ok":true,"model":"<first allowed model>"}`.

```json
{
  "model": "qwen2.5-coder-7b-instruct",
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "{\"contract_change\":{...},\"editable_lines\":{...},\"source_excerpt\":[...]}" }
  ],
  "response_format": { "type": "json_schema", "json_schema": { "name": "mender_patch", "strict": true, "schema": { } } },
  "temperature": 0,
  "stream": false
}
```

The gateway never forwards the client's JSON. It validates it and **rebuilds**
the upstream request from an allow-list:

| Field | Rule |
| --- | --- |
| `model` | Must be in `MENDER_ALLOWED_MODELS` |
| `messages` | 1 to 4 items, roles `system` / `user` only, string content, last one `user`, total <= `MENDER_MAX_PROMPT_CHARS` |
| `response_format` | Required. `{type:"json_schema", json_schema:{name, strict?, schema}}`, schema <= 8 KB |
| `temperature` | Clamped to [0, 0.2]; default 0 |
| `max_tokens` (or `max_completion_tokens`) | Clamped to `MENDER_MAX_OUTPUT_TOKENS`; default is that maximum |
| `stream` | Forced `false` |
| anything else | Dropped |

Rejected with 400: `tools`, `tool_choice`, `functions`, `function_call` (present
at all), `stream: true`, `n > 1`, `logprobs` / `top_logprobs`, and
`assistant` / `tool` / any other role. The model is never given tools.

The response is rebuilt too:
`{ id, model, choices: [{ index: 0, finish_reason, message: { role: "assistant", content } }], usage }`.
`content` must be a string of at most 64 KB. An upstream reply with tool calls,
non-string content or an unknown `finish_reason` (anything other than `stop`,
`length`, `content_filter`) is a 502. No upstream header reaches the client.

| Status | Meaning |
| --- | --- |
| 400 | Invalid JSON or outside the protocol |
| 401 | Missing or invalid token (one indistinguishable response) |
| 404 / 405 | Unknown path / wrong method |
| 413 / 415 | Body over `MENDER_MAX_BODY_BYTES` / content-type is not `application/json` |
| 429 | Per-token rate limit, or gateway at `MENDER_MAX_CONCURRENCY`; always with `Retry-After` |
| 502 / 504 | Upstream failed or answered unexpectedly / upstream timed out. Upstream bodies are never echoed |

Every response carries `cache-control: no-store` and `x-request-id`.

## What the gateway does NOT do

- **No content logging.** One JSON line per request on stdout with exactly:
  `ts`, `request_id`, `token` (name), `model`, `request_bytes`,
  `response_bytes`, `status`, `latency_ms`, `upstream_status`. Never bodies,
  prompts, completions, tokens or `Authorization` headers. `model` is logged
  only after it passed the allow-list, so a client cannot smuggle text into
  the log through it. Startup and shutdown messages go to stderr.
- **No storage.** Nothing is written to disk; the container runs with a
  read-only root filesystem and no volumes. Rate-limit windows and the
  concurrency counter are in memory and vanish on restart.
- **No tools.** Tool and function fields are rejected on the way in, and a
  response containing tool calls is rejected on the way out.
- **No training, no fine-tuning, no analytics.** Requests are used to produce
  one response and are then gone.
- **No proxying to vendors.** See the deny-list in `gateway/server.mjs`.
- **No TLS.** It speaks plain HTTP on loopback; you terminate TLS in front.

## Deploying (Mender-hosted)

Prerequisites: Docker with Compose v2; for the `gpu` profile, an NVIDIA GPU with
the NVIDIA Container Toolkit.

```sh
cd model-service
cp .env.example .env

# 1. Mint a token for the Worker. The plaintext is printed once.
node gateway/token.mjs new worker-prod
#    Put the printed `worker-prod:<hash>` line in MENDER_GATEWAY_TOKENS_SHA256 in .env.

# 2. Download weights once (the only step with internet access).
docker compose --profile weights run --rm fetch-weights            # MENDER_FETCH_TARGET=gpu
#    For the cpu profile: MENDER_FETCH_TARGET=cpu docker compose --profile weights run --rm fetch-weights

# 3. Start ONE profile.
docker compose --profile gpu up -d --build     # vLLM, safetensors weights
docker compose --profile cpu up -d --build     # llama.cpp, GGUF file

# 4. Check.
curl -s http://127.0.0.1:8787/healthz           # {"ok":true,"model":"..."}
```

`/healthz` reports only that the gateway is up; it deliberately does not probe
the inference server. Loading a model takes minutes; until then completions
return 502. Use a real request (with a token) as your readiness check.

Notes:

- Run one of `gpu` / `cpu` at a time; both inference services use the network
  alias `inference`.
- Pin `MENDER_VLLM_IMAGE`, `MENDER_LLAMA_IMAGE` and the Dockerfile base image to
  versions or digests you tested. The defaults are rolling tags.
- If `MENDER_WEIGHTS_DIR` is a host directory, it must be writable by root
  inside the `fetch-weights` container (which runs with all capabilities
  dropped) and readable by the inference container.
- The model is a configurable choice. To change it, change the weights
  (`MENDER_MODEL`, or `MENDER_GGUF_REPO` + `MENDER_GGUF`) and
  `MENDER_MODEL_NAME`, fetch, restart, and update the Worker's
  `MENDER_MODEL_NAME` secret. Re-check the licence and re-run your evaluation.

### Exposing it to the Worker

The compose file publishes the gateway on `127.0.0.1:8787` only. **Do not
expose it to the public internet without at least TLS and the bearer token**,
and add a second control on top. In order of preference:

1. **Cloudflare Tunnel + Access.** Run `cloudflared` on the host pointing at
   `http://127.0.0.1:8787`; protect the hostname with an Access policy that
   requires a service token. No inbound port is opened at all.
2. **Private networking** (WireGuard, a cloud private link) between the caller
   and the host.
3. **Reverse proxy with TLS** (Caddy, nginx) plus mTLS and/or an IP allow-list.

If you terminate TLS in a proxy, make sure the proxy does not log request
bodies and does not cache responses.

### Pointing the Cloudflare Worker at it

Three Worker secrets:

```sh
wrangler secret put MENDER_MODEL_ENDPOINT   # https://model.example.internal/v1   (base URL, ends in /v1)
wrangler secret put MENDER_MODEL_NAME       # same value as MENDER_MODEL_NAME on the gateway
wrangler secret put MENDER_MODEL_API_KEY    # the plaintext token minted in step 1
```

The Worker calls `${MENDER_MODEL_ENDPOINT}/chat/completions` with
`Authorization: Bearer ${MENDER_MODEL_API_KEY}`. Endpoint and model are
configuration; nothing in the product names a specific model.

## Tokens: mint, rotate, revoke

Tokens are 256-bit random values. The gateway stores and compares SHA-256
digests in constant time; the plaintext exists only in the caller's secret
store. (A plain SHA-256 is appropriate because the input is high-entropy random
data, not a password.)

- **Mint:** `node gateway/token.mjs new <name>` prints the token once and the
  `name:hash` entry. Append the entry to `MENDER_GATEWAY_TOKENS_SHA256` and
  restart the gateway (`docker compose --profile gpu up -d gateway`). Use one
  token per caller (`worker-prod`, `worker-staging`, `ci`) so logs and rate
  limits are per caller.
- **Rotate:** mint `worker-prod-2`, add its entry alongside the old one,
  restart the gateway, update the caller's secret, confirm traffic is logged
  under the new name, then remove the old entry and restart again. Both tokens
  work during the overlap.
- **Revoke:** delete the entry and restart. There is no other state to clean up.
- **Re-hash a token you already have:** `node gateway/token.mjs hash <name> < token-file`.

Configuration is read at startup only; every change needs a restart (in-flight
requests are drained on SIGTERM for up to 10 seconds).

## Customer-managed mode

Everything runs inside the customer's environment and **nothing reaches API
Mender**. Options, smallest first:

1. **Ollama or `llama-server` on localhost, no gateway.**

   ```sh
   ollama pull qwen2.5-coder:7b            # example; any open-weight coder model
   # point the CLI at http://127.0.0.1:11434/v1 with model name qwen2.5-coder:7b
   ```

   or `llama-server --model ./model.gguf --alias my-coder --ctx-size 8192 --host 127.0.0.1 --port 8000`
   and point the CLI at `http://127.0.0.1:8000/v1`. Keep the server bound to
   `127.0.0.1`. The server must support `response_format` with `json_schema`.

2. **The `cpu` or `gpu` compose profile**, exactly as above, on the customer's
   box or CI runner; point the CLI at `http://127.0.0.1:8787/v1` with a token
   minted locally. Use this when several people or jobs share one model host:
   it adds authentication, limits and content-free logs.

3. **The gateway without Docker**, in front of any local server:

   ```sh
   MENDER_UPSTREAM_URL=http://127.0.0.1:11434/v1 \
   MENDER_ALLOWED_MODELS=qwen2.5-coder:7b \
   MENDER_GATEWAY_TOKENS_SHA256="dev:<hash>" \
   node gateway/server.mjs
   ```

## Configuration reference (gateway)

| Variable | Default | Notes |
| --- | --- | --- |
| `MENDER_GATEWAY_LISTEN` | `127.0.0.1:8787` | `host:port`. A warning is printed for non-loopback hosts |
| `MENDER_UPSTREAM_URL` | required | http(s) base URL ending in `/v1`. No credentials, query or fragment. Hosted AI providers are refused |
| `MENDER_UPSTREAM_API_KEY` | none | Bearer sent to the inference server |
| `MENDER_GATEWAY_TOKENS_SHA256` | required | `name:sha256hex,...`. No tokens, no start |
| `MENDER_ALLOWED_MODELS` | required | Comma-separated. First entry is reported by `/healthz` |
| `MENDER_MAX_BODY_BYTES` | `65536` | Hard cap on the request body (413) |
| `MENDER_MAX_PROMPT_CHARS` | `49152` | Cap on total message characters (400) |
| `MENDER_MAX_OUTPUT_TOKENS` | `1024` | Upper clamp for `max_tokens` |
| `MENDER_REQUEST_TIMEOUT_MS` | `120000` | Upstream headers + body (504) |
| `MENDER_RATE_LIMIT_PER_MINUTE` | `60` | Per token, fixed one-minute window |
| `MENDER_MAX_CONCURRENCY` | `4` | In-flight requests across all tokens; over it, 429 |

Invalid configuration stops startup with a list of every problem.
`docker-compose.yml` and `.env.example` add deployment variables (images,
weights, model ids).

## Data handled by this service

| | What | Where it exists | Retention |
| --- | --- | --- | --- |
| Input | System prompt; one user message: a JSON document with the API contract diff and a source excerpt of at most 4 KB; the JSON schema for the answer. Under 32 KB in total | Gateway memory for the duration of the request; inference server memory while generating | **None in the gateway.** Inference server: see below |
| Output | One small JSON object describing a line edit or an abstention (about 700 tokens at most) | Same | None in the gateway |
| Metadata | Timestamp, request id, token name, model, byte counts, status, latency, upstream status | stdout, then wherever you ship container logs | Yours to set; contains no content |
| Credentials | SHA-256 of each gateway token; optional upstream key | Process environment | Until you change configuration |
| Weights | Model files | Read-only volume | Until you delete them |

### Retention in the inference server

The gateway keeps nothing, but the inference server is a separate program with
its own logging. Flag names change between releases, so **verify against the
version you pinned**: send a request containing a unique marker string, then
search the inference container's logs and filesystem for it.

- **vLLM.** Request logging (which includes prompt text) must be off. On
  current releases it is opt-in: do not pass `--enable-log-requests` or
  `--enable-log-outputs`. Older releases logged requests by default and need
  `--disable-log-requests`. The compose file also passes `--max-log-len 0`,
  which truncates any logged prompt to nothing, and sets
  `VLLM_NO_USAGE_STATS=1` / `DO_NOT_TRACK=1`.
- **llama.cpp `llama-server`.** Do not run with `-v` / `--verbose` (verbose
  logs contain prompt and completion text); `--log-disable` turns logging off
  entirely. The compose file passes `--no-slots` (the `/slots` endpoint shows
  the prompt held in each slot) and `--no-webui`. Never set
  `--slot-save-path`, which writes prompt caches to disk.
- **Ollama.** Do not set `OLLAMA_DEBUG`; debug logs include prompts.
- **Container logs.** Whatever the server prints ends up in Docker's log
  driver. Keep the inference server's log level at warning or above and set a
  rotation policy.

## Hardware sizing

**Rough operator guidance only. These are estimates to validate on your own
hardware with your own prompts, not measurements or guarantees.** Memory
depends on precision, context length and concurrency; throughput varies widely.

| Model (example) | Serving | Approximate memory | Starting point |
| --- | --- | --- | --- |
| 7B, 16-bit weights | vLLM (`gpu`) | ~15 GB weights + cache | One 24 GB GPU |
| 14B, 16-bit weights | vLLM (`gpu`) | ~30 GB weights + cache | One 48 GB GPU |
| 32B, 16-bit weights | vLLM (`gpu`) | ~65 GB weights + cache | One 80 GB GPU, or a quantised build on 48 GB |
| 7B, Q4_K_M GGUF | llama.cpp (`cpu`) | ~5 GB file, plan 8 GB RAM | 8+ modern cores |
| 14B, Q4_K_M GGUF | llama.cpp (`cpu`) | ~9 GB file, plan 16 GB RAM | 16+ cores, or a GPU build of llama.cpp |

- A request is small (<= 8K tokens of context, <= ~700 output tokens). On a GPU
  expect seconds per request; on CPU expect tens of seconds to minutes, so
  raise `MENDER_REQUEST_TIMEOUT_MS` and lower `MENDER_MAX_CONCURRENCY`
  (start at 1) for the `cpu` profile.
- Set `MENDER_MAX_CONCURRENCY` to what the inference server can batch without
  hitting the timeout; the gateway sheds the rest with 429 + `Retry-After`.
- The gateway itself needs well under 100 MB of RAM and negligible CPU.

## Threat model

| Threat | What limits it | What remains for the operator |
| --- | --- | --- |
| **Stolen gateway token** | Token grants one narrow operation: no tools, no other endpoints, bounded input and output, per-token rate limit. It cannot read other tenants' requests because nothing is stored. Hashes at rest, so a config leak does not leak tokens. Revocation is one config change | Add a network control (tunnel + Access, mTLS, IP allow-list) so a token alone is not enough. One token per caller. Rotate on suspicion; alert on unexpected token names or 401/429 spikes in the log |
| **Prompt injection via the source excerpt** (code comments telling the model to do something else) | The model has **no tools** and no network, so the worst it can do is return a bad JSON edit. Output is schema-constrained, size-capped, and tool calls in a response are rejected. Downstream, the product applies **deterministic patch gates** (editable-line range, policy checks, tests) before any proposal is shown, and treats the model's `reason` as untrusted display text | Keep those gates deterministic and independent of model output. Never add tools to this model |
| **SSRF / exfiltration via upstream configuration** | The upstream URL is static configuration, never client input. Scheme must be http(s); credentials, query and fragment are refused; hosted AI providers are refused at startup; redirects are never followed (`redirect: 'error'`). In compose, the inference network has no egress | The deny-list is a guard against misconfiguration, not a firewall: an IP address or a custom hostname in front of a vendor bypasses it. Control who can set the gateway's environment, and keep the network isolation |
| **Weights supply chain** (tampered or malicious model files) | Weights are downloaded once by a separate container; serving containers are offline (`HF_HUB_OFFLINE=1`, internal network) and mount weights read-only, so nothing is fetched at runtime and a compromised model cannot phone home | Pin `MENDER_MODEL_REVISION` to a commit SHA, prefer safetensors / GGUF over pickle formats, record the checksums `fetch-weights` prints, pin container images by digest, never enable `trust_remote_code` |
| **Noisy neighbour / cross-tenant leakage** | Requests are stateless: no conversation state, no cross-request cache holding content in the gateway, and clients cannot send server-specific cache fields because unknown fields are dropped. Per-token rate limits and a global concurrency cap bound how much one caller can take | Disable prompt caching where the inference server shares it between requests (llama.cpp: `--cache-ram 0` on builds that have it, and no `--slot-save-path`; llama-server reuses a slot's in-memory prompt prefix by default, which does not change outputs but is shared state and a timing side channel). vLLM batches tenants on one GPU: there is no content leakage between sequences, but latency is shared. Run separate instances for tenants that need hard isolation |
| **Operator or host compromise** | Nothing at rest: no prompt or completion is written by the gateway | Whoever controls the host can read memory. In Mender-hosted mode that is Mender; customers who cannot accept that use customer-managed mode |
| **Resource exhaustion** | Auth before body, hard body cap, header and receive timeouts, output token clamp, upstream timeout, concurrency cap. Unauthenticated requests cost one hash | Rate-limit unauthenticated traffic at the edge (tunnel / proxy); the gateway's limiter is per authenticated token |
| **Information leaks from the gateway** | Uniform 401; errors never echo input, upstream bodies or addresses; `/healthz` is static; no upstream headers pass through | Do not add debug logging in front of or behind it |

## The test double (`standin/`): NOT A MODEL

`standin/server.mjs` is a **test double** for the inference server so other
packages can run end-to-end tests where no GPU exists. It has no weights and no
intelligence, reports itself as model `mender-test-double`, listens on
`127.0.0.1` only, and must never be deployed or used to judge patch quality.

- `GET /v1/models` lists `mender-test-double`.
- `POST /v1/chat/completions` reads the last user message (the JSON task
  document) and applies **one** hard-coded rule: for a
  `request-property-removed` change with exactly one removed field `F`, where
  `after` has an array-typed property `Fs`, it rewrites the single line inside
  `editable_lines` that contains the object-literal entry `F: <identifier or
  member chain>` to `Fs: [<expr>]` and returns
  `{"decision":"patch","reason":"...","edits":[{"start_line":L,"end_line":L,"replacement":"..."}]}`.
  In every other case it returns
  `{"decision":"abstain","reason":"test double: no rule for this change","edits":[]}`.
- `STANDIN_SCRIPT=/path/to/script.json` (a JSON array of strings) replaces the
  rule: each request gets the next string verbatim as `content`, so security
  tests can make the "model" misbehave. After the last one it abstains. See
  `standin/fixtures/script.example.json`.
- `STANDIN_PORT` (default `8799`).

```js
import { createStandin } from '../model-service/standin/server.mjs';
import { createGateway, loadConfig } from '../model-service/gateway/server.mjs';
import { hashToken } from '../model-service/gateway/token.mjs';

const standin = createStandin();                      // or createStandin({ script: ['not json'] })
await new Promise((r) => standin.listen(0, '127.0.0.1', r));
const upstream = `http://127.0.0.1:${standin.address().port}/v1`;

const gateway = createGateway(
  loadConfig({
    MENDER_UPSTREAM_URL: upstream,
    MENDER_ALLOWED_MODELS: 'mender-test-double',
    MENDER_GATEWAY_TOKENS_SHA256: `test:${hashToken('test-token')}`,
  }),
  { log: () => {} },                                  // optional: silence request logs
);
await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
const endpoint = `http://127.0.0.1:${gateway.address().port}/v1`;
// ... standin.requests holds every body the double received ...
gateway.close(); standin.close();
```

## Tests

```sh
node --test model-service/      # from the repository root
npm test                        # from model-service/
```

Zero dependencies; nothing to install. The suite starts a fake upstream and a
real gateway on ephemeral ports and covers the request allow-list, every
rejection, authentication, limits, upstream failure mapping, the provider
deny-list, log hygiene and graceful shutdown. It does not start Docker, a GPU
or a real model.
