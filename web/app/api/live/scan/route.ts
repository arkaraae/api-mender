import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';
import { scanPublicRepository } from '@/lib/public-scan';

export async function POST(request: NextRequest) {
  const token = request.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1];
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!token) return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
  if (!url || !key) return NextResponse.json({ error: 'Supabase is not configured' }, { status: 503 });
  const supabase = createClient(url, key, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false, autoRefreshToken: false } });
  const { data: identity, error: authError } = await supabase.auth.getUser(token);
  if (authError || !identity.user) return NextResponse.json({ error: 'Session expired' }, { status: 401 });
  const body = await request.json().catch(() => null) as { repositoryId?: unknown } | null;
  if (typeof body?.repositoryId !== 'string' || !/^[a-f0-9-]{36}$/.test(body.repositoryId)) return NextResponse.json({ error: 'Invalid repository' }, { status: 400 });
  const { data: repository, error: lookupError } = await supabase.from('monitored_repositories').select('id,full_name,branch,visibility,paused').eq('id', body.repositoryId).single();
  if (lookupError || !repository) return NextResponse.json({ error: 'Repository not found' }, { status: 404 });
  if (repository.paused || repository.visibility !== 'public') return NextResponse.json({ error: 'Only active public repositories can be scanned' }, { status: 409 });
  try {
    const result = await scanPublicRepository(repository.full_name, repository.branch);
    const { error } = await supabase.from('monitored_repositories').update({ head_sha: result.head, sdk_version: result.inventory.sdkVersion, api_version: result.inventory.apiVersion, call_sites: result.inventory.calls, limitations: result.inventory.limitations, scanned_at: result.scannedAt }).eq('id', repository.id);
    if (error) throw new Error('Could not save scan result');
    return NextResponse.json({ head: result.head, inventory: result.inventory, scannedAt: result.scannedAt });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Scan failed' }, { status: 502 });
  }
}
