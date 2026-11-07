// Runs every test file from the command line:  node mender/tests/run.mjs [filter]
// The same files run in a browser at /tests/.
import { suites } from './suites.js';

const filter = process.argv[2]?.toLowerCase();
let passed = 0;
let failed = 0;
for (const [name, tests] of suites) {
  const selected = tests.filter(([title]) => !filter || `${name} ${title}`.toLowerCase().includes(filter));
  if (!selected.length) continue;
  console.log(`\n${name}`);
  for (const [title, test] of selected) {
    try {
      await test();
      passed += 1;
      console.log(`  ok    ${title}`);
    } catch (error) {
      failed += 1;
      console.log(`  FAIL  ${title}\n        ${String(error?.stack ?? error).split('\n').slice(0, 3).join('\n        ')}`);
    }
  }
}
console.log(`\n${passed} of ${passed + failed} passed`);
process.exit(failed ? 1 : 0);
