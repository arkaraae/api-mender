import type { Metadata } from 'next';
import { EntryFlow } from '@/components/mend-concept/EntryFlow';

export const metadata: Metadata = { title: 'Mend · Workspace demo' };

export default function WorkspaceDemo() {
  return <div className="mend-concept"><EntryFlow initialRoute="workspace" /></div>;
}
