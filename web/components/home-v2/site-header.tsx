'use client';

import { useEffect, useState } from 'react';

const LINKS = [
  { href: '/check', label: 'Check a change' },
  { href: '/watch', label: 'Watch an API' },
  { href: '/mender', label: 'Gateway' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/docs', label: 'Docs' },
];

// Transparent over the hero; fills in once the page scrolls. Also owns the light/dark switch.
export default function SiteHeader() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem('am-theme');
      if (saved === 'light' || saved === 'dark') document.documentElement.setAttribute('data-theme', saved);
    } catch {}
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  function toggleTheme() {
    const root = document.documentElement;
    const current = root.getAttribute('data-theme')
      ?? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = current === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('am-theme', next); } catch {}
  }

  return (
    <header className={`mv2-nav${scrolled ? ' is-scrolled' : ''}`}>
      <div className="mv2-nav-inner">
        <a className="mv2-logo" href="/" aria-label="mend home">
          <img className="only-light" src="/home/mend_logo.svg" alt="mend" width={1641} height={471} />
          <img className="only-dark" src="/home/mend_logo_white.svg" alt="mend" width={1641} height={471} />
        </a>
        <ul className="mv2-links">
          {LINKS.map((link) => <li key={link.href}><a href={link.href}>{link.label}</a></li>)}
        </ul>
        <div className="mv2-actions">
          <button className="mv2-theme" type="button" onClick={toggleTheme} aria-label="Switch light or dark mode">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
              <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />
            </svg>
          </button>
          <a className="mv2-btn" href="/check">Start free</a>
        </div>
      </div>
    </header>
  );
}
