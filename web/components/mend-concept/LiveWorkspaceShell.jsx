'use client';

// The signed-in Mend workspace. Layout and styling are the Mend design; every
// number, list and action comes from the workspace's real backend state
// (app/live/page.tsx loads it and passes it in).
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIcon as Activity, ArrowRightIcon as ArrowRight, BellIcon as Bell,
  CodeIcon as Code, GitBranchIcon as GitBranch, GithubLogoIcon as GithubLogo, GitPullRequestIcon as GitPullRequest,
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

// Repair job states, in the words a reviewer needs.
const pullStatus = {
  proposed: 'Patch ready to open', publishing: 'Opening draft PR', proof_pending: 'Waiting for CI',
  validated: 'CI passed', proof_failed: 'CI failed', proof_stale: 'Branch moved; re-check', superseded: 'Superseded',
};

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

// The four-colour Slack mark, drawn here so the button can be greyed out
// with CSS when Slack is not connected.
function SlackMark({ size = 16 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <rect x="2" y="8.6" width="9.4" height="3.4" rx="1.7" fill="#36C5F0"/><rect x="8" y="2" width="3.4" height="5.6" rx="1.7" fill="#36C5F0"/>
    <rect x="12.6" y="2" width="3.4" height="9.4" rx="1.7" fill="#2EB67D"/><rect x="18.4" y="8.6" width="3.6" height="3.4" rx="1.7" fill="#2EB67D"/>
    <rect x="8" y="12.6" width="3.4" height="9.4" rx="1.7" fill="#E01E5A"/><rect x="2" y="12.6" width="3.6" height="3.4" rx="1.7" fill="#E01E5A"/>
    <rect x="12.6" y="12.6" width="9.4" height="3.4" rx="1.7" fill="#ECB22E"/><rect x="12.6" y="16.4" width="3.4" height="5.6" rx="1.7" fill="#ECB22E"/>
  </svg>;
}

const channelName = channel => channel === 'slack' ? 'Slack' : 'GitHub issue';
const ChannelIcon = ({ channel, size = 15 }) => channel === 'slack' ? <SlackMark size={size}/> : <GithubLogo size={size} weight="fill"/>;
const deliveryWords = { sent: 'sent', failed: 'failed', pending: 'sending', skipped: 'skipped' };

// Where alerts go, as buttons: bright when connected, greyed out when not.
// Any of them opens the integrations panel.
function integrationList(alerts) {
  const view = alerts?.view;
  const editorOnly = alerts?.access === 'editor-only';
  const slackOn = Boolean(view?.slackHint);
  const githubOn = Boolean(view?.githubIssues);
  return [
    { id: 'slack', label: 'Slack', on: slackOn, icon: <SlackMark size={16}/>,
      title: slackOn ? `Slack: posting to ${view.slackHint}` : editorOnly ? 'Slack: not connected (an editor can connect it)'
        : view && !view.slackAvailable ? 'Slack: not available on this site yet' : 'Slack: not connected. Click to connect' },
    { id: 'github', label: 'GitHub issues', on: githubOn, icon: <GithubLogo size={16} weight="fill"/>,
      title: githubOn ? 'GitHub issues: on' : editorOnly ? 'GitHub issues: off (an editor can turn them on)' : 'GitHub issues: off. Click to turn on' },
  ];
}

function AlertFeed({ alerts, findings, onOpenFinding, onManage, limit }) {
  const view = alerts?.view;
  const rows = (view?.recent ?? []).slice(0, limit ?? 30);
  if (alerts?.access === 'editor-only') return <p className="live-empty">Alerts go to the channels a workspace editor connects. New findings always appear in Activity.</p>;
  if (!view) return <p className="live-empty">Loading alerts…</p>;
  if (!rows.length) return <div className="mend-alert-empty"><p className="live-empty">{view.slackHint || view.githubIssues
    ? 'No alerts sent yet. When a provider change affects your code, each alert shows up here.'
    : 'No alert channels connected. Connect Slack or GitHub issues and every alert shows up here too.'}</p>
    {!view.slackHint && !view.githubIssues && <button className="mend-link-button" onClick={onManage}>Connect an app →</button>}</div>;
  return <div className="mend-alert-feed">{rows.map(row => {
    const finding = findings.find(item => item.id === row.finding_id);
    return <article key={`${row.finding_id}:${row.channel}`} className={`mend-alert-row is-${row.status}`}>
      <span className="mend-alert-icon"><ChannelIcon channel={row.channel}/></span>
      <div><strong>{finding ? <button className="mend-link-button" onClick={() => onOpenFinding(finding)}>{finding.title}</button> : 'Finding'}</strong>
        <small>{channelName(row.channel)} · {deliveryWords[row.status] || row.status} · {new Date(row.updated_at).toLocaleString()}{row.status === 'failed' && row.detail ? ` · ${row.detail}` : ''}</small></div>
      {row.url && <a href={row.url} target="_blank" rel="noopener noreferrer">Open issue <ArrowRight size={13}/></a>}
    </article>;
  })}</div>;
}

// One square per day, today first: scans and provider checks that day,
// brighter when busier. Each day opens what ran that day.
function ActivityGrid({ days, selected, onSelect }) {
  if (!days?.length) return <div className="live-scan-grid" aria-hidden="true">{Array.from({ length: 252 }, (_, index) => <span key={index} className="live-scan-cell" />)}</div>;
  const newestFirst = [...days].reverse();
  return <div className="live-scan-grid" role="group" aria-label={`Scans and checks over the last ${days.length} days, most recent first`}>
    {newestFirst.map((day, index) => {
      const total = day.scans + day.checks;
      const level = total === 0 ? 0 : total < 3 ? 1 : total < 8 ? 2 : 3;
      const label = `${index === 0 ? 'Today' : day.date}: ${plural(day.scans, 'scan')}, ${plural(day.checks, 'check')}, ${day.flagged} flagged`;
      return <button type="button" key={day.date} className={`live-scan-cell level-${level}${day.flagged ? ' flagged' : ''}${index === 0 ? ' today' : ''}${selected === day.date ? ' selected' : ''}`}
        title={label} aria-label={label} aria-pressed={selected === day.date} onClick={() => onSelect?.(selected === day.date ? null : day.date)} />;
    })}
  </div>;
}

// What ran on one day: counts, repositories last scanned that day, findings raised that day.
function DayDetail({ day, repositories, findings, alerts, onReport, onOpenFinding, onClose }) {
  if (!day) return null;
  const sameDay = value => value && new Date(value).toISOString().slice(0, 10) === day.date;
  const scanned = repositories.filter(repo => sameDay(repo.scanned_at));
  const raised = findings.filter(finding => sameDay(finding.created_at));
  const sent = (alerts?.view?.recent ?? []).filter(row => row.status === 'sent' && sameDay(row.updated_at));
  const label = new Date(`${day.date}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  return <div className="mend-day-detail">
    <div className="mend-day-head"><strong>{label}</strong><span>{plural(day.scans, 'scan')} · {plural(day.checks, 'check')} · {day.flagged} flagged</span><button type="button" onClick={onClose} aria-label="Close day"><X size={14}/></button></div>
    {scanned.map(repo => <button type="button" key={repo.id} onClick={() => onReport(repo)}><Code size={14}/><span><strong>{repo.full_name}</strong><small>{repo.head_sha ? repo.head_sha.slice(0, 8) : ''} · {plural(repo.call_sites?.length || 0, 'API call')} · {new Date(repo.scanned_at).toLocaleTimeString()}</small></span><ArrowRight size={14}/></button>)}
    {raised.map(finding => <button type="button" key={finding.id} onClick={() => onOpenFinding(finding)}><Activity size={14}/><span><strong>{finding.title}</strong><small>{finding.severity} · {finding.status}</small></span><ArrowRight size={14}/></button>)}
    {sent.map(row => { const finding = findings.find(item => item.id === row.finding_id); return <button type="button" key={`${row.finding_id}:${row.channel}`} onClick={() => finding ? onOpenFinding(finding) : row.url && window.open(row.url, '_blank', 'noopener')}><ChannelIcon channel={row.channel} size={14}/><span><strong>Alert: {finding?.title || 'finding'}</strong><small>{channelName(row.channel)} · {new Date(row.updated_at).toLocaleTimeString()}</small></span><ArrowRight size={14}/></button>; })}
    {!scanned.length && !raised.length && !sent.length && <p>{day.scans + day.checks ? 'Repositories were scanned or rechecked this day; their latest scan reports are newer. Open Activity for every repository.' : 'Nothing ran this day.'}</p>}
  </div>;
}

function FindingList({ findings, onOpen, limit }) {
  const rows = limit ? findings.slice(0, limit) : findings;
  if (!rows.length) return <p className="live-empty">No findings yet. Connect a repository and Mend will flag API changes that affect it.</p>;
  return <div className="live-result-list">{rows.map(finding => <article key={finding.id}>
    <span className="session-icon"><Code size={17} /></span>
    <div><strong>{finding.title}</strong><small>{finding.severity} · {finding.status} · {new Date(finding.created_at).toLocaleString()}</small>{!limit && <p>{finding.description}</p>}</div>
    <button onClick={() => onOpen(finding)} aria-label={`Open ${finding.title}`}><ArrowRight size={16} /></button>
  </article>)}</div>;
}

export default function LiveWorkspaceShell({
  user, workspace, workspaceName, onWorkspaceNameChange, onCreateWorkspace,
  repositories, findings, services, activity, pullRequests,
  connections, renderFinding, settings, alerts, plan, initialFindingId,
  repositoryName, onRepositoryNameChange, branch, onBranchChange, onAddRepository, onScan,
  busy, message, onSignOut,
}) {
  const [section, setSection] = useState('home');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedScan, setSelectedScan] = useState(null);
  const [selectedFindingId, setSelectedFindingId] = useState(initialFindingId || null);
  const [selectedDay, setSelectedDay] = useState(null);
  const selectedDayData = activity?.days?.find(day => day.date === selectedDay) ?? null;
  const dayDetail = <DayDetail day={selectedDayData} repositories={repositories} findings={findings} alerts={alerts}
    onReport={repo => setSelectedScan(repo)} onOpenFinding={finding => openFinding(finding)} onClose={() => setSelectedDay(null)} />;
  const [showDismissed, setShowDismissed] = useState(false);
  const [integrationsOpen, setIntegrationsOpen] = useState(false);
  const integrations = integrationList(alerts);
  useEffect(() => {
    if (!integrationsOpen) return;
    const close = event => { if (event.key === 'Escape') setIntegrationsOpen(false); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [integrationsOpen]);
  const connectedApps = integrations.filter(item => item.on);

  // Activity badge: findings and sent alerts newer than the last time this
  // person opened Activity (kept per browser; a first visit starts at now).
  const seenKey = workspace ? `mend.activitySeen.${workspace.id}` : null;
  const [seenAt, setSeenAt] = useState(null);
  useEffect(() => {
    if (!seenKey) return;
    let stored = null;
    try { stored = window.localStorage.getItem(seenKey); } catch { /* storage blocked */ }
    const value = stored || new Date().toISOString();
    if (!stored) { try { window.localStorage.setItem(seenKey, value); } catch { /* storage blocked */ } }
    setSeenAt(value);
  }, [seenKey]);
  const unseen = useMemo(() => {
    if (!seenAt) return [];
    const after = value => value && value > seenAt;
    return [
      ...(alerts?.view?.recent ?? []).filter(row => row.status === 'sent' && after(row.updated_at)).map(row => ({ key: `a:${row.finding_id}:${row.channel}`, at: row.updated_at, row })),
      ...findings.filter(finding => finding.status !== 'Dismissed' && after(finding.created_at)).map(finding => ({ key: `f:${finding.id}`, at: finding.created_at, finding })),
    ].sort((a, b) => b.at.localeCompare(a.at));
  }, [seenAt, alerts, findings]);
  useEffect(() => {
    if (section !== 'activity' || !seenKey) return;
    const now = new Date().toISOString();
    try { window.localStorage.setItem(seenKey, now); } catch { /* storage blocked */ }
    setSeenAt(now);
  }, [section, seenKey, alerts?.view?.recent?.length, findings.length]);
  // A toast when something new arrives while the workspace is open.
  const [toast, setToast] = useState(null);
  const shown = useRef('');
  const [openedAt] = useState(() => new Date().toISOString());
  useEffect(() => {
    const newest = unseen[0];
    // Only things that happened after the page opened; older unseen items are the badge's job.
    if (!newest || newest.at <= openedAt || newest.key === shown.current) return;
    shown.current = newest.key;
    const title = newest.row ? findings.find(item => item.id === newest.row.finding_id)?.title : newest.finding.title;
    setToast(newest.row ? `Alert sent to ${channelName(newest.row.channel)}: ${title || 'a finding'}` : `New finding: ${title}`);
  }, [unseen, findings, openedAt]);
  const searchInput = useRef(null);
  const openFindings = findings.filter(finding => finding.status !== 'Dismissed');
  const listedFindings = showDismissed ? findings : openFindings;
  const selectedFinding = findings.find(finding => finding.id === selectedFindingId) || null;
  const openPulls = pullRequests.filter(pull => !['superseded'].includes(pull.status));
  const scanned = repositories.filter(repo => repo.scanned_at);
  const month = activity?.thisMonth;
  const monthDelta = month ? month.changesChecked - month.previousMonthChangesChecked : 0;
  const initials = (user.email || 'Mend').slice(0, 2).toUpperCase();
  const matches = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return [];
    return [
      ...repositories.filter(repo => repo.full_name.toLowerCase().includes(query)).map(repo => ({ id: repo.id, label: repo.full_name, detail: 'Repository', open: () => go('activity') })),
      ...services.filter(service => `${service.name} ${service.origin}`.toLowerCase().includes(query)).map(service => ({ id: service.id, label: service.name, detail: 'API', open: () => go('apis') })),
      ...findings.filter(finding => `${finding.title} ${finding.description}`.toLowerCase().includes(query)).map(finding => ({ id: finding.id, label: finding.title, detail: 'Finding', open: () => openFinding(finding) })),
    ].slice(0, 10);
  }, [search, repositories, services, findings]); // eslint-disable-line react-hooks/exhaustive-deps
  function go(next) { setSection(next); setSidebarOpen(false); setSearchOpen(false); window.scrollTo(0, 0); }
  function openFinding(finding) { setSelectedFindingId(finding.id); setSearchOpen(false); setSidebarOpen(false); }
  const openSearch = () => { setSearchOpen(true); setTimeout(() => searchInput.current?.focus(), 0); };

  return <div className="mend-concept live-product"><div className="canvas"><div className="window-shell">
    <header className="window-topbar"><button className="chrome-button sidebar-toggle" onClick={() => window.innerWidth <= 700 ? setSidebarOpen(value => !value) : setSidebarCollapsed(value => !value)} aria-label="Toggle sidebar"><SidebarSimple size={19} /></button><div className="window-title"><span className="mend-topbar-mark">⌁</span> mend <span>/</span> workspace</div><button className="top-search" onClick={openSearch}><Search size={15} /><span>Search Mend</span><kbd>⌘ K</kbd></button></header>
    <div className={`app-body ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      {sidebarOpen && <button className="sidebar-scrim" onClick={() => setSidebarOpen(false)} aria-label="Close sidebar" />}
      <aside className={`sidebar ${sidebarOpen ? 'sidebar--open' : ''}`} aria-label="Workspace sidebar">
        <div className="sidebar-heading"><img className="sidebar-wordmark" src="/mend-concept/mend-logo-white.png" alt="Mend" /><span className="sidebar-mini-mark" aria-hidden="true">⌁</span></div>
        <button className="new-session" onClick={() => go('activity')}><Plus size={18} /><span>New scan</span></button>
        <nav className="main-nav" aria-label="Workspace navigation">{navigation.map(({ id, label, icon: Icon }) => <button key={id} className={section === id ? 'active' : ''} onClick={() => go(id)} aria-current={section === id ? 'page' : undefined} aria-label={label} title={label}><Icon size={18} weight={section === id ? 'fill' : 'regular'} /><span>{label}</span>
          {id === 'activity' && unseen.length > 0 && <span className="nav-count mend-unseen" aria-label={`${unseen.length} new`}>{unseen.length}</span>}
          {id === 'apis' && services.length > 0 && <span className="nav-count">{services.length}</span>}
          {id === 'pulls' && openPulls.length + openFindings.length > 0 && <span className="nav-count">{openPulls.length || openFindings.length}</span>}</button>)}</nav>
        <div className="sidebar-rule" />
        <div className="sidebar-subhead"><span>RECENT FINDINGS</span><Activity size={15} /></div>
        <div className="sidebar-sessions">{openFindings.slice(0, 4).map(finding => <button key={finding.id} onClick={() => openFinding(finding)}><span className="session-bullet"/><span>{finding.title}<small>{new Date(finding.created_at).toLocaleDateString()}</small></span></button>)}{openFindings.length === 0 && <p className="sidebar-empty">No open findings</p>}</div>
        <div className="sidebar-bottom"><button className="sidebar-bottom-action mend-bell" onClick={() => go('activity')} aria-label={unseen.length ? `Activity, ${unseen.length} new` : 'Activity'}><Bell size={18} weight={unseen.length ? 'fill' : 'regular'}/>{unseen.length > 0 && <i aria-hidden="true"/>}<span>Activity</span></button><button className="sidebar-bottom-action sidebar-account" onClick={() => setAccountOpen(value => !value)} aria-expanded={accountOpen} aria-label="Account"><span className="sidebar-avatar">{initials}</span><span>{user.email}</span></button>{accountOpen && <div className="sidebar-account-menu"><span>{user.email}</span><small>{workspace?.name || 'Your workspace'}</small><button onClick={onSignOut}>Sign out</button></div>}</div>
      </aside>
      <main className="workspace"><div className="workspace-inner">
        {section === 'home' && <>
          <div className="hero"><h1>Make every API change<br/>a safe one.</h1><p>{workspace ? `${workspace.name} · ${repositories.length} monitored ${repositories.length === 1 ? 'repository' : 'repositories'} · ${plural(services.length, 'API')}` : 'Create a workspace to start monitoring your APIs.'}</p></div>
          <div className="composer-brand"><img className="composer-wordmark" src="/mend-concept/mend-logo-white.png" alt="Mend" /></div>
          <div className="composer live-search-composer"><input value={search} onChange={event => setSearch(event.target.value)} onFocus={() => setSearchOpen(true)} onKeyDown={event => { if (event.key === 'Enter') openSearch(); }} placeholder="Search your repositories, APIs and findings…" aria-label="Search workspace" /><div className="composer-foot"><div className="mend-integrations" role="group" aria-label="Alert integrations">{integrations.map(item => <button type="button" key={item.id} className={`mend-integration ${item.on ? 'is-on' : 'is-off'}`} disabled={!workspace} title={item.title} aria-label={item.title} aria-pressed={item.on} onClick={() => setIntegrationsOpen(true)}>{item.icon}{item.on && <i aria-hidden="true"/>}</button>)}<span>{!workspace ? 'Create a workspace to connect apps' : connectedApps.length ? `Alerts to ${connectedApps.map(item => item.label).join(' and ')}` : 'Connect an app for alerts'}</span></div><button className="send-button" onClick={openSearch} aria-label="Search"><ArrowRight size={18} /></button></div></div>
          <div className="suggestions"><button onClick={() => go('activity')}><Activity size={16}/>Connect or scan a repository<ArrowRight size={13}/></button><button onClick={() => go('apis')}><SquaresFour size={16}/>See detected APIs<ArrowRight size={13}/></button><button onClick={() => go('pulls')}><GitPullRequest size={16}/>Review findings<ArrowRight size={13}/></button></div>
          {!workspace && <section className="dashboard-card live-create"><span className="card-eyebrow">GET STARTED</span><h2>Create your workspace</h2><p>Name the workspace that will hold your repositories and API checks.</p><div className="live-fields"><label>Workspace name<input value={workspaceName} maxLength={120} onChange={event => onWorkspaceNameChange(event.target.value)} /></label></div><button disabled={busy || !workspaceName.trim()} onClick={onCreateWorkspace}>Create workspace</button></section>}
          {workspace && repositories.length === 0 && <section className="dashboard-card mend-onboarding"><span className="card-eyebrow">GET STARTED</span><h2>Three steps to your first finding.</h2>
            <ol>
              <li><strong>Connect GitHub.</strong> Choose the repositories Mend may read. Nothing to install in your code.</li>
              <li><strong>First scan runs on its own.</strong> Mend lists every API your code calls: fetch, axios, requests, and the GitHub, Stripe, OpenAI and Twilio SDKs.</li>
              <li><strong>Turn on alerts.</strong> Get a Slack message or a GitHub issue when a provider change breaks a call.</li>
            </ol>
            <button onClick={() => go('activity')}>Connect GitHub <ArrowRight size={14}/></button></section>}
          {workspace && <div className="dashboard-grid">
            <section className="dashboard-card activity-card"><div className="card-heading"><div><span className="card-eyebrow"><Activity size={15}/> REPOSITORY SCANS</span><h2>Codebase scans, in view.</h2></div><span className="count-pill">{activity ? `${activity.days.length} days` : 'Loading'}</span></div><ActivityGrid days={activity?.days} selected={selectedDay} onSelect={setSelectedDay}/>{dayDetail}<div className="card-footer"><span><strong>{activity?.totals.scans ?? 0}</strong> scans run <i/> <strong>{activity?.totals.checks ?? 0}</strong> checks <i/> <strong>{activity?.totals.flagged ?? 0}</strong> changes flagged</span><button onClick={() => go('activity')}>View scans <ArrowRight size={14}/></button></div></section>
            <section className="dashboard-card recent-card"><div className="card-heading"><div><span className="card-eyebrow"><Activity size={15}/> RECENT FINDINGS</span><h2>Changes to review.</h2></div></div><FindingList findings={openFindings} onOpen={openFinding} limit={3}/><button className="text-link" onClick={() => go('pulls')}>All findings <ArrowRight size={14}/></button></section>
            <section className="dashboard-card metrics-card"><span className="card-eyebrow"><Activity size={15}/> THIS MONTH</span><div className="metric-pair"><div><small>API changes checked</small><strong>{month?.changesChecked ?? 0}</strong><span>{month ? `${monthDelta >= 0 ? '+' : ''}${monthDelta} from last month` : 'Loading'}</span></div><div><small>Fixes validated</small><strong>{month?.repairsValidated ?? 0}</strong><span>{month ? `of ${plural(month.repairsProposed, 'proposed fix')}` : 'Loading'}</span></div></div></section>
            <section className="dashboard-card pulls-card"><div className="card-heading"><div><span className="card-eyebrow"><GitPullRequest size={15}/> PULL REQUESTS</span><h2>Fixes ready for review.</h2></div><span className="count-pill">{openPulls.length} open</span></div><div className="pull-list">{openPulls.slice(0, 3).map(pull => <button key={pull.id} onClick={() => pull.prUrl ? window.open(pull.prUrl, '_blank', 'noopener') : go('pulls')}><GitPullRequest size={17}/><span><strong>{pull.title}</strong><small>{pull.repository} <i/> {pullStatus[pull.status] || pull.status}</small></span><ArrowRight size={14}/></button>)}{openPulls.length === 0 && <p className="live-empty">No fixes proposed yet. Open a finding to propose one.</p>}</div><button className="text-link" onClick={() => go('pulls')}>All pull requests <ArrowRight size={14}/></button></section>
          </div>}
          {workspace && plan && <div className="mend-plan-row">{plan}</div>}
        </>}
        {section !== 'home' && <div className="section-view live-section-view"><span className="section-eyebrow">MEND WORKSPACE / {section === 'pulls' ? 'PULL REQUESTS' : section.toUpperCase()}</span><h1>{section === 'activity' ? 'Repository scans.' : section === 'apis' ? 'APIs in motion.' : 'Fixes in review.'}</h1><p>{section === 'activity' ? 'Connect repositories, run scans and inspect their latest reports.' : section === 'apis' ? 'Every external API your connected code calls, and whether Mend watches its published contract.' : 'Review findings, propose bounded fixes and track their draft pull requests.'}</p>
          {section === 'activity' && <>
            <section className="section-panel"><h2>Scans and checks</h2><ActivityGrid days={activity?.days} selected={selectedDay} onSelect={setSelectedDay}/>{dayDetail}<div className="section-stats"><strong>{activity?.totals.scans ?? 0}</strong> scans <strong>{activity?.totals.checks ?? 0}</strong> checks <strong>{activity?.totals.flagged ?? 0}</strong> flagged</div></section>
            {workspace && <section className="section-panel live-tool-card mend-embed"><h2>Connect repositories</h2>{connections}</section>}
            {workspace && <section className="section-panel live-tool-card" id="mend-alert-feed"><div className="mend-panel-heading"><h2>Alerts</h2><div className="mend-integrations mend-integrations--panel">{integrations.map(item => <button type="button" key={item.id} className={`mend-integration ${item.on ? 'is-on' : 'is-off'}`} title={item.title} aria-label={item.title} onClick={() => setIntegrationsOpen(true)}>{item.icon}{item.on && <i aria-hidden="true"/>}</button>)}<button className="mend-link-button" onClick={() => setIntegrationsOpen(true)}>Manage</button></div></div>
              <AlertFeed alerts={alerts} findings={findings} onOpenFinding={openFinding} onManage={() => setIntegrationsOpen(true)}/></section>}
            <section className="section-panel live-tool-card"><h2>Monitored repositories</h2>{repositories.length ? <div className="live-repo-list">{repositories.map(repo => <article key={repo.id}><div><strong>{repo.full_name}</strong><small>{repo.branch} · {repo.head_sha ? repo.head_sha.slice(0, 8) : 'Not scanned'} · {repo.scanned_at ? `Scanned ${new Date(repo.scanned_at).toLocaleString()}` : 'Waiting for first scan'}{repo.github_installation_id ? ' · GitHub App' : ' · public'}</small><p>{plural(repo.call_sites?.length || 0, 'API call')} found{repo.paused ? ' · paused' : ''}</p></div><div className="mend-row-actions">{repo.scanned_at && <button onClick={() => setSelectedScan(repo)}>Report</button>}<button disabled={busy || repo.paused} onClick={() => onScan(repo.id)}>Scan now</button></div></article>)}</div> : <p className="live-empty">No repositories yet. Connect one with the GitHub App above, or add a public repository below.</p>}</section>
            <section className="section-panel live-tool-card"><h2>Add a public GitHub repository</h2><p>Public scans read source files only. Draft pull requests need the GitHub App.</p><div className="live-fields"><label>Owner/repository<input value={repositoryName} onChange={event => onRepositoryNameChange(event.target.value)}/></label><label>Branch<input value={branch} onChange={event => onBranchChange(event.target.value)}/></label></div><button disabled={busy || !repositoryName.trim() || !branch.trim() || !workspace} onClick={onAddRepository}>Add repository</button></section>
          </>}
          {section === 'apis' && <>
            <section className="section-panel live-tool-card"><h2>Integrated services</h2>{services.length ? <div className="live-repo-list mend-service-list">{services.map(service => <article key={service.id}><div>
              <strong>{service.name} <span className={`mend-chip mend-chip--${service.tone}`}>{service.status}</span></strong>
              <small>{service.origin ? `${service.origin} · ` : ''}{service.note}</small>
              {service.detail && <p>{service.detail}</p>}
              {service.operations.length > 0 && <p className="mend-operations">{service.operations.slice(0, 8).map(operation => <code key={operation}>{operation}</code>)}{service.operations.length > 8 && <span>+{service.operations.length - 8} more</span>}</p>}
              {service.findingIds.length > 0 && <p>{service.findingIds.map(id => { const finding = findings.find(item => item.id === id); return finding && <button key={id} className="mend-link-button" onClick={() => openFinding(finding)}>Review: {finding.title}</button>; })}</p>}
            </div></article>)}</div> : <p className="live-empty">No external API calls found yet. Scan a repository and the APIs it calls appear here.</p>}</section>
          </>}
          {section === 'pulls' && <>
            <section className="section-panel live-tool-card"><div className="mend-panel-heading"><h2>Findings</h2>{findings.length > openFindings.length && <button className="mend-link-button" onClick={() => setShowDismissed(value => !value)}>{showDismissed ? 'Hide dismissed' : `Show ${findings.length - openFindings.length} dismissed`}</button>}</div><FindingList findings={listedFindings} onOpen={openFinding}/></section>
            <section className="section-panel live-tool-card"><h2>Proposed pull requests</h2>{pullRequests.length ? <div className="live-repo-list">{pullRequests.map(pull => <article key={pull.id}><div><strong>{pull.title}</strong><small>{pull.repository} · {pullStatus[pull.status] || pull.status} · {new Date(pull.updatedAt).toLocaleString()}</small></div><div className="mend-row-actions">{pull.findingId && <button onClick={() => { const finding = findings.find(item => item.id === pull.findingId); if (finding) openFinding(finding); }}>Details</button>}{pull.prUrl && <a href={pull.prUrl} target="_blank" rel="noopener noreferrer">Review PR <ArrowRight size={14}/></a>}</div></article>)}</div> : <p className="live-empty">No fixes proposed yet. Open a finding and choose “Propose bounded repair”.</p>}</section>
          </>}
          <button className="back-home" onClick={() => go('home')}>← Back to workspace</button>
        </div>}
        {message && <p className="live-workspace-message" role="status">{message}</p>}
      </div></main>
    </div>
    {searchOpen && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setSearchOpen(false); }}><div className="search-modal" role="dialog" aria-modal="true" aria-label="Search workspace"><div className="search-input"><Search size={19}/><input ref={searchInput} autoFocus value={search} onChange={event => setSearch(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') setSearchOpen(false); }} placeholder="Search repositories, APIs and findings…"/><button onClick={() => setSearchOpen(false)} aria-label="Close search"><X size={16}/></button></div><div className="search-results"><span>RESULTS</span>{matches.length ? matches.map(result => <button key={`${result.detail}:${result.id}`} onClick={result.open}><Code size={17}/><span>{result.label}<small>{result.detail}</small></span><ArrowRight size={16}/></button>) : <p>{search.trim() ? 'No matching repositories, APIs or findings.' : 'Type to search your connected workspace.'}</p>}</div></div></div>}
    {integrationsOpen && workspace && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setIntegrationsOpen(false); }}><div className="mend-integrations-modal" role="dialog" aria-modal="true" aria-label="Connected apps"><div className="mend-integrations-modal-head"><strong>Connected apps</strong><button onClick={() => setIntegrationsOpen(false)} aria-label="Close"><X size={16}/></button></div>{settings}</div></div>}
    {toast && <div className="toast" role="status"><Bell size={15} weight="fill"/><span>{toast}</span><button onClick={() => { setToast(null); go('activity'); }}>View</button><button onClick={() => setToast(null)} aria-label="Dismiss"><X size={13}/></button></div>}
    {selectedScan && <div className="detail-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setSelectedScan(null); }}><aside className="detail-panel" role="dialog" aria-modal="true" aria-label={`${selectedScan.full_name} scan report`}><button className="detail-close" onClick={() => setSelectedScan(null)} aria-label="Close scan report"><X size={19}/></button><span className="detail-kicker">REPOSITORY SCAN</span><h2>{selectedScan.full_name}</h2><p>Scanned {new Date(selectedScan.scanned_at).toLocaleString()}</p><div className="detail-evidence"><span>REPORT</span><div><GitBranch size={16}/><strong>Branch</strong><small>{selectedScan.branch} · {selectedScan.head_sha?.slice(0, 8) || 'Unknown commit'}</small></div><div><Code size={16}/><strong>API calls</strong><small>{plural(selectedScan.call_sites?.length || 0, 'call')} across {plural(new Set((selectedScan.call_sites || []).map(call => call.origin).filter(Boolean)).size, 'API')}</small></div>{(selectedScan.call_sites || []).slice(0, 12).map((call, index) => <div key={`${call.file}:${call.line}:${index}`}><Activity size={16}/><strong>{call.endpoint || call.symbol}</strong><small>{call.origin ? `${new URL(call.origin).host} · ` : ''}{call.file}:{call.line}</small></div>)}{selectedScan.limitations?.length > 0 && <div><Bell size={16}/><strong>Limitations</strong><small>{selectedScan.limitations.join('; ')}</small></div>}</div><a className="detail-cta" href={`https://github.com/${selectedScan.full_name}`} target="_blank" rel="noopener noreferrer">Open repository <ArrowRight size={16}/></a></aside></div>}
    {selectedFinding && <div className="detail-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setSelectedFindingId(null); }}><aside className="detail-panel mend-finding-panel" role="dialog" aria-modal="true" aria-label={selectedFinding.title}><button className="detail-close" onClick={() => setSelectedFindingId(null)} aria-label="Close finding"><X size={19}/></button><span className="detail-kicker">FINDING</span><h2>{selectedFinding.title}</h2>{renderFinding(selectedFinding)}</aside></div>}
  </div></div></div>;
}
