import type { Metadata } from 'next';
import { EntryFlow } from '@/components/mend-concept/EntryFlow';

export const metadata: Metadata = { title: 'Security · Mend' };

export default function Security() {
  return <div className="mend-concept"><EntryFlow initialRoute="security" /></div>;
}
