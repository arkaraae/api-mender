// A D1 database for tests: Node's built-in SQLite behind the methods the site uses
// (prepare → bind → all/first/run, and batch), with the site's real migrations applied.
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export function memoryD1() {
  const db = new DatabaseSync(':memory:');
  const migrations = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(migrations).filter((name) => name.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(file, migrations), 'utf8'));
  // SQLite rows have no prototype; D1's are plain objects.
  const plain = (row) => (row ? { ...row } : null);
  const statement = (sql, values = []) => ({
    bind: (...next) => statement(sql, next),
    all: async () => ({ results: db.prepare(sql).all(...values).map(plain) }),
    first: async () => plain(db.prepare(sql).get(...values)),
    run: async () => ({ meta: { changes: db.prepare(sql).run(...values).changes } }),
  });
  return {
    prepare: (sql) => statement(sql),
    // D1 runs a batch as one transaction.
    async batch(statements) {
      db.exec('BEGIN');
      try {
        const results = [];
        for (const s of statements) results.push(await s.all());
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    rows: (sql) => db.prepare(sql).all().map(plain),
  };
}
