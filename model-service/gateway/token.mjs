#!/usr/bin/env node
// Token helper for the API Mender model gateway.
//
//   node token.mjs new <name>     mint a token; prints it ONCE plus the
//                                 `name:sha256` entry to configure
//   node token.mjs hash <name>    read an existing token on stdin and print
//                                 its `name:sha256` entry (nothing is echoed)
//
// The gateway only ever stores SHA-256 digests. A fast hash is appropriate
// here because tokens are 256 bits of CSPRNG output, not human passwords:
// there is nothing to brute-force, so a slow KDF would only add latency.

import { createHash, randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** SHA-256 of a token, lower-case hex: the form MENDER_GATEWAY_TOKENS_SHA256 expects. */
export function hashToken(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** A fresh random bearer token (256 bits, URL-safe, `mnd_` prefix for secret scanners). */
export function newToken() {
  return `mnd_${randomBytes(32).toString('base64url')}`;
}

/** The `name:hash` entry for MENDER_GATEWAY_TOKENS_SHA256. */
export function tokenEntry(name, token) {
  if (!NAME_RE.test(name)) throw new Error(`token name must match ${NAME_RE}`);
  return `${name}:${hashToken(token)}`;
}

async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data.trim();
}

function usage() {
  process.stderr.write('usage: node token.mjs new <name>\n       node token.mjs hash <name> < token-file\n');
  process.exit(2);
}

async function main() {
  const [command, name] = process.argv.slice(2);
  if (!name || !NAME_RE.test(name)) usage();
  if (command === 'new') {
    const token = newToken();
    process.stdout.write(
      [
        `Token for "${name}" (shown once; store it in the caller's secret store):`,
        '',
        `  ${token}`,
        '',
        'Add this entry to MENDER_GATEWAY_TOKENS_SHA256 (comma-separated) and restart the gateway:',
        '',
        `  ${tokenEntry(name, token)}`,
        '',
      ].join('\n'),
    );
  } else if (command === 'hash') {
    const token = await readStdin();
    if (!token) usage();
    process.stdout.write(`${tokenEntry(name, token)}\n`);
  } else {
    usage();
  }
}

function isExecutedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isExecutedDirectly()) await main();
