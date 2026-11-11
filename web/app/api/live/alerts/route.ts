import { env } from 'cloudflare:workers';
import { authenticatedEditor, onboardingDatabase, uuid } from '@/lib/github-onboarding';
import { readBoundedBody } from '@/lib/github-app';
import { isSlackWebhook, slackHint } from '@/lib/finding-alerts';
import { openSecret, sealSecret } from '@/lib/secret-box';

const noStore = { 'Cache-Control': 'no-store' };
const reply = (status: number, error: string) => Response.json({ error }, { status, headers: noStore });
const severities = ['low', 'medium', 'high'];

async function view(workspaceId: string) {
  const database = onboardingDatabase();
  const { data: settings, error } = await database.from('workspace_alert_settings')
    .select('slack_webhook_hint,github_issues,min_severity,alerts_since').eq('workspace_id', workspaceId).maybeSingle();
  if (error) throw error;
  const { data: recent } = await database.from('finding_notifications')
    .select('finding_id,channel,status,detail,url,updated_at').eq('workspace_id', workspaceId).order('updated_at', { ascending: false }).limit(10);
  return { slackHint: settings?.slack_webhook_hint ?? null, githubIssues: settings?.github_issues ?? false,
    minSeverity: settings?.min_severity ?? 'medium', recent: recent ?? [], slackAvailable: Boolean(env.MENDER_SETTINGS_KEY) };
}

/** A workspace's alert settings. The Slack webhook itself is never returned. */
export async function GET(request: Request) {
  const workspaceId = new URL(request.url).searchParams.get('workspaceId') ?? '';
  if (!uuid.test(workspaceId)) return reply(400, 'Invalid workspace');
  if (!await authenticatedEditor(request, workspaceId)) return reply(403, 'Workspace editor sign-in required');
  try { return Response.json(await view(workspaceId), { headers: noStore }); }
  catch { return reply(502, 'Could not read alert settings'); }
}

/**
 * Save alert settings, or send a test message. slackWebhook: a Slack
 * incoming-webhook URL to store (encrypted), null to remove it, or absent to
 * keep the current one.
 */
export async function POST(request: Request) {
  let body: { workspaceId?: unknown; slackWebhook?: unknown; githubIssues?: unknown; minSeverity?: unknown; test?: unknown } | null;
  try { body = JSON.parse(new TextDecoder().decode(await readBoundedBody(request, 4096))); }
  catch { return reply(400, 'Invalid request'); }
  if (!body || typeof body.workspaceId !== 'string' || !uuid.test(body.workspaceId)) return reply(400, 'Invalid workspace');
  const workspaceId = body.workspaceId;
  const identity = await authenticatedEditor(request, workspaceId);
  if (!identity) return reply(403, 'Workspace editor sign-in required');
  const database = onboardingDatabase();

  if (body.test === true) {
    const { data } = await database.from('workspace_alert_settings').select('slack_webhook_ciphertext').eq('workspace_id', workspaceId).maybeSingle();
    if (!data?.slack_webhook_ciphertext) return reply(400, 'Save a Slack webhook first');
    try {
      const url = await openSecret(env.MENDER_SETTINGS_KEY, workspaceId, data.slack_webhook_ciphertext);
      if (!isSlackWebhook(url)) return reply(400, 'The saved webhook is not a Slack incoming-webhook URL');
      const response = await fetch(url, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(8_000), headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'Mend is connected. New API findings for this workspace will be posted here.' }) });
      return response.ok ? Response.json({ ok: true }, { headers: noStore }) : reply(502, `Slack returned ${response.status}`);
    } catch { return reply(502, 'Could not reach Slack'); }
  }

  if (body.minSeverity !== undefined && (typeof body.minSeverity !== 'string' || !severities.includes(body.minSeverity))) return reply(400, 'Invalid severity');
  if (body.githubIssues !== undefined && typeof body.githubIssues !== 'boolean') return reply(400, 'Invalid GitHub issues setting');
  if (body.slackWebhook !== undefined && body.slackWebhook !== null && (typeof body.slackWebhook !== 'string' || !isSlackWebhook(body.slackWebhook.trim())))
    return reply(400, 'Paste a Slack incoming-webhook URL (https://hooks.slack.com/services/…)');
  const { data: current, error: readError } = await database.from('workspace_alert_settings')
    .select('slack_webhook_ciphertext,github_issues').eq('workspace_id', workspaceId).maybeSingle();
  if (readError) return reply(502, 'Could not read alert settings');
  const update: Record<string, unknown> = { workspace_id: workspaceId, updated_by: identity.user.id, updated_at: new Date().toISOString() };
  if (typeof body.minSeverity === 'string') update.min_severity = body.minSeverity;
  if (typeof body.githubIssues === 'boolean') update.github_issues = body.githubIssues;
  if (body.slackWebhook === null) { update.slack_webhook_ciphertext = null; update.slack_webhook_hint = null; }
  if (typeof body.slackWebhook === 'string') {
    if (!env.MENDER_SETTINGS_KEY) return reply(503, 'Slack alerts are not configured on this site yet');
    const url = body.slackWebhook.trim();
    update.slack_webhook_ciphertext = await sealSecret(env.MENDER_SETTINGS_KEY, workspaceId, url);
    update.slack_webhook_hint = slackHint(url);
  }
  // Turning a channel on starts its history now, so old findings are not replayed.
  const hadChannel = Boolean(current?.slack_webhook_ciphertext || current?.github_issues);
  const willHave = Boolean((update.slack_webhook_ciphertext ?? (body.slackWebhook === null ? null : current?.slack_webhook_ciphertext))
    || (update.github_issues ?? current?.github_issues));
  if (!hadChannel && willHave) update.alerts_since = new Date().toISOString();
  const { error } = await database.from('workspace_alert_settings').upsert(update, { onConflict: 'workspace_id' });
  if (error) return reply(502, 'Could not save alert settings');
  await database.from('audit_events').insert({ workspace_id: workspaceId, actor_type: 'user', actor_id: identity.user.id,
    action: 'alerts.update', target: 'workspace_alert_settings', detail: { slack: body.slackWebhook === undefined ? 'kept' : body.slackWebhook === null ? 'removed' : 'set',
      githubIssues: update.github_issues ?? null, minSeverity: update.min_severity ?? null } });
  try { return Response.json(await view(workspaceId), { headers: noStore }); }
  catch { return reply(502, 'Saved, but could not read the settings back'); }
}
