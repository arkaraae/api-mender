# API Mender for coding agents (MCP)

Lets Claude Code, Cursor, VS Code and other MCP clients ask API Mender which external APIs a codebase
calls, which provider changes break those calls, and whether a fix is safe.

Everything runs on your machine. Your source code is read locally and never sent anywhere; the only
network requests download providers' public API contracts.

## Tools

| Tool | What it does |
|---|---|
| `scan_apis` | Every external API the code calls (fetch, axios, requests, httpx, and the GitHub, Stripe, OpenAI and Twilio SDKs) with each call site. JavaScript, TypeScript and Python. |
| `check_breaking_changes` | Compares the provider versions the code uses with the newest published contracts and reports the calls a change breaks: the change, the file and line, the evidence, what is not established, and, when a bounded fix exists, exactly which lines may change and what the request must look like. |
| `validate_fix` | After your agent edits the code for a finding, checks the edit with Mend's repair gates: only that call changed, it parses, values are kept, no new capabilities or secrets, and the request satisfies the new contract. |

Ask your agent things like *"what APIs does this repo call?"*, *"is anything about to break?"*, or
*"fix the GitHub finding and validate it"*.

## Install

Requires Node.js 22.18 or newer.

**Claude Code**
```bash
claude mcp add mender -- npx -y @apimender/mcp
```

**Cursor** (`~/.cursor/mcp.json`) and **VS Code** (`.vscode/mcp.json`, key `servers`)
```json
{ "mcpServers": { "mender": { "command": "npx", "args": ["-y", "@apimender/mcp"] } } }
```

**Before the npm package is published**, run it from a clone:
```bash
git clone --depth 1 https://github.com/arkaraae/api-mender.git ~/api-mender-mcp
cd ~/api-mender-mcp/web && npm ci && cd ../mcp && npm ci && npm run build
claude mcp add mender -- node ~/api-mender-mcp/mcp/bin/mender-mcp.mjs
```

## Limits

- Provider changes are checked for GitHub, Stripe, OpenAI and Twilio. Other APIs are listed by `scan_apis`;
  connect the repository at [apimender.com](https://apimender.com) to watch APIs Mend discovers automatically.
- Static analysis: a finding shows where a provider change reaches the code. Run your tests after a fix.
- Calls whose URL comes from the environment or another file are not seen.
