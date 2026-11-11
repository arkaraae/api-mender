// Queues every external API origin a scan found for automatic discovery
// (see scripts/discover-api-contracts.mjs). Built-in providers are already
// watched and are left out. Best effort: a failure never fails the scan.
import type { SupabaseClient } from '@supabase/supabase-js';
import { isPublicApiOrigin } from './engine/discovery.ts';
import { providerForOrigin } from './engine/providers/registry.ts';

type Call = { origin?: unknown; endpoint?: unknown };

export function apiHostsFrom(calls: readonly Call[]) {
  const byOrigin = new Map<string, Set<string>>();
  for (const call of calls.slice(0, 1_000)) {
    if (typeof call.origin !== 'string' || !isPublicApiOrigin(call.origin.toLowerCase()) || providerForOrigin(call.origin)) continue;
    const endpoints = byOrigin.get(call.origin.toLowerCase()) ?? new Set<string>();
    if (typeof call.endpoint === 'string' && call.endpoint.length <= 300 && endpoints.size < 50) endpoints.add(call.endpoint);
    byOrigin.set(call.origin.toLowerCase(), endpoints);
  }
  return [...byOrigin].slice(0, 100).map(([origin, endpoints]) => ({ origin, endpoints: [...endpoints] }));
}

export async function recordApiHosts(database: SupabaseClient, calls: readonly Call[]) {
  const hosts = apiHostsFrom(calls);
  if (!hosts.length) return 0;
  try {
    const { data, error } = await database.rpc('record_api_hosts', { p_hosts: hosts });
    if (error) throw error;
    return typeof data === 'number' ? data : 0;
  } catch (error) {
    console.error(`[api-hosts] ${String((error as { message?: unknown })?.message ?? error).slice(0, 200)}`);
    return 0;
  }
}
