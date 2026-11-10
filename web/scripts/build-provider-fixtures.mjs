// Regenerates tests/fixtures/github-rest from the official GitHub REST API
// descriptions. The slices are produced by the engine itself, so a fixture is
// exactly what the pipeline would cut from the full document.
//
//   node scripts/build-provider-fixtures.mjs <api.github.com.2022-11-28.json> <api.github.com.2026-03-10.json>

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { sliceOperation } from '../lib/engine/openapi-slice.ts';
import { contractSourceFor, getProvider } from '../lib/engine/providers/registry.ts';

const operations = {
  'issues-create': 'POST /repos/{owner}/{repo}/issues',
  'issues-update': 'PATCH /repos/{owner}/{repo}/issues/{issue_number}',
  'teams-create': 'POST /orgs/{org}/teams',
  'orgs-update': 'PATCH /orgs/{org}',
  'workflow-dispatch': 'POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches',
  // Unchanged between the two versions; the control case.
  'issue-comment-create': 'POST /repos/{owner}/{repo}/issues/{issue_number}/comments',
};
const versions = ['2022-11-28', '2026-03-10'];
const paths = process.argv.slice(2);
if (paths.length !== versions.length) {
  console.error('usage: node scripts/build-provider-fixtures.mjs <2022-11-28.json> <2026-03-10.json>');
  process.exit(2);
}

const provider = getProvider('github-rest');
const target = new URL('../tests/fixtures/github-rest/', import.meta.url);
await mkdir(target, { recursive: true });
for (const [index, version] of versions.entries()) {
  const document = JSON.parse(await readFile(paths[index], 'utf8'));
  const sourceUrl = contractSourceFor(provider, version).url;
  for (const [name, operation] of Object.entries(operations)) {
    const slice = await sliceOperation(document, operation, { providerId: provider.id, version, sourceUrl });
    if (!slice) throw new Error(`${operation} could not be sliced from ${version}`);
    await writeFile(new URL(`${name}.${version}.json`, target), `${JSON.stringify(slice, null, 2)}\n`);
    console.log(`${name}.${version}.json ${slice.sha256}`);
  }
}
