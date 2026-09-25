import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { discover } from './core';

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const branchPattern = /^[A-Za-z0-9_./-]{1,120}$/;

async function githubJson(url: string) {
  const response = await fetch(url, {
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'api-mender-scanner' },
    cache: 'no-store', signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`GitHub API returned ${response.status}`);
  return response.json();
}

export async function scanPublicRepository(fullName: string, branch: string) {
  if (!repositoryPattern.test(fullName) || !branchPattern.test(branch) || branch.includes('..')) throw new Error('Invalid repository or branch');
  const repoPath = fullName.split('/').map(encodeURIComponent).join('/');
  const repo = await githubJson(`https://api.github.com/repos/${repoPath}`);
  if (repo.private || repo.archived) throw new Error('Only active public repositories can be scanned without a GitHub App');
  const branchInfo = await githubJson(`https://api.github.com/repos/${repoPath}/branches/${encodeURIComponent(branch)}`);
  const head = branchInfo.commit?.sha as string;
  if (!/^[a-f0-9]{40}$/.test(head)) throw new Error('Invalid GitHub commit');
  const commit = await githubJson(`https://api.github.com/repos/${repoPath}/git/commits/${head}`);
  const tree = await githubJson(`https://api.github.com/repos/${repoPath}/git/trees/${commit.tree.sha}?recursive=1`);
  if (tree.truncated) throw new Error('GitHub tree was truncated');
  const eligible = (tree.tree as { path: string; type: string; mode: string; size: number }[]).filter(file =>
    file.type === 'blob' && file.mode === '100644' && file.size <= 300_000 &&
    /^(package(-lock)?\.json|[^/].*\.[cm]?[jt]sx?)$/.test(file.path) &&
    !/(^|\/)(node_modules|dist|\.next|vendor)\//.test(file.path) &&
    !file.path.split('/').some(part => part === '..' || part === '.')
  );
  if (eligible.length > 80 || eligible.reduce((sum, file) => sum + file.size, 0) > 5_000_000) throw new Error('Repository exceeds the bounded public scanner limit');
  const root = mkdtempSync(join(tmpdir(), 'api-mender-scan-'));
  try {
    for (let offset = 0; offset < eligible.length; offset += 8) await Promise.all(eligible.slice(offset, offset + 8).map(async file => {
      const target = resolve(root, file.path);
      if (!target.startsWith(root + '/')) throw new Error('Unsafe repository path');
      const raw = `https://raw.githubusercontent.com/${repoPath}/${head}/${file.path.split('/').map(encodeURIComponent).join('/')}`;
      const response = await fetch(raw, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`GitHub file fetch returned ${response.status}`);
      const body = Buffer.from(await response.arrayBuffer());
      if (body.byteLength > file.size + 1024 || body.byteLength > 300_000) throw new Error('GitHub file exceeded size limit');
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, body);
    }));
    const found = discover(root);
    return { head, inventory: found, scannedAt: new Date().toISOString(), fingerprint: createHash('sha256').update(`${fullName}:${head}`).digest('hex') };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
