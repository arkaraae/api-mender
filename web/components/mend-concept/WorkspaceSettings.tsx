'use client';

// Alerts (Slack, GitHub issues) and the workspace's plan. Both talk to the
// Worker's API routes; the Slack webhook is sent once and never shown again.
import { useCallback, useEffect, useState } from 'react';

type Authed = () => Promise<string | null>;
export type AlertDelivery = { finding_id: string; channel: 'slack' | 'github-issue' | string; status: string; detail: string | null; url: string | null; updated_at: string };
export type AlertsView = { slackHint: string | null; githubIssues: boolean; minSeverity: 'low' | 'medium' | 'high';
  recent: AlertDelivery[]; slackAvailable: boolean };
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

export type AlertsState = {
  view: AlertsView | null; busy: boolean; message: string;
  /** null while loading; 'editor-only' when the signed-in user may not change alerts. */
  access: 'ok' | 'editor-only' | 'error' | null;
  reload: () => Promise<void>;
  save: (change: Record<string, unknown>, done: string) => Promise<boolean>;
  test: () => Promise<void>;
};

const POLL_MS = 60_000;

/**
 * The workspace's alert channels and recent deliveries, shared by the
 * composer's integration buttons, the Alerts panel and Activity. Refreshes
 * every minute while the tab is visible, so new alerts show up on their own.
 */
export function useAlerts(workspaceId: string | null, token: Authed): AlertsState {
  const [view, setView] = useState<AlertsView | null>(null);
  const [access, setAccess] = useState<AlertsState['access']>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const reload = useCallback(async () => {
    if (!workspaceId) { setView(null); setAccess(null); return; }
    const access = await token();
    if (!access) return;
    try {
      const response = await fetch(`/api/live/alerts?workspaceId=${workspaceId}`, { headers: { Authorization: `Bearer ${access}` } });
      if (response.status === 403) { setAccess('editor-only'); setView(null); return; }
      const data = await response.json().catch(() => null) as (AlertsView & { error?: string }) | null;
      if (response.ok && data) { setView(data); setAccess('ok'); }
      else { setAccess(current => current === 'ok' ? 'ok' : 'error'); setMessage(data?.error || 'Could not load alert settings.'); }
    } catch { setAccess(current => current === 'ok' ? 'ok' : 'error'); }
  }, [workspaceId, token]);
  useEffect(() => {
    void reload();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void reload(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [reload]);
  const save = useCallback(async (change: Record<string, unknown>, done: string) => {
    if (!workspaceId) return false;
    setBusy(true); setMessage('');
    const { ok, data } = await call<AlertsView>(token, '/api/live/alerts', { workspaceId, ...change });
    if (ok) { setView(data); setMessage(done); } else setMessage(data.error || 'Could not save.');
    setBusy(false);
    return ok;
  }, [workspaceId, token]);
  const test = useCallback(async () => {
    if (!workspaceId) return;
    setBusy(true); setMessage('');
    const { ok, data } = await call<{ ok?: boolean }>(token, '/api/live/alerts', { workspaceId, test: true });
    setMessage(ok ? 'Test message sent to Slack.' : data.error || 'Could not send.');
    setBusy(false);
  }, [workspaceId, token]);
  return { view, busy, message, access, reload, save, test };
}

export function AlertsSettings({ alerts }: { alerts: AlertsState }) {
  const { view, busy, message, access, save, test } = alerts;
  const [webhook, setWebhook] = useState('');

  if (access === 'editor-only') return <section className="section-panel live-tool-card mend-settings" id="mend-alerts"><h2>Alerts</h2><p className="live-muted">Only workspace owners and editors can change where alerts go.</p></section>;
  if (!view) return <section className="section-panel live-tool-card mend-settings" id="mend-alerts"><h2>Alerts</h2><p className="live-muted">{message || 'Loading…'}</p></section>;
  return <section className="section-panel live-tool-card mend-settings" id="mend-alerts">
    <h2>Alerts</h2>
    <p className="live-muted">Mend tells you when a provider change affects your code. Every alert also shows in Activity.</p>
    <div className="mend-setting-row">
      <div><strong>Slack</strong><span>{view.slackHint ? `Posting to ${view.slackHint}` : 'Post new findings to a Slack channel.'}</span></div>
      {view.slackHint
        ? <div className="mend-row-actions"><button className="ghost" disabled={busy} onClick={() => void test()}>Send test</button><button className="ghost" disabled={busy} onClick={() => void save({ slackWebhook: null }, 'Slack alerts turned off.')}>Disconnect</button></div>
        : null}
    </div>
    {!view.slackHint && (view.slackAvailable
      ? <><p className="live-muted mend-help">In Slack: <a href="https://api.slack.com/apps?new_app=1" target="_blank" rel="noopener noreferrer">create an app</a> → Incoming Webhooks → turn on → Add New Webhook → pick a channel → copy the URL here.</p><div className="live-fields"><label>Slack incoming-webhook URL<input type="password" autoComplete="off" value={webhook} placeholder="https://hooks.slack.com/services/…" onChange={event => setWebhook(event.target.value)} /></label>
        <button disabled={busy || !webhook.trim()} onClick={() => void save({ slackWebhook: webhook.trim() }, 'Slack connected. New findings will be posted there.').then(ok => { if (ok) setWebhook(''); })}>Connect Slack</button></div></>
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
