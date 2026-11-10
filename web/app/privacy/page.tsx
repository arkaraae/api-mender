import type { Metadata } from 'next';
import { EntryFlow } from '@/components/mend-concept/EntryFlow';

export const metadata: Metadata = { title: 'Privacy · Mend' };

export default function Privacy() {
  return <div className="mend-concept"><EntryFlow initialRoute="privacy" /></div>;
}
