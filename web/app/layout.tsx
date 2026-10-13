import type { Metadata } from 'next';
import './globals.css';
import './site.css';
import './demo.css';
import './brand.css';
import './public.css';

export const metadata: Metadata = { title: 'API Mender · API change monitor', description: 'Review evidence, impact, and patches for integration changes.' };
// Familjen Grotesk for the public pages, Martian Mono for requests and code (see app/home.css).
const FONTS = 'https://fonts.googleapis.com/css2?family=Familjen+Grotesk:wght@400;500;600;700&family=Martian+Mono:wght@400;500&display=swap';

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
