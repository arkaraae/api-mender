'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { browserSupabase } from '@/lib/supabase-browser';
import AuthScreen from '@/components/auth-screen';
import BrandLogo from '@/components/brand-logo';
import ManagedApiStudio from '@/components/managed-api-studio';
import GitHubConnections from '@/components/github-connections';
import RepairPreview from '@/components/repair-preview';
import { Activity, ArrowUpRight, ChevronRight, CircleAlert,
  FlaskConical, GitBranch, LayoutDashboard, PlugZap, RefreshCw, Search } from 'lucide-react';

type Workspace = { id: string; name: string; owner_id: string };
type CallSite = { file: string; line: number; symbol: string; endpoint?: string };
type Repository = { id: string; full_name: string; branch: string; head_sha: string | null; sdk_version: string | null; api_version: string | null; call_sites: CallSite[]; limitations: string[]; scanned_at: string | null; paused: boolean; github_installation_id: number | null };
type DatabaseImpact = { schemaLabel: string; table: string; column: string;
  status: 'column-present' | 'column-absent' | 'snapshot-missing' | 'snapshot-stale';
  notNull?: boolean; capturedAt?: string; schemaFingerprint?: string };
type DatabaseWrite = { responseField: string; table: string; column: string; writeLine: number; sourceUrl: string };
type ConsumerCandidate = { repository: string; file: string; line: number; endpoint: string;
  sourceUrl: string; databaseWrites?: DatabaseWrite[] };
type Finding = { id: string; title: string; description: string; severity: string; confidence: string; status: string; created_at: string; evidence: { kind?: string; sourceUrl?: string; contractUrl?: string; codeUrl?: string; previousVersion?: string; currentVersion?: string; note?: string; runUrl?: string; pullRequestUrl?: string; databaseImpact?: DatabaseImpact[]; consumerCandidates?: ConsumerCandidate[]; missing?: string[]; report?: { changes?: { title: string; fields: string[] }[] } } };
type Section = 'overview' | 'findings' | 'repositories' | 'integrations' | 'monitor' | 'lab';
type AwsRelease = { version: string; publishedAt: string; evidenceUrl: string; summary: string };
type AwsSnapshot = { retrieved_at: string; metadata: AwsRelease };

function DatabaseImpactEvidence({ impacts }: { impacts?: DatabaseImpact[] }) {
  if (!impacts?.length) return null;
  return <div className="live-muted"><strong>Customer-declared database mapping</strong><ul>{impacts.map((impact, index) =>
    <li key={`${impact.schemaLabel}:${impact.table}:${impact.column}:${index}`}>
      {impact.schemaLabel}: public.{impact.table}.{impact.column} — {impact.status === 'column-present'
        ? `present${impact.notNull ? ', NOT NULL' : ', nullable'}`
        : impact.status.replace('-', ' ')}
      {impact.capturedAt && <> · snapshot {new Date(impact.capturedAt).toLocaleString()}</>}
    </li>)}</ul><p>A schema match is a possible impact, not a verified production failure.</p></div>;
}

function FindingSummary({ finding, onOpen }: { finding: Finding; onOpen: () => void }) {
  const writes = finding.evidence?.consumerCandidates?.reduce((total, candidate) =>
    total + (candidate.databaseWrites?.length || 0), 0) || 0;
  return <article className="workspace-finding-card">
    <div className="workspace-finding-top"><span className="workspace-status-dot" />
      <span>{finding.evidence?.kind === 'request-schema-mismatch' ? 'Request mismatch' : 'API change'}</span>
      <time>{new Date(finding.created_at).toLocaleDateString()}</time></div>
    <h3>{finding.title}</h3><p>{finding.description}</p>
    <div className="workspace-finding-foot"><span>{finding.severity} · {finding.confidence}</span>
      {writes > 0 && <span>{writes} database write {writes === 1 ? 'trace' : 'traces'}</span>}
      <button type="button" onClick={onOpen}>Open evidence <ArrowUpRight size={14} /></button></div>
  </article>;
}

function RepositoryInventory({ repository }: { repository: Repository }) {
  const s3Calls = repository.call_sites.filter(call => call.endpoint?.startsWith('S3 '));
  const stripeCalls = repository.call_sites.filter(call => call.endpoint?.startsWith('POST /v1/'));
  const httpCalls = repository.call_sites.filter(call => call.symbol === 'fetch' || call.symbol?.startsWith('axios.'));
  const summary = repository.api_version?.startsWith('quotes-')
    ? `Quotes API: ${repository.api_version} · Call sites: ${repository.call_sites.length}`
    : s3Calls.length
      ? `AWS S3 SDK: ${repository.sdk_version || 'Unresolved'} · S3 commands: ${s3Calls.length}${stripeCalls.length ? ` · Stripe calls: ${stripeCalls.length}` : ''}`
      : stripeCalls.length
        ? `Stripe SDK: ${repository.sdk_version || 'Unresolved'} · API version: ${repository.api_version || 'Unresolved'} · Call sites: ${repository.call_sites.length}`
        : `Static HTTP call candidates: ${httpCalls.length} · Impact unverified`;
  return <><p>{summary}</p>{repository.head_sha && repository.call_sites.length > 0 && <ul className="live-call-sites">
    {repository.call_sites.slice(0, 12).map(call => <li key={`${call.file}:${call.line}:${call.symbol}`}>
      <a href={`https://github.com/${repository.full_name}/blob/${repository.head_sha}/${call.file.split('/').map(encodeURIComponent).join('/')}#L${call.line}`} target="_blank" rel="noopener noreferrer">{call.symbol} · {call.file}:{call.line} ↗</a>
    </li>)}
  </ul>}</>;
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
  const [stripeCheckedAt, setStripeCheckedAt] = useState<string | null>(null);
  const [contractSources, setContractSources] = useState<{ id: string; path: string; repository_id: string }[]>([]);
  const [selectedService, setSelectedService] = useState<'stripe' | 'aws' | 'contract' | null>(null);
  const [workspaceName, setWorkspaceName] = useState('API Mender');
  const [repositoryName, setRepositoryName] = useState('arkaraae/api-mender');
  const [branch, setBranch] = useState('main');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [awaitingConfirmation, setAwaitingConfirmation] = useState(false);
  const [section, setSection] = useState<Section>('overview');
  const [search, setSearch] = useState('');
  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(null);

  useEffect(() => {
    const syncHash = () => {
      const hash = window.location.hash.slice(1);
      if (hash === 'ci-proof-setup') setSection('integrations');
      else if (['overview', 'findings', 'repositories', 'integrations', 'monitor', 'lab'].includes(hash))
        setSection(hash as Section);
    };
    syncHash();
    window.addEventListener('hashchange', syncHash);
    return () => window.removeEventListener('hashchange', syncHash);
  }, []);

  const refresh = useCallback(async (uid: string) => {
    if (!supabase) return;
    const { data: workspaces, error } = await supabase.from('workspaces').select('id,name,owner_id').eq('owner_id', uid).order('created_at');
    if (error) { setMessage(error.message); return; }
    const chosen = (workspaces?.[0] as Workspace | undefined) || null;
    setWorkspace(chosen);
    if (!chosen) { setRepositories([]); setFindings([]); setAwsSnapshot(null); setStripeCheckedAt(null); setContractSources([]); return; }
    const [repoResult, findingResult, awsResult, stripeResult, contractResult] = await Promise.all([
      supabase.from('monitored_repositories').select('id,full_name,branch,head_sha,sdk_version,api_version,call_sites,limitations,scanned_at,paused,github_installation_id').eq('workspace_id', chosen.id).order('created_at'),
      supabase.from('findings').select('id,title,description,severity,confidence,status,created_at,evidence').eq('workspace_id', chosen.id).order('created_at', { ascending: false }).limit(50),
      supabase.from('source_snapshots').select('retrieved_at,metadata').eq('workspace_id', chosen.id).eq('provider', 'aws').eq('source_url', 'https://github.com/aws/aws-sdk-js-v3/releases').order('retrieved_at', { ascending: false }).limit(1),
      supabase.from('source_snapshots').select('retrieved_at').eq('workspace_id', chosen.id).eq('provider', 'stripe').order('retrieved_at', { ascending: false }).limit(1),
      supabase.from('api_contract_sources').select('id,path,repository_id').eq('workspace_id', chosen.id).eq('paused', false).limit(50),
    ]);
    if (repoResult.error || findingResult.error || awsResult.error || stripeResult.error || contractResult.error) { setMessage(repoResult.error?.message || findingResult.error?.message || awsResult.error?.message || stripeResult.error?.message || contractResult.error?.message || 'Could not load workspace'); return; }
    setRepositories((repoResult.data || []) as Repository[]);
    setFindings((findingResult.data || []) as Finding[]);
    setAwsSnapshot((awsResult.data?.[0] as AwsSnapshot | undefined) || null);
    setStripeCheckedAt(stripeResult.data?.[0]?.retrieved_at || null);
    setContractSources(contractResult.data || []);
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
      else { setWorkspace(null); setRepositories([]); setFindings([]); setAwsSnapshot(null); setStripeCheckedAt(null); setContractSources([]); }
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
    if (!supabase || !user || !workspace) return;
    setBusy(true); setMessage('');
    try {
      const { data } = await supabase.auth.getSession();
      if (!data.session) { setMessage('Please sign in again.'); return; }
      const installed = repositories.find(repo => repo.id === repositoryId)?.github_installation_id;
      if (installed) {
        const response = await fetch('/api/live/scan/installed', {
          method: 'POST', headers: { Authorization: `Bearer ${data.session.access_token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId: workspace.id, repositoryId }),
        });
        const result = await response.json() as { head?: string; status?: string; error?: string };
        setMessage(response.ok ? `Installed repository ${result.status === 'recent' ? 'was scanned recently' : `scan ${result.status}`}. Commit ${result.head?.slice(0, 8) || 'unknown'}. Refresh later to see findings.` : result.error || 'Could not queue scan');
        if (response.ok) await refresh(user.id);
        return;
      }
      const response = await fetch('/api/live/scan', { method: 'POST', headers: { Authorization: `Bearer ${data.session.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ repositoryId }) });
      const result = await response.json() as { head?: string; inventory?: { calls?: CallSite[] }; error?: string };
      const s3Count = result.inventory?.calls?.filter(call => call.endpoint?.startsWith('S3 ')).length || 0;
      const stripeCount = result.inventory?.calls?.filter(call => call.endpoint?.startsWith('POST /v1/')).length || 0;
      setMessage(response.ok && result.head && Array.isArray(result.inventory?.calls) ? `Scanned ${result.head.slice(0, 8)}: ${s3Count} possible S3 call(s), ${stripeCount} possible Stripe call(s).` : result.error || 'Scan failed');
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
      const review = data.findings ? ` ${data.findings} S3 repository review item(s) created; impact is not yet verified.` : '';
      setMessage(`${state}: AWS SDK for JavaScript ${data.release.version}.${review}`);
      await refresh(user.id);
    } catch { setMessage('Could not reach the AWS SDK source monitor.'); }
    finally { setBusy(false); }
  }

  if (!supabase) return <main className="live-shell"><a href="/">← Home</a><h1>Live workspace unavailable</h1><p>Set the public Supabase URL and publishable key in the app environment.</p></main>;
  if (!ready || !user) return <AuthScreen ready={ready} email={email} password={password} message={message} busy={busy} awaitingConfirmation={awaitingConfirmation} onEmailChange={setEmail} onPasswordChange={setPassword} onAuthenticate={authenticate} onResend={resendConfirmation} onBack={() => { setAwaitingConfirmation(false); setMessage(''); }} />;

  const navigation = [
    { id: 'overview' as Section, label: 'Overview', icon: LayoutDashboard },
    { id: 'findings' as Section, label: 'Findings', icon: CircleAlert, count: findings.length },
    { id: 'repositories' as Section, label: 'Repositories', icon: GitBranch, count: repositories.length },
    { id: 'integrations' as Section, label: 'Integrations', icon: PlugZap },
    { id: 'monitor' as Section, label: 'Monitor', icon: Activity },
    { id: 'lab' as Section, label: 'Evidence lab', icon: FlaskConical },
  ];
  const sectionTitle = navigation.find(item => item.id === section)?.label || 'Overview';
  const query = search.trim().toLowerCase();
  const visibleFindings = findings.filter(finding => !query || `${finding.title} ${finding.description}`.toLowerCase().includes(query));
  const visibleRepositories = repositories.filter(repo => !query || repo.full_name.toLowerCase().includes(query));
  const selectedFinding = findings.find(finding => finding.id === selectedFindingId) || findings[0];
  const openSection = (next: Section) => { setSection(next); window.location.hash = next; };
  const openFinding = (finding: Finding) => { setSelectedFindingId(finding.id); openSection('lab'); };
  const candidates = selectedFinding?.evidence?.consumerCandidates || [];
  const writes = candidates.flatMap(candidate => (candidate.databaseWrites || []).map(write => ({ ...write, repository: candidate.repository })));
  const scannedCount = repositories.filter(repo => repo.scanned_at).length;
  const contractNeedsReview = findings.some(finding => finding.evidence?.kind === 'request-schema-mismatch'
    || (finding.evidence?.report?.changes?.length || 0) > 0);
  const services = [
    { id: 'stripe' as const, name: 'Stripe', status: stripeCheckedAt ? 'Checked' : 'Not checked',
      note: stripeCheckedAt ? `Last check ${new Date(stripeCheckedAt).toLocaleDateString()}` : 'Official sources ready',
      tone: stripeCheckedAt ? 'good' : 'idle' },
    { id: 'aws' as const, name: 'AWS SDK', status: awsSnapshot ? 'Checked' : 'Not checked',
      note: awsSnapshot?.metadata?.version || 'JavaScript SDK v3', tone: awsSnapshot ? 'good' : 'idle' },
    { id: 'contract' as const, name: 'OpenAPI', status: contractNeedsReview ? 'Needs review' : contractSources.length ? 'Watching' : 'Not connected',
      note: `${contractSources.length} contract source${contractSources.length === 1 ? '' : 's'}`,
      tone: contractNeedsReview ? 'alert' : contractSources.length ? 'good' : 'idle' },
  ];

  return <div className="workspace-stage"><main className={`workspace-app ${section === 'monitor' ? 'workspace-app--monitor' : ''}`}>
    <aside className="workspace-sidebar">
      <a href="/" className="workspace-logo" aria-label="Mend home"><BrandLogo /></a>
      <div className="workspace-quick-actions"><button type="button" onClick={() => openSection('integrations')}>+ New</button><button type="button" onClick={() => openSection('integrations')}>Connect Account</button></div>
      <div className="workspace-switcher"><span className="workspace-avatar">{(workspace?.name || 'M').charAt(0).toUpperCase()}</span><div><strong>{workspace?.name || 'Your workspace'}</strong><small>Team workspace</small></div></div>
      <p className="workspace-nav-heading">WORKSPACE</p>
      <nav aria-label="Workspace sections">{navigation.map(item => { const Icon = item.icon; return <button key={item.id} type="button" className={section === item.id ? 'active' : ''} aria-current={section === item.id ? 'page' : undefined} onClick={() => openSection(item.id)}><Icon size={17} strokeWidth={1.8} /><span>{item.label}</span>{item.count !== undefined && <em>{item.count}</em>}</button>; })}</nav>
      <button type="button" className="workspace-sidebar-bottom" onClick={() => void supabase.auth.signOut()} title="Sign out of this account"><span className="workspace-account-mark" /> <span>Account<small>{user.email} · Sign out</small></span></button>
    </aside>
    <div className="workspace-main">
      <header className="workspace-topbar"><div className="workspace-breadcrumb"><span>{workspace?.name || 'Workspace'}</span><ChevronRight size={14} /><strong>{sectionTitle}</strong></div>
        <label className="workspace-search"><Search size={17} /><input aria-label="Search findings and repositories" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search findings or repositories" /></label>
        <div className="workspace-account"><button type="button" aria-label="Refresh workspace" title="Refresh workspace" onClick={() => void refresh(user.id)}><RefreshCw size={15} /></button><span title={user.email}>{user.email}</span><button type="button" onClick={() => void supabase.auth.signOut()}>Sign out</button></div></header>
      <div className="workspace-content">
        <div className="workspace-page-head"><div>{section !== 'monitor' && <span className="workspace-eyebrow">MEND / {sectionTitle.toUpperCase()}</span>}<h1>{section === 'monitor' ? 'Integrated Services' : sectionTitle}</h1>{section !== 'monitor' && <p>{section === 'lab' ? 'Compare the contract change, consumer code, and database evidence.' : 'Monitor upstream changes and review what your connected code actually uses.'}</p>}</div><span className="workspace-live-tag">{section === 'monitor' ? `${scannedCount} of ${repositories.length} repositories scanned` : 'STAGING DATA'}</span></div>
        {!workspace ? <section className="live-card"><h2>Create your workspace</h2><p>Connect repositories and API sources after creating a workspace.</p><label>Workspace name<input value={workspaceName} maxLength={120} onChange={event => setWorkspaceName(event.target.value)} /></label><button disabled={busy || !workspaceName.trim()} onClick={() => void createWorkspace()}>Create workspace</button></section> : <>
          {section === 'overview' && <>
            <section className="workspace-metrics" aria-label="Workspace totals"><div><span>Repositories</span><strong>{repositories.length}</strong><small>Connected or registered</small></div><div><span>Findings</span><strong>{findings.length}</strong><small>Recorded review items</small></div><div><span>Scanned</span><strong>{repositories.filter(repo => repo.scanned_at).length}</strong><small>With pinned source inventory</small></div><div><span>Needs review</span><strong>{findings.filter(finding => finding.status === 'Action required').length}</strong><small>Awaiting evidence or repair</small></div></section>
            <div className="workspace-overview-grid"><section className="workspace-panel"><div className="workspace-panel-head"><div><span className="workspace-eyebrow">RECENT ACTIVITY</span><h2>Findings</h2></div><button type="button" onClick={() => openSection('findings')}>View all <ArrowUpRight size={14} /></button></div><div className="workspace-card-list">{visibleFindings.length ? visibleFindings.slice(0, 4).map(finding => <FindingSummary key={finding.id} finding={finding} onOpen={() => openFinding(finding)} />) : <p className="workspace-empty">No findings match this search.</p>}</div></section>
              <div className="workspace-overview-side"><section className="workspace-panel"><div className="workspace-panel-head"><div><span className="workspace-eyebrow">CONNECTED CODE</span><h2>Repositories</h2></div><button type="button" onClick={() => openSection('repositories')}>View all <ArrowUpRight size={14} /></button></div>{visibleRepositories.length ? visibleRepositories.slice(0, 4).map(repo => <div key={repo.id} className="workspace-repo-mini"><GitBranch size={16} /><div><strong>{repo.full_name}</strong><small>{repo.scanned_at ? `Scanned ${new Date(repo.scanned_at).toLocaleDateString()}` : 'Not scanned yet'}</small></div></div>) : <p className="workspace-empty">No repositories match this search.</p>}</section><section className="workspace-panel workspace-next-step"><span className="workspace-eyebrow">NEXT CHECK</span><h2>Follow the evidence</h2><p>Review a changed contract, the pinned consumer call, and any database write trace before opening a repair.</p><button type="button" onClick={() => openSection('lab')}>Open evidence lab <ArrowUpRight size={15} /></button></section></div></div>
          </>}
          {section === 'findings' && <section className="workspace-panel"><div className="workspace-panel-head"><div><span className="workspace-eyebrow">CHANGE MONITOR</span><h2>All findings</h2></div><span className="workspace-count">{visibleFindings.length} shown</span></div><div className="workspace-card-list">{visibleFindings.length ? visibleFindings.map(finding => <FindingSummary key={finding.id} finding={finding} onOpen={() => openFinding(finding)} />) : <p className="workspace-empty">No findings match this search.</p>}</div></section>}
          {section === 'repositories' && <div className="workspace-column"><section className="live-card"><h2>Monitored repositories</h2>{visibleRepositories.length ? <div className="live-list">{visibleRepositories.map(repo => <article key={repo.id}><div><strong><a href={`https://github.com/${repo.full_name}`} target="_blank" rel="noopener noreferrer">{repo.full_name} ↗</a></strong><small>{repo.branch} · {repo.head_sha ? repo.head_sha.slice(0, 8) : 'Not scanned'} · {repo.scanned_at ? new Date(repo.scanned_at).toLocaleString() : 'Waiting for first scan'}</small><RepositoryInventory repository={repo} />{repo.limitations.length > 0 && <p className="live-muted">{repo.limitations.join('; ')}</p>}</div>{repo.api_version?.startsWith('quotes-') ? <a href="/demo">View testbed ↗</a> : <button disabled={busy || repo.paused} onClick={() => void scan(repo.id)}>Scan now</button>}</article>)}</div> : <p className="workspace-empty">No repositories match this search.</p>}</section><section className="live-card"><h2>Add a public GitHub repository</h2><p>Private repositories connect through the GitHub App in Integrations.</p><div className="live-fields"><label>Owner/repository<input value={repositoryName} onChange={event => setRepositoryName(event.target.value)} /></label><label>Branch<input value={branch} onChange={event => setBranch(event.target.value)} /></label></div><button disabled={busy || !repositoryName.trim() || !branch.trim()} onClick={() => void addRepository()}>Add repository</button></section></div>}
          {section === 'integrations' && <div className="workspace-column"><GitHubConnections database={supabase} workspaceId={workspace.id} repositories={repositories} /><ManagedApiStudio database={supabase} workspaceId={workspace.id} userId={user.id} /></div>}
          {section === 'monitor' && <>
            <section className="service-grid" aria-label="Integrated services">{services.map(service => <article key={service.id} className={`service-card service-card--${service.tone}`}>
              <div className="service-card-top"><strong>{service.name}</strong><button type="button" onClick={() => setSelectedService(service.id)}>Details</button></div>
              <p>{service.status}</p><small>{service.note}</small><span className="service-card-bar" />
            </article>)}{Array.from({ length: 5 }, (_, index) => <button type="button" key={index} className="service-empty" onClick={() => openSection('integrations')} aria-label={`Add integration ${index + 1}`}><span>+</span><small>Add a service</small></button>)}</section>
            {selectedService && <section className="service-details" aria-live="polite"><div className="service-details-head"><div><span>SERVICE DETAILS</span><h2>{services.find(service => service.id === selectedService)?.name}</h2></div><button type="button" onClick={() => setSelectedService(null)} aria-label="Close service details">×</button></div>
              {selectedService === 'aws' && <><p>Checks the official AWS SDK for JavaScript release stream. A release is a review signal until consumer impact is verified.</p>{awsSnapshot && <p>Latest observed: {awsSnapshot.metadata.version} · checked {new Date(awsSnapshot.retrieved_at).toLocaleString()}</p>}<button disabled={busy} onClick={() => void checkAwsSdk()}>Check AWS updates</button></>}
              {selectedService === 'stripe' && <><p>Checks official Stripe Node and OpenAPI sources against the workspace baseline.</p>{stripeCheckedAt && <p>Last checked {new Date(stripeCheckedAt).toLocaleString()}</p>}<button disabled={busy} onClick={() => void checkSources()}>Check Stripe sources</button></>}
              {selectedService === 'contract' && <><p>{contractSources.length} connected OpenAPI contract source{contractSources.length === 1 ? '' : 's'}. {contractNeedsReview ? 'Review the related findings before requesting a repair.' : 'Changes are compared on repository scans.'}</p><button onClick={() => openSection(contractNeedsReview ? 'findings' : 'integrations')}>{contractNeedsReview ? 'Review findings' : 'Manage contracts'}</button></>}
            </section>}
          </>}
          {section === 'lab' && <><div className="workspace-lab-toolbar"><label>Finding<select value={selectedFinding?.id || ''} onChange={event => setSelectedFindingId(event.target.value)}>{findings.map(finding => <option key={finding.id} value={finding.id}>{finding.title}</option>)}</select></label><span>Static evidence · runtime verification required</span></div>{selectedFinding ? <><div className="workspace-lab-grid"><section className="workspace-panel workspace-lab-card"><div className="workspace-lab-label">01 / UPSTREAM</div><h2>Contract change</h2><p>{selectedFinding.title}</p>{selectedFinding.evidence?.report?.changes?.map((change, index) => <div className="workspace-evidence-row" key={index}><strong>{change.title}</strong><small>{change.fields.join(', ')}</small></div>)}{selectedFinding.evidence?.missing?.length ? <div className="workspace-evidence-row"><strong>Required field missing</strong><small>{selectedFinding.evidence.missing.join(', ')}</small></div> : null}{(selectedFinding.evidence?.contractUrl || selectedFinding.evidence?.sourceUrl) && <a className="workspace-evidence-link" href={selectedFinding.evidence.contractUrl || selectedFinding.evidence.sourceUrl} target="_blank" rel="noopener noreferrer">Pinned API source <ArrowUpRight size={14} /></a>}</section>
                    <section className="workspace-panel workspace-lab-card"><div className="workspace-lab-label">02 / CONSUMER</div><h2>Code path</h2><p>{candidates.length ? `${candidates.length} matching call candidate${candidates.length === 1 ? '' : 's'}` : selectedFinding.evidence?.codeUrl ? 'Pinned request body' : 'No linked consumer call'}</p>{candidates.slice(0, 10).map((candidate, index) => <div className="workspace-evidence-row" key={`${candidate.file}:${candidate.line}:${index}`}><strong>{candidate.repository}</strong><a href={candidate.sourceUrl} target="_blank" rel="noopener noreferrer">{candidate.file}:{candidate.line} <ArrowUpRight size={12} /></a><small>{candidate.endpoint}</small></div>)}{selectedFinding.evidence?.codeUrl && <a className="workspace-evidence-link" href={selectedFinding.evidence.codeUrl} target="_blank" rel="noopener noreferrer">Pinned consumer code <ArrowUpRight size={14} /></a>}</section>
                    <section className="workspace-panel workspace-lab-card"><div className="workspace-lab-label">03 / DATABASE</div><h2>Write evidence</h2><p>{writes.length ? 'Direct static response-to-write candidates' : 'No direct database write traced for this change'}</p>{writes.slice(0, 10).map((write, index) => <div className="workspace-evidence-row" key={`${write.repository}:${write.writeLine}:${index}`}><strong>public.{write.table}.{write.column}</strong><small>From response field {write.responseField}</small><a href={write.sourceUrl} target="_blank" rel="noopener noreferrer">{write.repository}:{write.writeLine} <ArrowUpRight size={12} /></a></div>)}<DatabaseImpactEvidence impacts={selectedFinding.evidence?.databaseImpact} /><small className="workspace-evidence-caution">A code trace or schema match does not prove a production failure.</small></section></div><section className="workspace-panel workspace-repair-panel"><div className="workspace-panel-head"><div><span className="workspace-eyebrow">VALIDATION</span><h2>Repair and customer CI</h2></div></div><p>{selectedFinding.description}</p>{selectedFinding.evidence?.kind === 'request-schema-mismatch' ? <RepairPreview database={supabase} workspaceId={workspace.id} findingId={selectedFinding.id} /> : <p className="workspace-empty">A bounded repair is available only for supported literal request body mismatches.</p>}</section></> : <p className="workspace-empty">No finding is available for review yet.</p>}</>}
        </>}
        {message && <p className="live-message" role="status">{message}</p>}
      </div>
    </div>
  </main></div>;
}
