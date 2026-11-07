import { authenticatedEditor, onboardingDatabase, uuid } from '@/lib/github-onboarding';
import { readBoundedBody } from '@/lib/github-app';
import { setFindingDismissed } from '@/lib/finding-dismissal';

const noStore = { 'Cache-Control': 'no-store' };
const reply = (status: number, error: string) => Response.json({ error }, { status, headers: noStore });

/** Hide a finding from the workspace's active list, or restore it. Editors only. */
export async function POST(request: Request) {
  let body: { workspaceId?: unknown; findingId?: unknown; dismissed?: unknown } | null;
  try { body = JSON.parse(new TextDecoder().decode(await readBoundedBody(request, 2048))); }
  catch { return reply(400, 'Invalid request'); }
  if (!body || typeof body.workspaceId !== 'string' || !uuid.test(body.workspaceId)
    || typeof body.findingId !== 'string' || !uuid.test(body.findingId)
    || typeof body.dismissed !== 'boolean') return reply(400, 'Invalid finding request');
  const identity = await authenticatedEditor(request, body.workspaceId);
  if (!identity) return reply(403, 'Workspace editor sign-in required');
  try {
    const status = await setFindingDismissed(onboardingDatabase(), { workspaceId: body.workspaceId,
      findingId: body.findingId, userId: identity.user.id, dismissed: body.dismissed });
    if (!status) return reply(404, body.dismissed ? 'Finding not found' : 'Finding is not dismissed');
    return Response.json({ status }, { headers: noStore });
  } catch { return reply(502, 'Could not update the finding'); }
}
