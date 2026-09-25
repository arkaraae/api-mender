import { createClient } from 'npm:@supabase/supabase-js@2.117.1';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};
const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: cors });
const sha256 = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))).map(byte => byte.toString(16).padStart(2, '0')).join('');
const sources = [
  {
    provider: 'stripe', kind: 'sdk_release',
    apiUrl: 'https://api.github.com/repos/stripe/stripe-node/releases/latest',
    sourceUrl: 'https://github.com/stripe/stripe-node/releases',
    read: (data: Record<string, unknown>) => ({ version: String(data.tag_name || ''), evidenceUrl: String(data.html_url || ''), publishedAt: String(data.published_at || '') }),
  },
  {
    provider: 'stripe', kind: 'openapi',
    apiUrl: 'https://api.github.com/repos/stripe/openapi/contents/latest/openapi.spec3.json',
    sourceUrl: 'https://github.com/stripe/openapi/blob/master/latest/openapi.spec3.json',
    read: (data: Record<string, unknown>) => ({ version: String(data.sha || ''), evidenceUrl: String(data.html_url || ''), publishedAt: '' }),
  },
];

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return respond({ error: 'Method not allowed' }, 405);
  const authorization = request.headers.get('authorization') || '';
  const token = authorization.match(/^Bearer (.+)$/)?.[1];
  if (!token) return respond({ error: 'Sign in required' }, 401);
  const url = Deno.env.get('SUPABASE_URL');
  const publishable = JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') || '{}').default || Deno.env.get('SUPABASE_ANON_KEY');
  const secret = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}').default || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !publishable || !secret) return respond({ error: 'Function configuration is incomplete' }, 503);
  const userClient = createClient(url, publishable, { global: { headers: { Authorization: authorization } }, auth: { persistSession: false, autoRefreshToken: false } });
  const { data: identity, error: authError } = await userClient.auth.getUser(token);
  if (authError || !identity.user) return respond({ error: 'Session expired' }, 401);
  const body = await request.json().catch(() => null);
  const workspaceId = body?.workspaceId;
  if (typeof workspaceId !== 'string' || !/^[a-f0-9-]{36}$/.test(workspaceId)) return respond({ error: 'Invalid workspace' }, 400);
  const { data: workspace, error: workspaceError } = await userClient.from('workspaces').select('id').eq('id', workspaceId).single();
  if (workspaceError || !workspace) return respond({ error: 'Workspace not found' }, 404);
  const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
  const results: { source: string; state: string; version?: string; findings?: number }[] = [];
  try {
    for (const source of sources) {
      const { data: previous, error: previousError } = await admin.from('source_snapshots').select('id,sha256,retrieved_at,metadata').eq('workspace_id', workspaceId).eq('source_url', source.sourceUrl).order('retrieved_at', { ascending: false }).limit(1).maybeSingle();
      if (previousError) throw previousError;
      if (previous && Date.now() - new Date(previous.retrieved_at).getTime() < 5 * 60_000) {
        results.push({ source: source.kind, state: 'recently_checked', version: String(previous.metadata?.version || '') });
        continue;
      }
      const response = await fetch(source.apiUrl, { headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'api-mender-monitor' }, signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`Official source returned ${response.status}`);
      const metadata = source.read(await response.json());
      if (!metadata.version || !metadata.evidenceUrl.startsWith('https://github.com/stripe/')) throw new Error('Official source response was incomplete');
      const digest = await sha256(`${source.kind}:${metadata.version}`);
      if (previous?.sha256 === digest) {
        const { error } = await admin.from('source_snapshots').update({ retrieved_at: new Date().toISOString() }).eq('id', previous.id);
        if (error) throw error;
        results.push({ source: source.kind, state: 'unchanged', version: metadata.version });
        continue;
      }
      const { data: snapshot, error: insertError } = await admin.from('source_snapshots').insert({ workspace_id: workspaceId, provider: source.provider, source_url: source.sourceUrl, sha256: digest, simulated: false, metadata }).select('id').single();
      if (insertError || !snapshot) throw insertError || new Error('Snapshot was not saved');
      let findingCount = 0;
      if (previous) {
        const { data: repositories, error: repoError } = await admin.from('monitored_repositories').select('id,full_name,sdk_version,call_sites').eq('workspace_id', workspaceId).eq('paused', false);
        if (repoError) throw repoError;
        for (const repository of repositories || []) {
          if (!repository.sdk_version && (!Array.isArray(repository.call_sites) || repository.call_sites.length === 0)) continue;
          const fingerprint = await sha256(`${repository.id}:${source.sourceUrl}:${digest}`);
          const title = source.kind === 'sdk_release' ? `Stripe Node release ${metadata.version}` : 'Stripe OpenAPI source updated';
          const description = `The official ${source.kind === 'sdk_release' ? 'Stripe Node SDK release' : 'Stripe OpenAPI file'} changed. Review applicability to this repository; no breaking change has been established.`;
          const { error } = await admin.from('findings').upsert({ workspace_id: workspaceId, repository_id: repository.id, source_id: snapshot.id, fingerprint, title, description, severity: 'low', confidence: 'informational', status: 'Action required', evidence: { sourceUrl: metadata.evidenceUrl, previousVersion: previous.metadata?.version || null, currentVersion: metadata.version, note: 'Source update only; API version applicability and code impact are unverified.' } }, { onConflict: 'repository_id,fingerprint' });
          if (error) throw error;
          findingCount++;
        }
      }
      results.push({ source: source.kind, state: previous ? 'changed' : 'baseline', version: metadata.version, findings: findingCount });
    }
    return respond({ results });
  } catch {
    return respond({ error: 'Official source check failed; retry later' }, 502);
  }
});
