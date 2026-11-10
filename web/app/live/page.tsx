'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { browserSupabase } from '@/lib/supabase-browser';
import ManagedApiStudio from '@/components/managed-api-studio';
import LiveWorkspaceShell from '@/components/mend-concept/LiveWorkspaceShell';

type Workspace = { id: string; name: string; owner_id: string };
type Repository = { id: string; full_name: string; branch: string; head_sha: string | null; sdk_version: string | null; api_version: string | null; call_sites: { file: string; line: number; symbol: string }[]; limitations: string[]; scanned_at: string | null; paused: boolean };
type Finding = { id: string; title: string; description: string; severity: string; confidence: string; status: string; created_at: string; evidence: { sourceUrl?: string; previousVersion?: string; currentVersion?: string; note?: string; runUrl?: string; pullRequestUrl?: string } };
type AwsRelease = { version: string; publishedAt: string; evidenceUrl: string; summary: string };
type AwsSnapshot = { retrieved_at: string; metadata: AwsRelease };

export default function LiveWorkspace() {
  const supabase = useMemo(() => { try { return browserSupabase(); } catch { return null; } }, []);
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [awsSnapshot, setAwsSnapshot] = useState<AwsSnapshot | null>(null);
  const [workspaceName, setWorkspaceName] = useState('API Mender');
  const [repositoryName, setRepositoryName] = useState('arkaraae/api-mender');
  const [branch, setBranch] = useState('main');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

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

  useEffect(() => {
    if (ready && supabase && !user) window.location.replace('/login');
  }, [ready, supabase, user]);

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

  if (!ready) return <main className="live-shell"><p role="status">Opening your workspace…</p></main>;
  if (!supabase) return <main className="live-shell"><a href="/">← Home</a><h1>Live workspace unavailable</h1><p>Set the public Supabase URL and publishable key in the app environment.</p></main>;
  if (!user) return <main className="live-shell"><p role="status">Taking you to sign in…</p></main>;

  return <LiveWorkspaceShell
    user={user}
    workspace={workspace}
    workspaceName={workspaceName}
    onWorkspaceNameChange={setWorkspaceName}
    onCreateWorkspace={() => void createWorkspace()}
    repositories={repositories}
    findings={findings}
    awsSnapshot={awsSnapshot}
    repositoryName={repositoryName}
    onRepositoryNameChange={setRepositoryName}
    branch={branch}
    onBranchChange={setBranch}
    onAddRepository={() => void addRepository()}
    onScan={(repositoryId: string) => void scan(repositoryId)}
    onCheckSources={() => void checkSources()}
    onCheckAwsSdk={() => void checkAwsSdk()}
    studio={workspace ? <ManagedApiStudio database={supabase} workspaceId={workspace.id} userId={user.id} /> : null}
    busy={busy}
    message={message}
    onSignOut={() => void supabase.auth.signOut()}
  />;
}
