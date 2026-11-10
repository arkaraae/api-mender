import type { Metadata } from 'next';
import { EntryFlow } from '@/components/mend-concept/EntryFlow';
import AuthCallbackRedirect from '@/components/auth-callback-redirect';

export const metadata: Metadata = {
  title: 'Mend · Make every API change a safe one',
  description: 'Compare API versions, prove the translation, and keep older callers working through the gateway.',
};

export default function Home() {
  return <div className="mend-concept"><AuthCallbackRedirect /><EntryFlow initialRoute="home" /></div>;
}
