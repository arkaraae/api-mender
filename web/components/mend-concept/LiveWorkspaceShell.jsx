'use client';

import { useMemo, useRef, useState } from 'react';
import {
  ActivityIcon as Activity, ArrowRightIcon as ArrowRight, BellIcon as Bell,
  CodeIcon as Code, GitBranchIcon as GitBranch, GitPullRequestIcon as GitPullRequest,
  HouseIcon as House, MagnifyingGlassIcon as Search, PlusIcon as Plus,
  SidebarSimpleIcon as SidebarSimple, SquaresFourIcon as SquaresFour,
  XIcon as X,
} from '@phosphor-icons/react';
import './concept.css';

const navigation = [
  { id: 'home', label: 'Home', icon: House },
  { id: 'activity', label: 'Activity', icon: Activity },
  { id: 'apis', label: 'APIs', icon: SquaresFour },
  { id: 'pulls', label: 'Pull requests', icon: GitPullRequest },
];

function ScanGrid({ repositories, onSelect }) {
  const scans = repositories.filter(repo => repo.scanned_at).slice().sort((a, b) => new Date(b.scanned_at) - new Date(a.scanned_at));
  const cells = Array.from({ length: 252 }, (_, index) => scans[index] || null);
  return <div className="live-scan-grid" role="group" aria-label="Latest repository scans. Select a square to see its report.">
    {cells.map((repo, index) => repo
      ? <button key={repo.id} type="button" className="live-scan-cell active" title={`${repo.full_name} · ${new Date(repo.scanned_at).toLocaleString()}`} aria-label={`Open latest scan report for ${repo.full_name}`} onClick={() => onSelect(repo)} />
      : <span key={`empty-${index}`} className="live-scan-cell" aria-hidden="true" />)}
  </div>;
}

function FindingList({ findings, onNavigate, limit }) {
  const rows = limit ? findings.slice(0, limit) : findings;
  if (!rows.length) return <p className="live-empty">No findings yet. Scan a repository or check an API source to begin.</p>;
  return <div className="live-result-list">{rows.map(finding => <article key={finding.id}>
    <span className="session-icon"><Code size={17} /></span>
    <div><strong>{finding.title}</strong><small>{finding.severity} · {finding.status} · {new Date(finding.created_at).toLocaleString()}</small>{!limit && <p>{finding.description}</p>}</div>
    {finding.evidence?.runUrl ? <a href={finding.evidence.runUrl} target="_blank" rel="noopener noreferrer" aria-label={`Open evidence for ${finding.title}`}><ArrowRight size={16} /></a> : limit ? <button onClick={() => onNavigate('pulls')} aria-label={`View ${finding.title}`}><ArrowRight size={16} /></button> : null}
  </article>)}</div>;
}

export default function LiveWorkspaceShell({ user, workspace, workspaceName, onWorkspaceNameChange, onCreateWorkspace, repositories, findings, awsSnapshot, repositoryName, onRepositoryNameChange, branch, onBranchChange, onAddRepository, onScan, onCheckSources, onCheckAwsSdk, studio, busy, message, onSignOut }) {
  const [section, setSection] = useState('home');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedScan, setSelectedScan] = useState(null);
  const searchInput = useRef(null);
  const scanned = repositories.filter(repo => repo.scanned_at);
  const pullFindings = findings.filter(finding => finding.evidence?.pullRequestUrl);
  const initials = (user.email || 'Mend').slice(0, 2).toUpperCase();
  const matches = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return [];
    return [
      ...repositories.filter(repo => repo.full_name.toLowerCase().includes(query)).map(repo => ({ id: repo.id, label: repo.full_name, detail: 'Repository', section: 'activity' })),
      ...findings.filter(finding => `${finding.title} ${finding.description}`.toLowerCase().includes(query)).map(finding => ({ id: finding.id, label: finding.title, detail: 'Finding', section: 'pulls' })),
    ].slice(0, 10);
  }, [search, repositories, findings]);
  const go = next => { setSection(next); setSidebarOpen(false); setSearchOpen(false); window.scrollTo(0, 0); };
  const openSearch = () => { setSearchOpen(true); setTimeout(() => searchInput.current?.focus(), 0); };

  return <div className="mend-concept live-product"><div className="canvas"><div className="window-shell">
    <header className="window-topbar"><button className="chrome-button sidebar-toggle" onClick={() => window.innerWidth <= 700 ? setSidebarOpen(value => !value) : setSidebarCollapsed(value => !value)} aria-label="Toggle sidebar"><SidebarSimple size={19} /></button><div className="window-title"><span className="mend-topbar-mark">⌁</span> mend <span>/</span> workspace</div><button className="top-search" onClick={openSearch}><Search size={15} /><span>Search Mend</span><kbd>⌘ K</kbd></button></header>
    <div className={`app-body ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      {sidebarOpen && <button className="sidebar-scrim" onClick={() => setSidebarOpen(false)} aria-label="Close sidebar" />}
      <aside className={`sidebar ${sidebarOpen ? 'sidebar--open' : ''}`} aria-label="Workspace sidebar">
        <div className="sidebar-heading"><img className="sidebar-wordmark" src="/mend-concept/mend-logo-white.png" alt="Mend" /><span className="sidebar-mini-mark" aria-hidden="true">⌁</span></div>
        <button className="new-session" onClick={() => go('activity')}><Plus size={18} /><span>New scan</span></button>
        <nav className="main-nav" aria-label="Workspace navigation">{navigation.map(({ id, label, icon: Icon }) => <button key={id} className={section === id ? 'active' : ''} onClick={() => go(id)} aria-current={section === id ? 'page' : undefined} aria-label={label} title={label}><Icon size={18} weight={section === id ? 'fill' : 'regular'} /><span>{label}</span>{id === 'pulls' && pullFindings.length > 0 && <span className="nav-count">{pullFindings.length}</span>}</button>)}</nav>
        <div className="sidebar-rule" />
        <div className="sidebar-subhead"><span>RECENT FINDINGS</span><Activity size={15} /></div>
        <div className="sidebar-sessions">{findings.slice(0, 4).map(finding => <button key={finding.id} onClick={() => go('pulls')}><span className="session-bullet"/><span>{finding.title}<small>{new Date(finding.created_at).toLocaleDateString()}</small></span></button>)}{findings.length === 0 && <p className="sidebar-empty">No findings yet</p>}</div>
        <div className="sidebar-bottom"><button className="sidebar-bottom-action" onClick={() => go('activity')}><Bell size={18}/><span>Activity</span></button><button className="sidebar-bottom-action sidebar-account" onClick={() => setAccountOpen(value => !value)} aria-expanded={accountOpen} aria-label="Account"><span className="sidebar-avatar">{initials}</span><span>{user.email}</span></button>{accountOpen && <div className="sidebar-account-menu"><span>{user.email}</span><small>{workspace?.name || 'Your workspace'}</small><button onClick={onSignOut}>Sign out</button></div>}</div>
      </aside>
      <main className="workspace"><div className="workspace-inner">
        {section === 'home' && <>
          <div className="hero"><h1>Make every API change<br/>a safe one.</h1><p>{workspace ? `${workspace.name} · ${repositories.length} monitored ${repositories.length === 1 ? 'repository' : 'repositories'}` : 'Create a workspace to start monitoring your APIs.'}</p></div>
          <div className="composer-brand"><img className="composer-wordmark" src="/mend-concept/mend-logo-white.png" alt="Mend" /></div>
          <div className="composer live-search-composer"><input value={search} onChange={event => setSearch(event.target.value)} onFocus={() => setSearchOpen(true)} onKeyDown={event => { if (event.key === 'Enter') openSearch(); }} placeholder="Search your repositories and findings…" aria-label="Search workspace" /><div className="composer-foot"><span>Explore your connected workspace</span><button className="send-button" onClick={openSearch} aria-label="Search"><ArrowRight size={18} /></button></div></div>
          <div className="suggestions"><button onClick={() => go('activity')}><Activity size={16}/>Scan a repository<ArrowRight size={13}/></button><button onClick={() => go('apis')}><SquaresFour size={16}/>Check APIs<ArrowRight size={13}/></button><button onClick={() => go('pulls')}><GitPullRequest size={16}/>Review findings<ArrowRight size={13}/></button></div>
          {!workspace && <section className="dashboard-card live-create"><span className="card-eyebrow">GET STARTED</span><h2>Create your workspace</h2><p>Name the workspace that will hold your repositories and API checks.</p><div className="live-fields"><label>Workspace name<input value={workspaceName} maxLength={120} onChange={event => onWorkspaceNameChange(event.target.value)} /></label></div><button disabled={busy || !workspaceName.trim()} onClick={onCreateWorkspace}>Create workspace</button></section>}
          {workspace && <div className="dashboard-grid">
            <section className="dashboard-card activity-card"><div className="card-heading"><div><span className="card-eyebrow"><Activity size={15}/> REPOSITORY SCANS</span><h2>Latest scans, in view.</h2></div></div><ScanGrid repositories={repositories} onSelect={setSelectedScan}/><div className="card-footer"><span><strong>{scanned.length}</strong> repositories scanned <i/> <strong>{findings.length}</strong> findings</span><button onClick={() => go('activity')}>View scans <ArrowRight size={14}/></button></div></section>
            <section className="dashboard-card recent-card"><div className="card-heading"><div><span className="card-eyebrow"><Activity size={15}/> RECENT FINDINGS</span><h2>Changes to review.</h2></div></div><FindingList findings={findings} onNavigate={go} limit={3}/><button className="text-link" onClick={() => go('pulls')}>All findings <ArrowRight size={14}/></button></section>
            <section className="dashboard-card metrics-card"><span className="card-eyebrow"><Activity size={15}/> THIS WORKSPACE</span><div className="metric-pair"><div><small>Repositories</small><strong>{repositories.length}</strong><span>{scanned.length} scanned</span></div><div><small>Findings</small><strong>{findings.length}</strong><span>{pullFindings.length} with pull requests</span></div></div></section>
            <section className="dashboard-card pulls-card"><div className="card-heading"><div><span className="card-eyebrow"><GitBranch size={15}/> REPOSITORIES</span><h2>Monitored codebases.</h2></div></div><div className="pull-list">{repositories.slice(0, 3).map(repo => <button key={repo.id} onClick={() => go('activity')}><GitBranch size={17}/><span><strong>{repo.full_name}</strong><small>{repo.scanned_at ? `Scanned ${new Date(repo.scanned_at).toLocaleDateString()}` : 'Waiting for first scan'}</small></span><ArrowRight size={14}/></button>)}{repositories.length === 0 && <p className="live-empty">Add a repository to begin monitoring.</p>}</div><button className="text-link" onClick={() => go('activity')}>All repositories <ArrowRight size={14}/></button></section>
          </div>}
        </>}
        {section !== 'home' && <div className="section-view live-section-view"><span className="section-eyebrow">MEND WORKSPACE / {section.toUpperCase()}</span><h1>{section === 'activity' ? 'Repository scans.' : section === 'apis' ? 'APIs in motion.' : 'Fixes in review.'}</h1><p>{section === 'activity' ? 'Scan your repositories and inspect their latest reports.' : section === 'apis' ? 'Manage your API and check official source updates.' : 'Review findings and proposed pull requests.'}</p>
          {section === 'activity' && <><section className="section-panel"><h2>Latest repository scans</h2><ScanGrid repositories={repositories} onSelect={setSelectedScan}/><div className="section-stats"><strong>{scanned.length}</strong> repositories scanned <strong>{findings.length}</strong> findings</div></section><section className="section-panel live-tool-card"><h2>Add a public GitHub repository</h2><p>Public scans read source files only. Private access and pull requests need a GitHub App installation.</p><div className="live-fields"><label>Owner/repository<input value={repositoryName} onChange={event => onRepositoryNameChange(event.target.value)}/></label><label>Branch<input value={branch} onChange={event => onBranchChange(event.target.value)}/></label></div><button disabled={busy || !repositoryName.trim() || !branch.trim() || !workspace} onClick={onAddRepository}>Add repository</button></section><section className="section-panel live-tool-card"><h2>Monitored repositories</h2>{repositories.length ? <div className="live-repo-list">{repositories.map(repo => <article key={repo.id}><div><strong>{repo.full_name}</strong><small>{repo.branch} · {repo.head_sha ? repo.head_sha.slice(0,8) : 'Not scanned'} · {repo.scanned_at ? new Date(repo.scanned_at).toLocaleString() : 'Waiting for first scan'}</small><p>{repo.api_version || repo.sdk_version || 'No API version identified'} · {repo.call_sites?.length || 0} call sites</p></div><button disabled={busy || repo.paused} onClick={() => onScan(repo.id)}>Scan now</button></article>)}</div> : <p className="live-empty">No repositories registered yet.</p>}</section></>}
          {section === 'apis' && <>{studio}<section className="section-panel live-tool-card"><h2>AWS SDK for JavaScript</h2><p>Check the official AWS SDK v3 release stream. The first check saves a baseline; later checks detect a new release version.</p><button disabled={busy || !workspace} onClick={onCheckAwsSdk}>Check AWS SDK updates</button>{awsSnapshot?.metadata && <p>Latest observed: {awsSnapshot.metadata.version} · <a href={awsSnapshot.metadata.evidenceUrl} target="_blank" rel="noopener noreferrer">Official release notes ↗</a></p>}</section><section className="section-panel live-tool-card"><h2>Check official Stripe sources</h2><p>Compare the latest Stripe Node release and OpenAPI file with your workspace baseline.</p><button disabled={busy || !workspace} onClick={onCheckSources}>Check Stripe sources</button></section></>}
          {section === 'pulls' && <><section className="section-panel live-tool-card"><h2>Findings</h2><FindingList findings={findings} onNavigate={go}/></section><section className="section-panel live-tool-card"><h2>Proposed pull requests</h2>{pullFindings.length ? <div className="live-repo-list">{pullFindings.map(finding => <article key={finding.id}><div><strong>{finding.title}</strong><small>{finding.status}</small></div><a href={finding.evidence.pullRequestUrl} target="_blank" rel="noopener noreferrer">Review PR <ArrowRight size={14}/></a></article>)}</div> : <p className="live-empty">No pull requests have been proposed yet.</p>}</section></>}
          <button className="back-home" onClick={() => go('home')}>← Back to workspace</button>
        </div>}
        {message && <p className="live-workspace-message" role="status">{message}</p>}
      </div></main>
    </div>
    {searchOpen && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setSearchOpen(false); }}><div className="search-modal" role="dialog" aria-modal="true" aria-label="Search workspace"><div className="search-input"><Search size={19}/><input ref={searchInput} autoFocus value={search} onChange={event => setSearch(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') setSearchOpen(false); }} placeholder="Search repositories and findings…"/><button onClick={() => setSearchOpen(false)} aria-label="Close search"><X size={16}/></button></div><div className="search-results"><span>RESULTS</span>{matches.length ? matches.map(result => <button key={result.id} onClick={() => go(result.section)}><Code size={17}/><span>{result.label}<small>{result.detail}</small></span><ArrowRight size={16}/></button>) : <p>{search.trim() ? 'No matching repositories or findings.' : 'Type to search your connected workspace.'}</p>}</div></div></div>}
    {selectedScan && <div className="detail-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setSelectedScan(null); }}><aside className="detail-panel" role="dialog" aria-modal="true" aria-label={`${selectedScan.full_name} scan report`}><button className="detail-close" onClick={() => setSelectedScan(null)} aria-label="Close scan report"><X size={19}/></button><span className="detail-kicker">REPOSITORY SCAN</span><h2>{selectedScan.full_name}</h2><p>Scanned {new Date(selectedScan.scanned_at).toLocaleString()}</p><div className="detail-evidence"><span>REPORT</span><div><GitBranch size={16}/><strong>Branch</strong><small>{selectedScan.branch} · {selectedScan.head_sha?.slice(0,8) || 'Unknown commit'}</small></div><div><Code size={16}/><strong>API version</strong><small>{selectedScan.api_version || 'Not identified'}</small></div><div><Activity size={16}/><strong>Call sites</strong><small>{selectedScan.call_sites?.length || 0} found</small></div>{selectedScan.limitations?.length > 0 && <div><Bell size={16}/><strong>Limitations</strong><small>{selectedScan.limitations.join('; ')}</small></div>}</div><a className="detail-cta" href={`https://github.com/${selectedScan.full_name}`} target="_blank" rel="noopener noreferrer">Open repository <ArrowRight size={16}/></a></aside></div>}
  </div></div></div>;
}
