import type { ContractSource, ProviderAdapter } from '../types.ts';
import { githubRest } from './github-rest.ts';

// Adding a provider: write one adapter file and add it to this list. Nothing
// else in the engine names a provider.
const providers: ProviderAdapter[] = [
  githubRest,
];

export function listProviders(): ProviderAdapter[] {
  return [...providers];
}

export function getProvider(id: string): ProviderAdapter | null {
  return providers.find(provider => provider.id === id) ?? null;
}

// Origins are compared whole. A host that merely starts or ends with a
// provider's host (api.example.com.evil.test) is a different origin.
export function providerForOrigin(origin: string, catalog: ProviderAdapter[] = providers): ProviderAdapter | null {
  return catalog.find(provider => provider.origins.includes(origin)) ?? null;
}

export function contractSourceFor(provider: ProviderAdapter, version: string): ContractSource | null {
  return provider.contractSources.find(source => source.version === version) ?? null;
}
