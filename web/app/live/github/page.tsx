'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { browserSupabase } from '@/lib/supabase-browser';

export default function GitHubReturn() {
  const database = useMemo(() => { try { return browserSupabase(); } catch { return null; } }, []);
  const once = useRef(false);
  const [message, setMessage] = useState('Verifying your GitHub connection…');
  const [finished, setFinished] = useState(false);

  useEffect(() => {
    if (!database || once.current) return;
    once.current = true;
    void (async () => {
      const query = new URLSearchParams(window.location.search);
      const state = query.get('state');
      const code = query.get('code');
      const installationId = query.get('installation_id');
      if (!state || (!code && !installationId)) throw new Error('GitHub did not return a connection. Start again from your workspace.');
      const { data } = await database.auth.getSession();
      if (!data.session) throw new Error('Your API Mender session expired. Sign in to the same workspace and restart the connection.');
      const endpoint = code ? '/api/live/github/connect/complete' : '/api/live/github/connect/authorize';
      const response = await fetch(endpoint, {
        method: 'POST', headers: { Authorization: `Bearer ${data.session.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(code ? { state, code } : { state, installationId }),
      });
      const result = await response.json() as { url?: string; account?: string; repositories?: number; scansQueued?: number; error?: string };
      if (!response.ok) throw new Error(result.error || 'Could not connect GitHub');
      if (result.url) { window.location.replace(result.url); return; }
      window.history.replaceState(null, '', '/live/github');
      setMessage(`Connected ${result.repositories || 0} GitHub repositories from ${result.account || 'your account'}; ${result.scansQueued || 0} initial scans queued.`);
      setFinished(true);
    })().catch(error => {
      window.history.replaceState(null, '', '/live/github');
      setMessage(error instanceof Error ? error.message : 'GitHub connection failed');
      setFinished(true);
    });
  }, [database]);

  return <main className="live-shell"><section className="live-card"><h1>GitHub connection</h1><p role="status">{message}</p>{finished && <a href="/live">Return to workspace →</a>}</section></main>;
}
