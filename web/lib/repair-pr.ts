const sha = /^[a-f0-9]{40}$/;
const repoName = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const repairBranch = /^mender\/repair-[a-f0-9-]{36}$/;
const sourcePath = /^[A-Za-z0-9_./-]+\.(?:m?js|c?js|tsx?)$/;
const githubHeaders = { Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'api-mender-repair' };
async function sha256(value: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

type PublishInput = {
  token: string; fullName: string; baseBranch: string; baseSha: string;
  jobId: string; file: string; source: string; patchedSource: string;
  sourceSha256: string; patchedSha256: string; blobSha: string;
  generationMethod?: string; modelId?: string | null;
};

function pathSegments(value: string) { return value.split('/').map(encodeURIComponent).join('/'); }

async function github(url: string, token: string, init: RequestInit = {}) {
  const response = await fetch(url, {
    ...init, redirect: 'manual', signal: AbortSignal.timeout(15_000),
    headers: { ...githubHeaders, Authorization: `Bearer ${token}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
  });
  return response;
}

function b64(source: string) {
  const bytes = new TextEncoder().encode(source);
  if (bytes.byteLength > 64_000) throw new Error('Patched file exceeds the 64 KB limit');
  let binary = '';
  for (let offset = 0; offset < bytes.byteLength; offset += 8192)
    binary += String.fromCharCode(...bytes.slice(offset, offset + 8192));
  return btoa(binary);
}

function validPr(value: any, owner: string, branch: string, base: string, patchSha: string) {
  return Number.isSafeInteger(value?.number) && value.number > 0 && value.draft === true
    && value.head?.ref === branch && value.head?.sha === patchSha && value.base?.ref === base
    && value.html_url === `https://github.com/${owner}/pull/${value.number}`;
}

/** Create only a draft PR on a deterministic branch. The customer must prove it in CI. */
export async function publishDraftRepair(input: PublishInput) {
  if (!repoName.test(input.fullName)
    || input.fullName.split('/').some(part => part === '.' || part === '..')
    || !repairBranch.test(`mender/repair-${input.jobId}`)
    || !sha.test(input.baseSha) || !sha.test(input.blobSha)
    || !sourcePath.test(input.file) || input.file.length > 512 || input.file.startsWith('/')
    || input.file.split('/').some(part => !part || part === '.' || part === '..')
    || !/^[A-Za-z0-9_./-]{1,120}$/.test(input.baseBranch)
    || input.baseBranch.split('/').some(part => !part || part === '.' || part === '..')
    || !/^[a-f0-9]{64}$/.test(input.sourceSha256)
    || !/^[a-f0-9]{64}$/.test(input.patchedSha256)) throw new Error('Invalid repair publication context');
  if (await sha256(input.source) !== input.sourceSha256
    || await sha256(input.patchedSource) !== input.patchedSha256
    || input.source === input.patchedSource) throw new Error('Repair content does not match its saved hashes');
  const content = b64(input.patchedSource);
  const encodedRepo = pathSegments(input.fullName);
  const root = `https://api.github.com/repos/${encodedRepo}`;
  const branch = `mender/repair-${input.jobId}`;
  const branchPath = pathSegments(branch);
  let patchSha: string | null = null;

  const create = await github(`${root}/git/refs`, input.token, {
    method: 'POST', body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: input.baseSha }),
  });
  if (create.status !== 201 && create.status !== 422)
    throw new Error(`Could not create repair branch (${create.status})`);
  if (create.status === 422) {
    const existing = await github(`${root}/git/ref/heads/${branchPath}`, input.token);
    if (!existing.ok) throw new Error('Repair branch already exists but cannot be verified');
    const ref = await existing.json() as { object?: { sha?: unknown } };
    if (ref.object?.sha !== input.baseSha) {
      const file = await github(`${root}/contents/${pathSegments(input.file)}?ref=${encodeURIComponent(branch)}`, input.token);
      if (!file.ok) throw new Error('Repair branch contains an unexpected commit');
      const saved = await file.json() as { type?: unknown; encoding?: unknown; size?: unknown; content?: unknown };
      if (saved.type !== 'file' || saved.encoding !== 'base64' || typeof saved.size !== 'number'
        || saved.size > 64_000 || typeof saved.content !== 'string')
        throw new Error('Repair branch contains an unsupported file');
      const bytes = Uint8Array.from(atob(saved.content.replace(/\s/g, '')), char => char.charCodeAt(0));
      if (bytes.byteLength !== saved.size || await sha256(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) !== input.patchedSha256)
        throw new Error('Repair branch differs from the saved proposal');
      const existingSha = ref.object?.sha;
      if (typeof existingSha !== 'string' || !sha.test(existingSha)) throw new Error('Repair branch commit is invalid');
      const commitResponse = await github(`${root}/commits/${existingSha}`, input.token);
      if (!commitResponse.ok) throw new Error('Could not verify the repair branch commit');
      const commit = await commitResponse.json() as {
        parents?: { sha?: string }[]; files?: { filename?: string; status?: string }[];
      };
      if (commit.parents?.length !== 1 || commit.parents[0].sha !== input.baseSha
        || commit.files?.length !== 1 || commit.files[0].filename !== input.file
        || commit.files[0].status !== 'modified')
        throw new Error('Repair branch includes changes outside the saved proposal');
      patchSha = existingSha;
    }
  }

  if (!patchSha) {
    const update = await github(`${root}/contents/${pathSegments(input.file)}`, input.token, {
      method: 'PUT', body: JSON.stringify({ message: `Mender: repair API request (${input.jobId})`,
        content, sha: input.blobSha, branch }),
    });
    if (!update.ok) throw new Error(`Could not write repair branch (${update.status})`);
    const written = await update.json() as { commit?: { sha?: unknown } };
    if (typeof written.commit?.sha !== 'string' || !sha.test(written.commit.sha))
      throw new Error('GitHub did not return the repair commit');
    patchSha = written.commit.sha;
  }

  const title = `Mender: update API request for ${input.file}`.slice(0, 120);
  const body = `This draft changes one request field in \`${input.file}\` for repair job \`${input.jobId}\`.\n\n`
    + `Pinned consumer base: \`${input.baseSha}\`. Patched file SHA-256: \`${input.patchedSha256}\`.\n\n`
    + (input.generationMethod === 'ai_assisted'
      ? `**AI-assisted:** ${input.modelId ? `\`${input.modelId}\`` : 'An AI model'} chose which existing request field maps to the new required field, using only the operation and field names. Mender's bounded repair engine wrote the edit. Check this mapping first.\n\n`
      : '')
    + '**Unverified:** customer CI must show the old request failing and the patched request passing. Review semantics before merging. Mender never merges this PR automatically.';
  const opened = await github(`${root}/pulls`, input.token, {
    method: 'POST', body: JSON.stringify({ title, head: branch, base: input.baseBranch, body, draft: true }),
  });
  let pull: any;
  if (opened.status === 201) pull = await opened.json();
  else if (opened.status === 422) {
    const [owner] = input.fullName.split('/');
    const list = await github(`${root}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&base=${encodeURIComponent(input.baseBranch)}&per_page=10`, input.token);
    if (!list.ok) throw new Error('Could not verify existing repair pull request');
    const pulls = await list.json() as any[];
    pull = pulls.find(item => validPr(item, input.fullName, branch, input.baseBranch, patchSha!));
    if (!pull) throw new Error('A different pull request already exists for this repair branch');
  } else throw new Error(`Could not open draft repair pull request (${opened.status})`);
  if (!validPr(pull, input.fullName, branch, input.baseBranch, patchSha))
    throw new Error('GitHub returned an unexpected repair pull request');
  return { prNumber: pull.number as number, prUrl: pull.html_url as string,
    patchBranch: branch, patchSha };
}
