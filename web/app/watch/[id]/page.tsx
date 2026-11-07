import type { Metadata } from 'next';
import SiteFooter from '@/components/home-v2/site-footer';
import SiteHeader from '@/components/home-v2/site-header';
import WatchView from '@/components/watch-view';
import '../../check/check.css';
import '../../home-v2.css';
import '../../mv2-pages.css';

export const metadata: Metadata = { title: 'Watched API · API Mender', robots: { index: false } };

export default async function WatchedApiPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div className="mv2">
    <SiteHeader />
    <main className="marketing-page">
      <div className="check-page check-page-top"><WatchView id={id} /></div>
    </main>
    <SiteFooter />
    </div>
  );
}
