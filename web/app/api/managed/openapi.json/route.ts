import { NextRequest, NextResponse } from 'next/server';
import { loadManagedApiVersion, managedOpenApi } from '@/lib/managed-api';

export async function GET(request: NextRequest) {
  const raw = request.nextUrl.searchParams.get('version');
  if (raw && !/^[1-9][0-9]{0,5}$/.test(raw)) return NextResponse.json({ error: 'Invalid version' }, { status: 400 });
  try {
    const api = await loadManagedApiVersion(raw ? Number(raw) : undefined);
    return NextResponse.json(managedOpenApi(api), { headers: { 'cache-control': 'no-store', 'x-mender-api-version': String(api.version) } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'API unavailable' }, { status: 503, headers: { 'cache-control': 'no-store' } });
  }
}
