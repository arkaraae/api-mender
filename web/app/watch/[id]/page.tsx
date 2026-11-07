import type { Metadata } from 'next';
import BrandLogo from '@/components/brand-logo';
import SiteNav from '@/components/site-nav';
import WatchView from '@/components/watch-view';
import '../../check/check.css';

export const metadata: Metadata = { title: 'Watched API · API Mender', robots: { index: false } };

export default async function WatchedApiPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <main className="marketing-page">
      <SiteNav />
      <div className="check-page check-page-top"><WatchView id={id} /></div>
      <footer className="marketing-footer"><span className="site-brand"><BrandLogo /></span><span>Know what changed. Know what to do.</span><a href="/watch">Watch another API ↗</a></footer>
    </main>
  );
}
