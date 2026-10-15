import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { openStageDatabase, stageOpenApi } from './database.mjs';

const db = openStageDatabase(resolve(process.env.MENDER_STAGE_DB || 'data/managed-stage.sqlite'));
const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/api/managed/openapi.json') {
    const requested = url.searchParams.get('version');
    if (requested && !/^[1-9][0-9]{0,5}$/.test(requested)) return send(res, 400, { error: 'Invalid version' });
    const api = requested
      ? db.prepare('SELECT * FROM api_versions WHERE version = ?').get(Number(requested))
      : db.prepare('SELECT * FROM api_versions ORDER BY version DESC LIMIT 1').get();
    return api ? send(res, 200, stageOpenApi(api)) : send(res, 404, { error: 'Version not found' });
  }
  if (req.method !== 'POST' || url.pathname !== '/api/managed/quotes') return send(res, 404, { error: 'Not found' });
  if (!req.headers['content-type']?.startsWith('application/json')) return send(res, 415, { error: 'Send JSON' });
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw) > 4096) return send(res, 413, { error: 'Request too large' });
  }
  let body;
  try { body = JSON.parse(raw); } catch { return send(res, 400, { error: 'Invalid JSON' }); }
  const api = db.prepare('SELECT * FROM api_versions ORDER BY version DESC LIMIT 1').get();
  const identity = body?.[api.identity_field];
  const sku = body?.sku;
  if (typeof identity !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(identity) ||
      typeof sku !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(sku)) {
    return send(res, 422, { error: 'Request does not match the published contract', required: [api.identity_field, 'sku'], version: api.version });
  }
  const product = db.prepare('SELECT * FROM products WHERE sku = ? AND active = 1').get(sku);
  if (!product) return send(res, 404, { error: 'Product not found' });
  return send(res, 200, { id: `quote_stage_${crypto.randomUUID()}`, sku: product.sku, product: product.name, amountCents: product.amount_cents, contractVersion: api.version });
});

server.listen(Number(process.env.PORT || 0), '127.0.0.1', () => {
  console.log(`MENDER_STAGE_URL=http://127.0.0.1:${server.address().port}`);
});
process.on('SIGTERM', () => server.close(() => db.close()));
