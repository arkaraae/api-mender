import { NextRequest, NextResponse } from 'next/server';
import { loadManagedApiVersion, loadProduct } from '@/lib/managed-api';

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type', 'cache-control': 'no-store' };

export async function OPTIONS() { return new Response(null, { status: 204, headers: cors }); }

export async function POST(request: NextRequest) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) return NextResponse.json({ error: 'Send JSON' }, { status: 415, headers: cors });
  const text = await request.text();
  if (text.length > 4096) return NextResponse.json({ error: 'Request too large' }, { status: 413, headers: cors });
  let body: Record<string, unknown>;
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid JSON object');
    body = value as Record<string, unknown>;
  } catch { return NextResponse.json({ error: 'Invalid JSON object' }, { status: 400, headers: cors }); }
  try {
    const api = await loadManagedApiVersion();
    const identity = body[api.identityField];
    const sku = body.sku;
    if (typeof identity !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(identity) || typeof sku !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(sku)) {
      return NextResponse.json({ error: 'Request does not match the published contract', required: [api.identityField, 'sku'], version: api.version }, { status: 422, headers: cors });
    }
    const product = await loadProduct(api.apiId, sku);
    if (!product) return NextResponse.json({ error: 'Product not found' }, { status: 404, headers: cors });
    return NextResponse.json({ id: `quote_${crypto.randomUUID()}`, sku: product.sku, product: product.name, amountCents: product.amount_cents, contractVersion: api.version }, { headers: cors });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'API unavailable' }, { status: 503, headers: cors });
  }
}
