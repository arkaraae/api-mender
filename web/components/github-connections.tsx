'use client';

import { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';

type Repository = { id: string; full_name: string; github_installation_id?: number | null; paused: boolean };
type Source = { id: string; repository_id: string; path: string; paused: boolean };
type Consumer = { id: string; source_id: string; repository_id: string; paused: boolean };

export default function GitHubConnections({ database, workspaceId, repositories }: {
  database: SupabaseClient; workspaceId: string; repositories: Repository[];
}) {
  const [sources, setSources] = useState<Source[]>([]);
  const [consumers, setConsumers] = useState<Consumer[]>([]);
  const [sourceRepository, setSourceRepository] = useState('');
  const [consumerRepository, setConsumerRepository] = useState('');
  const [selectedSource, setSelectedSource] = useState('');
  const [path, setPath] = useState('openapi.json');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const connected = repositories.filter(repo => repo.github_installation_id && !repo.paused);

  async function api<T>(url: string, method = 'GET', body?: unknown): Promise<T> {
    const { data } = await database.auth.getSession();
    if (!data.session) throw new Error('Sign in again to continue');
    const response = await fetch(url, {
      method, headers: { Authorization: `Bearer ${data.session.access_token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const result = await response.json() as T & { error?: string };
    if (!response.ok) throw new Error(result.error || 'Request failed');
    return result;
  }

  async function refresh() {
    try {
      const query = `?workspaceId=${encodeURIComponent(workspaceId)}`;
      const [sourceResult, consumerResult] = await Promise.all([
        api<{ sources: Source[] }>(`/api/live/contracts${query}`),
        api<{ consumers: Consumer[] }>(`/api/live/contracts/consumers${query}`),
      ]);
      setSources(sourceResult.sources);
      setConsumers(consumerResult.consumers);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not load connections'); }
  }

  useEffect(() => { void refresh(); }, [workspaceId]);

  async function connectGitHub() {
    setBusy(true); setMessage('');
    try {
      const result = await api<{ url: string }>('/api/live/github/connect/start', 'POST', { workspaceId });
      window.location.assign(result.url);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not connect GitHub'); setBusy(false); }
  }

  async function addSource() {
    setBusy(true); setMessage('');
    try {
      await api('/api/live/contracts', 'POST', { workspaceId, repositoryId: sourceRepository, path: path.trim() });
      setMessage('API contract added. Mender will load it during the next scan.');
      await refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not add API contract'); }
    finally { setBusy(false); }
  }

  async function addConsumer() {
    setBusy(true); setMessage('');
    try {
      await api('/api/live/contracts/consumers', 'POST', { workspaceId, sourceId: selectedSource, repositoryId: consumerRepository });
      setMessage('Consumer connected. Mender will compare its calls with the API contract.');
      await refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not connect consumer'); }
    finally { setBusy(false); }
  }

  return <section className="live-card">
    <h2>Connect GitHub and APIs</h2>
    <p>Install API Mender Scanner on the repositories you choose in GitHub. Mender reads their code and checks saved API contracts against the consumer repositories you connect below.</p>
    <button disabled={busy} onClick={() => void connectGitHub()}>{connected.length ? 'Add or update GitHub repositories' : 'Connect GitHub App'}</button>
    {connected.length > 0 && <p className="live-muted">Connected: {connected.map(repo => repo.full_name).join(', ')}</p>}
    {connected.length > 0 && <div className="live-fields">
      <label>API contract repository<select value={sourceRepository} onChange={event => setSourceRepository(event.target.value)}><option value="">Choose repository</option>{connected.map(repo => <option key={repo.id} value={repo.id}>{repo.full_name}</option>)}</select></label>
      <label>OpenAPI JSON path<input value={path} onChange={event => setPath(event.target.value)} placeholder="openapi.json" /></label>
      <button disabled={busy || !sourceRepository || !path.trim()} onClick={() => void addSource()}>Watch API contract</button>
    </div>}
    {sources.length > 0 && <div className="live-fields">
      <label>Watched API<select value={selectedSource} onChange={event => setSelectedSource(event.target.value)}><option value="">Choose API</option>{sources.filter(source => !source.paused).map(source => <option key={source.id} value={source.id}>{repositories.find(repo => repo.id === source.repository_id)?.full_name || 'Repository'} / {source.path}</option>)}</select></label>
      <label>Consumer codebase<select value={consumerRepository} onChange={event => setConsumerRepository(event.target.value)}><option value="">Choose repository</option>{connected.filter(repo => repo.id !== sources.find(source => source.id === selectedSource)?.repository_id).map(repo => <option key={repo.id} value={repo.id}>{repo.full_name}</option>)}</select></label>
      <button disabled={busy || !selectedSource || !consumerRepository} onClick={() => void addConsumer()}>Connect consumer</button>
    </div>}
    {consumers.length > 0 && <p className="live-muted">{consumers.filter(consumer => !consumer.paused).length} API-to-consumer connection(s) active.</p>}
    {message && <p role="status" className="live-message">{message}</p>}
  </section>;
}
