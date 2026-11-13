import { env } from 'cloudflare:workers';
import { authenticatedEditor, onboardingDatabase, uuid } from '@/lib/github-onboarding';
import { billingView } from '@/lib/billing';
import { noStore, reply } from '../shared';

export async function GET(request: Request) {
  const workspaceId = new URL(request.url).searchParams.get('workspaceId') ?? '';
  if (!uuid.test(workspaceId)) return reply(400, 'Invalid workspace');
  if (!await authenticatedEditor(request, workspaceId)) return reply(403, 'Workspace editor sign-in required');
  try { return Response.json(await billingView(onboardingDatabase(), workspaceId, env), { headers: noStore }); }
  catch { return reply(502, 'Could not read billing'); }
}
