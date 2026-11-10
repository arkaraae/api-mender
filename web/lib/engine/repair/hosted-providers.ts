// Hosted AI providers that customer source code must never be sent to.
//
// This list is defence in depth, not the control. The control is that the
// operator configures an inference endpoint they run themselves; the list only
// catches the obvious misconfiguration of pointing that setting at a public
// API. A host missing from this list is not thereby approved.
//
// This is the only file under repair/ allowed to name these hosts (a test
// greps for that).

/** Matched against the hostname itself and as a `.suffix`, case-insensitively. */
export const HOSTED_AI_PROVIDER_DOMAINS: readonly string[] = [
  'openai.com', 'chatgpt.com', 'oaiusercontent.com',
  'anthropic.com', 'claude.ai', 'claude.com',
  'generativelanguage.googleapis.com', 'aiplatform.googleapis.com',
  'openai.azure.com', 'cognitiveservices.azure.com', 'services.ai.azure.com', 'inference.ai.azure.com',
  'models.github.ai', 'githubcopilot.com',
  'mistral.ai',
  'cohere.com', 'cohere.ai',
  'groq.com',
  'together.xyz', 'together.ai',
  'fireworks.ai',
  'openrouter.ai',
  'deepseek.com',
  'x.ai',
  'perplexity.ai',
  'replicate.com',
  'huggingface.co',
  'deepinfra.com',
  'cerebras.ai',
  'sambanova.ai',
  'inference.net',
  'ai21.com',
  'novita.ai',
  'hyperbolic.xyz',
  'anyscale.com',
  'lepton.ai',
  'voyageai.com',
];

/** Providers whose hostnames embed a region, so a suffix cannot name them. */
export const HOSTED_AI_PROVIDER_PATTERNS: readonly RegExp[] = [
  // bedrock.us-east-1.amazonaws.com, bedrock-runtime-fips.us-west-2.amazonaws.com, bedrock-agent-runtime.…
  /(^|\.)bedrock(-[a-z-]+)?\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/,
  /(^|\.)bedrock(-[a-z-]+)?\.[a-z0-9-]+\.api\.aws$/,
  // us-central1-aiplatform.googleapis.com
  /(^|[.-])aiplatform\.googleapis\.com$/,
];

/** True when `hostname` belongs to a known hosted AI provider. */
export function isHostedAiProviderHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return HOSTED_AI_PROVIDER_DOMAINS.some(domain => host === domain || host.endsWith(`.${domain}`))
    || HOSTED_AI_PROVIDER_PATTERNS.some(pattern => pattern.test(host));
}
