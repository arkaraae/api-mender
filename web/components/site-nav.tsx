import BrandLogo from '@/components/brand-logo';

const LINKS = [
  { href: '/check', label: 'Check a change' },
  { href: '/watch', label: 'Watch an API' },
  { href: '/mender', label: 'Gateway' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/demo', label: 'Demo' },
];

// The top bar of the public pages; "dark" for the homepage's black top.
export default function SiteNav({ current, tone = 'light' }: { current?: string; tone?: 'light' | 'dark' }) {
  return (
    <header className={`marketing-nav ${tone === 'dark' ? 'marketing-nav-dark' : ''}`}>
      <a className="site-brand" href="/" aria-label="API Mender home"><BrandLogo /></a>
      <nav aria-label="Main navigation">
        {LINKS.map((link) => <a key={link.href} href={link.href} aria-current={current === link.href ? 'page' : undefined}>{link.label}</a>)}
      </nav>
      <div className="marketing-nav-actions">
        <a className="nav-text-link" href="/live">Log in</a>
        <a className="pill-button pill-dark nav-cta" href="/check">Check a change</a>
      </div>
    </header>
  );
}
