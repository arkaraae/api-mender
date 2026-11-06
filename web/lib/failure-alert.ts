import { backendAdmin } from './backend-admin.ts';

export type AlertConfig = { ALERT_WEBHOOK?: string; SITE_ORIGIN?: string;
  NEXT_PUBLIC_SUPABASE_URL?: string; SUPABASE_SECRET_KEY?: string };

const hour = 60 * 60 * 1000;
const lastSent = new Map<string, number>();

async function claimInDatabase(config: AlertConfig, task: string) {
  const { data, error } = await backendAdmin(config).rpc('claim_failure_alert', { p_task: task });
  if (error) throw error;
  return data === true;
}

/**
 * Log a failure and tell the operator's Slack or Discord webhook, at most hourly per task.
 * Never throws: a broken alert must not change what the failing code does next.
 */
export async function reportFailure(config: AlertConfig, task: string, error: unknown,
  { fetcher = fetch, claim = claimInDatabase, now = Date.now() } = {}) {
  // Supabase errors are plain objects rather than Error instances.
  const message = String((error as { message?: unknown } | null)?.message ?? error).slice(0, 500);
  console.error(`[${task}] ${message}`);
  if (!config.ALERT_WEBHOOK || now - (lastSent.get(task) ?? -Infinity) < hour) return;
  // If the database is what failed, this isolate's memory is still a limit.
  lastSent.set(task, now);
  try {
    let claimed = true;
    try { claimed = await claim(config, task); }
    catch { /* Send anyway: an outage is the case most worth hearing about. */ }
    if (!claimed) return;
    const text = `API Mender failure on ${config.SITE_ORIGIN || 'unknown site'}: ${task}: ${message}`;
    // Slack reads "text", Discord reads "content"; each ignores the other.
    const response = await fetcher(config.ALERT_WEBHOOK, { method: 'POST', redirect: 'manual',
      signal: AbortSignal.timeout(5_000), headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, content: text }) });
    if (!response.ok) console.error(`[failure-alert] webhook returned ${response.status}`);
  } catch { console.error('[failure-alert] could not send the alert'); }
}
