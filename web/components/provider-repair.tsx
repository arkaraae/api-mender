'use client';

import { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Finding as EngineFinding } from '@/lib/engine/types';

type RepairView = {
  repairJob: { id: string; status: string } | null; diff?: string; file?: string; line?: number;
  generationMethod?: string; modelId?: string; prUrl?: string;
  policyChecks?: { name: string; passed: boolean }[]; uncertainty?: string[];
};

const methodLabel = (method?: string, model?: string) => method === 'self_hosted_model'
  ? `Self-hosted open-weight model${model ? ` (${model})` : ''}; no hosted AI provider was used`
  : 'Deterministic rule; no model was used';

/** Evidence, bounded repair, draft PR and customer CI for a provider finding. */
export default function ProviderRepair({ database, workspaceId, findingId, finding, codeUrl }: {
  database: SupabaseClient; workspaceId: string; findingId: string; finding: EngineFinding; codeUrl?: string;
}) {
  const [view, setView] = useState<RepairView | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  async function call(path: string, payload: object) {
    const { data } = await database.auth.getSession();
    if (!data.session) throw new Error('Sign in again to continue');
    const response = await fetch(path, { method: 'POST', body: JSON.stringify({ workspaceId, ...payload }),
      headers: { Authorization: `Bearer ${data.session.access_token}`, 'Content-Type': 'application/json' } });
    const result = await response.json() as RepairView & { error?: string; status?: string; prUrl?: string };
    if (!response.ok) throw new Error(result.error || 'Request failed');
    return result;
  }

  async function run(work: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('');
    try { await work(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Request failed'); }
    finally { setBusy(false); }
  }

  const load = (action?: 'prepare') => run(async () => setView(await call('/api/live/repairs/provider', { findingId, ...(action ? { action } : {}) })));
  useEffect(() => { void load(); }, [findingId]); // eslint-disable-line react-hooks/exhaustive-deps

  const publish = () => run(async () => {
    const result = await call('/api/live/repairs/provider/publish', { jobId: view!.repairJob!.id });
    setView(current => current && { ...current, prUrl: result.prUrl, repairJob: { id: current.repairJob!.id, status: result.status! } });
  });
  const proof = () => run(async () => {
    const result = await call('/api/live/repairs/proof', { jobId: view!.repairJob!.id });
    setView(current => current && { ...current, repairJob: { id: current.repairJob!.id, status: result.status! } });
    setNotice(result.status === 'validated'
      ? 'Customer CI passed on the draft PR. Tests passing is not proof of correct behavior; review the change.'
      : result.status === 'proof_failed' ? 'Customer CI failed on the draft PR.' : 'Customer CI has not finished.');
  });

  const job = view?.repairJob;
  return <div className="live-muted">
    <p><strong>Upstream:</strong> {finding.change.summary}</p>
    <p><strong>Code:</strong> {codeUrl ? <a href={codeUrl} target="_blank" rel="noopener noreferrer">{finding.location.file}:{finding.location.line} ↗</a>
      : `${finding.location.file}:${finding.location.line}`} · {finding.change.operation}</p>
    <p><strong>Impact:</strong> {finding.impact.summary}</p>
    <p><strong>Evidence:</strong> confidence {finding.confidence} · {finding.evidence.applicability === 'on-upgrade'
      ? `breaks when the pinned ${finding.evidence.pinnedVersion ?? 'default'} version is upgraded or retired`
      : finding.evidence.applicability} · {finding.verification === 'test-confirmed' ? 'confirmed by a test' : 'inferred from static analysis'}</p>
    <ul>{finding.evidence.staticChecks.map(item => <li key={item}>{item}</li>)}</ul>
    <p><strong>Not established:</strong></p><ul>{finding.evidence.limits.map(item => <li key={item}>{item}</li>)}</ul>
    {finding.change.changelogUrl && <p><a href={finding.change.changelogUrl} target="_blank" rel="noopener noreferrer">Provider changelog ↗</a></p>}

    {!finding.repairable && <p>Mender has no bounded repair for this change; it needs a person.</p>}
    {finding.repairable && !job && <button disabled={busy} onClick={() => void load('prepare')}>
      {busy ? 'Preparing bounded repair…' : 'Propose bounded repair'}</button>}
    {job && view?.diff && <>
      <p>{methodLabel(view.generationMethod, view.modelId)}. Repair job {job.id.slice(0, 8)} · {job.status}.</p>
      <pre><code>{view.diff}</code></pre>
      <p>Patch checks passed: {(view.policyChecks ?? []).filter(check => check.passed).map(check => check.name).join(', ')}</p>
      {(view.uncertainty ?? []).length > 0 && <ul>{view.uncertainty!.map(item => <li key={item}>{item}</li>)}</ul>}
      {job.status === 'proposed' && <button disabled={busy} onClick={() => void publish()}>Open draft PR</button>}
      {view.prUrl && <p><a href={view.prUrl} target="_blank" rel="noreferrer">Review draft PR ↗</a> Mender never merges it.</p>}
      {job.status !== 'proposed' && <button disabled={busy} onClick={() => void proof()}>{busy ? 'Checking GitHub CI…' : 'Check customer CI'}</button>}
    </>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
