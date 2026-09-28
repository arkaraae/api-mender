'use client';

import { useEffect } from 'react';

export default function AuthCallbackRedirect() {
  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    if (fragment.has('access_token') && fragment.has('refresh_token')) {
      window.location.replace(`/live${window.location.hash}`);
    }
  }, []);
  return null;
}
