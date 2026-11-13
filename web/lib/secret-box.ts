// AES-256-GCM for small workspace secrets (a Slack webhook URL). The key is a
// Worker secret (MENDER_SETTINGS_KEY, base64 of 32 bytes); the database holds
// only `v1.<iv>.<ciphertext>` and never the key. The workspace ID is bound as
// additional data, so a ciphertext copied to another workspace does not open.
const encoder = new TextEncoder();
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (text: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(text), char => char.charCodeAt(0));

async function keyFrom(secret: string | undefined) {
  if (!secret) throw new Error('MENDER_SETTINGS_KEY is not configured');
  let raw: Uint8Array<ArrayBuffer>;
  try { raw = unb64(secret.trim()); } catch { throw new Error('MENDER_SETTINGS_KEY is not base64'); }
  if (raw.byteLength !== 32) throw new Error('MENDER_SETTINGS_KEY must be 32 bytes');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function sealSecret(secret: string | undefined, workspaceId: string, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(workspaceId) },
    await keyFrom(secret), encoder.encode(plaintext));
  return `v1.${b64(iv)}.${b64(new Uint8Array(sealed))}`;
}

export async function openSecret(secret: string | undefined, workspaceId: string, sealed: string): Promise<string> {
  const [version, iv, data] = sealed.split('.');
  if (version !== 'v1' || !iv || !data) throw new Error('Unsupported sealed value');
  const opened = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv), additionalData: encoder.encode(workspaceId) },
    await keyFrom(secret), unb64(data));
  return new TextDecoder().decode(opened);
}
