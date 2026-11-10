import type { Metadata } from 'next';
import { EntryFlow } from '@/components/mend-concept/EntryFlow';

export const metadata: Metadata = { title: 'Sign in · Mend' };

export default function Login() {
  return <div className="mend-concept"><EntryFlow initialRoute="login" /></div>;
}
