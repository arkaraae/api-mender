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
      <button onClick={() => navigate('/privacy')}>Privacy</button>
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
  const showGateway = () => scrollTo('gateway');

  return <div className="entry-page public-home entry-home">
    <header className="entry-header">
      <button className="entry-brand-link" onClick={() => window.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })} aria-label="Mend home"><BrandLogo /></button>
      <nav className="entry-nav" aria-label="Main navigation">
        <button onClick={showSteps}>How it works</button>
        <button onClick={showGateway}>Gateway</button>
        <button onClick={() => navigate('/login')}>Sign in</button>
        <button className="entry-nav-cta" onClick={() => navigate('/login')}>Get started <ArrowRight size={16} /></button>
      </nav>
    </header>

    <main>
      <section className="entry-hero" aria-labelledby="entry-title">
        <h1 id="entry-title">Make every API change<br /><em>a safe one.</em></h1>
        <p>Compare API versions, prove the translation, and keep older callers working through the gateway.</p>
        <div className="entry-hero-actions">
          <button className="entry-primary" onClick={() => navigate('/login')}>Get started <ArrowRight size={19} /></button>
          <button className="entry-secondary" onClick={showSteps}>See how it works <ArrowRight size={17} /></button>
        </div>
        <span className="entry-hero-note"><CheckCircle size={15} /> No AI runs on your traffic.</span>
      </section>

      <section className="entry-steps" id="how-it-works" aria-labelledby="steps-title">
        <div className="entry-steps-heading entry-reveal"><div><span className="entry-section-kicker">THE MEND FLOW</span><h2 id="steps-title">From change to confidence.</h2></div><p>Mend works out the rules once, proves them, then follows them on every call.</p></div>
        <div className="entry-step-grid">
          <article className="entry-step entry-reveal"><span className="entry-step-icon"><Code size={24} /></span><span className="entry-step-number">01 / COMPARE</span><h3>Read both versions.</h3><p>Compare old and new API descriptions field by field to see what changed and who it affects.</p></article>
          <article className="entry-step entry-reveal" style={{ '--reveal-delay': '70ms' }}><span className="entry-step-icon"><ShieldCheck size={24} /></span><span className="entry-step-number">02 / PROVE</span><h3>Prove the rule.</h3><p>Check that old requests become valid new ones and responses return in the shape callers expect.</p></article>
          <article className="entry-step entry-reveal" style={{ '--reveal-delay': '140ms' }}><span className="entry-step-icon"><ArrowsLeftRight size={24} /></span><span className="entry-step-number">03 / TRANSLATE</span><h3>Keep old apps working.</h3><p>Run older calls through the gateway, which applies the proved translation on every request.</p></article>
          <article className="entry-step entry-reveal" style={{ '--reveal-delay': '210ms' }}><span className="entry-step-icon"><UsersThree size={24} /></span><span className="entry-step-number">04 / TRACK</span><h3>Know who is left.</h3><p>Count older-version calls by caller so you know who to move before retiring an API version.</p></article>
        </div>
      </section>

      <section className="entry-gateway" id="gateway" aria-labelledby="gateway-title">
        <div className="entry-gateway-copy entry-reveal">
          <span className="entry-section-kicker">A PROVED TRANSLATION</span>
          <h2 id="gateway-title">Old requests in.<br />New requests out.</h2>
          <p>When the Quotes API renames <code>customerId</code> to <code>accountId</code>, Mend can prove the rule in both directions and apply it for callers still on version one.</p>
          <span className="entry-gateway-assurance"><CheckCircle size={17} /> Every translated call can be counted by caller.</span>
        </div>
        <div className="entry-gateway-card entry-reveal" style={{ '--reveal-delay': '100ms' }} aria-label="Quotes API translation example">
          <div className="entry-gateway-card-head"><GitBranch size={17} /><span>QUOTES API</span></div>
          <div className="entry-gateway-row"><span>OLD REQUEST <b>v1</b></span><code>customerId</code></div>
          <div className="entry-gateway-arrow"><ArrowsLeftRight size={18} /><span>field renamed, request and response checked</span></div>
          <div className="entry-gateway-row"><span>NEW REQUEST <b>v2</b></span><code>accountId</code></div>
          <div className="entry-gateway-card-foot"><CheckCircle size={16} /> Mender-Status: translated</div>
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

function Privacy({ navigate }) {
  return <div className="entry-page public-home entry-subpage">
    <InfoHeader navigate={navigate} />
    <main className="entry-info-main">
      <section className="entry-info-hero">
        <span className="entry-section-kicker">PRIVACY</span>
        <h1>Clear about<br /><em>your data.</em></h1>
        <p>An overview of how Mend handles account access, API changes, and gateway traffic.</p>
      </section>
      <div className="entry-privacy-grid">
        <article className="entry-info-card entry-privacy-lead">
          <span className="entry-privacy-label">ACCOUNT ACCESS</span>
          <h2>Your workspace starts with an account.</h2>
          <p>Mend account sign-in uses Supabase Auth. The demo workspace uses sample data and does not connect to your repositories.</p>
        </article>
        <article className="entry-info-card">
          <span className="entry-privacy-label">CHECKING A CHANGE</span>
          <h2>Browser-first comparison.</h2>
          <p>API Mender says change checks run in your browser. Its live service may fetch an API description when the hosting site blocks browser access, or when you ask it to watch that API.</p>
        </article>
        <article className="entry-info-card">
          <span className="entry-privacy-label">WATCHING AN API</span>
          <h2>Versions kept for a watch.</h2>
          <p>The live watch feature keeps a copy of an API description and checks it daily. A watch has a private link; anyone with that link can view it, so share it only with your team.</p>
        </article>
        <article className="entry-info-card">
          <span className="entry-privacy-label">GATEWAY TRAFFIC</span>
          <h2>Proved rules on each call.</h2>
          <p>API Mender says no AI runs on gateway traffic. Proved rules translate older calls, and old-version usage is counted by caller.</p>
        </article>
      </div>
      <div className="entry-privacy-bottom"><p>This page summarizes product behavior and is not a complete legal privacy policy. Ask us about data handling for your use case.</p><button onClick={() => navigate('/contact')}>Get in touch <ArrowRight size={16} /></button></div>
    </main>
    <PublicFooter navigate={navigate} />
  </div>;
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
    document.title = route === 'workspace' ? 'Mend · Workspace' : route === 'login' ? 'Sign in · Mend' : route === 'privacy' ? 'Privacy · Mend' : route === 'contact' ? 'Get in touch · Mend' : 'Mend · Make every API change a safe one';
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
  return <PublicHome navigate={navigate} />;
}
