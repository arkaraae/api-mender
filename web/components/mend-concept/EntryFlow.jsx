'use client';

import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import {
  ArrowRightIcon as ArrowRight,
  ArrowUpRightIcon as ArrowUpRight,
  ArrowsLeftRightIcon as ArrowsLeftRight,
  CheckCircleIcon as CheckCircle,
  CodeIcon as Code,
  GitBranchIcon as GitBranch,
  ShieldCheckIcon as ShieldCheck,
  UsersThreeIcon as UsersThree,
} from '@phosphor-icons/react';
import { App as Workspace } from './App.jsx';
import JoinForm from '../join-form';
import AuthScreen from '../auth-screen';
import { browserSupabase } from '../../lib/supabase-browser';
import './entry.css';

const routeForPath = () => {
  if (window.location.pathname.startsWith('/workspace')) return 'workspace';
  if (window.location.pathname.startsWith('/login')) return 'login';
  if (window.location.pathname.startsWith('/privacy')) return 'privacy';
  if (window.location.pathname.startsWith('/contact')) return 'contact';
  if (window.location.pathname.startsWith('/terms')) return 'terms';
  if (window.location.pathname.startsWith('/security')) return 'security';
  return 'home';
};

function BrandLogo({ className = '' }) {
  return <img className={`entry-logo ${className}`} src="/mend-concept/mend-logo-white.png" alt="Mend" />;
}

function PublicFooter({ navigate }) {
  return <footer className="entry-footer">
    <div className="entry-footer-main">
      <button className="entry-brand-link" onClick={() => navigate('/')} aria-label="Mend home"><BrandLogo /></button>
      <p>Know what changed. Know what to do.</p>
    </div>
    <nav className="entry-footer-links" aria-label="Footer navigation">
      <button onClick={() => navigate('/contact')}>Get in touch</button>
      <a href="/pricing">Pricing <ArrowUpRight size={14} /></a>
      <button onClick={() => navigate('/security')}>Security</button>
      <button onClick={() => navigate('/privacy')}>Privacy</button>
      <button onClick={() => navigate('/terms')}>Terms</button>
    </nav>
    <span className="entry-footer-copyright">Mend © 2026</span>
  </footer>;
}

function PublicHome({ navigate }) {
  useLayoutEffect(() => {
    const root = document.querySelector('.entry-home');
    if (!root || !('IntersectionObserver' in window) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const sections = root.querySelectorAll('.entry-reveal');
    root.classList.add('entry-motion-ready');
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -25px 0px' });
    sections.forEach(section => observer.observe(section));
    return () => observer.disconnect();
  }, []);

  const scrollTo = id => document.getElementById(id)?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  const showSteps = () => scrollTo('how-it-works');
  const showGateway = () => scrollTo('example');
  const showAgents = () => scrollTo('agents');

  return <div className="entry-page public-home entry-home">
    <header className="entry-header">
      <button className="entry-brand-link" onClick={() => window.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })} aria-label="Mend home"><BrandLogo /></button>
      <nav className="entry-nav" aria-label="Main navigation">
        <button onClick={showSteps}>How it works</button>
        <button onClick={showAgents}>AI agents</button>
        <a className="entry-nav-link" href="/pricing">Pricing</a>
        <button onClick={() => navigate('/login')}>Sign in</button>
        <button className="entry-nav-cta" onClick={() => navigate('/login')}>Get started <ArrowRight size={16} /></button>
      </nav>
    </header>

    <main>
      <section className="entry-hero" aria-labelledby="entry-title">
        <h1 id="entry-title">Know before an API change<br /><em>breaks your code.</em></h1>
        <p>Mend finds every external API your code calls, watches those APIs for breaking changes, and opens a reviewed fix before your users notice.</p>
        <div className="entry-hero-actions">
          <button className="entry-primary" onClick={() => navigate('/login')}>Connect GitHub <ArrowRight size={19} /></button>
          <button className="entry-secondary" onClick={showSteps}>See how it works <ArrowRight size={17} /></button>
        </div>
        <span className="entry-hero-note"><CheckCircle size={15} /> Your code is never sent to a hosted AI provider.</span>
      </section>

      <section className="entry-steps" id="how-it-works" aria-labelledby="steps-title">
        <div className="entry-steps-heading entry-reveal"><div><span className="entry-section-kicker">THE MEND FLOW</span><h2 id="steps-title">From change to fix.</h2></div><p>Connect your repositories once. Mend does the watching.</p></div>
        <div className="entry-step-grid">
          <article className="entry-step entry-reveal"><span className="entry-step-icon"><GitBranch size={24} /></span><span className="entry-step-number">01 / CONNECT</span><h3>Pick your repos.</h3><p>Install the GitHub App on the repositories you choose. Nothing to add to your code.</p></article>
          <article className="entry-step entry-reveal" style={{ '--reveal-delay': '70ms' }}><span className="entry-step-icon"><Code size={24} /></span><span className="entry-step-number">02 / FIND</span><h3>See every API you call.</h3><p>fetch, axios, requests, and the GitHub, Stripe, OpenAI and Twilio SDKs, in JavaScript, TypeScript and Python.</p></article>
          <article className="entry-step entry-reveal" style={{ '--reveal-delay': '140ms' }}><span className="entry-step-icon"><ShieldCheck size={24} /></span><span className="entry-step-number">03 / WATCH</span><h3>Catch breaking changes.</h3><p>Mend reads each provider's published API contract and flags the exact line a change affects, in Slack or a GitHub issue.</p></article>
          <article className="entry-step entry-reveal" style={{ '--reveal-delay': '210ms' }}><span className="entry-step-icon"><ArrowsLeftRight size={24} /></span><span className="entry-step-number">04 / FIX</span><h3>Review the fix.</h3><p>A bounded patch, checked by 11 safety gates and your CI, opens as a draft pull request. Nothing merges on its own.</p></article>
        </div>
      </section>

      <section className="entry-gateway" id="example" aria-labelledby="example-title">
        <div className="entry-gateway-copy entry-reveal">
          <span className="entry-section-kicker">A REAL CHANGE</span>
          <h2 id="example-title">The provider changed.<br />Your code didn't.</h2>
          <p>GitHub's REST API version 2026-03-10 stops accepting <code>assignee</code> when you create an issue. Mend finds the call that still sends it, shows the contract that changed, and proposes moving the value to <code>assignees</code>.</p>
          <span className="entry-gateway-assurance"><CheckCircle size={17} /> Every finding cites the provider's contract and the line it affects.</span>
        </div>
        <div className="entry-gateway-card entry-reveal" style={{ '--reveal-delay': '100ms' }} aria-label="GitHub API change example">
          <div className="entry-gateway-card-head"><GitBranch size={17} /><span>GITHUB REST API</span></div>
          <div className="entry-gateway-row"><span>YOUR CODE <b>today</b></span><code>assignee: onCall</code></div>
          <div className="entry-gateway-arrow"><ArrowsLeftRight size={18} /><span>removed in 2026-03-10, value kept</span></div>
          <div className="entry-gateway-row"><span>PROPOSED FIX <b>draft PR</b></span><code>assignees: [onCall]</code></div>
          <div className="entry-gateway-card-foot"><CheckCircle size={16} /> 11 of 11 safety gates passed</div>
        </div>
      </section>

      <section className="entry-gateway entry-agents" id="agents" aria-labelledby="agents-title">
        <div className="entry-gateway-copy entry-reveal">
          <span className="entry-section-kicker">FOR AI CODING AGENTS</span>
          <h2 id="agents-title">Ask your agent<br />what's about to break.</h2>
          <p>Add Mend to Claude Code, Cursor or VS Code. Your agent can list the APIs a repo calls, find provider changes that break them, fix them, and check the fix with Mend's gates. It all runs on your machine.</p>
          <span className="entry-gateway-assurance"><CheckCircle size={17} /> Source code stays on your computer.</span>
        </div>
        <div className="entry-gateway-card entry-reveal" style={{ '--reveal-delay': '100ms' }} aria-label="Install for AI agents">
          <div className="entry-gateway-card-head"><Code size={17} /><span>CLAUDE CODE</span></div>
          <div className="entry-gateway-row"><code>claude mcp add mender -- npx -y @apimender/mcp</code></div>
          <div className="entry-gateway-card-head"><Code size={17} /><span>CURSOR · VS CODE</span></div>
          <div className="entry-gateway-row"><code>{'{ "mender": { "command": "npx", "args": ["-y", "@apimender/mcp"] } }'}</code></div>
          <div className="entry-gateway-card-foot"><CheckCircle size={16} /> scan_apis · check_breaking_changes · validate_fix</div>
        </div>
      </section>
    </main>
    <PublicFooter navigate={navigate} />
  </div>;
}

function InfoHeader({ navigate }) {
  return <header className="entry-header">
    <button className="entry-brand-link" onClick={() => navigate('/')} aria-label="Mend home"><BrandLogo /></button>
    <nav className="entry-nav" aria-label="Main navigation">
      <button onClick={() => navigate('/')}>Home</button>
      <button onClick={() => navigate('/contact')}>Get in touch</button>
      <button onClick={() => navigate('/login')}>Sign in</button>
      <button className="entry-nav-cta" onClick={() => navigate('/login')}>Get started <ArrowRight size={16} /></button>
    </nav>
  </header>;
}

function Contact({ navigate }) {
  return <div className="entry-page public-home entry-subpage">
    <InfoHeader navigate={navigate} />
    <main className="entry-info-main">
      <section className="entry-info-hero">
        <span className="entry-section-kicker">GET IN TOUCH</span>
        <h1>Let's talk about<br /><em>your APIs.</em></h1>
        <p>Tell us what is changing, what you are building, or where your callers need a safer path forward.</p>
      </section>
      <div className="entry-contact-grid">
        <article className="entry-info-card entry-contact-primary">
          <span className="entry-info-card-icon"><Code size={23} /></span>
          <h2>Start a conversation.</h2>
          <p>Try Mend, share feedback, or explore a collaboration. Send a note to the API Mender team.</p>
          <JoinForm />
        </article>
        <article className="entry-info-card">
          <span className="entry-info-card-icon"><UsersThree size={23} /></span>
          <h2>Talk about pricing.</h2>
          <p>Running an API or planning for a larger team? See current plans and reach the sales form on API Mender.</p>
          <a className="entry-info-text-link" href="/pricing#contact-sales">Pricing and sales <ArrowUpRight size={16} /></a>
        </article>
      </div>
      <p className="entry-info-note">We use your contact details to reply to your message.</p>
    </main>
    <PublicFooter navigate={navigate} />
  </div>;
}

// A titled page of plain-language sections, shared by Privacy, Terms and Security.
function InfoPage({ navigate, kicker, title, accent, intro, updated, sections, footnote }) {
  return <div className="entry-page public-home entry-subpage">
    <InfoHeader navigate={navigate} />
    <main className="entry-info-main">
      <section className="entry-info-hero">
        <span className="entry-section-kicker">{kicker}</span>
        <h1>{title}<br /><em>{accent}</em></h1>
        <p>{intro}</p>
        {updated && <span className="entry-info-updated">Last updated {updated}</span>}
      </section>
      <div className="entry-privacy-grid">
        {sections.map(([label, heading, ...paragraphs], index) => <article key={label} className={`entry-info-card${index === 0 ? ' entry-privacy-lead' : ''}`}>
          <span className="entry-privacy-label">{label}</span>
          <h2>{heading}</h2>
          {paragraphs.map((text, line) => <p key={line}>{text}</p>)}
        </article>)}
      </div>
      <div className="entry-privacy-bottom"><p>{footnote}</p><button onClick={() => navigate('/contact')}>Get in touch <ArrowRight size={16} /></button></div>
    </main>
    <PublicFooter navigate={navigate} />
  </div>;
}

const UPDATED = 'November 13, 2026';

function Privacy({ navigate }) {
  return <InfoPage navigate={navigate} kicker="PRIVACY" title="Clear about" accent="your data." updated={UPDATED}
    intro="What Mend reads, what it keeps, who it shares it with, and how to have it deleted."
    footnote="Questions about your data, or a request to see or delete it? Get in touch and we will answer within five business days."
    sections={[
      ['WHAT WE READ', 'Only the repositories you choose.',
        'When you install the Mend GitHub App, you pick the repositories it may read. Mend downloads their code at the commit being scanned, reads it in memory, and discards it when the scan ends.',
        'Public repositories you add by name are read the same way, without any GitHub permission.'],
      ['WHAT WE KEEP', 'Facts about API calls, not your code.',
        'For each call Mend keeps the file and line, the API and endpoint, the names of request fields, and API version headers. Credentials written into code are dropped before anything is stored.',
        'Findings, fix jobs, alert history and an audit log of actions in your workspace are kept while your workspace exists.'],
      ['AI AND YOUR CODE', 'Never sent to a hosted AI provider.',
        'Fixes are written by an open-weight model that Mend runs on infrastructure it controls. Your code, prompts containing it, patches and test output are never sent to OpenAI, Anthropic or any other hosted AI provider.',
        'Only the lines around the affected call are given to the model, and it has no tools or network access.'],
      ['WHO ELSE SEES IT', 'A short list of processors.',
        'Supabase (database and sign-in), Cloudflare (hosting), GitHub (repository access and pull requests you approve), Stripe (payments, if you subscribe) and Slack (only if you connect it). We do not sell data or use it for advertising.'],
      ['HOW LONG', 'Kept only as long as needed.',
        'Reports sent by the command-line tool expire on their own. Alert history and audit events are deleted after 400 days. Deleting a workspace deletes its repositories, findings and settings.'],
      ['YOUR CHOICES', 'See, export or delete.',
        'You can remove a repository or uninstall the GitHub App at any time, which stops all access. Ask us to export or delete your account data and we will do it.'],
    ]} />;
}

function Terms({ navigate }) {
  return <InfoPage navigate={navigate} kicker="TERMS OF SERVICE" title="The terms for" accent="using Mend." updated={UPDATED}
    intro="By creating an account or connecting a repository, you agree to these terms."
    footnote="These terms may change as Mend grows; we will tell account owners before material changes take effect."
    sections={[
      ['THE SERVICE', 'What Mend does.',
        'Mend scans the code you connect for calls to external APIs, compares the APIs’ published contracts across versions, reports changes that may affect your code, and can propose fixes as draft pull requests.'],
      ['YOUR RESPONSIBILITY', 'You review every change.',
        'Findings come from static analysis and may be incomplete or wrong. Proposed fixes are never merged automatically: you decide whether to merge them, and you should test them first. You are responsible for the code you ship.'],
      ['YOUR ACCOUNT', 'Keep access to yourself.',
        'You must have the right to connect the repositories you add. Keep your sign-in and command-line tokens secret and tell us if you think they were exposed.'],
      ['ACCEPTABLE USE', 'No abuse of the service.',
        'Do not use Mend to scan code you have no right to access, to attack or overload Mend or any API, or to get around usage limits. We may suspend accounts that do.'],
      ['PLANS AND PAYMENT', 'Billed monthly through Stripe.',
        'Paid plans renew monthly until canceled. You can cancel at any time from Billing; your plan stays active until the end of the period you paid for. Plan limits, such as the number of repositories, are shown on the pricing page.'],
      ['YOUR CODE STAYS YOURS', 'We claim no rights to it.',
        'You keep all rights to your code and to fixes Mend proposes for it. You give Mend permission to read your connected repositories only to provide the service.'],
      ['WARRANTY AND LIABILITY', 'Provided as is.',
        'Mend is provided as is, without warranties. To the extent the law allows, our liability is limited to the amount you paid us in the twelve months before a claim.'],
      ['ENDING', 'You can leave at any time.',
        'You can delete your workspace or stop using Mend whenever you want. We may end the service with reasonable notice and will let you export your data first.'],
    ]} />;
}

function Security({ navigate }) {
  return <InfoPage navigate={navigate} kicker="SECURITY" title="How Mend protects" accent="your code." updated={UPDATED}
    intro="The controls behind every scan, finding and fix."
    footnote="Found a vulnerability? Report it through Get in touch with the details; we respond to security reports within two business days."
    sections={[
      ['LEAST ACCESS', 'Read-only, per repository.',
        'Scans use short-lived GitHub tokens limited to the one repository being scanned and to reading its contents. Writing a fix branch or an issue uses a separate token with only that permission.'],
      ['ISOLATION', 'Workspaces are separated in the database.',
        'Row-level security keeps each workspace’s repositories, findings and settings visible only to its members. Which APIs one workspace calls is never visible to another.'],
      ['SECRETS', 'Encrypted, never shown again.',
        'Slack webhook URLs are encrypted with AES-256-GCM before they are stored. Command-line tokens are stored only as hashes. Credentials found in scanned code are never kept.'],
      ['PRIVATE AI', 'A self-hosted model with no tools.',
        'Fixes come from an open-weight model on infrastructure Mend controls, reached over an authenticated private connection that refuses hosted AI provider addresses. The model sees only the lines around the call.'],
      ['SAFE FIXES', 'Eleven gates before anything is proposed.',
        'A fix must stay inside the call, keep every existing value, add no new network calls, imports or secrets, still parse, and satisfy the new contract. Then your own CI runs it. Nothing merges automatically.'],
      ['UNTRUSTED INPUT', 'Code and contracts are data.',
        'Repository code is parsed, never run. Provider contracts and other downloads are size-limited and treated as untrusted. Requests to expensive actions are rate-limited per user.'],
    ]} />;
}

function Login() {
  const supabase = useMemo(() => { try { return browserSupabase(); } catch { return null; } }, []);
  const [ready, setReady] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [awaitingConfirmation, setAwaitingConfirmation] = useState(false);
  const [githubEnabled, setGithubEnabled] = useState(false);

  useEffect(() => {
    if (!supabase) { setReady(true); setMessage('Sign in is unavailable right now.'); return; }
    let active = true;
    supabase.auth.getUser().then(({ data }) => {
      if (!active) return;
      setReady(true);
      if (data.user) window.location.replace('/live');
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (active && session?.user) window.location.replace('/live');
    });
    return () => { active = false; listener.subscription.unsubscribe(); };
  }, [supabase]);

  useEffect(() => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    if (!url || !key) return;
    let active = true;
    fetch(`${url}/auth/v1/settings`, { headers: { apikey: key } })
      .then(response => response.ok ? response.json() : null)
      .then(settings => { if (active) setGithubEnabled(settings?.external?.github === true); })
      .catch(() => { if (active) setGithubEnabled(false); });
    return () => { active = false; };
  }, []);

  async function authenticate(mode) {
    if (!supabase) { setMessage('Sign in is unavailable right now.'); return; }
    setBusy(true); setMessage('');
    try {
      const result = mode === 'signin'
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password, options: { emailRedirectTo: `${window.location.origin}/live` } });
      const needsConfirmation = mode === 'signup' && !result.error && !result.data.session;
      if (needsConfirmation) setAwaitingConfirmation(true);
      setMessage(result.error?.message || (needsConfirmation ? 'Check your inbox for a confirmation link.' : 'Opening your workspace…'));
      if (result.data.session) window.location.replace('/live');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not sign in.');
    } finally { setBusy(false); }
  }

  async function authenticateWithGithub() {
    if (!supabase) { setMessage('Sign in is unavailable right now.'); return; }
    if (!githubEnabled) { setMessage('GitHub sign-in is not enabled yet. Use your Mend account or explore the demo.'); return; }
    setBusy(true); setMessage('');
    try {
      const { error } = await supabase.auth.signInWithOAuth({ provider: 'github', options: { redirectTo: `${window.location.origin}/live` } });
      if (error) setMessage(error.message);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not start GitHub sign in.');
    } finally { setBusy(false); }
  }

  async function resendConfirmation() {
    if (!supabase || !email) return;
    setBusy(true); setMessage('');
    try {
      const { error } = await supabase.auth.resend({ type: 'signup', email, options: { emailRedirectTo: `${window.location.origin}/live` } });
      setMessage(error?.message || 'Confirmation email requested. Check your inbox and spam.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not resend confirmation email.');
    } finally { setBusy(false); }
  }

  return <AuthScreen ready={ready} email={email} password={password} message={message} busy={busy} awaitingConfirmation={awaitingConfirmation} onEmailChange={setEmail} onPasswordChange={setPassword} onAuthenticate={authenticate} onGithubAuthenticate={authenticateWithGithub} onResend={resendConfirmation} onBack={() => { setAwaitingConfirmation(false); setMessage(''); }} />;
}

export function EntryFlow({ initialRoute = 'home' }) {
  const [route, setRoute] = useState(initialRoute);
  useEffect(() => {
    document.title = route === 'workspace' ? 'Mend · Workspace' : route === 'login' ? 'Sign in · Mend' : route === 'privacy' ? 'Privacy · Mend' : route === 'contact' ? 'Get in touch · Mend' : route === 'terms' ? 'Terms · Mend' : route === 'security' ? 'Security · Mend' : 'Mend · Know before an API change breaks your code';
  }, [route]);
  useEffect(() => {
    const onPopState = () => setRoute(routeForPath());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigate = path => {
    if (window.location.pathname !== path) window.history.pushState({}, '', path);
    setRoute(routeForPath());
    window.scrollTo(0, 0);
  };

  if (route === 'workspace') return <Workspace onSignOut={() => navigate('/login')} />;
  if (route === 'login') return <Login />;
  if (route === 'privacy') return <Privacy navigate={navigate} />;
  if (route === 'contact') return <Contact navigate={navigate} />;
  if (route === 'terms') return <Terms navigate={navigate} />;
  if (route === 'security') return <Security navigate={navigate} />;
  return <PublicHome navigate={navigate} />;
}
