import { env } from 'cloudflare:workers';
import { authenticatedEditor, githubHeaders, onboardingDatabase, uuid } from '@/lib/github-onboarding';
import { installationToken, readBoundedBody } from '@/lib/github-app';
import { proofWorkflowPath, proofWorkflowStructurePresent, renderCustomerProofWorkflow } from '@/lib/customer-proof-setup';

const noStore = { 'Cache-Control': 'no-store' };

export async function POST(request: Request) {
  let body: { workspaceId?: unknown; repositoryId?: unknown;
    testCommand?: unknown; expectedBeforeOutput?: unknown } | null;
  try { body = JSON.parse(new TextDecoder().decode(await readBoundedBody(request, 2048))); }
  catch { return Response.json({ error: 'Invalid request' }, { status: 400, headers: noStore }); }
  if (!body || !['repositoryId,workspaceId', 'expectedBeforeOutput,repositoryId,testCommand,workspaceId']
    .includes(Object.keys(body).sort().join(','))
    || typeof body.workspaceId !== 'string' || !uuid.test(body.workspaceId)
    || typeof body.repositoryId !== 'string' || !uuid.test(body.repositoryId))
    return Response.json({ error: 'Invalid proof setup request' }, { status: 400, headers: noStore });
  if (!await authenticatedEditor(request, body.workspaceId))
    return Response.json({ error: 'Workspace editor sign-in required' }, { status: 403, headers: noStore });
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY)
    return Response.json({ error: 'GitHub App is not configured' }, { status: 503, headers: noStore });
  let workflow: string | undefined;
  try {
    if (body.testCommand !== undefined)
      workflow = renderCustomerProofWorkflow(body.testCommand, body.expectedBeforeOutput);
  } catch (cause) {
    return Response.json({ error: cause instanceof Error ? cause.message : 'Invalid proof inputs' },
      { status: 400, headers: noStore });
  }
  const database = onboardingDatabase();
  const { data: repository, error: repoError } = await database.from('monitored_repositories')
    .select('full_name,branch,github_repo_id,github_installation_id,paused')
    .eq('id', body.repositoryId).eq('workspace_id', body.workspaceId).maybeSingle();
  if (repoError || !repository || repository.paused || !repository.github_repo_id || !repository.github_installation_id)
    return Response.json({ error: 'Connected repository is unavailable' }, { status: 409, headers: noStore });
  const { data: installation, error: installationError } = await database.from('github_installations')
    .select('workspace_id,suspended_at').eq('installation_id', repository.github_installation_id).maybeSingle();
  if (installationError || !installation || installation.workspace_id !== body.workspaceId || installation.suspended_at)
    return Response.json({ error: 'GitHub installation is unavailable' }, { status: 409, headers: noStore });
  try {
    const token = await installationToken({ appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_APP_PRIVATE_KEY }, Number(repository.github_installation_id),
    Number(repository.github_repo_id));
    const repo = repository.full_name.split('/').map(encodeURIComponent).join('/');
    const path = proofWorkflowPath.split('/').map(encodeURIComponent).join('/');
    const response = await fetch(`https://api.github.com/repos/${repo}/contents/${path}?ref=${encodeURIComponent(repository.branch)}`, {
      headers: { ...githubHeaders, Authorization: `Bearer ${token}` },
      redirect: 'manual', signal: AbortSignal.timeout(15_000),
    });
    let status: 'missing' | 'detected' | 'review' = 'missing';
    if (response.status === 200) {
      status = 'review';
      const file = await response.json() as { type?: unknown; encoding?: unknown; size?: unknown; content?: unknown };
      if (file.type === 'file' && file.encoding === 'base64' && typeof file.size === 'number'
        && file.size <= 64_000 && typeof file.content === 'string') {
        try {
          const bytes = Uint8Array.from(atob(file.content.replace(/\s/g, '')), char => char.charCodeAt(0));
          const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          if (bytes.byteLength === file.size && proofWorkflowStructurePresent(source)) status = 'detected';
        } catch { /* The file exists but its structure could not be verified. */ }
      }
    } else if (response.status !== 404) throw new Error(`GitHub returned ${response.status}`);
    return Response.json({ repository: repository.full_name, branch: repository.branch,
      path: proofWorkflowPath, status, workflow }, { headers: noStore });
  } catch (cause) {
    return Response.json({ error: cause instanceof Error ? cause.message : 'Could not check CI setup' },
      { status: 502, headers: noStore });
  }
}
