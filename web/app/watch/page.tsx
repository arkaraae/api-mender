import type { Metadata } from 'next';
import BrandLogo from '@/components/brand-logo';
import SiteNav from '@/components/site-nav';
import WatchForm from '@/components/watch-form';
import '../check/check.css';

export const metadata: Metadata = {
  title: 'Watch an API · API Mender',
  description: 'Know before an API you use breaks your code: Mender checks its description every day and shows what changed.',
};

export default function WatchPage() {
  return (
    <main className="marketing-page">
      <SiteNav current="/watch" />
      <div className="check-page">
        <section className="check-hero">
          <p className="hero-kicker">FREE · NO SIGN-UP</p>
          <h1>Know before an API you use breaks your code.</h1>
          <p className="hero-subtitle">Give Mender the address of the API&apos;s description. It checks every day, keeps each version, and shows what changed and how to fix your code.</p>
        </section>
        <WatchForm />
      </div>
      <footer className="marketing-footer"><span className="site-brand"><BrandLogo /></span><span>Know what changed. Know what to do.</span><a href="/check">Check a change ↗</a></footer>
    </main>
  );
}
