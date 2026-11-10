import type { ProviderAdapter } from '../types.ts';

// Official OpenAPI descriptions published by the provider, one per dated API
// version. With no version header the provider serves defaultVersion.
const description = (version: string) =>
  `https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.${version}.json`;
const changelogUrl = 'https://github.com/github/rest-api-description/blob/main/descriptions/api.github.com/CHANGELOG.md';

export const githubRest: ProviderAdapter = {
  id: 'github-rest',
  name: 'GitHub REST API',
  origins: ['https://api.github.com'],
  versionHeader: 'x-github-api-version',
  defaultVersion: '2022-11-28',
  contractSources: ['2022-11-28', '2026-03-10'].map(version => (
    { version, url: description(version), format: 'openapi-json', changelogUrl }
  )),
};
