import { authenticatedEditor, uuid } from '@/lib/github-onboarding';
import { summarizeActivity } from '@/lib/activity-summary';

const noStore = { 'Cache-Control': 'no-store' };
const reply = (status: number, body: object) => Response.json(body, { status, headers: noStore });

/**
 * GET /api/live/activity?workspaceId=…&days=90
 * Real scan, check and finding counts for the Home and Activity views.
 * Every query runs as the signed-in user, so row-level security limits it to
 * workspaces they belong to; nothing here uses the service role.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const workspaceId = url.searchParams.get('workspaceId') ?? '';
  const days = Number(url.searchParams.get('days') ?? 90);
  if (!uuid.test(workspaceId) || !Number.isInteger(days) || days < 1 || days > 366)
    return reply(400, { error: 'Give a workspaceId and days between 1 and 366' });
  const identity = await authenticatedEditor(request);
  if (!identity) return reply(401, { error: 'Sign in required' });
  const now = new Date();
  // Reach back to the start of last month too, for the month-over-month figure.
  const since = new Date(Math.min(now.getTime() - days * 86_400_000,
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))).toISOString();
  const db = identity.client;
  const [membership, scans, rechecks, findings, repairs, repositories] = await Promise.all([
    db.from('workspace_members').select('role').eq('workspace_id', workspaceId).eq('user_id', identity.user.id).maybeSingle(),
    db.from('repository_scan_jobs').select('created_at,status,finished_at').eq('workspace_id', workspaceId).gte('created_at', since).limit(10_000),
    db.from('audit_events').select('created_at,detail').eq('workspace_id', workspaceId).eq('action', 'provider.recheck').gte('created_at', since).limit(10_000),
    db.from('findings').select('created_at,evidence').eq('workspace_id', workspaceId).gte('created_at', since).limit(10_000),
    db.from('repair_jobs').select('created_at,status').eq('workspace_id', workspaceId).gte('created_at', since).limit(10_000),
    db.from('monitored_repositories').select('scanned_at').eq('workspace_id', workspaceId).limit(1_000),
  ]);
  if (membership.error || !membership.data) return reply(403, { error: 'Not a member of this workspace' });
  const failed = [scans, findings, repairs, repositories].find(result => result.error);
  if (failed) return reply(502, { error: 'Could not load activity' });
  return reply(200, summarizeActivity({ now, days, scans: scans.data ?? [],
    // Older databases without the audit table simply report no rechecks.
    rechecks: rechecks.error ? [] : rechecks.data ?? [],
    findings: findings.data ?? [], repairs: repairs.data ?? [], repositories: repositories.data ?? [] }));
}
