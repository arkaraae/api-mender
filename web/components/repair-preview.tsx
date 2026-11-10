'use client';

import { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';

type Preview = { file: string; line: number; oldField: string; newField: string;
  before: string; after: string; validation: 'static_only'; runtimeVerified: false; note: string;
  generationMethod?: 'deterministic' | 'ai_assisted' | 'self_hosted_model'; modelId?: string;
  repairJob: { id: string; status: string } | null; prUrl?: string };

export default function RepairPreview({ database, workspaceId, findingId }: {
  database: SupabaseClient; workspaceId: string; findingId: string;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [aiEligible, setAiEligible] = useState(false);
  const [proofMessage, setProofMessage] = useState('');
  const jobId = preview?.repairJob?.id;
  const jobStatus = preview?.repairJob?.status;

  useEffect(() => {
    if (!jobId || !['proof_pending', 'proof_failed', 'validated'].includes(jobStatus || '')) return;
    let active = true;
    async function refreshSavedProof() {
      const { data, error: readError } = await database.from('repair_jobs')
        .select('status,pr_url,proof').eq('id', jobId).eq('workspace_id', workspaceId).maybeSingle();
      if (!active || readError || !data) return;
      setPreview(current => {
        if (!current?.repairJob || current.repairJob.id !== jobId) return current;
        return { ...current, repairJob: { ...current.repairJob, status: data.status },
          prUrl: data.pr_url || current.prUrl };
      });
      if (data.status === 'validated')
        setProofMessage('Customer CI proof passed. The draft PR still needs human review.');
      else if (data.status === 'proof_failed')
        setProofMessage('Customer CI failed. Review the check before retrying.');
      else if (data.proof?.error)
        setProofMessage(`Previous CI proof is no longer current: ${data.proof.error}.`);
      else if (data.proof?.url)
        setProofMessage('Customer CI is running. This repair will update when the check finishes.');
    }
    void refreshSavedProof();
    const timer = window.setInterval(() => void refreshSavedProof(), 15_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [database, workspaceId, jobId, jobStatus]);

  async function load(action?: 'prepare' | 'ai_prepare') {
    setBusy(true); setError(''); setProofMessage(''); setPreview(null);
    try {
      const { data } = await database.auth.getSession();
      if (!data.session) throw new Error('Sign in again to preview this repair');
      const response = await fetch('/api/live/repairs/preview', {
        method: 'POST',
        headers: { Authorization: `Bearer ${data.session.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, findingId, ...(action ? { action } : {}) }),
      });
      const result = await response.json() as Preview & { error?: string };
      if (!response.ok) throw new Error(result.error || 'Could not preview repair');
      setPreview(result); setAiEligible(false);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Could not preview repair';
      setError(message);
      if (/replaced request field is ambiguous/.test(message)) setAiEligible(true);
    }
    finally { setBusy(false); }
  }

  async function advance(path: 'publish' | 'proof') {
    if (!preview?.repairJob) return;
    setBusy(true); setError(''); setProofMessage('');
    try {
      const { data } = await database.auth.getSession();
      if (!data.session) throw new Error('Sign in again to continue this repair');
      const response = await fetch(`/api/live/repairs/${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${data.session.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, jobId: preview.repairJob.id }),
      });
      const result = await response.json() as { status?: string; prUrl?: string; error?: string;
        proof?: { url?: string; conclusion?: string | null } | null };
      if (!response.ok) throw new Error(result.error || 'Could not update repair job');
      setPreview(current => current?.repairJob ? { ...current,
        repairJob: { ...current.repairJob, status: result.status || current.repairJob.status },
        prUrl: result.prUrl || current.prUrl } : current);
      if (path === 'proof') {
        const checkedAt = new Date().toLocaleTimeString();
        setProofMessage(result.status === 'validated'
          ? `Customer CI proof passed at ${checkedAt}. The draft PR still needs human review.`
          : result.status === 'proof_failed'
            ? `Customer CI failed. Checked at ${checkedAt}; review the check before retrying.`
            : result.proof?.url
              ? `Customer CI is still running. Checked at ${checkedAt}; check again after it finishes.`
              : `No matching customer CI check is available yet. Checked at ${checkedAt}.`);
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not update repair job'); }
    finally { setBusy(false); }
  }

  return <div>
    <button disabled={busy} onClick={() => void load()}>{busy ? 'Checking current code…' : 'Preview bounded repair'}</button>
    {preview && <div className="live-muted" role="status">
      <p>{preview.file}:{preview.line} · Replace <code>{preview.oldField}</code> with <code>{preview.newField}</code></p>
      {preview.generationMethod === 'ai_assisted' &&
        <p>AI selected this field mapping. The patch was checked against the pinned code and API contract.</p>}
      {preview.generationMethod === 'self_hosted_model' &&
        <p>Mender&apos;s self-hosted open-weight model{preview.modelId ? ` (${preview.modelId})` : ''} selected this field mapping from field names only; no hosted AI provider was used. The patch was checked against the pinned code and API contract.</p>}
      <pre><code>{`- ${preview.before}\n+ ${preview.after}`}</code></pre>
      <p>{preview.note} {preview.prUrl
        ? 'The proposed change is in a draft PR for review; it has not been merged.'
        : 'No code has been changed or published.'}</p>
      {preview.repairJob
        ? <div><p>Repair job {preview.repairJob.id} · {preview.repairJob.status}.</p>
          {preview.repairJob.status === 'proposed' &&
            <button disabled={busy} onClick={() => void advance('publish')}>Open draft repair PR</button>}
          {preview.repairJob.status !== 'proposed' && <>
            {preview.prUrl && <p><a href={preview.prUrl} target="_blank" rel="noreferrer">Review draft PR ↗</a></p>}
            <button disabled={busy} onClick={() => void advance('proof')}>
              {busy ? 'Checking GitHub CI…' : 'Check customer CI proof'}
            </button>
            {proofMessage && <p role="status">{proofMessage}</p>}
            <p>{preview.repairJob.status === 'validated'
              ? 'Customer CI reports the expected old failure and a passing patch. Human review is still required.'
              : 'Customer CI proof is required before this repair is validated.'}</p>
          </>}
        </div>
        : <button disabled={busy} onClick={() => void load('prepare')}>Save repair job</button>}
    </div>}
    {error && <p role="alert">{error}</p>}
    {aiEligible && !preview && <button disabled={busy} onClick={() => void load('ai_prepare')}>
      {busy ? 'Checking field mapping…' : 'Try self-hosted model field mapping'}
    </button>}
  </div>;
}
