'use client';

import { type FormEvent, useState } from 'react';

type FormState = { phase: 'idle' | 'sending' | 'sent'; error?: string };

export default function JoinForm() {
  const [state, setState] = useState<FormState>({ phase: 'idle' });

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setState({ phase: 'sending' });
    try {
      const response = await fetch('/api/interest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(Object.fromEntries(new FormData(form))),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) {
        setState({ phase: 'idle', error: body.error || 'We could not save your details. Please try again.' });
        return;
      }
      form.reset();
      setState({ phase: 'sent' });
    } catch {
      setState({ phase: 'idle', error: 'We could not connect. Please check your connection and try again.' });
    }
  }

  if (state.phase === 'sent') return (
    <div className="join-success" role="status">
      <span aria-hidden="true">✓</span>
      <div><strong>Thanks for reaching out.</strong><p>We have your details and will be in touch.</p></div>
    </div>
  );

  return (
    <form className="join-form" onSubmit={(event) => void send(event)}>
      <div className="join-fields">
        <label>Your name<input name="name" autoComplete="name" required maxLength={100} placeholder="Your name" /></label>
        <label>Email address<input name="email" type="email" autoComplete="email" required maxLength={200} placeholder="you@example.com" /></label>
      </div>
      <label><span className="join-label">What brings you here? <em>(optional)</em></span>
        <select name="interest" defaultValue="">
          <option value="">Choose if you like</option>
          <option value="use">I want to try API Mender</option>
          <option value="collaborate">I want to collaborate</option>
          <option value="invest">I am interested in investing</option>
          <option value="feedback">I have feedback</option>
          <option value="other">Something else</option>
        </select>
      </label>
      <label><span className="join-label">Anything you want to add? <em>(optional)</em></span>
        <textarea name="message" rows={3} maxLength={1000} placeholder="Tell us what you have in mind" />
      </label>
      <label className="join-trap" aria-hidden="true">Website<input name="website" tabIndex={-1} autoComplete="off" /></label>
      {state.error && <p className="join-error" role="alert">{state.error}</p>}
      <div className="join-submit">
        <button type="submit" disabled={state.phase === 'sending'}>{state.phase === 'sending' ? 'Sending…' : 'Join us'}</button>
        <p>No account needed. We will email you only about API Mender.</p>
      </div>
    </form>
  );
}
