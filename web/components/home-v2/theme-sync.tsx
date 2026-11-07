'use client';

import { useEffect } from 'react';

// Applies the light/dark choice saved by the site header, for pages that have no header of their own.
export default function ThemeSync() {
  useEffect(() => {
    try {
      const saved = localStorage.getItem('am-theme');
      if (saved === 'light' || saved === 'dark') document.documentElement.setAttribute('data-theme', saved);
    } catch {}
  }, []);
  return null;
}
