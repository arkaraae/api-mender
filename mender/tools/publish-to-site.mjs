// Copies Mender Studio into the site's public folder, so the site serves it at /studio/.
//
//   node mender/tools/publish-to-site.mjs          copy
//   node mender/tools/publish-to-site.mjs --check  exit 1 if the copy is out of date
//
// The Studio is plain files with no build step, so the copy is the deployment.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const target = resolve(root, '..', 'public', 'studio');
const wanted = ['index.html', 'walkthrough.html', 'src', 'sandbox'];

function files(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files(path, out);
    else out.push(path);
  }
  return out;
}

const sources = wanted.flatMap((name) => (statSync(join(root, name)).isDirectory() ? files(join(root, name)) : [join(root, name)]));

if (process.argv.includes('--check')) {
  const stale = sources.filter((file) => {
    const copy = join(target, relative(root, file));
    return !existsSync(copy) || !readFileSync(copy).equals(readFileSync(file));
  });
  const extra = existsSync(target) ? files(target).filter((copy) => !sources.includes(join(root, relative(target, copy)))) : [];
  if (stale.length || extra.length) {
    console.error(`public/studio is out of date (${stale.length} changed, ${extra.length} left over). Run: node mender/tools/publish-to-site.mjs`);
    process.exit(1);
  }
  console.log(`public/studio matches mender/ (${sources.length} files).`);
} else {
  rmSync(target, { recursive: true, force: true });
  for (const file of sources) {
    const copy = join(target, relative(root, file));
    mkdirSync(dirname(copy), { recursive: true });
    cpSync(file, copy);
  }
  console.log(`Copied ${sources.length} files to public/studio.`);
}
