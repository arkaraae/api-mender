// Plans and Stripe billing. Stripe is called over its REST API with the
// Worker's secret key; card details never touch Mender (Stripe Checkout and
// the customer portal collect them). Webhooks are verified with the endpoint
// secret and applied once each; the subscription is re-read from Stripe so
// out-of-order events cannot leave a stale plan.
import type { SupabaseClient } from '@supabase/supabase-js';

export type BillingConfig = { STRIPE_SECRET_KEY?: string; STRIPE_WEBHOOK_SECRET?: string; STRIPE_PRICE_PRO?: string; SITE_ORIGIN?: string };
type Fetcher = typeof fetch;

const paidStatuses = new Set(['active', 'trialing', 'past_due']);
const knownStatuses = new Set(['trialing', 'active', 'past_due', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused']);

function form(values: Record<string, string>) {
  return new URLSearchParams(values).toString();
}

async function stripe<T>(config: BillingConfig, method: 'GET' | 'POST', path: string, body?: Record<string, string>, fetcher: Fetcher = fetch, idempotencyKey?: string): Promise<T> {
  if (!config.STRIPE_SECRET_KEY) throw new Error('Billing is not configured');
  const response = await fetcher(`https://api.stripe.com${path}`, {
    method, redirect: 'manual', signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${config.STRIPE_SECRET_KEY}`, 'stripe-version': '2025-03-31.basil',
      ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) },
    ...(body ? { body: form(body) } : {}),
  });
  const json = await response.json().catch(() => null) as T & { error?: { message?: string } } | null;
  if (!response.ok || !json) throw new Error(`Stripe returned ${response.status}${json?.error?.message ? `: ${json.error.message.slice(0, 200)}` : ''}`);
  return json;
}

const site = (config: BillingConfig) => (config.SITE_ORIGIN ?? 'https://apimender.com').replace(/\/+$/, '');

export type BillingView = { plan: 'free' | 'pro'; status: string; repositoryLimit: number; repositoriesUsed: number; currentPeriodEnd: string | null; available: boolean };

export async function billingView(database: SupabaseClient, workspaceId: string, config: BillingConfig): Promise<BillingView> {
  const [{ data: billing }, { data: limit }, { count }] = await Promise.all([
    database.from('workspace_billing').select('plan,status,current_period_end').eq('workspace_id', workspaceId).maybeSingle(),
    database.rpc('workspace_repository_limit', { p_workspace: workspaceId }),
    database.from('monitored_repositories').select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId).eq('paused', false),
  ]);
  const paid = billing?.plan === 'pro' && paidStatuses.has(billing.status);
  return { plan: paid ? 'pro' : 'free', status: billing?.status ?? 'none', repositoryLimit: typeof limit === 'number' ? limit : 3,
    repositoriesUsed: count ?? 0, currentPeriodEnd: billing?.current_period_end ?? null,
    available: Boolean(config.STRIPE_SECRET_KEY && config.STRIPE_PRICE_PRO) };
}

async function customerFor(database: SupabaseClient, config: BillingConfig, workspaceId: string, email: string | undefined, fetcher: Fetcher) {
  const { data: billing, error } = await database.from('workspace_billing').select('stripe_customer_id').eq('workspace_id', workspaceId).maybeSingle();
  if (error) throw error;
  if (billing?.stripe_customer_id) return billing.stripe_customer_id as string;
  const customer = await stripe<{ id: string }>(config, 'POST', '/v1/customers',
    { ...(email ? { email } : {}), 'metadata[workspace_id]': workspaceId }, fetcher, `customer-${workspaceId}`);
  if (!/^cus_[A-Za-z0-9]+$/.test(customer.id)) throw new Error('Stripe returned an invalid customer');
  const { error: saveError } = await database.from('workspace_billing').upsert({ workspace_id: workspaceId, stripe_customer_id: customer.id,
    updated_at: new Date().toISOString() }, { onConflict: 'workspace_id' });
  if (saveError) throw saveError;
  return customer.id;
}

/** A Stripe Checkout page for the Pro plan. */
export async function checkoutUrl(database: SupabaseClient, config: BillingConfig, workspaceId: string, email: string | undefined, fetcher: Fetcher = fetch) {
  if (!config.STRIPE_PRICE_PRO || !/^price_[A-Za-z0-9]+$/.test(config.STRIPE_PRICE_PRO)) throw new Error('Billing is not configured');
  const customer = await customerFor(database, config, workspaceId, email, fetcher);
  const session = await stripe<{ url?: string }>(config, 'POST', '/v1/checkout/sessions', {
    mode: 'subscription', customer, client_reference_id: workspaceId,
    'line_items[0][price]': config.STRIPE_PRICE_PRO, 'line_items[0][quantity]': '1',
    'subscription_data[metadata][workspace_id]': workspaceId, allow_promotion_codes: 'true',
    success_url: `${site(config)}/live?billing=success`, cancel_url: `${site(config)}/live?billing=canceled`,
  }, fetcher);
  if (!session.url?.startsWith('https://checkout.stripe.com/')) throw new Error('Stripe returned no checkout page');
  return session.url;
}

/** Stripe's customer portal, where the customer changes card, plan or cancels. */
export async function portalUrl(database: SupabaseClient, config: BillingConfig, workspaceId: string, fetcher: Fetcher = fetch) {
  const { data: billing } = await database.from('workspace_billing').select('stripe_customer_id').eq('workspace_id', workspaceId).maybeSingle();
  if (!billing?.stripe_customer_id) throw new Error('This workspace has no billing account yet');
  const session = await stripe<{ url?: string }>(config, 'POST', '/v1/billing_portal/sessions',
    { customer: billing.stripe_customer_id, return_url: `${site(config)}/live` }, fetcher);
  if (!session.url?.startsWith('https://billing.stripe.com/')) throw new Error('Stripe returned no portal page');
  return session.url;
}

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');

/** Stripe-Signature check (t=…,v1=…), with a five-minute tolerance. */
export async function verifyStripeSignature(payload: string, header: string | null, secret: string | undefined, now = Date.now()) {
  if (!secret || !header) return false;
  const parts = header.split(',').map(part => part.split('=') as [string, string]);
  const timestamp = Number(parts.find(([key]) => key === 't')?.[1]);
  const signatures = parts.filter(([key]) => key === 'v1').map(([, value]) => value);
  if (!Number.isSafeInteger(timestamp) || Math.abs(now / 1000 - timestamp) > 300 || !signatures.length) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${payload}`)));
  // Constant-time comparison.
  return signatures.some(signature => signature.length === expected.length
    && [...signature].reduce((difference, char, index) => difference | (char.charCodeAt(0) ^ expected.charCodeAt(index)), 0) === 0);
}

type Subscription = { id: string; customer: string; status: string; metadata?: Record<string, string>; current_period_end?: number;
  items?: { data?: { price?: { id?: string }; current_period_end?: number }[] } };

/** Apply one verified webhook event. Returns what changed, for the audit log. */
export async function applyStripeEvent(database: SupabaseClient, config: BillingConfig, event: { id?: unknown; type?: unknown; data?: { object?: Record<string, unknown> } }, fetcher: Fetcher = fetch) {
  if (typeof event.id !== 'string' || !/^evt_[A-Za-z0-9]+$/.test(event.id) || typeof event.type !== 'string') throw new Error('Invalid event');
  const { error: seenError } = await database.from('stripe_events').insert({ id: event.id, type: event.type.slice(0, 100) });
  if (seenError) {
    if ((seenError as { code?: string }).code === '23505') return { applied: false, reason: 'duplicate' };
    throw seenError;
  }
  const object = event.data?.object ?? {};
  const subscriptionId = event.type.startsWith('customer.subscription.') ? object.id
    : event.type === 'checkout.session.completed' ? object.subscription : null;
  if (typeof subscriptionId !== 'string' || !/^sub_[A-Za-z0-9]+$/.test(subscriptionId)) return { applied: false, reason: 'ignored' };
  try {
    const subscription = await stripe<Subscription>(config, 'GET', `/v1/subscriptions/${subscriptionId}`, undefined, fetcher);
    let workspaceId = subscription.metadata?.workspace_id;
    if (!workspaceId || !/^[a-f0-9-]{36}$/i.test(workspaceId)) {
      const { data } = await database.from('workspace_billing').select('workspace_id').eq('stripe_customer_id', subscription.customer).maybeSingle();
      workspaceId = data?.workspace_id;
    }
    if (!workspaceId) return { applied: false, reason: 'unknown workspace' };
    const pro = (subscription.items?.data ?? []).some(item => item.price?.id === config.STRIPE_PRICE_PRO);
    const status = knownStatuses.has(subscription.status) ? subscription.status : 'incomplete';
    const periodEnd = subscription.current_period_end ?? subscription.items?.data?.[0]?.current_period_end;
    const row = { workspace_id: workspaceId, plan: pro && paidStatuses.has(status) ? 'pro' : 'free', status,
      stripe_customer_id: /^cus_[A-Za-z0-9]+$/.test(subscription.customer) ? subscription.customer : null,
      stripe_subscription_id: subscription.id, current_period_end: typeof periodEnd === 'number' ? new Date(periodEnd * 1000).toISOString() : null,
      updated_at: new Date().toISOString() };
    const { error } = await database.from('workspace_billing').upsert(row, { onConflict: 'workspace_id' });
    if (error) throw error;
    return { applied: true, workspaceId, plan: row.plan, status };
  } catch (error) {
    // Let Stripe retry: forget the event so the retry is not treated as a duplicate.
    await database.from('stripe_events').delete().eq('id', event.id);
    throw error;
  }
}

/** Friendly text for the repository-limit trigger's error. */
export function repositoryLimitMessage(error: { message?: string } | null | undefined) {
  const match = error?.message?.match(/repository limit reached: this plan allows (\d+) repositories/);
  return match ? `Your plan allows ${match[1]} repositories. Upgrade to Pro to connect more.` : null;
}
