import type { ProviderAdapter } from '../types.ts';

// Stripe publishes the contract of its newest API version in stripe/openapi
// and edits it in place. Breaking changes reach an integration only when its
// account (or a request's Stripe-Version) moves to a newer API version.
export const stripe: ProviderAdapter = {
  id: 'stripe',
  name: 'Stripe API',
  origins: ['https://api.stripe.com'],
  versionHeader: 'stripe-version',
  versioning: 'snapshot',
  snapshotApplicability: 'on-upgrade',
  snapshot: { repository: 'stripe/openapi', path: 'openapi/spec3.json', branch: 'master' },
  contractSources: [{
    version: '2026-05-23',
    url: 'https://raw.githubusercontent.com/stripe/openapi/fbd00919865b69647f714ba1c02adced187d4664/openapi/spec3.json',
    format: 'openapi-json',
    changelogUrl: 'https://docs.stripe.com/changelog',
  }],
};
