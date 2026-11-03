'use client';

import { useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';

type Preview = { file: string; line: number; oldField: string; newField: string;
  before: string; after: string; validation: 'static_only'; runtimeVerified: false; note: string;
  repairJob: { id: string; status: string } | null; prUrl?: string };

export default function RepairPreview({ database, workspaceId, findingId }: {
  database: SupabaseClient; workspaceId: string; findingId: string;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function load(action?: 'prepare') {
    setBusy(true); setError(''); setPreview(null);
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
      setPreview(result);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not preview repair'); }
    finally { setBusy(false); }
  }

  async function advance(path: 'publish' | 'proof') {
    if (!preview?.repairJob) return;
    setBusy(true); setError('');
    try {
      const { data } = await database.auth.getSession();
      if (!data.session) throw new Error('Sign in again to continue this repair');
      const response = await fetch(`/api/live/repairs/${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${data.session.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, jobId: preview.repairJob.id }),
      });
      const result = await response.json() as { status?: string; prUrl?: string; error?: string };
      if (!response.ok) throw new Error(result.error || 'Could not update repair job');
      setPreview(current => current?.repairJob ? { ...current,
        repairJob: { ...current.repairJob, status: result.status || current.repairJob.status },
        prUrl: result.prUrl || current.prUrl } : current);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not update repair job'); }
    finally { setBusy(false); }
  }

  return <div>
    <button disabled={busy} onClick={() => void load()}>{busy ? 'Checking current code…' : 'Preview bounded repair'}</button>
    {preview && <div className="live-muted" role="status">
      <p>{preview.file}:{preview.line} · Replace <code>{preview.oldField}</code> with <code>{preview.newField}</code></p>
      <pre><code>{`- ${preview.before}\n+ ${preview.after}`}</code></pre>
      <p>{preview.note} No code has been changed or published.</p>
      {preview.repairJob
        ? <div><p>Repair job {preview.repairJob.id} · {preview.repairJob.status}.</p>
          {preview.repairJob.status === 'proposed' &&
            <button disabled={busy} onClick={() => void advance('publish')}>Open draft repair PR</button>}
          {preview.repairJob.status !== 'proposed' && <>
            {preview.prUrl && <p><a href={preview.prUrl} target="_blank" rel="noreferrer">Review draft PR ↗</a></p>}
            <button disabled={busy} onClick={() => void advance('proof')}>Check customer CI proof</button>
            <p>{preview.repairJob.status === 'validated'
              ? 'Customer CI reports the expected old failure and a passing patch. Human review is still required.'
              : 'Customer CI proof is required before this repair is validated.'}</p>
          </>}
        </div>
        : <button disabled={busy} onClick={() => void load('prepare')}>Save repair job</button>}
    </div>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
