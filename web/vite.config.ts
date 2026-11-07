import { cloudflare, getLocalWorkerdCompatibilityDate } from '@cloudflare/vite-plugin';
import vinext from 'vinext';
import { defineConfig } from 'vite';

export default defineConfig(({ command }) => ({
  plugins: [
    vinext(),
    cloudflare({
      viteEnvironment: { name: 'rsc', childEnvironments: ['ssr'] },
      // `npm run dev` runs the Workers runtime installed with the packages, which can be older
      // than the compatibility date in wrangler.jsonc. Locally only, use the newest date it
      // supports; builds and deploys keep the date from wrangler.jsonc.
      ...(command === 'serve' ? {
        config: (config) => {
          const local = getLocalWorkerdCompatibilityDate().date;
          return config.compatibility_date && config.compatibility_date > local ? { compatibility_date: local } : undefined;
        },
      } : {}),
    }),
  ],
}));
