'use client';

// Alerts (Slack, GitHub issues) and the workspace's plan. Both talk to the
// Worker's API routes; the Slack webhook is sent once and never shown again.
import { useCallback, useEffect, useState } from 'react';

type Authed = () => Promise<string | null>;
type AlertsView = { slackHint: string | null; githubIssues: boolean; minSeverity: 'low' | 'medium' | 'high';
  recent: { finding_id: string; channel: string; status: string; detail: string | null; url: string | null; updated_at: string }[]; slackAvailable: boolean };
export type BillingView = { plan: 'free' | 'pro'; status: string; repositoryLimit: number; repositoriesUsed: number; currentPeriodEnd: string | null; available: boolean };

async function call<T>(token: Authed, url: string, body?: object): Promise<{ ok: boolean; data: T & { error?: string } }> {
  const access = await token();
  if (!access) return { ok: false, data: { error: 'Please sign in again.' } as T & { error?: string } };
  const response = await fetch(url, { method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${access}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json().catch(() => ({ error: 'Unexpected response' })) as T & { error?: string };
  return { ok: response.ok, data };
}

export function AlertsSettings({ workspaceId, token }: { workspaceId: string; token: Authed }) {
  const [view, setView] = useState<AlertsView | null>(null);
  const [webhook, setWebhook] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const load = useCallback(async () => {
    const { ok, data } = await call<AlertsView>(token, `/api/live/alerts?workspaceId=${workspaceId}`);
    if (ok) setView(data); else setMessage(data.error || 'Could not load alert settings.');
  }, [token, workspaceId]);
  useEffect(() => { void load(); }, [load]);

  async function save(change: Record<string, unknown>, done: string) {
    setBusy(true); setMessage('');
    const { ok, data } = await call<AlertsView>(token, '/api/live/alerts', { workspaceId, ...change });
    if (ok) { setView(data); setWebhook(''); setMessage(done); } else setMessage(data.error || 'Could not save.');
    setBusy(false);
  }
  async function test() {
    setBusy(true); setMessage('');
    const { ok, data } = await call<{ ok?: boolean }>(token, '/api/live/alerts', { workspaceId, test: true });
    setMessage(ok ? 'Test message sent to Slack.' : data.error || 'Could not send.');
    setBusy(false);
  }

  if (!view) return <section className="section-panel live-tool-card mend-settings"><h2>Alerts</h2><p className="live-muted">{message || 'Loading…'}</p></section>;
  return <section className="section-panel live-tool-card mend-settings">
    <h2>Alerts</h2>
    <p className="live-muted">Mend tells you when a provider change affects your code. Findings always appear here too.</p>
    <div className="mend-setting-row">
      <div><strong>Slack</strong><span>{view.slackHint ? `Posting to ${view.slackHint}` : 'Post new findings to a Slack channel.'}</span></div>
      {view.slackHint
        ? <div className="mend-row-actions"><button className="ghost" disabled={busy} onClick={() => void test()}>Send test</button><button className="ghost" disabled={busy} onClick={() => void save({ slackWebhook: null }, 'Slack alerts turned off.')}>Remove</button></div>
        : null}
    </div>
    {!view.slackHint && (view.slackAvailable
      ? <div className="live-fields"><label>Slack incoming-webhook URL<input type="password" autoComplete="off" value={webhook} placeholder="https://hooks.slack.com/services/…" onChange={event => setWebhook(event.target.value)} /></label>
        <button disabled={busy || !webhook.trim()} onClick={() => void save({ slackWebhook: webhook.trim() }, 'Slack connected. New findings will be posted there.')}>Connect Slack</button></div>
      : <p className="live-muted">Slack alerts are not enabled on this site yet.</p>)}
    <div className="mend-setting-row">
      <div><strong>GitHub issues</strong><span>Open an issue in the affected repository for each new finding (repositories connected through the GitHub App).</span></div>
      <label className="mend-toggle"><input type="checkbox" checked={view.githubIssues} disabled={busy}
        onChange={event => void save({ githubIssues: event.target.checked }, event.target.checked ? 'GitHub issues turned on.' : 'GitHub issues turned off.')} /><span>{view.githubIssues ? 'On' : 'Off'}</span></label>
    </div>
    <div className="mend-setting-row">
      <div><strong>Alert on</strong><span>The lowest severity that sends an alert.</span></div>
      <select value={view.minSeverity} disabled={busy} onChange={event => void save({ minSeverity: event.target.value }, 'Saved.')}>
        <option value="low">All findings</option><option value="medium">Medium and high</option><option value="high">High only</option>
      </select>
    </div>
    {view.recent.length > 0 && <div className="mend-notifications"><span className="card-eyebrow">RECENT ALERTS</span>{view.recent.map(row =>
      <p key={`${row.finding_id}-${row.channel}`}><span className={`mend-chip ${row.status === 'sent' ? 'good' : row.status === 'failed' ? 'alert' : ''}`}>{row.channel === 'slack' ? 'Slack' : 'GitHub issue'} · {row.status}</span>
        {row.url ? <a href={row.url} target="_blank" rel="noopener noreferrer">issue ↗</a> : null}{row.detail ? <span className="live-muted"> {row.detail}</span> : null}</p>)}</div>}
    {message && <p role="status" className="live-message">{message}</p>}
  </section>;
}

export function PlanCard({ workspaceId, token, billing, onChange }: { workspaceId: string; token: Authed; billing: BillingView | null; onChange?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  if (!billing) return null;
  async function go(path: string) {
    setBusy(true); setMessage('');
    const { ok, data } = await call<{ url?: string }>(token, path, { workspaceId });
    if (ok && data.url) window.location.assign(data.url);
    else { setMessage(data.error || 'Could not open billing.'); setBusy(false); onChange?.(); }
  }
  const full = billing.repositoriesUsed >= billing.repositoryLimit;
  return <section className="dashboard-card mend-plan">
    <span className="card-eyebrow">PLAN</span>
    <h2>{billing.plan === 'pro' ? 'Pro' : 'Free'}</h2>
    <p>{billing.repositoriesUsed} of {billing.repositoryLimit} repositories{full && billing.plan === 'free' ? ' · limit reached' : ''}
      {billing.plan === 'pro' && billing.currentPeriodEnd ? ` · renews ${new Date(billing.currentPeriodEnd).toLocaleDateString()}` : ''}
      {billing.status === 'past_due' ? ' · payment past due' : ''}</p>
    {billing.available && (billing.plan === 'pro'
      ? <button className="ghost" disabled={busy} onClick={() => void go('/api/billing/portal')}>Manage billing</button>
      : <button disabled={busy} onClick={() => void go('/api/billing/checkout')}>Upgrade to Pro</button>)}
    {message && <p role="status" className="live-message">{message}</p>}
  </section>;
}
