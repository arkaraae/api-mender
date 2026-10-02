import { createClient } from '@supabase/supabase-js';

const slug = 'quote-api';

export type ManagedApiVersion = {
  apiId: string;
  version: number;
  identityField: string;
  changeNote: string;
  publishedAt: string;
};

function publicDatabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error('API database is not configured');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export async function loadManagedApiVersion(requestedVersion?: number): Promise<ManagedApiVersion> {
  const database = publicDatabase();
  const { data: api, error: apiError } = await database.from('managed_apis').select('id').eq('slug', slug).eq('is_public', true).single();
  if (apiError || !api) throw new Error('Published API is unavailable');
  let query = database.from('managed_api_versions').select('version,identity_field,change_note,published_at').eq('api_id', api.id);
  query = requestedVersion ? query.eq('version', requestedVersion) : query.order('version', { ascending: false }).limit(1);
  const { data: rows, error: versionError } = await query;
  if (versionError || !rows?.[0]) throw new Error('Published API version is unavailable');
  const row = rows[0];
  if (!Number.isInteger(row.version) || typeof row.identity_field !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(row.identity_field)) throw new Error('Published API version is invalid');
  return { apiId: api.id, version: row.version, identityField: row.identity_field, changeNote: row.change_note, publishedAt: row.published_at };
}

export async function loadProduct(apiId: string, sku: string) {
  const { data, error } = await publicDatabase().from('managed_api_products').select('sku,name,amount_cents').eq('api_id', apiId).eq('sku', sku).eq('active', true).maybeSingle();
  if (error) throw new Error('Could not load product');
  return data as { sku: string; name: string; amount_cents: number } | null;
}

export function managedOpenApi(api: ManagedApiVersion) {
  return {
    openapi: '3.0.3',
    info: { title: 'API Mender Managed Quote API', version: `${api.version}.0.0`, description: api.changeNote || 'Published from the API Mender workspace database.' },
    paths: { '/api/managed/quotes': { post: {
      operationId: 'createManagedQuote',
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: [api.identityField, 'sku'], properties: { [api.identityField]: { type: 'string' }, sku: { type: 'string' } } } } } },
      responses: { '200': { description: 'Quote created', content: { 'application/json': { schema: { type: 'object', required: ['id', 'sku', 'amountCents', 'contractVersion'], properties: { id: { type: 'string' }, sku: { type: 'string' }, amountCents: { type: 'integer' }, contractVersion: { type: 'integer' } } } } } }, '404': { description: 'Product not found' }, '422': { description: 'Request does not match the published contract' } },
    } } },
  };
}
