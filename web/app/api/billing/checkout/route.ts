import { env } from 'cloudflare:workers';
import { onboardingDatabase, uuid } from '@/lib/github-onboarding';
import { readBoundedBody } from '@/lib/github-app';
import { checkoutUrl } from '@/lib/billing';
import { authenticatedOwner, noStore, reply } from '../shared';

/** Start Stripe Checkout for the Pro plan. Workspace owners only. */
export async function POST(request: Request) {
  let body: { workspaceId?: unknown } | null;
  try { body = JSON.parse(new TextDecoder().decode(await readBoundedBody(request, 1024))); } catch { return reply(400, 'Invalid request'); }
  if (!body || typeof body.workspaceId !== 'string' || !uuid.test(body.workspaceId)) return reply(400, 'Invalid workspace');
  const identity = await authenticatedOwner(request, body.workspaceId);
  if (!identity) return reply(403, 'Only the workspace owner can change billing');
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_PRICE_PRO) return reply(503, 'Billing is not available on this site yet');
  try {
    const url = await checkoutUrl(onboardingDatabase(), env, body.workspaceId, identity.user.email ?? undefined);
    await onboardingDatabase().from('audit_events').insert({ workspace_id: body.workspaceId, actor_type: 'user', actor_id: identity.user.id,
      action: 'billing.checkout', target: 'pro', detail: {} });
    return Response.json({ url }, { headers: noStore });
  } catch { return reply(502, 'Could not start checkout'); }
}
