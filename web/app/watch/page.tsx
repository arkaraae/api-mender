import type { Metadata } from 'next';
import SiteFooter from '@/components/home-v2/site-footer';
import SiteHeader from '@/components/home-v2/site-header';
import WindowBand from '@/components/home-v2/window-band';
import WatchForm from '@/components/watch-form';
import '../check/check.css';
import '../home-v2.css';
import '../mv2-pages.css';

export const metadata: Metadata = {
  title: 'Watch an API · API Mender',
  description: 'Know before an API you use breaks your code: Mender checks its description every day and shows what changed.',
};

export default function WatchPage() {
  return (
    <div className="mv2">
    <SiteHeader current="/watch" />
    <main className="marketing-page">
      <WindowBand scene="watch" />
      <div className="check-page">
        <section className="check-hero">
          <p className="hero-kicker">FREE · NO SIGN-UP</p>
          <h1>Know before an API you use breaks your code.</h1>
          <p className="hero-subtitle">Give Mender the address of the API&apos;s description. It checks every day, keeps each version, and shows what changed and how to fix your code.</p>
        </section>
        <WatchForm />
      </div>
    </main>
    <SiteFooter />
    </div>
  );
}
