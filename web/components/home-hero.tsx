'use client';

// The homepage: a centered opening over a faint grid, with floating API tiles, two buttons
// and the mascot at a glowing horizon; then the live gateway: the team's film of the machine with the X-ray lens, a switch for Mender, and a real
// call to the live Quotes API (version 2) sent from this page, with or without Mender.
import { useState } from 'react';
import FloatingTiles from '@/components/floating-tiles';
import GatewayScene from '@/components/gateway-scene';
import HeroCards from '@/components/hero-cards';
import HeroNav from '@/components/hero-nav';

type Answer = { status: number; ms: number; throughMender: boolean; detail: string };

const OLD_REQUEST = { customerId: 'acct_fixture_1', amountCents: 2500 };

export default function HomeHero() {
  const [mender, setMender] = useState(true);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState('');

  async function sendRealCall() {
    setSending(true);
    setProblem('');
    const throughMender = mender;
    const started = performance.now();
    try {
      const response = await fetch(throughMender ? '/mender/v1/api/testbed/quotes' : '/api/testbed/quotes', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-consumer': 'apimender-home' },
        body: JSON.stringify(OLD_REQUEST),
      });
      const ms = Math.round(performance.now() - started);
      const body = (await response.json().catch(() => ({}))) as { id?: string; error?: string; required?: string[] };
      const detail = response.ok
        ? `Mender renamed customerId to accountId and the API created quote ${String(body.id ?? '').slice(0, 22)}…`
        : response.status === 422
          ? `The API refused it: version 2 requires ${(body.required ?? ['accountId']).filter((field) => !(field in OLD_REQUEST)).join(' and ') || 'other fields'}, and this request still sends customerId.`
          : `The API answered: ${body.error ?? response.statusText}.`;
      setAnswer({ status: response.status, ms, throughMender, detail });
    } catch {
      setProblem('The call did not go through. Check your connection and try again.');
    }
    setSending(false);
  }

  return (
    <>
      <section className="hero" aria-labelledby="home-title">
        <HeroNav />
        <span className="hero-grid" aria-hidden="true" />
        <span className="hero-grid hero-grid-lit" aria-hidden="true" />
        <FloatingTiles />
        <div className="hero-copy">
          <p className="hero-badge hero-anim hero-fade" style={{ animationDelay: '.1s' }}><b>Beta</b>Pro is free while we are in beta</p>
          <h1 id="home-title">
            <span className="hero-anim hero-reveal hero-dim" style={{ animationDelay: '.2s' }}>APIs change.</span>
            <span className="hero-anim hero-reveal" style={{ animationDelay: '.38s' }}>Your integrations shouldn&apos;t break.</span>
          </h1>
          <p className="hero-lead hero-anim hero-fade" style={{ animationDelay: '.65s' }}>Mender checks the change, fixes the code that calls the API, and keeps old apps working through its gateway. No AI runs on your traffic.</p>
          <div className="hero-actions hero-anim hero-fade" style={{ animationDelay: '.8s' }}>
            <a className="hero-button" href="/check">Start for free</a>
            <a className="hero-demo" href="#join">Book a demo<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg></a>
          </div>
        </div>
        <div className="hero-horizon" aria-hidden="true">
          <img className="hero-mascot" src="/mend-mascot-dark.png" alt="" width={442} height={360} />
        </div>
        <div className="hero-side hero-anim hero-fade" style={{ animationDelay: '.95s' }}>
          <HeroCards />
        </div>
      </section>

      <section className="home-gateway" id="gateway" aria-labelledby="gateway-title">
        <div className="home-gateway-head">
          <span className="home-kicker">LIVE GATEWAY</span>
          <h2 id="gateway-title">Old requests go in. Version-two requests come out.</h2>
          <p>See the code behind each part of the machine, then send a real call and watch the answer.</p>
        </div>

        <GatewayScene mender={mender} answer={answer} />

        <div className="home-console glass">
          <div className="home-switch">
            <button type="button" role="switch" aria-checked={mender} className="switch" onClick={() => setMender((on) => !on)}>
              <span className="switch-knob" aria-hidden="true" />
              <span className="switch-text">Mender is {mender ? 'on' : 'off'}</span>
            </button>
            <p>Switch it off to see what old callers get without it.</p>
          </div>
          <div className="home-call" aria-live="polite">
            <div className="home-call-head">
              <button type="button" className="hero-button" disabled={sending} onClick={() => void sendRealCall()}>{sending ? 'SENDING…' : 'SEND A REAL CALL'}</button>
              <p>An old-style request, <code>{'{"customerId": …}'}</code>, from this page to the live Quotes API version 2, {mender ? 'through Mender' : 'straight to the API'}.</p>
            </div>
            {problem && <p className="home-call-problem">{problem}</p>}
            {answer && !problem && (
              <div className={`home-answer ${answer.status < 400 ? 'is-pass' : 'is-fail'}`}>
                <strong>{answer.status}</strong>
                <p><span>{answer.throughMender ? 'Through Mender' : 'Straight to the API'}, in {answer.ms} ms.</span> {answer.detail}</p>
              </div>
            )}
          </div>
        </div>
      </section>
    </>
  );
}
