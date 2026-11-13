import type { Metadata } from 'next';
import { EntryFlow } from '@/components/mend-concept/EntryFlow';

export const metadata: Metadata = { title: 'Terms · Mend' };

export default function Terms() {
  return <div className="mend-concept"><EntryFlow initialRoute="terms" /></div>;
}
