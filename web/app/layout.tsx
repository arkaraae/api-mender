import type { Metadata } from 'next';
import './globals.css';
import './site.css';
import './demo.css';
import './brand.css';

export const metadata: Metadata = { title: 'API Mender · API change monitor', description: 'Review evidence, impact, and patches for integration changes.' };
export default function Layout({children}:{children:React.ReactNode}) {return <html lang="en"><body>{children}</body></html>}
