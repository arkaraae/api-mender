import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openStageDatabase(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_versions (
      version INTEGER PRIMARY KEY,
      identity_field TEXT NOT NULL,
      change_note TEXT NOT NULL,
      published_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS products (
      sku TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );
  `);
  db.prepare('INSERT OR IGNORE INTO api_versions(version,identity_field,change_note) VALUES (1,?,?)')
    .run('customerId', 'Initial staging contract.');
  db.prepare('INSERT OR IGNORE INTO products(sku,name,amount_cents) VALUES (?,?,?)')
    .run('WIDGET-1', 'Staging Widget', 2500);
  return db;
}

export function stageOpenApi(api) {
  return {
    openapi: '3.0.3',
    info: { title: 'API Mender Staging Quote API', version: `${api.version}.0.0`, description: api.change_note },
    paths: { '/api/managed/quotes': { post: {
      operationId: 'createManagedQuote',
      requestBody: { required: true, content: { 'application/json': { schema: {
        type: 'object', required: [api.identity_field, 'sku'],
        properties: { [api.identity_field]: { type: 'string' }, sku: { type: 'string' } },
      } } } },
      responses: { '200': { description: 'Quote created' }, '404': { description: 'Product not found' }, '422': { description: 'Request does not match the published contract' } },
    } } },
  };
}
