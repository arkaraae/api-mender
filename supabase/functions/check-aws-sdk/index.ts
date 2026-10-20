import { createClient } from 'npm:@supabase/supabase-js@2.117.1';

const sourceUrl = 'https://github.com/aws/aws-sdk-js-v3/releases';
const apiUrl = 'https://api.github.com/repos/aws/aws-sdk-js-v3/releases/latest';
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: cors });
const sha256 = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))).map(byte => byte.toString(16).padStart(2, '0')).join('');

Deno.serve(async (request: Request) => {
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
  try {
    const { data: previous, error: lookupError } = await admin.from('source_snapshots').select('id,sha256,retrieved_at,metadata').eq('workspace_id', workspaceId).eq('source_url', sourceUrl).order('retrieved_at', { ascending: false }).limit(1).maybeSingle();
    if (lookupError) throw lookupError;
    if (previous && Date.now() - new Date(previous.retrieved_at).getTime() < 5 * 60_000) {
      return respond({ state: 'recently_checked', release: previous.metadata, checkedAt: previous.retrieved_at });
    }

    const response = await fetch(apiUrl, {
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'api-mender-monitor' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return respond({ error: `Official AWS SDK release source returned ${response.status}` }, 502);
    const release = await response.json() as Record<string, unknown>;
    const version = release.tag_name;
    const publishedAt = release.published_at;
    const evidenceUrl = release.html_url;
    if (release.draft || release.prerelease || typeof version !== 'string' || !/^v3\.\d+\.\d+$/.test(version) || typeof publishedAt !== 'string' || Number.isNaN(Date.parse(publishedAt)) || typeof evidenceUrl !== 'string' || !/^https:\/\/github\.com\/aws\/aws-sdk-js-v3\/releases\/tag\/v3\.\d+\.\d+$/.test(evidenceUrl)) {
      return respond({ error: 'Official AWS SDK release response was incomplete' }, 502);
    }

    const metadata = {
      kind: 'aws_sdk_js_v3_release',
      version,
      publishedAt,
      evidenceUrl,
      summary: typeof release.body === 'string' ? release.body.replace(/\[[^\]]*\]\([^)]*\)/g, '').replace(/[#*`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 700) : '',
    };
    const digest = await sha256(`aws-sdk-js-v3:${metadata.version}`);
    const checkedAt = new Date().toISOString();
    if (previous?.sha256 === digest) {
      const { error } = await admin.from('source_snapshots').update({ retrieved_at: checkedAt }).eq('id', previous.id);
      if (error) throw error;
      return respond({ state: 'unchanged', release: metadata, checkedAt });
    }

    const { data: snapshot, error: insertError } = await admin.from('source_snapshots').upsert({ workspace_id: workspaceId, provider: 'aws', source_url: sourceUrl, sha256: digest, simulated: false, retrieved_at: checkedAt, metadata }, { onConflict: 'workspace_id,source_url,sha256' }).select('id').single();
    if (insertError || !snapshot) throw insertError || new Error('Snapshot was not saved');
    let findings = 0;
    if (previous) {
      const { data: repositories, error: repoError } = await admin.from('monitored_repositories').select('id,head_sha,call_sites').eq('workspace_id', workspaceId).eq('paused', false).limit(101);
      if (repoError) throw repoError;
      if ((repositories || []).length > 100) throw new Error('Workspace exceeds the source check limit');
      for (const repository of repositories || []) {
        const calls = (Array.isArray(repository.call_sites) ? repository.call_sites : []).filter((call: { endpoint?: unknown }) => typeof call?.endpoint === 'string' && call.endpoint.startsWith('S3 '));
        if (!calls.length) continue;
        const fingerprint = await sha256(`${repository.id}:${sourceUrl}:${digest}`);
        const { error } = await admin.from('findings').upsert({
          workspace_id: workspaceId, repository_id: repository.id, source_id: snapshot.id, fingerprint,
          title: `AWS SDK for JavaScript ${metadata.version} released`,
          description: `The official AWS SDK v3 release changed. This repository contains ${calls.length} possible S3 command call site(s). Review the release and S3 model diff; no breaking change or code impact has been proven.`,
          severity: 'low', confidence: 'informational', status: 'Action required', base_sha: repository.head_sha,
          evidence: { sourceUrl: metadata.evidenceUrl, previousVersion: previous.metadata?.version || null, currentVersion: metadata.version, note: 'Release detection only. This is not a failing test or a verified repair.', callSites: calls.slice(0, 25) },
        }, { onConflict: 'repository_id,fingerprint' });
        if (error) throw error;
        findings++;
      }
    }
    return respond({ state: previous ? 'changed' : 'baseline', release: metadata, previousVersion: previous?.metadata?.version || null, checkedAt, findings });
  } catch {
    return respond({ error: 'AWS SDK source check failed; retry later' }, 502);
  }
});
