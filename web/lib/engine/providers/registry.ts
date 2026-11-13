import type { ContractSource, ProviderAdapter } from '../types.ts';
import { githubRest } from './github-rest.ts';
import { openai } from './openai.ts';
import { stripe } from './stripe.ts';
import { twilio } from './twilio.ts';

// Adding a provider: write one adapter file and add it to this list. Nothing
// else in the engine names a provider.
const providers: ProviderAdapter[] = [
  githubRest,
  stripe,
  openai,
  twilio,
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

// A call's endpoint as the provider's contract writes it: the contract's
// server path (OpenAI's /v1) is not part of its operation keys.
export function contractEndpoint(provider: ProviderAdapter, endpoint: string): string {
  const base = provider.basePath;
  if (!base) return endpoint;
  const space = endpoint.indexOf(' ');
  const path = endpoint.slice(space + 1);
  return path === base || path.startsWith(`${base}/`) ? `${endpoint.slice(0, space)} ${path.slice(base.length) || '/'}` : endpoint;
}
