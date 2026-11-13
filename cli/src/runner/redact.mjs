// Best-effort secret scrubbing for captured check output.
//
// This is a pattern scrub, not a guarantee: it recognises common token
// shapes and `name=value` assignments whose name looks secret. The primary
// protection is that the sandbox starts from an EMPTY environment, so the
// caller's credentials are not there to be printed in the first place, and
// that logs stay on the local machine. Redaction is the second line.

export const REDACTED = '[REDACTED]';

/** Whole-match token shapes. */
const TOKEN_PATTERNS = [
  // PEM private keys (multi-line).
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  // GitHub: classic/OAuth/app tokens and fine-grained PATs.
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  // AWS access key ids.
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  // OpenAI/Anthropic/Stripe style `sk-...`, `sk_live_...`, `rk_live_...`.
  /\b(?:sk|rk|pk)[-_](?:live_|test_|proj-|ant-)?[A-Za-z0-9_-]{20,}\b/g,
  // Slack.
  /\bxox[abeprs]-[A-Za-z0-9-]{10,}\b/g,
  // Google API keys.
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  // npm tokens.
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  // JSON Web Tokens.
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
];

/** Patterns where only a captured part is secret; `$1` (prefix) is kept. */
const KEEP_PREFIX_PATTERNS = [
  // Authorization headers.
  /\b((?:Bearer|Basic|token)\s+)[A-Za-z0-9._~+/=-]{16,}/gi,
  // Credentials inside URLs: scheme://user:password@host
  /\b([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+(?=@)/gi,
  // name = value, where the name looks like a credential.
  /\b([A-Za-z0-9_.-]{0,64}(?:api[_-]?key|secret|token|passw(?:or)?d|credential|private[_-]?key)[A-Za-z0-9_.-]{0,64}["']?[ \t]{0,8}[:=][ \t]{0,8}["']?)[^\s"',;]{6,512}/gi,
];

/**
 * Replaces things that look like credentials with `[REDACTED]`.
 * @param {string} text
 * @returns {string}
 */
export function redactSecrets(text) {
  if (typeof text !== 'string' || text.length === 0) return '';
  let out = text;
  for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, REDACTED);
  for (const pattern of KEEP_PREFIX_PATTERNS) out = out.replace(pattern, `$1${REDACTED}`);
  return out;
}
