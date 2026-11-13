// The MCP server: four tools over stdio for coding agents (Claude Code,
// Cursor, VS Code, and any other MCP client).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { checkBreakingChanges, scanApis, validateFix } from './tools.mjs';

export const VERSION = '0.1.0';

const asResult = async work => {
  try {
    const value = await work();
    return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: String(error?.message ?? error).slice(0, 2000) }] };
  }
};

export function createServer() {
  const server = new McpServer({ name: 'api-mender', version: VERSION }, {
    instructions: [
      'API Mender finds the external APIs a codebase calls and the provider changes that break those calls.',
      'Use scan_apis to list the APIs and call sites; check_breaking_changes for provider changes that affect this code;',
      'after editing code for a finding, validate_fix to check the edit. Everything runs locally: source code never leaves this machine.',
    ].join(' '),
  });
  const pathField = z.string().optional().describe('Repository root. Defaults to the current working directory.');

  server.registerTool('scan_apis', {
    title: 'List the APIs this code calls',
    description: 'Scan a repository (JavaScript, TypeScript, Python) for external API calls: fetch, axios, requests, httpx, and the GitHub, Stripe, OpenAI and Twilio SDKs. Returns each service, its operations and every call site.',
    inputSchema: { path: pathField },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ path }) => asResult(() => scanApis({ path })));

  server.registerTool('check_breaking_changes', {
    title: 'Find provider changes that break this code',
    description: 'Compare the provider API versions this code uses with the newest published contracts (GitHub, Stripe, OpenAI, Twilio) and report calls a change breaks, with evidence and, when possible, the exact bounds for a fix. Downloads only public API contracts.',
    inputSchema: {
      path: pathField,
      provider: z.enum(['github-rest', 'stripe', 'openai', 'twilio']).optional().describe('Check only this provider.'),
      offline: z.boolean().optional().describe('Use only contracts already cached; no network.'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, ({ path, provider, offline }) => asResult(() => checkBreakingChanges({ path, provider, offline })));

  server.registerTool('validate_fix', {
    title: 'Check a fix against Mend\'s repair gates',
    description: 'After editing the file for a finding from check_breaking_changes, check the edit: only the call changed, it still parses, existing values are kept, no new capabilities or secrets, and the request now satisfies the new contract.',
    inputSchema: { findingId: z.string().describe('The finding id from check_breaking_changes.') },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ findingId }) => asResult(() => validateFix({ findingId })));

  return server;
}

export async function main() {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}
