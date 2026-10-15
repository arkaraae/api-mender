import { resolve } from 'node:path';
import { openStageDatabase } from './database.mjs';

if (process.argv[2] !== 'v2') throw new Error('Usage: node testbed/managed-stage/publish.mjs v2');
const db = openStageDatabase(resolve(process.env.MENDER_STAGE_DB || 'data/managed-stage.sqlite'));
try {
  const result = db.prepare('INSERT OR IGNORE INTO api_versions(version,identity_field,change_note) VALUES (2,?,?)')
    .run('accountId', 'Breaking change: accountId replaces customerId.');
  console.log(result.changes ? 'Published staging contract v2.' : 'Staging contract v2 was already published.');
} finally { db.close(); }
