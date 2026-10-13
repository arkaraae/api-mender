'use client';

// The top of the homepage: what Mender does, the 3D gateway, a switch for Mender, and a real
// call to the live Quotes API (version 2) sent from this page, with or without Mender.
import { useState } from 'react';
import GatewayScene from '@/components/gateway-scene';
import type { Shot } from '@/lib/gateway-scene';

type Answer = { status: number; ms: number; throughMender: boolean; detail: string };

const OLD_REQUEST = { customerId: 'acct_fixture_1', amountCents: 2500 };

export default function HomeHero() {
  const [mender, setMender] = useState(true);
  const [shot, setShot] = useState<Shot | null>(null);
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
      setShot({ id: Date.now(), status: response.status, ms, throughMender });
    } catch {
      setProblem('The call did not go through. Check your connection and try again.');
    }
    setSending(false);
  }

  return (
    <section className="home-hero" aria-labelledby="home-title">
      <div className="home-hero-copy">
        <h1 id="home-title">Ship the breaking change. Keep every old caller working.</h1>
        <p>API Mender reads both versions of your API, proves how each old request maps to the new one, and translates old calls on the way in. Your customers upgrade when they are ready.</p>
        <div className="home-actions">
          <a className="home-button home-button-thread" href="/check">Check a change</a>
          <a className="home-button home-button-quiet" href="/mender">See the gateway</a>
        </div>
      </div>

      <GatewayScene mender={mender} shot={shot} onToggle={() => setMender((on) => !on)} />

      <div className="home-console">
        <div className="home-switch">
          <button type="button" role="switch" aria-checked={mender} className="switch" onClick={() => setMender((on) => !on)}>
            <span className="switch-knob" aria-hidden="true" />
            <span className="switch-text">Mender is {mender ? 'on' : 'off'}</span>
          </button>
          <p>Switch it off, or click the gold ring, to see what old callers get without it.</p>
        </div>
        <div className="home-call" aria-live="polite">
          <div className="home-call-head">
            <button type="button" className="home-button home-button-thread" disabled={sending} onClick={() => void sendRealCall()}>{sending ? 'Sending…' : 'Send a real call'}</button>
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
  );
}
