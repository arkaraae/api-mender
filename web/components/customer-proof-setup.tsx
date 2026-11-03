'use client';

import { useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';

type Repository = { id: string; full_name: string; github_installation_id?: number | null; paused: boolean };
type Consumer = { id: string; repository_id: string; paused: boolean };
type Setup = { repository: string; branch: string; path: string;
  status: 'missing' | 'detected' | 'review'; workflow?: string };

export default function CustomerProofSetup({ database, workspaceId, repositories, consumers }: {
  database: SupabaseClient; workspaceId: string; repositories: Repository[]; consumers: Consumer[];
}) {
  const consumerIds = new Set(consumers.filter(item => !item.paused).map(item => item.repository_id));
  const choices = repositories.filter(repo => repo.github_installation_id && !repo.paused);
  const [repositoryId, setRepositoryId] = useState('');
  const [testCommand, setTestCommand] = useState('');
  const [expectedBeforeOutput, setExpectedBeforeOutput] = useState('');
  const [setup, setSetup] = useState<Setup | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function check(generate: boolean) {
    setBusy(true); setMessage(''); setSetup(null);
    try {
      const { data } = await database.auth.getSession();
      if (!data.session) throw new Error('Sign in again to check customer CI setup');
      const response = await fetch('/api/live/github/proof-setup', {
        method: 'POST',
        headers: { Authorization: `Bearer ${data.session.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, repositoryId, ...(generate ? { testCommand, expectedBeforeOutput } : {}) }),
      });
      const result = await response.json() as Setup & { error?: string };
      if (!response.ok) throw new Error(result.error || 'Could not check customer CI setup');
      setSetup(result);
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : 'Could not check customer CI setup'); }
    finally { setBusy(false); }
  }

  return <div className="live-fields" id="ci-proof-setup">
    <h3>Customer CI proof setup</h3>
    <p>Choose a consumer repository, then check whether its proof workflow is present. The test command must fail on the old request and pass on a repair branch. Run it against a test API or safe read-only endpoint.</p>
    {!choices.length && <p role="status">Connect a GitHub repository above to set up CI proof.</p>}
    <label>Consumer repository
      <select value={repositoryId} onChange={event => { setRepositoryId(event.target.value); setSetup(null); }}>
        <option value="">Choose repository</option>
        {choices.map(repo => <option key={repo.id} value={repo.id}>{repo.full_name}{consumerIds.has(repo.id) ? ' · linked consumer' : ''}</option>)}
      </select>
    </label>
    {repositoryId && !consumerIds.has(repositoryId) &&
      <p className="live-muted">You can prepare this workflow now. Connect the repository as a consumer above before requesting a repair.</p>}
    <button disabled={busy || !repositoryId} onClick={() => void check(false)}>
      {busy ? 'Checking GitHub…' : 'Check proof workflow'}
    </button>
    {setup && <p role="status">{setup.status === 'detected'
      ? 'Proof workflow structure detected. A passing customer CI run is still required for each repair.'
      : setup.status === 'review'
        ? `A file exists at ${setup.path}, but its proof job needs review.`
        : `No proof workflow found at ${setup.path} on ${setup.branch}.`}</p>}
    <label>Focused test command
      <input value={testCommand} onChange={event => setTestCommand(event.target.value)}
        placeholder="npm ci && npm run test:api-mender" maxLength={300} />
    </label>
    <label>Exact old failure text
      <input value={expectedBeforeOutput} onChange={event => setExpectedBeforeOutput(event.target.value)}
        placeholder="Request rejected: 422" maxLength={200} />
    </label>
    <button disabled={busy || !repositoryId || !testCommand.trim() || !expectedBeforeOutput.trim()}
      onClick={() => void check(true)}>Generate proof workflow</button>
    {setup?.workflow && <div>
      <p>Commit this file to <code>{setup.repository}</code> on <code>{setup.branch}</code> at <code>{setup.path}</code>. The repository owner controls this workflow; Mender does not install or run it.</p>
      <pre><code>{setup.workflow}</code></pre>
      <button onClick={() => void navigator.clipboard.writeText(setup.workflow || '').then(
        () => setMessage('Workflow copied.'), () => setMessage('Copy failed; select the workflow text above.'))}>
        Copy workflow
      </button>
    </div>}
    {message && <p role="alert">{message}</p>}
  </div>;
}
