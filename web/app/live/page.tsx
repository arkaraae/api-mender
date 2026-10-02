'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { browserSupabase } from '@/lib/supabase-browser';
import AuthScreen from '@/components/auth-screen';
import BrandLogo from '@/components/brand-logo';
import ManagedApiStudio from '@/components/managed-api-studio';

type Workspace = { id: string; name: string; owner_id: string };
type Repository = { id: string; full_name: string; branch: string; head_sha: string | null; sdk_version: string | null; api_version: string | null; call_sites: { file: string; line: number; symbol: string }[]; limitations: string[]; scanned_at: string | null; paused: boolean };
type Finding = { id: string; title: string; description: string; severity: string; confidence: string; status: string; created_at: string; evidence: { sourceUrl?: string; previousVersion?: string; currentVersion?: string; note?: string; runUrl?: string; pullRequestUrl?: string } };
type AwsRelease = { version: string; publishedAt: string; evidenceUrl: string; summary: string };
type AwsSnapshot = { retrieved_at: string; metadata: AwsRelease };

function AwsSdkSection({ snapshot, busy, onCheck }: { snapshot: AwsSnapshot | null; busy: boolean; onCheck: () => void }) {
  const release = snapshot?.metadata;
  return <section className="live-card">
    <h2>AWS SDK for JavaScript</h2>
    <p>Check the official AWS SDK v3 release stream. The first check saves a baseline; later checks detect a new release version. A release alone does not establish an impact on your code.</p>
    <button disabled={busy} onClick={onCheck}>Check AWS SDK updates</button>
    {release && <div className="aws-release">
      <div><strong>Latest observed: {release.version}</strong><span>Checked {new Date(snapshot.retrieved_at).toLocaleString()}</span></div>
      <p>Published {new Date(release.publishedAt).toLocaleDateString()} · <a href={release.evidenceUrl} target="_blank" rel="noopener noreferrer">Official release notes ↗</a></p>
      {release.summary && <p className="live-muted">{release.summary}</p>}
    </div>}
  </section>;
}

export default function LiveWorkspace() {
  const supabase = useMemo(() => { try { return browserSupabase(); } catch { return null; } }, []);
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [awsSnapshot, setAwsSnapshot] = useState<AwsSnapshot | null>(null);
  const [workspaceName, setWorkspaceName] = useState('API Mender');
  const [repositoryName, setRepositoryName] = useState('arkaraae/api-mender');
  const [branch, setBranch] = useState('main');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [awaitingConfirmation, setAwaitingConfirmation] = useState(false);

  const refresh = useCallback(async (uid: string) => {
    if (!supabase) return;
    const { data: workspaces, error } = await supabase.from('workspaces').select('id,name,owner_id').eq('owner_id', uid).order('created_at');
    if (error) { setMessage(error.message); return; }
    const chosen = (workspaces?.[0] as Workspace | undefined) || null;
    setWorkspace(chosen);
    if (!chosen) { setRepositories([]); setFindings([]); setAwsSnapshot(null); return; }
    const [repoResult, findingResult, awsResult] = await Promise.all([
      supabase.from('monitored_repositories').select('id,full_name,branch,head_sha,sdk_version,api_version,call_sites,limitations,scanned_at,paused').eq('workspace_id', chosen.id).order('created_at'),
      supabase.from('findings').select('id,title,description,severity,confidence,status,created_at,evidence').eq('workspace_id', chosen.id).order('created_at', { ascending: false }).limit(50),
      supabase.from('source_snapshots').select('retrieved_at,metadata').eq('workspace_id', chosen.id).eq('provider', 'aws').eq('source_url', 'https://github.com/aws/aws-sdk-js-v3/releases').order('retrieved_at', { ascending: false }).limit(1),
    ]);
    if (repoResult.error || findingResult.error || awsResult.error) { setMessage(repoResult.error?.message || findingResult.error?.message || awsResult.error?.message || 'Could not load workspace'); return; }
    setRepositories((repoResult.data || []) as Repository[]);
    setFindings((findingResult.data || []) as Finding[]);
    setAwsSnapshot((awsResult.data?.[0] as AwsSnapshot | undefined) || null);
  }, [supabase]);

  useEffect(() => {
    if (!supabase) { setReady(true); return; }
    let active = true;
    supabase.auth.getUser().then(({ data }) => {
      if (!active) return;
      setUser(data.user);
      setReady(true);
      if (data.user) void refresh(data.user.id);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!active) return;
      setUser(session?.user || null);
      if (session?.user) setTimeout(() => { void refresh(session.user.id); }, 0);
      else { setWorkspace(null); setRepositories([]); setFindings([]); setAwsSnapshot(null); }
    });
    return () => { active = false; listener.subscription.unsubscribe(); };
  }, [supabase, refresh]);

  async function authenticate(mode: 'signin' | 'signup') {
    if (!supabase) return;
    setBusy(true); setMessage('');
    try {
      const result = mode === 'signin'
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password, options: { emailRedirectTo: `${window.location.origin}/live` } });
      const needsConfirmation = mode === 'signup' && !result.error && !result.data.session;
      if (needsConfirmation) setAwaitingConfirmation(true);
      setMessage(result.error?.message || (needsConfirmation ? 'Account created. Check your inbox and spam for a confirmation email, then sign in. You can resend it below.' : 'Signed in.'));
    } finally { setBusy(false); }
  }

  async function resendConfirmation() {
    if (!supabase || !email) return;
    setBusy(true); setMessage('');
    try {
      const { error } = await supabase.auth.resend({ type: 'signup', email, options: { emailRedirectTo: `${window.location.origin}/live` } });
      setMessage(error?.message || 'Supabase accepted the confirmation request. Check your inbox and spam.');
    } finally { setBusy(false); }
  }

  async function createWorkspace() {
    if (!supabase || !user) return;
    setBusy(true); setMessage('');
    const { error } = await supabase.from('workspaces').insert({ name: workspaceName.trim(), owner_id: user.id });
    setMessage(error?.message || 'Workspace created.');
    if (!error) await refresh(user.id);
    setBusy(false);
  }

  async function addRepository() {
    if (!supabase || !user || !workspace) return;
    setBusy(true); setMessage('');
    const { error } = await supabase.from('monitored_repositories').insert({ workspace_id: workspace.id, full_name: repositoryName.trim(), branch: branch.trim(), visibility: 'public' });
    setMessage(error?.message || 'Public repository registered. Run a scan to inspect its current commit.');
    if (!error) await refresh(user.id);
    setBusy(false);
  }

  async function scan(repositoryId: string) {
    if (!supabase || !user) return;
    setBusy(true); setMessage('');
    try {
      const { data } = await supabase.auth.getSession();
      if (!data.session) { setMessage('Please sign in again.'); return; }
      const response = await fetch('/api/live/scan', { method: 'POST', headers: { Authorization: `Bearer ${data.session.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ repositoryId }) });
      const result = await response.json() as { head?: string; inventory?: { calls?: unknown[] }; error?: string };
      setMessage(response.ok && result.head && Array.isArray(result.inventory?.calls) ? `Scanned ${result.head.slice(0, 8)}: ${result.inventory.calls.length} possible Stripe call site(s).` : result.error || 'Scan failed');
      if (response.ok) await refresh(user.id);
    } catch { setMessage('Could not reach the scanner.'); }
    finally { setBusy(false); }
  }

  async function checkSources() {
    if (!supabase || !workspace || !user) return;
    setBusy(true); setMessage('');
    try {
      const { data, error } = await supabase.functions.invoke('check-stripe', { body: { workspaceId: workspace.id } });
      if (error) { setMessage('Source check failed. Please sign in again or retry later.'); return; }
      const summary = (data.results as { source: string; state: string; findings?: number }[]).map(result => `${result.source}: ${result.state}${result.findings ? ` (${result.findings} review item(s))` : ''}`).join(' · ');
      setMessage(summary || 'Source check completed.');
      await refresh(user.id);
    } catch { setMessage('Could not reach the source monitor.'); }
    finally { setBusy(false); }
  }

  async function checkAwsSdk() {
    if (!supabase || !workspace || !user) return;
    setBusy(true); setMessage('');
    try {
      const { data, error } = await supabase.functions.invoke('check-aws-sdk', { body: { workspaceId: workspace.id } });
      if (error || !data?.release?.version) { setMessage(data?.error || 'AWS SDK check failed. Please retry later.'); return; }
      const state = data.state === 'baseline' ? 'Baseline saved' : data.state === 'changed' ? `New release since ${data.previousVersion || 'the previous check'}` : 'No newer release since the previous check';
      setMessage(`${state}: AWS SDK for JavaScript ${data.release.version}.`);
      await refresh(user.id);
    } catch { setMessage('Could not reach the AWS SDK source monitor.'); }
    finally { setBusy(false); }
  }

  if (!supabase) return <main className="live-shell"><a href="/">← Home</a><h1>Live workspace unavailable</h1><p>Set the public Supabase URL and publishable key in the app environment.</p></main>;
  if (!ready || !user) return <AuthScreen ready={ready} email={email} password={password} message={message} busy={busy} awaitingConfirmation={awaitingConfirmation} onEmailChange={setEmail} onPasswordChange={setPassword} onAuthenticate={authenticate} onResend={resendConfirmation} onBack={() => { setAwaitingConfirmation(false); setMessage(''); }} />;
  return <main className="live-shell"><header className="live-header"><a href="/">← Home</a><div className="live-brand"><BrandLogo /><span>LIVE WORKSPACE</span></div>{user && <button onClick={() => void supabase.auth.signOut()}>Sign out</button>}</header>
    <><div className="live-intro"><div><div className="eyebrow">CONNECTED TO SUPABASE</div><h1>{workspace?.name || 'Create a workspace'}</h1><p>Signed in as {user.email}. Repository scans use the current public GitHub commit.</p></div><span className="live-badge">LIVE DATA</span></div>
        {!workspace ? <section className="live-card"><h2>Your workspace</h2><p>Create a workspace before adding repositories.</p><label>Workspace name<input value={workspaceName} maxLength={120} onChange={event => setWorkspaceName(event.target.value)} /></label><button disabled={busy || !workspaceName.trim()} onClick={() => void createWorkspace()}>Create workspace</button></section>
          : <><section className="live-stats"><div><span>REPOSITORIES</span><strong>{repositories.length}</strong></div><div><span>FINDINGS</span><strong>{findings.length}</strong></div><div><span>SCANNED</span><strong>{repositories.filter(repo => repo.scanned_at).length}</strong></div></section><ManagedApiStudio database={supabase} workspaceId={workspace.id} userId={user.id} /><AwsSdkSection snapshot={awsSnapshot} busy={busy} onCheck={() => void checkAwsSdk()} /><section className="live-card"><h2>Check official Stripe sources</h2><p>Compares the latest Stripe Node release and OpenAPI file with your workspace baseline. A changed source creates an informational review item for scanned Stripe repositories; it does not claim a breaking API change.</p><button disabled={busy} onClick={() => void checkSources()}>Check Stripe sources</button></section><section className="live-card"><h2>Add a public GitHub repository</h2><p>Public scans read source files only. Private access and pull requests need a GitHub App installation.</p><div className="live-fields"><label>Owner/repository<input value={repositoryName} onChange={event => setRepositoryName(event.target.value)} /></label><label>Branch<input value={branch} onChange={event => setBranch(event.target.value)} /></label></div><button disabled={busy || !repositoryName.trim() || !branch.trim()} onClick={() => void addRepository()}>Add repository</button></section><section className="live-card"><h2>Monitored repositories</h2>{repositories.length ? <div className="live-list">{repositories.map(repo => <article key={repo.id}><div><strong><a href={`https://github.com/${repo.full_name}`} target="_blank" rel="noopener noreferrer">{repo.full_name} ↗</a></strong><small>{repo.branch} · {repo.head_sha ? repo.head_sha.slice(0, 8) : 'Not scanned'} · {repo.scanned_at ? new Date(repo.scanned_at).toLocaleString() : 'Waiting for first scan'}</small><p>{repo.api_version?.startsWith('quotes-') ? `Quotes API: ${repo.api_version} · Call sites: ${repo.call_sites.length}` : `Stripe SDK: ${repo.sdk_version || 'Unresolved'} · API version: ${repo.api_version || 'Unresolved'} · Call sites: ${repo.call_sites.length}`}</p>{repo.limitations.length > 0 && <p className="live-muted">{repo.limitations.join('; ')}</p>}</div>{repo.api_version?.startsWith('quotes-') ? <a href="/demo">View testbed ↗</a> : <button disabled={busy || repo.paused} onClick={() => void scan(repo.id)}>Scan now</button>}</article>)}</div> : <p className="live-muted">No repositories registered.</p>}</section><section className="live-card"><h2>Findings</h2>{findings.length ? findings.map(finding => <article key={finding.id} className="live-finding"><strong>{finding.title}</strong><p>{finding.description}</p><small>{finding.severity} · {finding.confidence} · {finding.status} · {new Date(finding.created_at).toLocaleString()}</small>{finding.evidence?.sourceUrl && <p><a href={finding.evidence.sourceUrl} target="_blank" rel="noopener noreferrer">API source ↗</a> · {finding.evidence.note}</p>}{finding.evidence?.runUrl && <p><a href={finding.evidence.runUrl} target="_blank" rel="noopener noreferrer">Scan and database artifact ↗</a>{finding.evidence.pullRequestUrl && <> · <a href={finding.evidence.pullRequestUrl} target="_blank" rel="noopener noreferrer">Review proposed fix ↗</a></>}</p>}</article>) : <p className="live-muted">No official source changes have been recorded beyond the baseline. Run a repository scan and source check to begin monitoring.</p>}</section></>}
      </>{message && <p className="live-message" role="status">{message}</p>}
  </main>;
}
