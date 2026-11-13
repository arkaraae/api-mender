// One self-contained file for npm: the server, the engine and its parser.
import { build } from 'esbuild';

await build({
  entryPoints: [new URL('../src/server.mjs', import.meta.url).pathname],
  outfile: new URL('../dist/mender-mcp.mjs', import.meta.url).pathname,
  bundle: true, platform: 'node', format: 'esm', target: 'node22', minify: false, legalComments: 'inline',
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
});
console.log('built dist/mender-mcp.mjs');
