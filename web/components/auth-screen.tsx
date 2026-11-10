'use client';

import { useState } from 'react';

type AuthMode = 'signin' | 'signup';

type Props = {
  ready: boolean;
  email: string;
  password: string;
  message: string;
  busy: boolean;
  awaitingConfirmation: boolean;
  onEmailChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onAuthenticate: (mode: AuthMode) => Promise<void>;
  onGithubAuthenticate: () => Promise<void>;
  onResend: () => Promise<void>;
  onBack: () => void;
};

export default function AuthScreen({
  ready, email, password, message, busy, awaitingConfirmation,
  onEmailChange, onPasswordChange, onAuthenticate, onGithubAuthenticate,
  onResend, onBack,
}: Props) {
  const [mode, setMode] = useState<AuthMode>('signin');
  const [showEmail, setShowEmail] = useState(false);
  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void onAuthenticate(mode);
  };

  return <main className="mend-auth">
    <header className="mend-auth-header">
      <a href="/" aria-label="Back to API Mender home"><span aria-hidden="true">←</span> Back to home</a>
    </header>
    <div className="mend-auth-stage">
      <section className="mend-auth-content" aria-label="Sign in to API Mender">
        <img className="mend-auth-logo" src="/mend-logo-white.png" alt="Mend" />
        <span className="mend-auth-kicker">WELCOME TO MEND</span>
        <h1>The workspace where<br />API changes become safe.</h1>
        <p className="mend-auth-intro">Find the impact. Prove the fix. Move forward together.</p>

        {!ready ? <p className="mend-auth-loading" role="status">Loading workspace…</p> : awaitingConfirmation ? <div className="mend-auth-confirmation">
          <h2>Check your inbox.</h2>
          <p>We sent a confirmation link to <strong>{email}</strong>. Follow it to finish creating your account.</p>
          <button type="button" className="mend-auth-primary" disabled={busy} onClick={() => void onResend()}>Resend confirmation email <span aria-hidden="true">→</span></button>
          <button type="button" className="mend-auth-text-link" onClick={onBack}>Back to sign in</button>
        </div> : <div className="mend-auth-actions">
          {!showEmail ? <button type="button" className="mend-auth-primary" onClick={() => setShowEmail(true)}><span aria-hidden="true">✉</span> Continue with Mend account <span aria-hidden="true">→</span></button> : <div className="mend-auth-email-panel">
            <div className="mend-auth-tabs" role="tablist" aria-label="Mend account access">
              <button type="button" role="tab" aria-selected={mode === 'signin'} className={mode === 'signin' ? 'selected' : ''} onClick={() => setMode('signin')}>Sign in</button>
              <button type="button" role="tab" aria-selected={mode === 'signup'} className={mode === 'signup' ? 'selected' : ''} onClick={() => setMode('signup')}>Create account</button>
            </div>
            <form className="mend-auth-form" onSubmit={submit}>
              <label htmlFor="mend-auth-email">Email</label>
              <input id="mend-auth-email" type="email" autoComplete="email" placeholder="name@company.com" value={email} onChange={event => onEmailChange(event.target.value)} required autoFocus />
              <label htmlFor="mend-auth-password">Password</label>
              <input id="mend-auth-password" type="password" autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} placeholder={mode === 'signup' ? 'Create a password' : 'Your password'} value={password} onChange={event => onPasswordChange(event.target.value)} required minLength={6} />
              <button className="mend-auth-primary" disabled={busy || !email || !password} type="submit">{busy ? 'Please wait…' : mode === 'signup' ? 'Create Mend account' : 'Sign in to Mend'} <span aria-hidden="true">→</span></button>
            </form>
            {email && <button type="button" className="mend-auth-text-link" disabled={busy} onClick={() => void onResend()}>Resend confirmation email</button>}
          </div>}

          <span className="mend-auth-divider">or</span>
          <button type="button" className="mend-auth-github" disabled={busy} onClick={() => void onGithubAuthenticate()}><img src="/integrations/github.svg" alt="" /> Continue with GitHub <span aria-hidden="true">→</span></button>
          <a className="mend-auth-demo" href="/workspace">Explore the demo workspace <span aria-hidden="true">→</span></a>
        </div>}

        {message && <p className="mend-auth-message" role="status">{message}</p>}
        <small>By continuing, you agree to use Mend for repositories you are authorized to access.</small>
      </section>
    </div>
  </main>;
}
