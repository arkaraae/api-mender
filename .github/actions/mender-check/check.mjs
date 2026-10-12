// The API Mender GitHub check: for each API description a pull request changes, explain in plain
// words what the change means for people who call the API, and whether Mender can keep old
// callers working. Writes Markdown to $OUTPUT and exits 1 when FAIL_ON=breaks and old callers
// lose something.
//
// Env: SPECS (paths, separated by spaces or new lines), BASE_SHA, HEAD_SHA, REPO (owner/name),
//      OUTPUT (file for the Markdown), FAIL_ON (breaks | never), SITE (default https://apimender.com)
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { proveWithSchemas, rulesFromOpenApi } from '../../../mender/src/openapi.js';
import { summarize } from '../../../web/lib/mender/report.js';

const specs = (process.env.SPECS ?? '').split(/\s+/).filter(Boolean);
const base = process.env.BASE_SHA;
const head = process.env.HEAD_SHA;
const repo = process.env.REPO;
const site = (process.env.SITE ?? 'https://apimender.com').replace(/\/$/, '');
const failOn = process.env.FAIL_ON ?? 'never';

async function parse(text) {
  const trimmed = text.trim();
  if (/^[{[]/.test(trimmed)) return JSON.parse(trimmed);
  const { load } = await import('js-yaml');
  return load(trimmed);
}

function atBase(path) {
  try { return execFileSync('git', ['show', `${base}:${path}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; }
}

const ICON = { bridged: '🟢 Mender bridges this', lost: '🔴 Old callers lose this', gone: '🔴 Endpoint removed' };
const VERDICT = { safe: '✅', bridged: '🟢', breaks: '🔴' };
const cell = (text) => String(text ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');

const sections = [];
let breaks = false;
for (const path of specs) {
  if (!existsSync(path)) { sections.push(`### \`${path}\`\nThis file was removed in this pull request.`); continue; }
  const before = atBase(path);
  if (before === null) { sections.push(`### \`${path}\`\nNew API description: nothing to compare yet.`); continue; }
  const after = readFileSync(path, 'utf8');
  if (before === after) continue;
  let oldSpec;
  let newSpec;
  try { [oldSpec, newSpec] = [await parse(before), await parse(after)]; } catch (error) {
    sections.push(`### \`${path}\`\nCould not read it: ${error.message}`);
    continue;
  }
  const found = rulesFromOpenApi(oldSpec, newSpec);
  const proof = proveWithSchemas(oldSpec, newSpec, found.rules);
  const report = summarize({ found, proof });
  if (report.verdict === 'breaks') breaks = true;
  const lines = [`### ${VERDICT[report.verdict]} \`${path}\`: ${report.headline}`, '', report.detail, ''];
  if (report.items.length) {
    lines.push('| | What changed for old callers | Where |', '|---|---|---|');
    for (const item of report.items.slice(0, 25)) lines.push(`| ${ICON[item.kind]} | ${cell(item.title)} | ${cell(item.scope)} |`);
    if (report.items.length > 25) lines.push(`| | …and ${report.items.length - 25} more | |`);
    lines.push('');
  }
  if (report.attention.length) {
    lines.push(`<details><summary>${report.attention.length} thing${report.attention.length === 1 ? '' : 's'} worth a look</summary>`, '');
    for (const note of report.attention.slice(0, 30)) lines.push(`- ${note.blocking ? '🔴 ' : ''}${note.message}`);
    lines.push('', '</details>', '');
  }
  lines.push(`Checked ${report.counts.endpoints} endpoint${report.counts.endpoints === 1 ? '' : 's'}; proof on ${proof.samples} generated sample${proof.samples === 1 ? '' : 's'} ${proof.ok ? 'passed' : 'did not pass'}.`);
  if (repo && base && head) {
    const raw = (sha) => `https://raw.githubusercontent.com/${repo}/${sha}/${path}`;
    lines.push(`[Open it on API Mender](${site}/check?before=${encodeURIComponent(raw(base))}&after=${encodeURIComponent(raw(head))}) to see the fix for a caller's code.`);
  }
  sections.push(lines.join('\n'));
}

const markdown = sections.length
  ? ['## API Mender', '', ...sections.flatMap((section) => [section, ''])].join('\n')
  : '## API Mender\n\nNo API description changed in this pull request.';
if (process.env.OUTPUT) writeFileSync(process.env.OUTPUT, markdown);
console.log(markdown);
if (failOn === 'breaks' && breaks) {
  console.error('Old callers lose something in this change (fail-on: breaks).');
  process.exit(1);
}
