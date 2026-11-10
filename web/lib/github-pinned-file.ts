// Read one repository file at an exact commit with a repository-scoped
// installation token, after checking the branch still points at that commit.
// The file content is used in memory for one request and never stored.
const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'api-mender-repair' };
const sha = /^[a-f0-9]{40}$/;

export class StaleBranchError extends Error {}

export async function readPinnedFile(input: { token: string; fullName: string; branch: string; baseSha: string; file: string }) {
  const { token, fullName, branch, baseSha, file } = input;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName) || !sha.test(baseSha)
    || !/^[A-Za-z0-9_./-]{1,120}$/.test(branch) || branch.includes('..')
    || !/^[A-Za-z0-9_./-]+\.(?:m?js|c?js|tsx?)$/.test(file) || file.startsWith('/')
    || file.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid file reference');
  const repo = fullName.split('/').map(encodeURIComponent).join('/');
  const get = (url: string) => fetch(url, { headers: { ...headers, Authorization: `Bearer ${token}` },
    redirect: 'manual', signal: AbortSignal.timeout(15_000) });
  const branchResponse = await get(`https://api.github.com/repos/${repo}/branches/${encodeURIComponent(branch)}`);
  if (!branchResponse.ok) throw new Error('Could not verify the current branch');
  const head = await branchResponse.json() as { commit?: { sha?: string } };
  if (head.commit?.sha !== baseSha) throw new StaleBranchError('The branch moved; rescan its latest commit first');
  const response = await get(`https://api.github.com/repos/${repo}/contents/${file.split('/').map(encodeURIComponent).join('/')}?ref=${baseSha}`);
  if (!response.ok) throw new Error('GitHub could not read the pinned file');
  const body = await response.json() as { type?: unknown; encoding?: unknown; size?: unknown; content?: unknown; sha?: unknown };
  if (body.type !== 'file' || body.encoding !== 'base64' || typeof body.size !== 'number' || body.size > 300_000
    || typeof body.content !== 'string' || typeof body.sha !== 'string' || !sha.test(body.sha))
    throw new Error('The file is unsupported or too large');
  const bytes = Uint8Array.from(atob(body.content.replace(/\s/g, '')), char => char.charCodeAt(0));
  if (bytes.byteLength !== body.size) throw new Error('The file was incomplete');
  return { source: new TextDecoder('utf-8', { fatal: true }).decode(bytes), blobSha: body.sha };
}
