'use client';

// The signed-in product at /live: the Mend workspace design, backed by the
// real workspace data (repositories, scans, detected APIs, findings, repair
// jobs, activity). Signed-out visitors go to /login.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { browserSupabase } from '@/lib/supabase-browser';
import ManagedApiStudio from '@/components/managed-api-studio';
import GitHubConnections from '@/components/github-connections';
import DatabaseEvidenceSetup from '@/components/database-evidence-setup';
import LiveWorkspaceShell from '@/components/mend-concept/LiveWorkspaceShell';
import FindingDetail, { type LiveFinding } from '@/components/mend-concept/FindingDetail';
import { AlertsSettings, PlanCard, type BillingView } from '@/components/mend-concept/WorkspaceSettings';
import { deriveProviderServices, type WatchStatus } from '@/lib/provider-services';
import { repositoryLimitMessage } from '@/lib/billing';
import type { ActivitySummary } from '@/lib/activity-summary';
import { deriveWatchedServices, type ContractConsumer, type ContractSnapshot, type ContractSource, type ContractVersion } from '@/lib/live-services';

type Workspace = { id: string; name: string; owner_id: string };
type CallSite = { file: string; line: number; symbol: string; endpoint?: string; origin?: string; headers?: Record<string, string> };
type Repository = { id: string; full_name: string; branch: string; visibility: string; head_sha: string | null; target_sha: string | null;
  call_sites: CallSite[]; limitations: string[]; scanned_at: string | null; paused: boolean; github_installation_id: number | null };
type RepairJob = { id: string; finding_id: string; repository_id: string; status: string; pr_url: string | null; updated_at: string };
type CliReport = { repository_label: string; received_at: string; report: { providers?: { providerId: string; providerName: string; operations: string[]; callCount: number }[] } };

export type ServiceCard = { id: string; name: string; origin: string; status: string; tone: 'alert' | 'good' | 'idle';
  note: string; detail?: string; operations: string[]; findingIds: string[] };

const ACTIVITY_DAYS = 252; // 36 weeks: one square per day in the scan grid

export default function LiveWorkspace() {
  const supabase = useMemo(() => { try { return browserSupabase(); } catch { return null; } }, []);
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [findings, setFindings] = useState<LiveFinding[]>([]);
  const [repairJobs, setRepairJobs] = useState<RepairJob[]>([]);
  const [contractSources, setContractSources] = useState<ContractSource[]>([]);
  const [contractVersions, setContractVersions] = useState<ContractVersion[]>([]);
  const [contractConsumers, setContractConsumers] = useState<ContractConsumer[]>([]);
  const [contractSnapshots, setContractSnapshots] = useState<ContractSnapshot[]>([]);
  const [cliReports, setCliReports] = useState<CliReport[]>([]);
  const [activity, setActivity] = useState<ActivitySummary | null>(null);
  const [billing, setBilling] = useState<BillingView | null>(null);
  const [watchStatus, setWatchStatus] = useState<WatchStatus[]>([]);
  // Deep links from Slack and GitHub issues: /live?finding=<id>; Checkout returns with ?billing=.
  const [initialFindingId] = useState(() => typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('finding'));
  const [workspaceName, setWorkspaceName] = useState('API Mender');
  const [repositoryName, setRepositoryName] = useState('');
  const [branch, setBranch] = useState('main');
  const [busy, setBusy] = useState(false);
  const [dismissingId, setDismissingId] = useState<string | null>(null);
  const [message, setMessage] = useState('');

  const loadActivity = useCallback(async (workspaceId: string) => {
    if (!supabase) return;
    const { data } = await supabase.auth.getSession();
    if (!data.session) return;
    try {
      const response = await fetch(`/api/live/activity?workspaceId=${workspaceId}&days=${ACTIVITY_DAYS}`,
        { headers: { Authorization: `Bearer ${data.session.access_token}` } });
      if (response.ok) setActivity(await response.json() as ActivitySummary);
    } catch { /* The grid shows empty days; the rest of the workspace still works. */ }
    try {
      const response = await fetch(`/api/billing/status?workspaceId=${workspaceId}`, { headers: { Authorization: `Bearer ${data.session.access_token}` } });
      setBilling(response.ok ? await response.json() as BillingView : null);
    } catch { setBilling(null); }
  }, [supabase]);

  const refresh = useCallback(async () => {
    if (!supabase) return;
    // Row-level security limits this to workspaces the user belongs to.
    const { data: workspaces, error } = await supabase.from('workspaces').select('id,name,owner_id').order('created_at');
    if (error) { setMessage(error.message); return; }
    const chosen = (workspaces?.[0] as Workspace | undefined) || null;
    setWorkspace(chosen);
    if (!chosen) { setRepositories([]); setFindings([]); setRepairJobs([]); setActivity(null); return; }
    const [repoResult, findingResult, jobResult, sourceResult, versionResult, consumerResult, snapshotResult] = await Promise.all([
      supabase.from('monitored_repositories').select('id,full_name,branch,visibility,head_sha,target_sha,call_sites,limitations,scanned_at,paused,github_installation_id').eq('workspace_id', chosen.id).order('created_at'),
      supabase.from('findings').select('id,source_id,title,description,severity,confidence,status,created_at,evidence').eq('workspace_id', chosen.id).order('created_at', { ascending: false }).limit(100),
      supabase.from('repair_jobs').select('id,finding_id,repository_id,status,pr_url,updated_at').eq('workspace_id', chosen.id).order('updated_at', { ascending: false }).limit(50),
      supabase.from('api_contract_sources').select('id,path,repository_id,paused').eq('workspace_id', chosen.id).limit(100),
      supabase.from('api_contract_versions').select('source_id,head_sha,created_at').eq('workspace_id', chosen.id).order('created_at', { ascending: false }).limit(200),
      supabase.from('api_contract_consumers').select('source_id,repository_id,paused').eq('workspace_id', chosen.id).limit(200),
      supabase.from('source_snapshots').select('id,provider,metadata').eq('workspace_id', chosen.id).eq('provider', 'github-openapi').order('retrieved_at', { ascending: false }).limit(200),
    ]);
    const failed = [repoResult, findingResult].find(result => result.error);
    if (failed?.error) { setMessage(failed.error.message); return; }
    setRepositories((repoResult.data || []) as Repository[]);
    setFindings((findingResult.data || []) as LiveFinding[]);
    // Optional tables: an older database without them still shows the rest.
    setRepairJobs(jobResult.error ? [] : (jobResult.data || []) as RepairJob[]);
    setContractSources(sourceResult.error ? [] : sourceResult.data || []);
    setContractVersions(versionResult.error ? [] : versionResult.data || []);
    setContractConsumers(consumerResult.error ? [] : consumerResult.data || []);
    setContractSnapshots(snapshotResult.error ? [] : (snapshotResult.data || []) as ContractSnapshot[]);
    // Discovery state of the APIs this workspace calls (members only; never other workspaces').
    const watchResult = await supabase.rpc('workspace_api_watch_status', { p_workspace: chosen.id });
    setWatchStatus(watchResult.error ? [] : (watchResult.data || []) as WatchStatus[]);
    const reportResult = await supabase.from('cli_reports').select('repository_label,received_at,report')
      .eq('workspace_id', chosen.id).order('received_at', { ascending: false }).limit(50);
    setCliReports(reportResult.error ? [] : (reportResult.data || []) as CliReport[]);
    void loadActivity(chosen.id);
  }, [supabase, loadActivity]);

  useEffect(() => {
    if (!supabase) { setReady(true); return; }
    let active = true;
    supabase.auth.getUser().then(({ data }) => {
      if (!active) return;
      setUser(data.user);
      setReady(true);
      if (data.user) void refresh();
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!active) return;
      setUser(session?.user || null);
      if (session?.user) setTimeout(() => { void refresh(); }, 0);
      else { setWorkspace(null); setRepositories([]); setFindings([]); setRepairJobs([]); setActivity(null); }
    });
    return () => { active = false; listener.subscription.unsubscribe(); };
  }, [supabase, refresh]);

  useEffect(() => {
    if (ready && supabase && !user) window.location.replace('/login');
  }, [ready, supabase, user]);

  useEffect(() => {
    const result = new URLSearchParams(window.location.search).get('billing');
    if (result === 'success') setMessage('Thanks — your Pro plan is active once Stripe confirms the payment (usually a few seconds).');
    if (result === 'canceled') setMessage('Checkout canceled. You are still on the Free plan.');
  }, []);

  const accessToken = useCallback(async () => {
    if (!supabase) return null;
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  }, [supabase]);

  async function session() {
    const { data } = await supabase!.auth.getSession();
    if (!data.session) { setMessage('Please sign in again.'); return null; }
    return data.session.access_token;
  }

  async function createWorkspace() {
    if (!supabase || !user) return;
    setBusy(true); setMessage('');
    const { error } = await supabase.from('workspaces').insert({ name: workspaceName.trim(), owner_id: user.id });
    setMessage(error?.message || 'Workspace created.');
    if (!error) await refresh();
    setBusy(false);
  }

  async function addRepository() {
    if (!supabase || !workspace) return;
    setBusy(true); setMessage('');
    const { error } = await supabase.from('monitored_repositories').insert({ workspace_id: workspace.id, full_name: repositoryName.trim(), branch: branch.trim(), visibility: 'public' });
    setMessage(repositoryLimitMessage(error) || error?.message || 'Public repository added. Run a scan to inspect its current commit.');
    if (!error) { setRepositoryName(''); await refresh(); }
    setBusy(false);
  }

  async function scan(repositoryId: string) {
    if (!supabase || !workspace) return;
    setBusy(true); setMessage('');
    try {
      const token = await session();
      if (!token) return;
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
      if (repositories.find(repo => repo.id === repositoryId)?.github_installation_id) {
        const response = await fetch('/api/live/scan/installed', { method: 'POST', headers, body: JSON.stringify({ workspaceId: workspace.id, repositoryId }) });
        const result = await response.json() as { head?: string; status?: string; error?: string };
        setMessage(response.ok ? `Scan ${result.status === 'recent' ? 'already ran recently' : result.status} for commit ${result.head?.slice(0, 8) || 'unknown'}. Findings appear here when it finishes.` : result.error || 'Could not queue the scan.');
      } else {
        const response = await fetch('/api/live/scan', { method: 'POST', headers, body: JSON.stringify({ repositoryId }) });
        const result = await response.json() as { head?: string; inventory?: { calls?: CallSite[] }; error?: string };
        const calls = result.inventory?.calls ?? [];
        const hosts = new Set(calls.map(call => call.origin).filter(Boolean)).size;
        setMessage(response.ok && result.head ? `Scanned ${result.head.slice(0, 8)}: ${calls.length} API call${calls.length === 1 ? '' : 's'} to ${hosts} API${hosts === 1 ? '' : 's'}.` : result.error || 'Scan failed.');
      }
      await refresh();
    } catch { setMessage('Could not reach the scanner.'); }
    finally { setBusy(false); }
  }

  async function setDismissed(finding: LiveFinding, dismissed: boolean) {
    if (!supabase || !workspace) return;
    setDismissingId(finding.id); setMessage('');
    try {
      const token = await session();
      if (!token) return;
      const response = await fetch('/api/live/findings/dismiss', { method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: workspace.id, findingId: finding.id, dismissed }) });
      const result = await response.json() as { error?: string };
      setMessage(response.ok ? (dismissed ? 'Finding dismissed.' : 'Finding restored.') : result.error || 'Could not update the finding.');
      if (response.ok) await refresh();
    } catch { setMessage('Could not update the finding.'); }
    finally { setDismissingId(null); }
  }

  if (!ready) return <main className="live-shell"><p role="status">Opening your workspace…</p></main>;
  if (!supabase) return <main className="live-shell"><a href="/">← Home</a><h1>Live workspace unavailable</h1><p>Set the public Supabase URL and publishable key in the app environment.</p></main>;
  if (!user) return <main className="live-shell"><p role="status">Taking you to sign in…</p></main>;

  // Every external API the connected code calls, plus OpenAPI contracts kept in connected repositories.
  const services: ServiceCard[] = [
    ...deriveProviderServices(repositories, findings, cliReports, watchStatus).map(service => ({
      id: `provider:${service.id}`, name: service.name, origin: service.origin, status: service.status, tone: service.tone,
      note: service.source,
      detail: service.coverage === 'built-in'
        ? `Watched against the provider's published contract${service.pinnedVersions.length ? `; pinned to ${service.pinnedVersions.join(', ')}` : ''}.`
        : service.coverage === 'discovered' ? 'Found automatically: Mend located this API’s published OpenAPI description and checks it for changes twice a day.'
        : service.coverage === 'searching' ? 'Detected in your code. Mend is looking for this API’s published OpenAPI description; it is watched as soon as one is found.'
        : 'Detected in your code. This API publishes no OpenAPI description Mend could find, so its changes cannot be checked yet. Mend looks again every week.',
      operations: service.operations, findingIds: service.openFindings.map(finding => finding.id) })),
    ...deriveWatchedServices({ repositories, sources: contractSources, versions: contractVersions,
      consumers: contractConsumers, snapshots: contractSnapshots, findings: findings.map(finding => ({ ...finding, source_id: (finding as { source_id?: string | null }).source_id ?? null })) }).map(service => ({
      id: `contract:${service.id}`, name: service.name, origin: '', status: service.status, tone: service.tone,
      note: `OpenAPI contract in ${service.repositoryName} / ${service.path}`,
      detail: `${service.consumerNames.length} connected consumer codebase${service.consumerNames.length === 1 ? '' : 's'}. ${service.lastCheckedAt ? `Last contract scan ${new Date(service.lastCheckedAt).toLocaleString()}.` : 'First contract scan pending.'}`,
      operations: [], findingIds: service.findings.map(finding => finding.id) })),
  ];
  const repoName = new Map(repositories.map(repo => [repo.id, repo.full_name]));
  const findingTitle = new Map(findings.map(finding => [finding.id, finding.title]));
  const pullRequests = repairJobs.map(job => ({ id: job.id, findingId: job.finding_id, status: job.status, prUrl: job.pr_url,
    updatedAt: job.updated_at, repository: repoName.get(job.repository_id) || 'repository',
    title: findingTitle.get(job.finding_id) || 'API repair' }));

  return <LiveWorkspaceShell
    user={user}
    workspace={workspace}
    workspaceName={workspaceName}
    onWorkspaceNameChange={setWorkspaceName}
    onCreateWorkspace={() => void createWorkspace()}
    repositories={repositories}
    findings={findings}
    services={services}
    activity={activity}
    pullRequests={pullRequests}
    connections={workspace ? <>
      <GitHubConnections database={supabase} workspaceId={workspace.id} repositories={repositories} onConnectionsChange={() => void refresh()} />
      {contractSources.length > 0 && <DatabaseEvidenceSetup database={supabase} workspaceId={workspace.id} repositories={repositories} sources={contractSources} consumers={contractConsumers} />}
    </> : null}
    settings={workspace ? <AlertsSettings workspaceId={workspace.id} token={accessToken} /> : null}
    plan={workspace ? <PlanCard workspaceId={workspace.id} token={accessToken} billing={billing} onChange={() => void refresh()} /> : null}
    initialFindingId={initialFindingId}
    studio={workspace ? <ManagedApiStudio database={supabase} workspaceId={workspace.id} userId={user.id} /> : null}
    renderFinding={(finding: LiveFinding) => workspace && <FindingDetail database={supabase} workspaceId={workspace.id} finding={finding}
      busy={dismissingId === finding.id} onDismiss={dismissed => void setDismissed(finding, dismissed)} />}
    repositoryName={repositoryName}
    onRepositoryNameChange={setRepositoryName}
    branch={branch}
    onBranchChange={setBranch}
    onAddRepository={() => void addRepository()}
    onScan={(repositoryId: string) => void scan(repositoryId)}
    busy={busy}
    message={message}
    onSignOut={() => void supabase.auth.signOut()}
  />;
}
