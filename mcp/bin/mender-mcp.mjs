#!/usr/bin/env node
// API Mender MCP server (stdio). Add it to a coding agent, for example:
//   claude mcp add mender -- npx -y @apimender/mcp
import { existsSync } from 'node:fs';

const bundled = new URL('../dist/mender-mcp.mjs', import.meta.url);
const { main } = existsSync(bundled) ? await import(bundled.href) : await import('../src/server.mjs');
main().catch(error => {
  // stdout carries the protocol; diagnostics go to stderr.
  console.error(`mender-mcp: ${error?.message ?? error}`);
  process.exit(1);
});
