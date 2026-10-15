// Copies the Mender engine into the web app, which is what the live site is built from.
//
//   node mender/tools/sync-web.mjs          copy
//   node mender/tools/sync-web.mjs --check  exit 1 if the copy is out of date
//
// The engine is plain JavaScript with no dependencies, so the copy is the whole integration.
// web/lib/mender/gateway.js is the web app's own file and is not part of the copy.
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const source = resolve(import.meta.dirname, '..', 'src');
const target = resolve(import.meta.dirname, '..', '..', 'web', 'lib', 'mender');
const files = ['rules.js', 'infer.js', 'openapi.js', 'mender.js', 'codefix.js'];

if (process.argv.includes('--check')) {
  const stale = files.filter((file) => !existsSync(join(target, file)) || !readFileSync(join(target, file)).equals(readFileSync(join(source, file))));
  if (stale.length) {
    console.error(`web/lib/mender is out of date (${stale.join(', ')}). Run: node mender/tools/sync-web.mjs`);
    process.exit(1);
  }
  console.log(`web/lib/mender matches mender/src (${files.length} files).`);
} else {
  mkdirSync(target, { recursive: true });
  for (const file of files) cpSync(join(source, file), join(target, file));
  console.log(`Copied ${files.length} files to web/lib/mender.`);
}
