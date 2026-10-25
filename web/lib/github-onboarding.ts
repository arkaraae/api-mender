import { createClient } from '@supabase/supabase-js';
import { env } from 'cloudflare:workers';
import { backendAdmin } from '@/lib/backend-admin';

export const uuid = /^[a-f0-9-]{36}$/i;
export const statePattern = /^[A-Za-z0-9_-]{43}$/;
export const githubHeaders = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'api-mender-onboarding',
};

export function randomState() {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256(value: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

export function base64urlSha256(hex: string) {
  const bytes = Uint8Array.from(hex.match(/../g) || [], byte => parseInt(byte, 16));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function authenticatedEditor(request: Request, workspaceId?: string) {
  const token = request.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1];
  if (!token || !env.NEXT_PUBLIC_SUPABASE_URL || !env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) return null;
  const client = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) return null;
  if (workspaceId) {
    const { data: member, error: memberError } = await client.from('workspace_members')
      .select('role').eq('workspace_id', workspaceId).eq('user_id', data.user.id).maybeSingle();
    if (memberError || !member || !['owner', 'editor'].includes(member.role)) return null;
  }
  return { user: data.user, client };
}

export function onboardingDatabase() { return backendAdmin(env); }

export function githubConfiguration() {
  const clientId = env.GITHUB_APP_CLIENT_ID;
  const clientSecret = env.GITHUB_APP_CLIENT_SECRET;
  const origin = env.SITE_ORIGIN;
  if (!clientId || !clientSecret || !origin || !origin.startsWith('https://')) return null;
  return { clientId, clientSecret, origin, callback: `${origin}/live/github` };
}

export async function githubJson<T>(url: string, token: string): Promise<T> {
  const response = await fetch(url, {
    headers: { ...githubHeaders, Authorization: `Bearer ${token}` },
    redirect: 'error', signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
  return response.json() as Promise<T>;
}
