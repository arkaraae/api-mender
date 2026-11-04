import { env } from 'cloudflare:workers';
import { authenticatedEditor, onboardingDatabase, uuid } from '@/lib/github-onboarding';
import { readBoundedBody } from '@/lib/github-app';
import { refreshRepairProofJob } from '@/lib/repair-proof-worker';

const noStore = { 'Cache-Control': 'no-store' };

/** Refresh a draft repair PR's customer-run CI attestation for its pinned patch SHA. */
export async function POST(request: Request) {
  let body: { workspaceId?: unknown; jobId?: unknown } | null;
  try { body = JSON.parse(new TextDecoder().decode(await readBoundedBody(request, 2048))); }
  catch { return Response.json({ error: 'Invalid request' }, { status: 400, headers: noStore }); }
  if (!body || Object.keys(body).sort().join(',') !== 'jobId,workspaceId'
    || typeof body.workspaceId !== 'string' || !uuid.test(body.workspaceId)
    || typeof body.jobId !== 'string' || !uuid.test(body.jobId))
    return Response.json({ error: 'Invalid proof request' }, { status: 400, headers: noStore });
  if (!await authenticatedEditor(request, body.workspaceId))
    return Response.json({ error: 'Workspace editor sign-in required' }, { status: 403, headers: noStore });
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY)
    return Response.json({ error: 'GitHub App is not configured' }, { status: 503, headers: noStore });
  const database = onboardingDatabase();
  const { data: job, error: jobError } = await database.from('repair_jobs')
    .select('id,workspace_id,repository_id,pr_number,patch_branch,patch_sha,status')
    .eq('id', body.jobId).eq('workspace_id', body.workspaceId).maybeSingle();
  if (jobError) return Response.json({ error: 'Could not load repair job' }, { status: 502, headers: noStore });
  if (!job)
    return Response.json({ error: 'Repair job has no draft PR awaiting CI proof' }, { status: 409, headers: noStore });
  try {
    const result = await refreshRepairProofJob(database, env, job);
    return Response.json(result, { headers: noStore });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Could not verify customer CI' },
      { status: 502, headers: noStore });
  }
}
