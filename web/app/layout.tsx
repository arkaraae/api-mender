import type { Metadata } from 'next';
import './globals.css';
import './site.css';
import './join-cta.css';
import './demo.css';
import './brand.css';
import './public.css';

export const metadata: Metadata = { title: 'API Mender · API change monitor', description: 'Review evidence, impact, and patches for integration changes.' };
// DM Sans for the public pages, JetBrains Mono for the top bar, requests and code (see app/public.css).
const FONTS = 'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;900&family=JetBrains+Mono:wght@400;500;700&display=swap';

export default function Layout({children}:{children:React.ReactNode}) {
  return <html lang="en">
    <head>
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
      <link rel="stylesheet" href={FONTS} />
    </head>
    <body>{children}</body>
  </html>;
}
