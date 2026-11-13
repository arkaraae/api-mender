// Per-caller request limits for expensive or public routes, counted in
// Supabase (public.hit_rate_limit). If the counter cannot be reached the
// request is allowed: a limiter outage must not take the product down.
import type { SupabaseClient } from '@supabase/supabase-js';

export type Limit = { route: string; limit: number; windowSeconds: number };

/** Limits per route. Generous for normal use; they stop scripted abuse and runaway costs. */
export const limits = {
  publicScan: { route: 'scan-public', limit: 20, windowSeconds: 3600 },
  installedScan: { route: 'scan-installed', limit: 60, windowSeconds: 3600 },
  modelRepair: { route: 'repair-model', limit: 30, windowSeconds: 3600 },
  publish: { route: 'repair-publish', limit: 20, windowSeconds: 3600 },
  alertsWrite: { route: 'alerts', limit: 30, windowSeconds: 3600 },
  billing: { route: 'billing', limit: 10, windowSeconds: 3600 },
  cliReport: { route: 'cli-report', limit: 120, windowSeconds: 3600 },
  form: { route: 'form', limit: 5, windowSeconds: 3600 },
} satisfies Record<string, Limit>;

/** The caller's network address as Cloudflare reports it. */
export function clientAddress(request: Request) {
  return (request.headers.get('cf-connecting-ip') ?? 'unknown').slice(0, 64);
}

/**
 * Counts this request for `caller` (a user ID, token ID or address). Returns
 * a 429 response when over the limit, otherwise null.
 */
export async function rateLimit(database: SupabaseClient, rule: Limit, caller: string): Promise<Response | null> {
  try {
    const { data, error } = await database.rpc('hit_rate_limit', { p_bucket: `${rule.route}:${caller}`.slice(0, 200), p_limit: rule.limit, p_window_seconds: rule.windowSeconds });
    if (error || data !== false) return null;
  } catch { return null; }
  const minutes = Math.round(rule.windowSeconds / 60);
  return Response.json({ error: `Too many requests. Try again within ${minutes} minutes.` },
    { status: 429, headers: { 'Cache-Control': 'no-store', 'Retry-After': String(rule.windowSeconds) } });
}
