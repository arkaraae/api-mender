import type { Metadata } from 'next';
import { EntryFlow } from '@/components/mend-concept/EntryFlow';
import AuthCallbackRedirect from '@/components/auth-callback-redirect';

export const metadata: Metadata = {
  title: 'Mend · Know before an API change breaks your code',
  description: 'Mend finds every external API your code calls, watches those APIs for breaking changes, and opens a reviewed fix.',
};

export default function Home() {
  return <div className="mend-concept"><AuthCallbackRedirect /><EntryFlow initialRoute="home" /></div>;
}
