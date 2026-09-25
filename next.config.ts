import type { NextConfig } from 'next';
const config: NextConfig = { turbopack: { root: import.meta.dirname }, serverExternalPackages: ['typescript'] };
export default config;
