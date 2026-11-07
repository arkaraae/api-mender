import type { Metadata } from 'next';
import ChangeCheck from '@/components/change-check';
import SiteFooter from '@/components/home-v2/site-footer';
import SiteHeader from '@/components/home-v2/site-header';
import './check.css';
import '../home-v2.css';
import '../mv2-pages.css';

export const metadata: Metadata = {
  title: 'Check an API change · API Mender',
  description: 'Compare two versions of an API: every change in plain words, whether old callers can be kept working, and the fix for your code.',
};

export default function CheckPage() {
  return (
    <div className="mv2">
    <SiteHeader current="/check" />
    <main className="marketing-page">
      <ChangeCheck />
    </main>
    <SiteFooter />
    </div>
  );
}
