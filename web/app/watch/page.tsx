import type { Metadata } from 'next';
import SiteFooter from '@/components/home-v2/site-footer';
import SiteHeader from '@/components/home-v2/site-header';
import { PageHead } from '@/components/home-v2/page-parts';
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
      <div className="check-page">
        <PageHead kicker="Free · No sign-up" title="Know before an API you use breaks your code.">
          Give Mender the address of the API&apos;s description. It checks every day, keeps each version, and shows what changed and how to fix your code.
        </PageHead>
        <WatchForm />
      </div>
    </main>
    <SiteFooter />
    </div>
  );
}
