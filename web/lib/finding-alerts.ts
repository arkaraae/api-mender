// Tells a workspace about new findings in Slack and as GitHub issues. Runs
// from the Worker's minute cron. Every send is recorded in
// finding_notifications, so a finding is announced once per channel, failures
// are retried a bounded number of times, and members can see what was sent.
//
// Messages carry only the finding's own text (written by the engine from
// provider contracts), its severity, and links. No source code is sent.
import type { SupabaseClient } from '@supabase/supabase-js';
import { installationToken } from './github-app.ts';
import { openSecret } from './secret-box.ts';

export type AlertsConfig = { MENDER_SETTINGS_KEY?: string; GITHUB_APP_ID?: string; GITHUB_APP_PRIVATE_KEY?: string; SITE_ORIGIN?: string };
type Settings = { workspace_id: string; slack_webhook_ciphertext: string | null; github_issues: boolean; min_severity: string; alerts_since: string };
type FindingRow = { id: string; workspace_id: string; repository_id: string | null; title: string; description: string | null;
  severity: string; status: string; created_at: string; dismissed_at: string | null; evidence: { codeUrl?: unknown } | null };
type Channel = 'slack' | 'github-issue';
type Deps = { fetcher?: typeof fetch; token?: (installationId: number, repository: string) => Promise<string>; now?: number };

const rank: Record<string, number> = { low: 0, informational: 0, medium: 1, high: 2, critical: 3 };
const maxAttempts = 3;
const maxSendsPerRun = 30;
const slackWebhook = /^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9]+\/[A-Za-z0-9]+\/[A-Za-z0-9]+$/;

/** Only Slack's incoming-webhook host is accepted, so the URL cannot point the Worker anywhere else. */
export function isSlackWebhook(url: string) { return url.length <= 300 && slackWebhook.test(url); }
export const slackHint = (url: string) => `hooks.slack.com/…/${url.slice(-4)}`;

const clean = (text: string, limit: number) => text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[<>&]/g, char => ({ '<': '‹', '>': '›', '&': '+' }[char]!)).slice(0, limit);

export function slackMessage(finding: FindingRow, repository: string | null, site: string) {
  const link = `${site}/live?finding=${finding.id}`;
  const code = typeof finding.evidence?.codeUrl === 'string' && finding.evidence.codeUrl.startsWith('https://github.com/') ? finding.evidence.codeUrl : null;
  const text = `Mend found an API change that affects ${repository ?? 'your code'}: ${clean(finding.title, 200)} (${finding.severity})`;
  return { text, blocks: [
    { type: 'section', text: { type: 'mrkdwn', text: `*${clean(finding.title, 300)}*\n${clean(finding.description ?? '', 900)}` } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `${finding.severity} · ${clean(repository ?? 'repository', 120)}${code ? ` · <${code}|code>` : ''} · <${link}|review in Mend>` }] },
  ] };
}

export function issueBody(finding: FindingRow, site: string) {
  const code = typeof finding.evidence?.codeUrl === 'string' && finding.evidence.codeUrl.startsWith('https://github.com/') ? finding.evidence.codeUrl : null;
  return [
    `**${finding.title.slice(0, 300)}**`, '',
    (finding.description ?? '').slice(0, 2000), '',
    `- Severity: ${finding.severity}`,
    ...(code ? [`- Code: ${code}`] : []),
    `- Review and proposed fix: ${site}/live?finding=${finding.id}`, '',
    '_Found by API Mender from the provider\'s published API contract. This is static analysis: no code was run. A fix is only opened as a draft pull request for your review; nothing is merged automatically._',
  ].join('\n');
}

export async function dispatchFindingAlerts(database: SupabaseClient, config: AlertsConfig, deps: Deps = {}) {
  const fetcher = deps.fetcher ?? fetch;
  const now = deps.now ?? Date.now();
  const site = (config.SITE_ORIGIN ?? 'https://apimender.com').replace(/\/+$/, '');
  const { data: settingsRows, error } = await database.from('workspace_alert_settings')
    .select('workspace_id,slack_webhook_ciphertext,github_issues,min_severity,alerts_since')
    .or('slack_webhook_ciphertext.not.is.null,github_issues.eq.true').limit(500);
  if (error) throw error;
  const settings = new Map((settingsRows ?? []).map((row: Settings) => [row.workspace_id, row]));
  if (!settings.size) return { sent: 0, failed: 0 };
  const since = new Date(now - 7 * 86_400_000).toISOString();
  const { data: findings, error: findingError } = await database.from('findings')
    .select('id,workspace_id,repository_id,title,description,severity,status,created_at,dismissed_at,evidence')
    .in('workspace_id', [...settings.keys()]).gte('created_at', since).is('dismissed_at', null)
    .order('created_at', { ascending: true }).limit(200);
  if (findingError) throw findingError;
  const due = (findings ?? []).filter((finding: FindingRow) => {
    const setting = settings.get(finding.workspace_id)!;
    return finding.created_at >= setting.alerts_since && (rank[finding.severity] ?? 0) >= (rank[setting.min_severity] ?? 1);
  });
  if (!due.length) return { sent: 0, failed: 0 };
  const { data: previous, error: previousError } = await database.from('finding_notifications')
    .select('finding_id,channel,status,attempts').in('finding_id', due.map(finding => finding.id));
  if (previousError) throw previousError;
  const prior = new Map((previous ?? []).map(row => [`${row.finding_id}\0${row.channel}`, row]));
  const repositoryIds = [...new Set(due.map(finding => finding.repository_id).filter((id): id is string => !!id))];
  const { data: repositories } = repositoryIds.length
    ? await database.from('monitored_repositories').select('id,full_name,github_installation_id').in('id', repositoryIds)
    : { data: [] };
  const repositoryOf = new Map((repositories ?? []).map(row => [row.id, row]));

  let sent = 0;
  let failed = 0;
  let budget = maxSendsPerRun;
  const record = async (finding: FindingRow, channel: Channel, status: 'sent' | 'failed' | 'skipped', detail: string | null, url: string | null) => {
    const attempts = ((prior.get(`${finding.id}\0${channel}`)?.attempts as number | undefined) ?? 0) + 1;
    const { error: writeError } = await database.from('finding_notifications').upsert({ finding_id: finding.id, channel,
      workspace_id: finding.workspace_id, status, detail: detail?.slice(0, 500) ?? null, url, attempts: Math.min(attempts, 10),
      updated_at: new Date(now).toISOString() }, { onConflict: 'finding_id,channel' });
    if (writeError) throw writeError;
    if (status === 'sent') sent++;
    if (status === 'failed') failed++;
  };
  const pending = (finding: FindingRow, channel: Channel) => {
    const row = prior.get(`${finding.id}\0${channel}`);
    return !row || (row.status === 'failed' && (row.attempts as number) < maxAttempts);
  };
  for (const finding of due) {
    if (budget <= 0) break;
    const setting = settings.get(finding.workspace_id)!;
    const repository = finding.repository_id ? repositoryOf.get(finding.repository_id) : undefined;
    if (setting.slack_webhook_ciphertext && pending(finding, 'slack')) {
      budget--;
      try {
        const url = await openSecret(config.MENDER_SETTINGS_KEY, finding.workspace_id, setting.slack_webhook_ciphertext);
        if (!isSlackWebhook(url)) throw new Error('Stored Slack webhook is not a Slack incoming-webhook URL');
        const response = await fetcher(url, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(8_000),
          headers: { 'content-type': 'application/json' }, body: JSON.stringify(slackMessage(finding, repository?.full_name ?? null, site)) });
        await record(finding, 'slack', response.ok ? 'sent' : 'failed', response.ok ? null : `Slack returned ${response.status}`, null);
      } catch (sendError) {
        await record(finding, 'slack', 'failed', String((sendError as Error)?.message ?? sendError), null);
      }
    }
    if (setting.github_issues && pending(finding, 'github-issue')) {
      if (!repository?.github_installation_id || !config.GITHUB_APP_ID || !config.GITHUB_APP_PRIVATE_KEY) {
        await record(finding, 'github-issue', 'skipped', 'The repository is not connected through the GitHub App', null);
        continue;
      }
      budget--;
      try {
        const [, name] = repository.full_name.split('/');
        const token = deps.token ? await deps.token(repository.github_installation_id, name)
          : await installationToken({ appId: config.GITHUB_APP_ID, privateKey: config.GITHUB_APP_PRIVATE_KEY }, repository.github_installation_id, name, 'issue-write');
        const response = await fetcher(`https://api.github.com/repos/${repository.full_name.split('/').map(encodeURIComponent).join('/')}/issues`, {
          method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15_000),
          headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'api-mender-site',
            authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ title: `[Mend] ${finding.title}`.slice(0, 250), body: issueBody(finding, site) }),
        });
        const issue = response.ok ? await response.json() as { html_url?: unknown } : null;
        const issueUrl = typeof issue?.html_url === 'string' && issue.html_url.startsWith('https://github.com/') ? issue.html_url : null;
        await record(finding, 'github-issue', response.ok ? 'sent' : 'failed',
          response.ok ? null : response.status === 403 ? 'GitHub denied issue creation; grant the App the Issues (write) permission' : `GitHub returned ${response.status}`, issueUrl);
      } catch (sendError) {
        await record(finding, 'github-issue', 'failed', String((sendError as Error)?.message ?? sendError), null);
      }
    }
  }
  return { sent, failed };
}
