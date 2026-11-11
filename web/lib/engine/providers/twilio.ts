import type { ProviderAdapter } from '../types.ts';

// Twilio's 2010-04-01 API (Messaging, Voice) published in twilio/twilio-oai.
// The version is in the path, so contract edits apply to every caller.
// Request properties are PascalCase (To, From, Body); SDKs write them camelCase.
export const twilio: ProviderAdapter = {
  id: 'twilio',
  name: 'Twilio API',
  origins: ['https://api.twilio.com'],
  versioning: 'snapshot',
  snapshotApplicability: 'active',
  fieldCase: 'pascal',
  snapshot: { repository: 'twilio/twilio-oai', path: 'spec/json/twilio_api_v2010.json', branch: 'main' },
  contractSources: [{
    version: '2026-05-06',
    url: 'https://raw.githubusercontent.com/twilio/twilio-oai/bb6288e9f540d2d63540bbaadf6b73fd262c2df3/spec/json/twilio_api_v2010.json',
    format: 'openapi-json',
    changelogUrl: 'https://github.com/twilio/twilio-oai/blob/main/CHANGES.md',
  }],
};
