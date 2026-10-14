'use client';

// The homepage: a full-screen opening over the film of a chain of requests, then the live
// gateway: the team's film of the machine with the X-ray lens, a switch for Mender, and a real
// call to the live Quotes API (version 2) sent from this page, with or without Mender.
import { useState } from 'react';
import GatewayScene from '@/components/gateway-scene';
import HeroCards from '@/components/hero-cards';
import HeroNav from '@/components/hero-nav';
import Mascot from '@/components/mascot';
import XrayLens from '@/components/xray-lens';

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
        <video className="hero-film" autoPlay muted loop playsInline poster="/hero-bg.jpg" src="/hero-bg.mp4" aria-hidden="true" />
        {/* Over the chain of requests, the same X-ray lens as on the machine below; never over the text or the cards. */}
        <XrayLens mender={mender} ignore=".hero-copy, .hero-side, .hero-nav, .hero-menu" />
        <HeroNav />
        <div className="hero-body">
          <div className="hero-copy">
            <h1 id="home-title">
              <span className="hero-anim hero-reveal" style={{ animationDelay: '.2s' }}>APIs change.</span>
              <span className="hero-anim hero-reveal" style={{ animationDelay: '.38s' }}>Nothing <span className="line-mask">breaks.</span></span>
            </h1>
            <p className="hero-lead hero-anim hero-fade" style={{ animationDelay: '.65s' }}>Mender checks the change, fixes the code that calls the API, and keeps old apps working through its gateway. No AI runs on your traffic.</p>
            <div className="hero-actions hero-anim hero-fade" style={{ animationDelay: '.8s' }}>
              <a className="hero-button" href="/check">CHECK A CHANGE</a>
              <a className="hero-link" href="#gateway">See the gateway ↓</a>
            </div>
          </div>
          <div className="hero-side hero-anim hero-fade" style={{ animationDelay: '.95s' }}>
            <Mascot className="hero-mascot" size={120} label="Mender, the mascot, following your pointer with its eyes" />
            <HeroCards />
          </div>
        </div>
      </section>

      <section className="home-gateway" id="gateway" aria-labelledby="gateway-title">
        <div className="home-gateway-head">
          <span className="home-kicker">LIVE GATEWAY</span>
          <h2 id="gateway-title">Old requests go in. Version-two requests come out.</h2>
          <p>Move your pointer over the machine to see the code behind each part. Then send a real call.</p>
        </div>

        <GatewayScene mender={mender} />

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
