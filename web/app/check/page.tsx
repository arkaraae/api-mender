import type { Metadata } from 'next';
import BrandLogo from '@/components/brand-logo';
import ChangeCheck from '@/components/change-check';
import SiteNav from '@/components/site-nav';
import './check.css';

export const metadata: Metadata = {
  title: 'Check an API change · API Mender',
  description: 'Compare two versions of an API: every change in plain words, whether old callers can be kept working, and the fix for your code.',
};

export default function CheckPage() {
  return (
    <main className="marketing-page">
      <SiteNav current="/check" />
      <ChangeCheck />
      <footer className="marketing-footer"><span className="site-brand"><BrandLogo /></span><span>Know what changed. Know what to do.</span><a href="/mender">See the gateway ↗</a></footer>
    </main>
  );
}
