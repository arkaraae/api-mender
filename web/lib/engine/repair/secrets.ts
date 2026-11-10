// Credential detection for two decisions: never send an excerpt that holds a
// secret to a model, and never accept a patch that adds one. Only rule names
// are returned; the matched text must not reach logs, reports or prompts.

const RULES: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: 'aws-access-key', pattern: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[0-9A-Z]{16}\b/ },
  { name: 'github-token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/ },
  { name: 'ai-provider-key', pattern: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { name: 'slack-token', pattern: /\bxox[abeoprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'stripe-live-key', pattern: /\b[sr]k_live_[A-Za-z0-9]{16,}/ },
  { name: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}/ },
  { name: 'private-key', pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/ },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  // A credential-named key or variable assigned a literal. `${…}` templates
  // are references to a value held elsewhere, not the value itself.
  { name: 'credential-assignment',
    pattern: /(?:password|passwd|secret|token|api[_-]?key)[A-Za-z0-9_]*["']?\s*[:=]\s*(?:"[^"\s]{12,}"|'[^'\s]{12,}'|`[^`$\s]{12,}`)/i },
];

/** Names of the secret rules `text` matches. Never returns the matched text. */
export function findSecrets(text: string): string[] {
  return RULES.filter(rule => rule.pattern.test(text)).map(rule => rule.name);
}

/** True when an excerpt must not be shown to a model. */
export function excerptContainsSecret(excerpt: ReadonlyArray<{ text: string }> | string): boolean {
  const text = typeof excerpt === 'string' ? excerpt : excerpt.map(line => line.text).join('\n');
  return findSecrets(text).length > 0;
}
