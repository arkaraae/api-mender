import { rulesFromOpenApi, proveWithSchemas } from './mender/openapi.js';
import { summarize } from './mender/report.js';

const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const pathPattern = /^[A-Za-z0-9_./-]+\.json$/;
const maxBytes = 512_000;

function validPath(path: string) {
  return path.length <= 256 && pathPattern.test(path) && !path.startsWith('/') && !path.split('/').some(part => part === '.' || part === '..');
}

export async function readGitHubContract(fullName: string, head: string, path: string, token: string) {
  if (!repoPattern.test(fullName) || !/^[a-f0-9]{40}$/.test(head) || !validPath(path) || !token) throw new Error('Invalid contract source');
  const repo = fullName.split('/').map(encodeURIComponent).join('/');
  const filename = path.split('/').map(encodeURIComponent).join('/');
  const response = await fetch(`https://api.github.com/repos/${repo}/contents/${filename}?ref=${head}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'api-mender-contract' },
    redirect: 'error', signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`GitHub contract fetch failed (${response.status})`);
  const file = await response.json() as { type?: unknown; encoding?: unknown; size?: unknown; content?: unknown };
  if (file.type !== 'file' || file.encoding !== 'base64' || typeof file.content !== 'string'
    || typeof file.size !== 'number' || file.size > maxBytes) throw new Error('Contract must be a JSON file under 512 KB');
  const bytes = Uint8Array.from(atob(file.content.replace(/\s/g, '')), char => char.charCodeAt(0));
  if (bytes.byteLength !== file.size || bytes.byteLength > maxBytes) throw new Error('Contract body was incomplete');
  const document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!document || typeof document !== 'object' || Array.isArray(document)
    || typeof document.openapi !== 'string' || !/^3\.(0|1)\./.test(document.openapi)
    || !document.paths || typeof document.paths !== 'object' || Array.isArray(document.paths)) throw new Error('Only OpenAPI 3.0/3.1 JSON documents are supported');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return { document, sha256: Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('') };
}

export function compareContracts(before: object, after: object) {
  const found = rulesFromOpenApi(before, after);
  const sampleProof = proveWithSchemas(before, after, found.rules);
  const report = summarize({ found, proof: sampleProof });
  return {
    verdict: report.verdict as 'safe' | 'bridged' | 'breaks',
    headline: String(report.headline),
    counts: report.counts,
    changes: report.items.map((item: { rule: string; title: string; severity: string; fields: string[] }) => ({
      rule: item.rule, title: item.title, severity: item.severity, fields: item.fields,
    })).slice(0, 50),
    notes: report.attention.map((note: { rule: string; message: string; severity: string }) => ({
      rule: note.rule, message: note.message, severity: note.severity,
    })).slice(0, 50),
    sampleProof: { ok: sampleProof.ok, samples: sampleProof.samples },
  };
}
