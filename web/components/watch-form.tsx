'use client';

// Start watching an API description: one address, an optional Slack or Discord webhook.
import { useEffect, useState } from 'react';

export default function WatchForm() {
  const [url, setUrl] = useState('');
  const [webhook, setWebhook] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');

  useEffect(() => {
    const given = new URLSearchParams(window.location.search).get('url');
    if (given) setUrl(given);
  }, []);

  async function start() {
    setBusy(true);
    setProblem('');
    try {
      const response = await fetch('/api/mender/watch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url, webhook: webhook || undefined }) });
      const body = (await response.json()) as { id?: string; error?: string };
      if (!response.ok || !body.id) throw new Error(body.error || 'Mender could not start watching that address.');
      window.location.href = `/watch/${body.id}`;
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
      setBusy(false);
    }
  }

  return (
    <section className="check-card">
      <h2><span className="check-step">1</span>The API to watch</h2>
      <label className="check-field">
        <span>Address of its OpenAPI or Swagger description</span>
        <input value={url} onChange={(event) => setUrl(event.target.value)} spellCheck={false} placeholder="https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json" />
      </label>
      <label className="check-field">
        <span>Slack or Discord webhook, if you want a message when it changes (optional)</span>
        <input value={webhook} onChange={(event) => setWebhook(event.target.value)} spellCheck={false} placeholder="https://hooks.slack.com/services/…" />
      </label>
      <p className="check-hint">Mender keeps a copy now and checks the address once a day. You get a private link: anyone with it can see the watch, so share it only with your team.</p>
      <div className="check-actions"><button type="button" className="pill-button pill-dark" disabled={busy || !url.trim()} onClick={() => void start()}>{busy ? 'Reading the description…' : 'Start watching'}</button></div>
      {problem && <p className="check-problem" role="alert">{problem}</p>}
    </section>
  );
}
