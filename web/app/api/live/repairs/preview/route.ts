import { env } from 'cloudflare:workers';
import { authenticatedEditor, githubHeaders, onboardingDatabase, uuid } from '@/lib/github-onboarding';
import { installationToken, readBoundedBody } from '@/lib/github-app';
import { proposeRequestFieldRepair } from '@/lib/request-repair';

const noStore = { 'Cache-Control': 'no-store' };
const sourcePath = /^[A-Za-z0-9_./-]+\.(?:m?js|c?js|tsx?)$/;

export async function POST(request: Request) {
  let body: { workspaceId?: unknown; findingId?: unknown } | null;
  try {
    body = JSON.parse(new TextDecoder().decode(await readBoundedBody(request, 2048)));
  } catch { return Response.json({ error: 'Invalid request' }, { status: 400, headers: noStore }); }
  if (!body || Object.keys(body).sort().join(',') !== 'findingId,workspaceId'
    || typeof body.workspaceId !== 'string' || !uuid.test(body.workspaceId)
    || typeof body.findingId !== 'string' || !uuid.test(body.findingId))
    return Response.json({ error: 'Invalid repair request' }, { status: 400, headers: noStore });
  const identity = await authenticatedEditor(request, body.workspaceId);
  if (!identity) return Response.json({ error: 'Workspace editor sign-in required' }, { status: 403, headers: noStore });
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY)
    return Response.json({ error: 'GitHub scanning is not configured' }, { status: 503, headers: noStore });
  const database = onboardingDatabase();
  const { data: finding, error: findingError } = await database.from('findings')
    .select('id,workspace_id,repository_id,base_sha,evidence').eq('id', body.findingId)
    .eq('workspace_id', body.workspaceId).maybeSingle();
  if (findingError) return Response.json({ error: 'Could not load finding' }, { status: 502, headers: noStore });
  const evidence = finding?.evidence as Record<string, any> | undefined;
  const call = evidence?.call;
  if (!finding || evidence?.kind !== 'request-schema-mismatch'
    || typeof evidence.sourceId !== 'string' || !uuid.test(evidence.sourceId)
    || typeof evidence.contractSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(evidence.contractSha256)
    || !Array.isArray(evidence.missing) || evidence.missing.length !== 1
    || !call || typeof call.file !== 'string' || !sourcePath.test(call.file)
    || call.file.startsWith('/') || call.file.split('/').some((part: string) => part === '.' || part === '..'))
    return Response.json({ error: 'This finding cannot produce a bounded repair' }, { status: 422, headers: noStore });
  const { data: repository, error: repoError } = await database.from('monitored_repositories')
    .select('id,workspace_id,full_name,branch,github_repo_id,github_installation_id,head_sha,target_sha,paused')
    .eq('id', finding.repository_id).eq('workspace_id', body.workspaceId).maybeSingle();
  if (repoError || !repository || repository.paused || !repository.github_installation_id
    || !repository.github_repo_id || !repository.head_sha || repository.head_sha !== repository.target_sha
    || finding.base_sha !== repository.head_sha)
    return Response.json({ error: 'The consumer scan is stale; scan the current commit first' }, { status: 409, headers: noStore });
  const { data: source, error: sourceError } = await database.from('api_contract_sources')
    .select('id,workspace_id,repository_id,paused').eq('id', evidence.sourceId)
    .eq('workspace_id', body.workspaceId).maybeSingle();
  if (sourceError || !source || source.paused)
    return Response.json({ error: 'Connected API source is unavailable' }, { status: 409, headers: noStore });
  const { data: binding, error: bindingError } = await database.from('api_contract_consumers')
    .select('id,paused').eq('workspace_id', body.workspaceId).eq('source_id', source.id)
    .eq('repository_id', repository.id).maybeSingle();
  if (bindingError || !binding || binding.paused)
    return Response.json({ error: 'This repository is no longer connected to the API source' },
      { status: 409, headers: noStore });
  const { data: sourceRepository, error: sourceRepoError } = await database.from('monitored_repositories')
    .select('head_sha,target_sha,paused').eq('id', source.repository_id)
    .eq('workspace_id', body.workspaceId).maybeSingle();
  if (sourceRepoError || !sourceRepository || sourceRepository.paused || !sourceRepository.head_sha
    || sourceRepository.head_sha !== sourceRepository.target_sha)
    return Response.json({ error: 'The API contract scan is stale' }, { status: 409, headers: noStore });
  const { data: version, error: versionError } = await database.from('api_contract_versions')
    .select('document,content_sha256').eq('source_id', source.id)
    .eq('head_sha', sourceRepository.head_sha).maybeSingle();
  if (versionError || !version || version.content_sha256 !== evidence.contractSha256)
    return Response.json({ error: 'The finding refers to an older API contract' }, { status: 409, headers: noStore });
  try {
    const token = await installationToken({ appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_APP_PRIVATE_KEY }, Number(repository.github_installation_id), Number(repository.github_repo_id));
    const repo = repository.full_name.split('/').map(encodeURIComponent).join('/');
    const branchResponse = await fetch(`https://api.github.com/repos/${repo}/branches/${encodeURIComponent(repository.branch)}`, {
      headers: { ...githubHeaders, Authorization: `Bearer ${token}` },
      redirect: 'error', signal: AbortSignal.timeout(15_000),
    });
    if (!branchResponse.ok) throw new Error('Could not verify the current consumer branch');
    const branch = await branchResponse.json() as { commit?: { sha?: string } };
    if (branch.commit?.sha !== repository.head_sha)
      return Response.json({ error: 'The consumer branch moved; scan its latest commit first' },
        { status: 409, headers: noStore });
    const path = call.file.split('/').map(encodeURIComponent).join('/');
    const response = await fetch(`https://api.github.com/repos/${repo}/contents/${path}?ref=${repository.head_sha}`, {
      headers: { ...githubHeaders, Authorization: `Bearer ${token}` },
      redirect: 'error', signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error('GitHub could not read the pinned consumer file');
    const file = await response.json() as { type?: unknown; encoding?: unknown; size?: unknown; content?: unknown };
    if (file.type !== 'file' || file.encoding !== 'base64' || typeof file.size !== 'number'
      || file.size > 64_000 || typeof file.content !== 'string') throw new Error('Consumer file is unsupported or too large');
    const bytes = Uint8Array.from(atob(file.content.replace(/\s/g, '')), char => char.charCodeAt(0));
    if (bytes.byteLength !== file.size) throw new Error('Consumer file was incomplete');
    const proposal = proposeRequestFieldRepair({
      source: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      evidence: call, contract: version.document, missing: evidence.missing,
    });
    return Response.json({ findingId: finding.id, repository: repository.full_name,
      baseSha: repository.head_sha, contractSha256: version.content_sha256,
      file: proposal.file, line: proposal.line, oldField: proposal.oldField,
      newField: proposal.newField, before: proposal.before, after: proposal.after,
      validation: 'static_only', runtimeVerified: false, note: proposal.note }, { headers: noStore });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Could not prepare repair' },
      { status: 422, headers: noStore });
  }
}
