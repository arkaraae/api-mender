import type { ProviderAdapter } from '../types.ts';

// OpenAI publishes one live contract in openai/openai-openapi; there is no
// version header, so a change applies to every caller once it ships.
export const openai: ProviderAdapter = {
  id: 'openai',
  name: 'OpenAI API',
  origins: ['https://api.openai.com'],
  basePath: '/v1',
  versioning: 'snapshot',
  snapshotApplicability: 'active',
  snapshot: { repository: 'openai/openai-openapi', path: 'openapi.json', branch: 'main' },
  contractSources: [{
    version: '2026-07-16',
    url: 'https://raw.githubusercontent.com/openai/openai-openapi/bcb644949593744091c6cef593fd8d9e45b37eaa/openapi.json',
    format: 'openapi-json',
    changelogUrl: 'https://platform.openai.com/docs/changelog',
  }],
};
