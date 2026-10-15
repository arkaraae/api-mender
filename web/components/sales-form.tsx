'use client';

// The "Contact sales" form on /pricing. Saved by /api/sales; the team reads it from the database
// or gets it in Slack or Discord.
import { type FormEvent, useState } from 'react';

const API_COUNTS = ['1', '2–5', '6–20', 'More than 20'];

export default function SalesForm() {
  const [state, setState] = useState<{ phase: 'idle' | 'sending' | 'sent'; error?: string }>({ phase: 'idle' });

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState({ phase: 'sending' });
    const fields = Object.fromEntries(new FormData(event.currentTarget));
    try {
      const response = await fetch('/api/sales', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(fields) });
      const body = (await response.json()) as { error?: string };
      setState(response.ok ? { phase: 'sent' } : { phase: 'idle', error: body.error || 'Your message could not be sent.' });
    } catch {
      setState({ phase: 'idle', error: 'Your message could not be sent. Check your connection and try again.' });
    }
  }

  if (state.phase === 'sent') return <p className="sales-sent" role="status">Thanks. We got your message and will reply by email within two working days.</p>;

  return (
    <form className="sales-form" onSubmit={(event) => void send(event)}>
      <label className="check-field">Name<input name="name" autoComplete="name" required maxLength={100} /></label>
      <label className="check-field">Work email<input name="email" type="email" autoComplete="email" required maxLength={200} /></label>
      <label className="check-field">Company<input name="company" autoComplete="organization" required maxLength={120} /></label>
      <label className="check-field">APIs you run
        <select name="apis" required defaultValue="">
          <option value="" disabled>Choose</option>
          {API_COUNTS.map((count) => <option key={count} value={count}>{count}</option>)}
        </select>
      </label>
      <label className="check-field sales-wide"><span>What do you need? <span className="sales-optional">(optional)</span></span><textarea name="message" maxLength={2000} rows={4} /></label>
      {/* People never see this field; robots fill it in. */}
      <label className="sales-trap" aria-hidden="true">Website<input name="website" tabIndex={-1} autoComplete="off" /></label>
      {state.error && <p className="check-problem sales-wide" role="alert">{state.error}</p>}
      <div className="check-actions sales-wide">
        <button type="submit" className="pill-button pill-dark" disabled={state.phase === 'sending'}>{state.phase === 'sending' ? 'Sending…' : 'Send to sales'}</button>
        <span className="check-hint">We use this only to reply to you.</span>
      </div>
    </form>
  );
}
