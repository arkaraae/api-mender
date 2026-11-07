import type { NextConfig } from 'next';
const config: NextConfig = {
  turbopack: { root: import.meta.dirname },
  serverExternalPackages: ['typescript'],
  // Mender Studio is plain files under public/studio; these make /studio open it.
  async redirects() {
    return [
      { source: '/studio', destination: '/studio/index.html', permanent: false },
      { source: '/studio/walkthrough', destination: '/studio/walkthrough.html', permanent: false },
    ];
  },
};
export default config;
