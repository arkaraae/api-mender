// Hashing shared by slices and findings. Web Crypto only, so the same digest
// comes out of the Worker, the CLI and tests.

const maxDepth = 64;

export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

// JSON with object keys in code-unit order, so equal values hash equally
// whatever order a provider or parser emitted them in. Keys are written as
// text, never assigned, so `__proto__` is ordinary data. Nesting past the
// bound throws rather than truncating: two different values must not share a
// hash, and a recursive walk over hostile input must not exhaust the stack.
export function canonicalJson(value: unknown, depth = 0): string {
  if (depth > maxDepth) throw new RangeError('Value is nested too deeply to hash');
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item, depth + 1)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const members = Object.keys(record).sort()
    .filter(key => record[key] !== undefined && typeof record[key] !== 'function')
    .map(key => `${JSON.stringify(key)}:${canonicalJson(record[key], depth + 1)}`);
  return `{${members.join(',')}}`;
}
