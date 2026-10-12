import { NextRequest, NextResponse } from 'next/server';
import { fetchQuotesContract } from '@/lib/quotes-testbed';

export async function POST(request: NextRequest) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) return NextResponse.json({ error: 'Send JSON' }, { status: 415 });
  const text = await request.text();
  if (text.length > 4096) return NextResponse.json({ error: 'Request too large' }, { status: 413 });
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid body');
    body = parsed as Record<string, unknown>;
  } catch { return NextResponse.json({ error: 'Invalid JSON object' }, { status: 400 }); }
  try {
    const { contract, commit } = await fetchQuotesContract();
    const identity = body[contract.acceptedIdentityField];
    if (typeof identity !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(identity) || !Number.isInteger(body.amountCents) || (body.amountCents as number) < 1 || (body.amountCents as number) > 1_000_000) {
      return NextResponse.json({ error: 'Request does not satisfy the active contract', required: contract.requiredRequestFields, version: contract.version }, { status: 422, headers: { 'cache-control': 'no-store', 'x-mender-contract-commit': commit } });
    }
    return NextResponse.json({ id: `quote_test_${crypto.randomUUID()}`, identity, amountCents: body.amountCents, contractVersion: contract.version }, { headers: { 'cache-control': 'no-store', 'x-mender-contract-commit': commit } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Quotes API unavailable' }, { status: 502, headers: { 'cache-control': 'no-store' } });
  }
}
