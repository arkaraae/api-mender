'use client';

import { useState } from 'react';
import BrandLogo from '@/components/brand-logo';

type View = 'board' | 'repositories' | 'findings' | 'sources';
type AwsRelease = { version: string; publishedAt: string; url: string; summary: string };
type AwsFixture = { state: 'baseline'; message: string; repository: { fullName: string; head: string; url: string }; sdkVersion: string; calls: { symbol: string; line: number; url: string }[]; model: { url: string; sha256: string; retrievedAt: string; operations: { name: string; inputMembers: string[] }[] } };
type QuotesTestbed = { contractVersion: number; contractCommit: string; consumerUrl: string; status: null | { findingId: string; findingStatus: string; validation: string; oldConsumer: string; patchedConsumer: string; runUrl: string; fixBranchUrl: string; pullRequestUrl?: string } };
const sampleRepositories = [
  { name: 'acme/payments-service', calls: 2, status: 'Needs review' },
  { name: 'acme/checkout-web', calls: 1, status: 'Current' },
];
const labels: Record<View, string> = { board: 'Change board', repositories: 'Repositories', findings: 'Findings', sources: 'Sources' };

function LiveAwsSource({ release, busy, error, onCheck }: { release: AwsRelease | null; busy: boolean; error: string; onCheck: () => void }) {
  return <div className="demo-aws-live">
    <div><span className="demo-live-label">LIVE AWS SOURCE</span><h3>AWS SDK for JavaScript v3</h3><p>Fetch the latest release from the official AWS SDK repository. This lookup needs no account and does not change the sample findings.</p></div>
    <button className="demo-action" disabled={busy} onClick={onCheck}>{busy ? 'Checking…' : 'Check live AWS SDK'}</button>
    {release && <p className="demo-aws-result" role="status"><strong>{release.version}</strong> · Published {new Date(release.publishedAt).toLocaleDateString()} · <a href={release.url} target="_blank" rel="noopener noreferrer">Official release notes ↗</a>{release.summary && <span>{release.summary}</span>}</p>}
    {error && <p className="demo-feedback" role="alert">AWS source check failed: {error}. Please try again.</p>}
  </div>;
}

function S3FixtureCheck({ result, busy, error, onCheck }: { result: AwsFixture | null; busy: boolean; error: string; onCheck: () => void }) {
  return <div className="demo-aws-live">
    <div><span className="demo-live-label">LIVE S3 FIXTURE CHECK</span><h3>AWS S3 code and model</h3><p>Read two S3 commands from a public TypeScript fixture, then match them to AWS’s current published S3 model. No AWS account is needed.</p></div>
    <button className="demo-action" disabled={busy} onClick={onCheck}>{busy ? 'Checking…' : 'Check S3 fixture'}</button>
    {result && <div className="demo-aws-result" role="status"><strong>{result.calls.length} S3 commands matched</strong><span>{result.message}</span><span>Fixture: <a href={result.repository.url} target="_blank" rel="noopener noreferrer">{result.repository.fullName} at {result.repository.head.slice(0, 8)} ↗</a> · SDK {result.sdkVersion}</span><span>Official model: <a href={result.model.url} target="_blank" rel="noopener noreferrer">S3 Smithy JSON ↗</a> · SHA-256 {result.model.sha256.slice(0, 12)}…</span><ul>{result.calls.map(call => <li key={`${call.symbol}:${call.line}`}><a href={call.url} target="_blank" rel="noopener noreferrer">{call.symbol} at line {call.line} ↗</a> · {result.model.operations.find(operation => `${operation.name}Command` === call.symbol)?.inputMembers.length || 0} model input fields</li>)}</ul></div>}
    {error && <p className="demo-feedback" role="alert">S3 fixture check failed: {error}. Please try again.</p>}
  </div>;
}

function QuotesTestbedCheck({ result, busy, error, onCheck }: { result: QuotesTestbed | null; busy: boolean; error: string; onCheck: () => void }) {
  return <div className="demo-aws-live">
    <div><span className="demo-live-label">LIVE BREAK TEST</span><h3>Quotes API and consumer</h3><p>Read the active API contract and Mender’s validated result for a separate codebase that calls it.</p></div>
    <button className="demo-action" disabled={busy} onClick={onCheck}>{busy ? 'Checking…' : 'Check API break'}</button>
    {result && <div className="demo-aws-result" role="status"><strong>Contract v{result.contractVersion} · {result.status ? 'Fix ready for review' : 'Waiting for a Mender finding'}</strong><span>API source: <a href={`https://github.com/arkaraae/api-mender/commit/${result.contractCommit}`} target="_blank" rel="noopener noreferrer">commit {result.contractCommit.slice(0, 8)} ↗</a> · <a href={result.consumerUrl} target="_blank" rel="noopener noreferrer">Consumer code ↗</a></span>{result.status && <><span>{result.status.findingId} · {result.status.findingStatus} · validation {result.status.validation}</span><span>Old consumer: {result.status.oldConsumer}. Patched consumer: {result.status.patchedConsumer}.</span><span><a href={result.status.runUrl} target="_blank" rel="noopener noreferrer">Mender run and database ↗</a> · <a href={result.status.pullRequestUrl || result.status.fixBranchUrl} target="_blank" rel="noopener noreferrer">Review the fix ↗</a></span></>}</div>}
    {error && <p className="demo-feedback" role="alert">Quotes testbed check failed: {error}. Please try again.</p>}
  </div>;
}

export default function DemoPage() {
  const [view, setView] = useState<View>('board');
  const [selectedFinding, setSelectedFinding] = useState(false);
  const [sourceChecked, setSourceChecked] = useState(false);
  const [awsRelease, setAwsRelease] = useState<AwsRelease | null>(null);
  const [awsBusy, setAwsBusy] = useState(false);
  const [awsError, setAwsError] = useState('');
  const [s3Fixture, setS3Fixture] = useState<AwsFixture | null>(null);
  const [s3Busy, setS3Busy] = useState(false);
  const [s3Error, setS3Error] = useState('');
  const [quotesTestbed, setQuotesTestbed] = useState<QuotesTestbed | null>(null);
  const [quotesBusy, setQuotesBusy] = useState(false);
  const [quotesError, setQuotesError] = useState('');
  const [scanCount, setScanCount] = useState(0);
  const navigate = (next: View) => { setView(next); setSelectedFinding(false); };

  async function checkAwsRelease() {
    setAwsBusy(true); setAwsError('');
    try {
      const response = await fetch('https://api.github.com/repos/aws/aws-sdk-js-v3/releases/latest', {
        headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
        signal: AbortSignal.timeout(15_000),
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
      const release = await response.json() as Record<string, unknown>;
      const version = release.tag_name;
      const url = release.html_url;
      const publishedAt = release.published_at;
      if (typeof version !== 'string' || !/^v3\.\d+\.\d+$/.test(version) || typeof url !== 'string' || !/^https:\/\/github\.com\/aws\/aws-sdk-js-v3\/releases\/tag\/v3\.\d+\.\d+$/.test(url) || typeof publishedAt !== 'string' || Number.isNaN(Date.parse(publishedAt))) throw new Error('Release details were incomplete');
      setAwsRelease({ version, publishedAt, url, summary: typeof release.body === 'string' ? release.body.replace(/\[[^\]]*\]\([^)]*\)/g, '').replace(/[#*`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 500) : '' });
    } catch (error) { setAwsError(error instanceof Error ? error.message : 'Could not check the release'); }
    finally { setAwsBusy(false); }
  }

  async function checkS3Fixture() {
    setS3Busy(true); setS3Error('');
    try {
      const response = await fetch('/api/demo/aws-s3-fixture', { cache: 'no-store' });
      const result = await response.json() as AwsFixture & { error?: string };
      if (!response.ok) throw new Error(result.error || 'The source check was unavailable');
      setS3Fixture(result);
    } catch (error) { setS3Error(error instanceof Error ? error.message : 'Could not check the fixture'); }
    finally { setS3Busy(false); }
  }

  async function checkQuotesTestbed() {
    setQuotesBusy(true); setQuotesError('');
    try {
      const response = await fetch('/api/demo/quotes-testbed', { cache: 'no-store' });
      const result = await response.json() as QuotesTestbed & { error?: string };
      if (!response.ok) throw new Error(result.error || 'The testbed check was unavailable');
      setQuotesTestbed(result);
    } catch (error) { setQuotesError(error instanceof Error ? error.message : 'Could not check the testbed'); }
    finally { setQuotesBusy(false); }
  }

  return <main className="demo-app">
    <aside className="demo-sidebar" aria-label="Demo workspace navigation">
      <a className="demo-logo" href="/" aria-label="API Mender home"><BrandLogo /></a>
      <div className="demo-workspace-name"><span className="demo-workspace-avatar">A</span><div><strong>Acme engineering</strong><small>Sample workspace</small></div></div>
      <p className="demo-nav-label">WORKSPACE</p>
      <nav>{([['board', '▦', 'Change board'], ['repositories', '≡', 'Repositories'], ['findings', '◈', 'Findings'], ['sources', '⌁', 'Sources']] as const).map(([id, icon, label]) => <button key={id} type="button" className={view === id ? 'active' : ''} aria-current={view === id ? 'page' : undefined} onClick={() => navigate(id)}><span aria-hidden="true">{icon}</span>{label}{id === 'findings' && <em>1</em>}</button>)}</nav>
      <div className="demo-sidebar-bottom"><span className="demo-avatar">D</span><div><strong>Demo account</strong><small>No password or email needed</small></div></div>
    </aside>
    <div className="demo-main">
      <header className="demo-topbar"><span>Acme engineering <span aria-hidden="true">/</span> {labels[view]}</span><div><span className="demo-data-tag">SAMPLE DATA</span><a href="/live">Use live workspace ↗</a></div></header>
      <div className="demo-content">
        <div className="demo-heading"><div><p className="hero-kicker">EXPLORE API MENDER</p><h1>{labels[view]}</h1><p>See how a source update moves from detection to code review.</p></div><span className="demo-mode-pill">DEMO MODE</span></div>
        <div className="demo-notice"><strong>Interactive sample workspace.</strong> The board and Stripe findings are examples. The AWS and Quotes checks in Sources read live data; they do not alter sample findings.</div>
        {view === 'board' && <>
          <div className="demo-metrics"><div><span>REPOSITORIES</span><strong>2</strong><small>Sample repositories</small></div><div><span>CALL SITES</span><strong>3</strong><small>Recognized examples</small></div><div><span>NEEDS REVIEW</span><strong>1</strong><small>Illustrative finding</small></div></div>
          <div className="demo-board">
            <section><div className="demo-column-title"><span className="demo-chip lavender">Detected</span><small>2</small></div><article className="demo-card"><span className="demo-card-provider">S <strong>Stripe</strong></span><h2>Node SDK release</h2><p>A new version is available in this sample workflow.</p><button onClick={() => navigate('sources')}>Inspect source ↗</button></article><article className="demo-card"><span className="demo-card-provider">S <strong>Stripe</strong></span><h2>OpenAPI snapshot</h2><p>The specification changed in this example.</p><button onClick={() => navigate('sources')}>Inspect source ↗</button></article></section>
            <section><div className="demo-column-title"><span className="demo-chip peach">Needs review</span><small>1</small></div><article className="demo-card"><span className="demo-card-provider">↗ <strong>Payments service</strong></span><h2>PaymentIntent.create</h2><p>A recognized call site needs human review.</p><button onClick={() => { setView('findings'); setSelectedFinding(true); }}>Review evidence ↗</button></article></section>
            <section><div className="demo-column-title"><span className="demo-chip mint">Next step</span><small>1</small></div><article className="demo-card"><span className="demo-card-provider">✓ <strong>Engineer review</strong></span><h2>Decide on a fix</h2><p>Compare the source and code before making a change.</p><button onClick={() => navigate('repositories')}>See repository ↗</button></article></section>
          </div>
        </>}
        {view === 'repositories' && <section className="demo-panel"><div className="demo-panel-head"><div><p className="hero-kicker">CODE CONTEXT</p><h2>Monitored repositories</h2></div><span>2 samples</span></div>{sampleRepositories.map(repo => <article className="demo-repository" key={repo.name}><div><strong>{repo.name}</strong><p>main · stripe-node 17.2.0 · {repo.calls} recognized call site{repo.calls > 1 ? 's' : ''}</p></div><div><span className={repo.status === 'Current' ? 'demo-status current' : 'demo-status'}>{repo.status}</span><button onClick={() => setScanCount(count => count + 1)}>Simulate scan</button></div></article>)}{scanCount > 0 && <p className="demo-feedback" role="status">Sample scan complete. These results were not fetched from GitHub.</p>}</section>}
        {view === 'findings' && <div className="demo-detail-layout"><section className="demo-panel"><div className="demo-panel-head"><div><p className="hero-kicker">REVIEW QUEUE</p><h2>Findings</h2></div><span>1 sample</span></div><button className={`demo-finding-row ${selectedFinding ? 'selected' : ''}`} onClick={() => setSelectedFinding(true)}><span className="demo-finding-icon">↗</span><span><strong>Review PaymentIntent.create</strong><small>acme/payments-service · src/payments/charge.ts:48</small></span><span className="demo-status">Needs review</span></button></section><section className="demo-panel demo-finding-detail"><p className="hero-kicker">EVIDENCE</p><h2>{selectedFinding ? 'PaymentIntent.create' : 'Select a finding'}</h2>{selectedFinding ? <><p>This sample shows a recognized call site alongside a source update. A human must confirm whether a code change is needed.</p><dl><div><dt>Repository</dt><dd>acme/payments-service</dd></div><div><dt>Call site</dt><dd>src/payments/charge.ts:48</dd></div><div><dt>Confidence</dt><dd>Needs review</dd></div></dl><p className="demo-detail-note">Illustrative evidence only. No real repository was scanned.</p></> : <p>Choose the sample finding to inspect its code context and limitations.</p>}</section></div>}
        {view === 'sources' && <section className="demo-panel"><div className="demo-panel-head"><div><p className="hero-kicker">UPSTREAM SIGNALS</p><h2>Sources and testbeds</h2></div><button className="demo-action" onClick={() => setSourceChecked(true)}>Simulate source check</button></div><QuotesTestbedCheck result={quotesTestbed} busy={quotesBusy} error={quotesError} onCheck={() => void checkQuotesTestbed()} /><S3FixtureCheck result={s3Fixture} busy={s3Busy} error={s3Error} onCheck={() => void checkS3Fixture()} /><LiveAwsSource release={awsRelease} busy={awsBusy} error={awsError} onCheck={() => void checkAwsRelease()} /><article className="demo-source-row"><span className="demo-source-icon">S</span><div><strong>Stripe Node SDK</strong><p>Release version comparison in the sample workflow</p></div><span className="demo-status">Source update</span></article><article className="demo-source-row"><span className="demo-source-icon">S</span><div><strong>Stripe OpenAPI</strong><p>Specification snapshot comparison in the sample workflow</p></div><span className="demo-status current">Available</span></article>{sourceChecked && <p className="demo-feedback" role="status">Sample source check complete. No live source was fetched or saved.</p>}</section>}
        <footer className="demo-footer"><span>API Mender sample workspace</span><a href="/live">Ready for real data? Open the live workspace ↗</a></footer>
      </div>
    </div>
  </main>;
}
