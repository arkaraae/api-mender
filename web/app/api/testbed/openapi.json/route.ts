import { NextResponse } from 'next/server';
import { fetchQuotesContract, quotesOpenApi } from '@/lib/quotes-testbed';

export async function GET() {
  try {
    const { contract, commit } = await fetchQuotesContract();
    return NextResponse.json(quotesOpenApi(contract), { headers: { 'cache-control': 'no-store', 'x-mender-contract-commit': commit, 'x-mender-contract-version': String(contract.version) } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Quotes contract unavailable' }, { status: 502, headers: { 'cache-control': 'no-store' } });
  }
}
