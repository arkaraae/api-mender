import type { Metadata } from 'next';
import { EntryFlow } from '@/components/mend-concept/EntryFlow';

export const metadata: Metadata = { title: 'Get in touch · Mend' };

export default function Contact() {
  return <div className="mend-concept"><EntryFlow initialRoute="contact" /></div>;
}
