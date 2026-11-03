'use client';

import { useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';

type Preview = { file: string; line: number; oldField: string; newField: string;
  before: string; after: string; validation: 'static_only'; runtimeVerified: false; note: string };

export default function RepairPreview({ database, workspaceId, findingId }: {
  database: SupabaseClient; workspaceId: string; findingId: string;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function load() {
    setBusy(true); setError(''); setPreview(null);
    try {
      const { data } = await database.auth.getSession();
      if (!data.session) throw new Error('Sign in again to preview this repair');
      const response = await fetch('/api/live/repairs/preview', {
        method: 'POST',
        headers: { Authorization: `Bearer ${data.session.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, findingId }),
      });
      const result = await response.json() as Preview & { error?: string };
      if (!response.ok) throw new Error(result.error || 'Could not preview repair');
      setPreview(result);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not preview repair'); }
    finally { setBusy(false); }
  }

  return <div>
    <button disabled={busy} onClick={() => void load()}>{busy ? 'Checking current code…' : 'Preview bounded repair'}</button>
    {preview && <div className="live-muted" role="status">
      <p>{preview.file}:{preview.line} · Replace <code>{preview.oldField}</code> with <code>{preview.newField}</code></p>
      <pre><code>{`- ${preview.before}\n+ ${preview.after}`}</code></pre>
      <p>{preview.note} No code has been changed or published.</p>
    </div>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
