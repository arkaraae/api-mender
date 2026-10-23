type GithubAppConfig = { appId: string; privateKey: string };

const encoder = new TextEncoder();
const apiHeaders = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'api-mender-app' };
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function readBoundedBody(request: Request, limit = 1_000_000) {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw new Error('Payload too large'); }
    chunks.push(value);
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

export async function verifyWebhookSignature(body: Uint8Array, signature: string | null, secret: string) {
  if (!/^sha256=[a-f0-9]{64}$/.test(signature || '') || !secret) return false;
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signedBody = new Uint8Array(body.byteLength);
  signedBody.set(body);
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, signedBody.buffer));
  const expected = `sha256=${Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')}`;
  let difference = 0;
  for (let index = 0; index < expected.length; index++) difference |= expected.charCodeAt(index) ^ (signature || '').charCodeAt(index);
  return difference === 0;
}

export function parsePushEvent(event: string | null, payload: unknown) {
  if (event !== 'push' || !payload || typeof payload !== 'object') return null;
  const data = payload as Record<string, any>;
  const installationId = data.installation?.id;
  const repositoryId = data.repository?.id;
  const defaultBranch = data.repository?.default_branch;
  const head = data.after;
  if (!Number.isSafeInteger(installationId) || installationId <= 0 || !Number.isSafeInteger(repositoryId) || repositoryId <= 0) return null;
  if (typeof defaultBranch !== 'string' || data.ref !== `refs/heads/${defaultBranch}` || data.deleted === true) return null;
  if (typeof head !== 'string' || !/^[a-f0-9]{40}$/.test(head)) return null;
  return { installationId, repositoryId, head };
}

export async function githubAppJwt(config: GithubAppConfig) {
  if (!/^\d+$/.test(config.appId)) throw new Error('GitHub App ID is not configured');
  const pem = config.privateKey.replace(/\\n/g, '\n').replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, '');
  const der = Uint8Array.from(atob(pem), char => char.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(encoder.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const body = base64url(encoder.encode(JSON.stringify({ iat: now - 60, exp: now + 540, iss: config.appId })));
  const unsigned = `${header}.${body}`;
  const signature = base64url(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(unsigned))));
  return `${unsigned}.${signature}`;
}

export async function installationToken(config: GithubAppConfig, installationId: number, repository: number | string) {
  if (!Number.isSafeInteger(installationId) || installationId <= 0) throw new Error('Invalid GitHub installation');
  const scope = typeof repository === 'number'
    ? Number.isSafeInteger(repository) && repository > 0 ? { repository_ids: [repository] } : null
    : /^[A-Za-z0-9_.-]+$/.test(repository) ? { repositories: [repository] } : null;
  if (!scope) throw new Error('Invalid GitHub repository');
  const jwt = await githubAppJwt(config);
  const response = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers: { ...apiHeaders, Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...scope, permissions: { contents: 'read' } }),
  });
  if (!response.ok) throw new Error(`GitHub installation token failed (${response.status})`);
  const result = await response.json() as { token?: unknown; expires_at?: unknown };
  if (typeof result.token !== 'string' || typeof result.expires_at !== 'string') throw new Error('GitHub installation token was incomplete');
  return result.token;
}
