'use client';

// The homepage's top bar: the mascot (eyes following the pointer) with the name in monospace,
// the links, and on phones a menu button that turns into a cross and opens a full-screen menu.
import { useEffect, useState } from 'react';
import Mascot from '@/components/mascot';

const LINKS = [
  { href: '/check', label: 'Check a change' },
  { href: '/watch', label: 'Watch an API' },
  { href: '/mender', label: 'Gateway' },
  { href: '/pricing', label: 'Pricing' },
];

export default function HeroNav() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', close);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', close);
      document.body.style.overflow = '';
    };
  }, [open]);

  return (
    <>
      <nav className="hero-nav" aria-label="Main navigation">
        <a className="hero-brand" href="/" aria-label="API Mender home"><Mascot size={30} /><span>MENDER</span></a>
        <div className="hero-links">
          {LINKS.map((link) => <a key={link.href} href={link.href}>{link.label}</a>)}
        </div>
        <a className="hero-login" href="/live">Log in</a>
        <button type="button" className={`hero-menu-button ${open ? 'is-open' : ''}`} onClick={() => setOpen((on) => !on)} aria-label={open ? 'Close menu' : 'Open menu'} aria-expanded={open}>
          <svg className="icon-menu" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><line x1="4" x2="20" y1="12" y2="12" /><line x1="4" x2="20" y1="6" y2="6" /><line x1="4" x2="20" y1="18" y2="18" /></svg>
          <svg className="icon-x" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
        </button>
      </nav>
      <div className={`hero-menu ${open ? 'is-open' : ''}`} aria-hidden={!open}>
        <div className="hero-menu-content">
          {LINKS.map((link) => <a key={link.href} href={link.href} onClick={() => setOpen(false)}>{link.label}</a>)}
          <span className="hero-menu-rule" />
          <a href="/live" className="hero-menu-login" onClick={() => setOpen(false)}>Log in</a>
        </div>
      </div>
    </>
  );
}
