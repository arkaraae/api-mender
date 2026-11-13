import { env } from 'cloudflare:workers';
import { limits, rateLimit } from '@/lib/rate-limit';
import { onboardingDatabase, uuid } from '@/lib/github-onboarding';
import { readBoundedBody } from '@/lib/github-app';
import { portalUrl } from '@/lib/billing';
import { authenticatedOwner, noStore, reply } from '../shared';

/** Open Stripe's customer portal (card, invoices, cancel). Workspace owners only. */
export async function POST(request: Request) {
  let body: { workspaceId?: unknown } | null;
  try { body = JSON.parse(new TextDecoder().decode(await readBoundedBody(request, 1024))); } catch { return reply(400, 'Invalid request'); }
  if (!body || typeof body.workspaceId !== 'string' || !uuid.test(body.workspaceId)) return reply(400, 'Invalid workspace');
  const identity = await authenticatedOwner(request, body.workspaceId);
  if (!identity) return reply(403, 'Only the workspace owner can change billing');
  const limited = await rateLimit(onboardingDatabase(), limits.billing, identity.user.id);
  if (limited) return limited;
  try { return Response.json({ url: await portalUrl(onboardingDatabase(), env, body.workspaceId) }, { headers: noStore }); }
  catch (error) { return reply(400, String((error as Error)?.message ?? 'Could not open billing').slice(0, 200)); }
}
