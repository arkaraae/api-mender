// Read an untrusted public API description without following a redirect to a private target.
export const MAX_DESCRIPTION_BYTES = 20 * 1024 * 1024;

export class DescriptionTooLargeError extends Error {}

export function publicHttps(raw, what = 'API description') {
  let url;
  try { url = new URL(String(raw ?? '').trim()); } catch { throw new Error(`Enter the full address of the ${what}, starting with https://`); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:') throw new Error(`The ${what} must start with https://`);
  if (url.username || url.password || url.port || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || /^[\d.]+$/.test(host) || host.includes(':')) {
    throw new Error(`The ${what} must be on a public website without embedded credentials or a custom port.`);
  }
  return url;
}

/** @param {string} raw @param {{ fetcher?: typeof fetch, headers?: Record<string, string>, blockedHostname?: string | null }} [options] */
export async function fetchPublicSource(raw, { fetcher = fetch, headers = {}, blockedHostname = null } = {}) {
  let url = publicHttps(raw);
  const signal = AbortSignal.timeout(20_000);
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (url.hostname === blockedHostname) throw new Error('Use the address of another public website.');
    const response = await fetcher(url.href, { headers, redirect: 'manual', signal });
    if (![301, 302, 303, 307, 308].includes(response.status)) return { response, url };
    const location = response.headers.get('location');
    if (!location || redirects === 3) throw new Error('That address redirected too many times.');
    url = publicHttps(new URL(location, url).href);
  }
  throw new Error('That address redirected too many times.');
}

export async function boundedBody(response, maxBytes = MAX_DESCRIPTION_BYTES) {
  if (Number(response.headers.get('content-length') || 0) > maxBytes) throw new DescriptionTooLargeError('The description is larger than 20 MB.');
  const reader = response.body?.getReader();
  if (!reader) return new ArrayBuffer(0);
  const chunks = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maxBytes) {
      await reader.cancel();
      throw new DescriptionTooLargeError('The description is larger than 20 MB.');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes.buffer;
}
