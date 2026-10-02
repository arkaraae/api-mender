'use client';

import { useCallback, useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';

type Api = { id: string; title: string };
type Version = { version: number; identity_field: string; change_note: string; published_at: string };
type Product = { sku: string; name: string; amount_cents: number; active: boolean };

export default function ManagedApiStudio({ database, workspaceId, userId }: { database: SupabaseClient; workspaceId: string; userId: string }) {
  const [api, setApi] = useState<Api | null>(null);
  const [version, setVersion] = useState<Version | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [identityField, setIdentityField] = useState('');
  const [changeNote, setChangeNote] = useState('');
  const [sku, setSku] = useState('');
  const [productName, setProductName] = useState('');
  const [amountCents, setAmountCents] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    const { data: apiRow, error: apiError } = await database.from('managed_apis').select('id,title').eq('workspace_id', workspaceId).eq('slug', 'quote-api').maybeSingle();
    if (apiError) { setMessage(apiError.message); return; }
    if (!apiRow) { setMessage('Quote API is not assigned to this workspace.'); return; }
    setApi(apiRow as Api);
    const [versionResult, productResult] = await Promise.all([
      database.from('managed_api_versions').select('version,identity_field,change_note,published_at').eq('api_id', apiRow.id).order('version', { ascending: false }).limit(1),
      database.from('managed_api_products').select('sku,name,amount_cents,active').eq('api_id', apiRow.id).order('sku'),
    ]);
    if (versionResult.error || productResult.error) { setMessage(versionResult.error?.message || productResult.error?.message || 'Could not load API'); return; }
    const latest = (versionResult.data?.[0] as Version | undefined) || null;
    setVersion(latest);
    setIdentityField(latest?.identity_field || 'customerId');
    setProducts((productResult.data || []) as Product[]);
  }, [database, workspaceId]);

  useEffect(() => { void load(); }, [load]);

  async function publish() {
    if (!api || !version || !/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(identityField) || identityField === 'sku' || identityField === version.identity_field) return;
    setBusy(true); setMessage('');
    const { error } = await database.from('managed_api_versions').insert({ api_id: api.id, version: version.version + 1, identity_field: identityField, change_note: changeNote.trim(), published_by: userId });
    setMessage(error?.message || `Published API v${version.version + 1}. Mender will check the new contract.`);
    if (!error) { setChangeNote(''); await load(); }
    setBusy(false);
  }

  async function saveProduct() {
    if (!api || !/^[A-Za-z0-9_-]{1,40}$/.test(sku) || !productName.trim() || !Number.isInteger(Number(amountCents)) || Number(amountCents) < 1) return;
    setBusy(true); setMessage('');
    const { error } = await database.from('managed_api_products').upsert({ api_id: api.id, sku, name: productName.trim(), amount_cents: Number(amountCents), active: true }, { onConflict: 'api_id,sku' });
    setMessage(error?.message || `Saved ${sku} in the API database.`);
    if (!error) { setSku(''); setProductName(''); setAmountCents(''); await load(); }
    setBusy(false);
  }

  return <section className="live-card managed-api-studio">
    <div className="managed-api-heading"><div><h2>Your Quote API</h2><p>These published versions and products live in your Supabase database. Other codebases can call the public endpoint.</p></div><span className="live-badge">{version ? `v${version.version}` : 'LOADING'}</span></div>
    <p><a href="/api/managed/openapi.json" target="_blank" rel="noopener noreferrer">OpenAPI contract ↗</a> · <a href="https://github.com/arkaraae/api-mender/actions/workflows/managed-quote-api.yml" target="_blank" rel="noopener noreferrer">Mender monitor runs ↗</a></p>
    {version && <><p className="live-muted">Published request fields: <strong>{version.identity_field}</strong> and <strong>sku</strong>. Latest version published {new Date(version.published_at).toLocaleString()}.</p>
      <p>Call <code>POST /api/managed/quotes</code> with <code>{JSON.stringify({ [version.identity_field]: 'customer_1', sku: products[0]?.sku || 'WIDGET-1' })}</code>.</p>
      <div className="live-fields"><label>Required identity field<input value={identityField} maxLength={40} onChange={event => setIdentityField(event.target.value)} /></label><label>Change note<input value={changeNote} maxLength={1000} placeholder="Explain whether the identifier meaning changed" onChange={event => setChangeNote(event.target.value)} /></label></div>
      <p className="live-muted">Publishing a different required field changes the live API immediately. Mender is scheduled to check the consumer every five minutes and attempts an AI repair when a key is configured.</p>
      <button disabled={busy || identityField === version.identity_field || !/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(identityField) || identityField === 'sku'} onClick={() => void publish()}>Publish API v{version.version + 1}</button>
    </>}
    <h3>Products returned by the API</h3>
    <div className="live-list">{products.map(product => <article key={product.sku}><div><strong>{product.sku} · {product.name}</strong><small>{product.amount_cents} cents · {product.active ? 'Active' : 'Inactive'}</small></div><button disabled={busy} onClick={() => { setSku(product.sku); setProductName(product.name); setAmountCents(String(product.amount_cents)); }}>Edit</button></article>)}</div>
    <div className="live-fields"><label>SKU<input value={sku} maxLength={40} onChange={event => setSku(event.target.value)} /></label><label>Name<input value={productName} maxLength={120} onChange={event => setProductName(event.target.value)} /></label><label>Price in cents<input type="number" min="1" max="100000000" value={amountCents} onChange={event => setAmountCents(event.target.value)} /></label></div>
    <button disabled={busy || !sku || !productName.trim() || !amountCents} onClick={() => void saveProduct()}>Save product</button>
    {message && <p className="live-message" role="status">{message}</p>}
  </section>;
}
