import { env } from 'cloudflare:workers';
import { onboardingDatabase } from '@/lib/github-onboarding';
import { readBoundedBody } from '@/lib/github-app';
import { applyStripeEvent, verifyStripeSignature } from '@/lib/billing';

/** Stripe webhook: subscription changes set the workspace's plan. */
export async function POST(request: Request) {
  let payload: string;
  try { payload = new TextDecoder().decode(await readBoundedBody(request, 256 * 1024)); } catch { return new Response('Too large', { status: 413 }); }
  if (!await verifyStripeSignature(payload, request.headers.get('stripe-signature'), env.STRIPE_WEBHOOK_SECRET)) return new Response('Invalid signature', { status: 400 });
  let event: Parameters<typeof applyStripeEvent>[2];
  try { event = JSON.parse(payload); } catch { return new Response('Invalid JSON', { status: 400 }); }
  try {
    const result = await applyStripeEvent(onboardingDatabase(), env, event);
    if (result.applied && 'workspaceId' in result) await onboardingDatabase().from('audit_events').insert({ workspace_id: result.workspaceId,
      actor_type: 'system', actor_id: 'stripe', action: 'billing.subscription', target: result.plan, detail: { status: result.status } });
    return Response.json({ received: true });
  } catch { return new Response('Could not apply event', { status: 500 }); }
}
