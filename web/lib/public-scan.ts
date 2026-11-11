import { parseApiCalls, sharedSdkClients } from './engine/inventory.ts';
import type { SharedClients } from './engine/sdk/js-sdk-calls.ts';
import { readTarGz } from './repo-archive.ts';
import { traceStaticDatabaseWrites, type DatabaseWriteTrace } from './static-database-flow.ts';

type GitHubTreeEntry = { path: string; type: string; mode: string; size: number; sha?: string };
type CallSite = { file: string; line: number; symbol: string; endpoint: string; fields: string[]; uncertain: boolean; reason: string; origin?: string; fieldsComplete?: boolean; bodyLine?: number; databaseWrites?: DatabaseWriteTrace[] };

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const branchPattern = /^[A-Za-z0-9_./-]{1,120}$/;
const ignoredDirectory = /(^|\/)(node_modules|dist|build|vendor|fixtures|examples|__tests__|\.next|\.venv|venv|site-packages|__pycache__)\//;
const sourcePattern = /\.([cm]?[jt]sx?|py)$/;
const testPattern = /(\.(test|spec)\.[cm]?[jt]sx?$)|((^|\/)(test_[^/]*|[^/]*_test|conftest)\.py$)|((^|\/)tests?\/[^/]*\.py$)/;
// One archive download per scan; these bound what is read from it.
const archiveLimits = { maxArchiveBytes: 60_000_000, maxFiles: 1_500, maxFileBytes: 300_000, maxTotalBytes: 25_000_000 };
const eligiblePath = (path: string, size: number) => size <= 300_000 && path.length <= 256 && sourcePattern.test(path)
  && !path.endsWith('.d.ts') && !ignoredDirectory.test(path) && !path.split('/').some(part => part === '.' || part === '..');

async function githubJson(url: string, token = process.env.GITHUB_READ_TOKEN?.trim()): Promise<any> {
  const response = await fetch(url, { headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'api-mender-site', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, redirect: 'manual', signal: AbortSignal.timeout(15000) });
  if (!response.ok) {
    if (response.status === 403 || response.status === 429) {
      if (response.headers.get('x-ratelimit-remaining') === '0') throw new Error('GitHub API rate limit reached. Add a repository-scoped GITHUB_READ_TOKEN to the Cloudflare Worker.');
      throw new Error('GitHub denied repository access. Check the repository and the GITHUB_READ_TOKEN permissions.');
    }
    throw new Error(`GitHub returned ${response.status}`);
  }
  return response.json();
}

export function extractCalls(file: string, source: string, shared?: SharedClients): CallSite[] {
  // parseApiCalls is a superset of parseStaticHttpCalls: it also reads
  // template-literal URLs, literal headers (for API version pins), official
  // SDK clients and Python.
  const found: CallSite[] = parseApiCalls(file, source, shared).map(call => ({ ...call, uncertain: true,
    reason: call.sdk ? `Official SDK method ${call.sdk}; runtime behavior has not been verified`
      : call.fieldsComplete ? 'Literal request keys parsed; runtime behavior has not been verified'
      : 'Static HTTP URL found; request body or runtime behavior has not been verified' }));
  if (!/\.[cm]?[jt]sx?$/.test(file)) return found;
  const addHttpCall = (offset: number, symbol: string, method: string, address: string) => {
    if (address.includes('${')) return;
    let url: URL;
    try { url = new URL(address); } catch { return; }
    if (url.protocol !== 'https:' || url.username || url.password) return;
    const line = source.slice(0, offset).split('\n').length;
    const endpoint = `${method.toUpperCase()} ${url.pathname}`;
    if (found.some(call => call.line === line && call.endpoint === endpoint && call.origin === url.origin)) return;
    found.push({ file, line, symbol,
      endpoint, origin: url.origin, fields: [], uncertain: true,
      reason: 'Static HTTP URL found; request fields and runtime behavior have not been verified' });
  };
  // Only literal HTTPS calls with an unambiguous method are recorded. Dynamic
  // URLs and request options require a parser and explicit consumer binding.
  for (const match of source.matchAll(/\bfetch\s*\(\s*(['"`])(https:\/\/[^'"`\s]+)\1\s*,\s*\{\s*method\s*:\s*(['"`])(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\3/gi)) {
    addHttpCall(match.index, 'fetch', match[4], match[2]);
  }
  for (const match of source.matchAll(/\bfetch\s*\(\s*(['"`])(https:\/\/[^'"`\s]+)\1\s*\)/g)) {
    addHttpCall(match.index, 'fetch', 'GET', match[2]);
  }
  for (const match of source.matchAll(/\baxios\.(get|post|put|patch|delete|head|options)\s*\(\s*(['"`])(https:\/\/[^'"`\s]+)\2/gi)) {
    addHttpCall(match.index, `axios.${match[1].toLowerCase()}`, match[1], match[3]);
  }
  const flows = source.includes('supabase') && /\.(insert|upsert)\s*\(/.test(source)
    ? traceStaticDatabaseWrites(file, source) : [];
  for (const call of found) {
    const writes = flows.find(flow => flow.callLine === call.line && flow.endpoint === call.endpoint
      && flow.origin === call.origin)?.databaseWrites;
    if (writes?.length) call.databaseWrites = writes;
  }
  return found;
}

export async function scanPublicRepository(fullName: string, branch: string) {
  if (!repositoryPattern.test(fullName) || !branchPattern.test(branch) || branch.includes('..')) throw new Error('Invalid repository or branch');
  const repositoryPath = fullName.split('/').map(encodeURIComponent).join('/');
  const repo = await githubJson(`https://api.github.com/repos/${repositoryPath}`);
  if (repo.private || repo.archived) throw new Error('Only active public repositories can be scanned');
  const branchInfo = await githubJson(`https://api.github.com/repos/${repositoryPath}/branches/${encodeURIComponent(branch)}`);
  const head = branchInfo.commit?.sha;
  if (typeof head !== 'string' || !/^[a-f0-9]{40}$/.test(head)) throw new Error('GitHub did not return a valid commit');
  // Public archives come from the codeload host without credentials.
  const response = await fetch(`https://codeload.github.com/${repositoryPath}/tar.gz/${head}`, { redirect: 'error', signal: AbortSignal.timeout(60_000) });
  if (!response.ok || !response.body) throw new Error(`GitHub archive returned ${response.status}`);
  const contents = await readTarGz(response.body, eligiblePath, archiveLimits);
  return { head, inventory: inventoryFromContents(contents), scannedAt: new Date().toISOString() };
}

// Installation scans download the commit's archive with a short-lived token
// scoped to this repository. GitHub answers with a redirect to a signed
// codeload URL; the token is never sent to that host.
export async function scanInstallationRepository(fullName: string, head: string, token: string) {
  if (!repositoryPattern.test(fullName) || !/^[a-f0-9]{40}$/.test(head)) throw new Error('Invalid repository scan');
  const repositoryPath = fullName.split('/').map(encodeURIComponent).join('/');
  const redirect = await fetch(`https://api.github.com/repos/${repositoryPath}/tarball/${head}`, {
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'api-mender-site', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    redirect: 'manual', signal: AbortSignal.timeout(15_000) });
  const location = redirect.headers.get('location');
  if (redirect.status !== 302 || !location) throw new Error(`GitHub archive returned ${redirect.status}`);
  const signed = new URL(location);
  if (signed.protocol !== 'https:' || signed.hostname !== 'codeload.github.com') throw new Error('GitHub archive redirect was not to codeload.github.com');
  const response = await fetch(signed, { redirect: 'error', signal: AbortSignal.timeout(60_000) });
  if (!response.ok || !response.body) throw new Error(`GitHub archive returned ${response.status}`);
  const contents = await readTarGz(response.body, eligiblePath, archiveLimits);
  return { head, inventory: inventoryFromContents(contents), scannedAt: new Date().toISOString() };
}

// Every external API call the parser can attribute to a fixed https origin or
// an official SDK client. No provider is special-cased here: the provider
// catalog decides later which of these APIs have a published contract.
export function inventoryFromContents(contents: Map<string, string>) {
  const calls: CallSite[] = [];
  const files: string[] = [];
  const tests: string[] = [];
  const sources = [...contents].filter(([file]) => sourcePattern.test(file) && !file.endsWith('.d.ts') && !ignoredDirectory.test(file));
  const shared = sharedSdkClients(sources.filter(([file]) => !testPattern.test(file)).map(([path, source]) => ({ path, source })));
  for (const [file, source] of sources) {
    if (testPattern.test(file)) { tests.push(file); continue; }
    const found = extractCalls(file, source, shared);
    if (!found.length) continue;
    files.push(file);
    calls.push(...found);
  }
  const tooManyCalls = calls.length > 500;
  if (tooManyCalls) calls.length = 500;
  const limitations = ['Static scan flags possible calls for review; it does not prove runtime API impact', 'Fixture, example, build, virtualenv and test files are excluded',
    'Detected: fetch, axios, requests and httpx calls with a fixed https origin (written out, or a const in the same file), and official SDK clients for GitHub (Octokit), Stripe, OpenAI and Twilio in JavaScript, TypeScript and Python; URLs from other files or the environment are not'];
  if (calls.length) limitations.push('Only complete literal request bodies have known field names, and no call has been run by the scanner');
  if (tooManyCalls) limitations.push('Only the first 500 call sites were retained');
  if (!calls.length) limitations.push('No external API calls with a fixed https origin or a recognised SDK client were found; dynamic calls may exist');
  // provider/sdkVersion/apiVersion keep the stored shape; they no longer name an SDK.
  return { provider: 'http', sdkVersion: null as string | null, apiVersion: null as string | null, files, calls, tests, limitations };
}
