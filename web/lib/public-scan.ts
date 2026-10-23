type GitHubTreeEntry = { path: string; type: string; mode: string; size: number; sha?: string };
type CallSite = { file: string; line: number; symbol: string; endpoint: string; fields: string[]; uncertain: boolean; reason: string; origin?: string };

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const branchPattern = /^[A-Za-z0-9_./-]{1,120}$/;
const ignoredDirectory = /(^|\/)(node_modules|dist|build|vendor|fixtures|examples|__tests__|\.next)\//;

async function githubJson(url: string, token = process.env.GITHUB_READ_TOKEN?.trim()): Promise<any> {
  const response = await fetch(url, { headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'api-mender-site', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (!response.ok) {
    if (response.status === 403 || response.status === 429) {
      if (response.headers.get('x-ratelimit-remaining') === '0') throw new Error('GitHub API rate limit reached. Add a repository-scoped GITHUB_READ_TOKEN to the Cloudflare Worker.');
      throw new Error('GitHub denied repository access. Check the repository and the GITHUB_READ_TOKEN permissions.');
    }
    throw new Error(`GitHub returned ${response.status}`);
  }
  return response.json();
}

export function extractCalls(file: string, source: string): CallSite[] {
  const found: CallSite[] = [];
  const addHttpCall = (offset: number, symbol: string, method: string, address: string) => {
    if (address.includes('${')) return;
    let url: URL;
    try { url = new URL(address); } catch { return; }
    if (url.protocol !== 'https:' || url.username || url.password) return;
    found.push({ file, line: source.slice(0, offset).split('\n').length, symbol,
      endpoint: `${method.toUpperCase()} ${url.pathname}`, origin: url.origin, fields: [], uncertain: true,
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
  const pattern = /\.paymentIntents\.create\s*\(/g;
  for (const match of source.matchAll(pattern)) {
    const offset = match.index + match[0].length;
    const argument = source.slice(offset).trimStart();
    const literal = argument.startsWith('{');
    const line = source.slice(0, match.index).split('\n').length;
    found.push({ file, line, symbol: 'paymentIntents.create', endpoint: 'POST /v1/payment_intents', fields: [], uncertain: true, reason: literal ? 'Text scan found a request object; field mapping requires review' : 'Dynamic request body; field mapping unresolved' });
  }
  if (/from\s*['"]@aws-sdk\/client-s3['"]|require\s*\(\s*['"]@aws-sdk\/client-s3['"]\s*\)/.test(source)) {
    for (const match of source.matchAll(/\bnew\s+(PutObject|GetObject)Command\s*\(/g)) {
      const operation = match[1];
      found.push({ file, line: source.slice(0, match.index).split('\n').length, symbol: `${operation}Command`, endpoint: `S3 ${operation}`, fields: [], uncertain: true, reason: 'Command construction found; request fields and upstream impact require model comparison' });
    }
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
  const commit = await githubJson(`https://api.github.com/repos/${repositoryPath}/git/commits/${head}`);
  if (!/^[a-f0-9]{40}$/.test(commit.tree?.sha || '')) throw new Error('GitHub did not return a valid tree');
  const tree = await githubJson(`https://api.github.com/repos/${repositoryPath}/git/trees/${commit.tree.sha}?recursive=1`);
  if (tree.truncated || !Array.isArray(tree.tree)) throw new Error('GitHub tree was incomplete');
  const eligible = (tree.tree as GitHubTreeEntry[]).filter(file => file.type === 'blob' && file.mode === '100644' && Number.isInteger(file.size) && file.size <= 300_000 && file.path.length <= 256 && /(^|\/)package(-lock)?\.json$|\.[cm]?[jt]sx?$/.test(file.path) && !ignoredDirectory.test(file.path) && !file.path.split('/').some(part => part === '.' || part === '..'));
  if (eligible.length > 80 || eligible.reduce((total, file) => total + file.size, 0) > 5_000_000) throw new Error('Repository exceeds the public scan limit');
  const contents = new Map<string, string>();
  for (let offset = 0; offset < eligible.length; offset += 8) {
    await Promise.all(eligible.slice(offset, offset + 8).map(async file => {
      const path = file.path.split('/').map(encodeURIComponent).join('/');
      const response = await fetch(`https://raw.githubusercontent.com/${repositoryPath}/${head}/${path}`, { signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`GitHub file fetch returned ${response.status}`);
      const body = await response.arrayBuffer();
      if (body.byteLength > file.size + 1024 || body.byteLength > 300_000) throw new Error('GitHub file exceeded its size limit');
      contents.set(file.path, new TextDecoder().decode(body));
    }));
  }
  return { head, inventory: inventoryFromContents(contents), scannedAt: new Date().toISOString() };
}

// Installation scans read blobs through api.github.com with a short-lived token
// scoped to this repository. The token is never sent to the raw content host.
export async function scanInstallationRepository(fullName: string, head: string, token: string) {
  if (!repositoryPattern.test(fullName) || !/^[a-f0-9]{40}$/.test(head) || !token) throw new Error('Invalid repository scan');
  const repositoryPath = fullName.split('/').map(encodeURIComponent).join('/');
  const commit = await githubJson(`https://api.github.com/repos/${repositoryPath}/git/commits/${head}`, token);
  if (!/^[a-f0-9]{40}$/.test(commit.tree?.sha || '')) throw new Error('GitHub did not return a valid tree');
  const tree = await githubJson(`https://api.github.com/repos/${repositoryPath}/git/trees/${commit.tree.sha}?recursive=1`, token);
  if (tree.truncated || !Array.isArray(tree.tree)) throw new Error('GitHub tree was incomplete');
  const eligible = (tree.tree as GitHubTreeEntry[]).filter(file => file.type === 'blob' && file.mode === '100644' && Number.isInteger(file.size) && file.size <= 300_000 && file.path.length <= 256 && /(^|\/)package(-lock)?\.json$|\.[cm]?[jt]sx?$/.test(file.path) && !ignoredDirectory.test(file.path) && /^[a-f0-9]{40}$/.test(file.sha || ''));
  if (eligible.length > 80 || eligible.reduce((total, file) => total + file.size, 0) > 5_000_000) throw new Error('Repository exceeds the scan limit');
  const contents = new Map<string, string>();
  for (let offset = 0; offset < eligible.length; offset += 8) {
    await Promise.all(eligible.slice(offset, offset + 8).map(async file => {
      const blob = await githubJson(`https://api.github.com/repos/${repositoryPath}/git/blobs/${file.sha}`, token);
      if (blob.encoding !== 'base64' || typeof blob.content !== 'string' || blob.size !== file.size) throw new Error('GitHub blob was incomplete');
      const decoded = Uint8Array.from(atob(blob.content.replace(/\s/g, '')), char => char.charCodeAt(0));
      if (decoded.byteLength !== file.size || decoded.byteLength > 300_000) throw new Error('GitHub blob exceeded its size limit');
      contents.set(file.path, new TextDecoder('utf-8', { fatal: true }).decode(decoded));
    }));
  }
  return { head, inventory: inventoryFromContents(contents), scannedAt: new Date().toISOString() };
}

function inventoryFromContents(contents: Map<string, string>) {
  const declaredVersions: Record<string, Set<string>> = { stripe: new Set(), '@aws-sdk/client-s3': new Set() };
  const lockedVersions: Record<string, Set<string>> = { stripe: new Set(), '@aws-sdk/client-s3': new Set() };
  for (const [manifest, body] of contents) {
    if (!/(^|\/)package(-lock)?\.json$/.test(manifest)) continue;
    try {
      const parsed = JSON.parse(body);
      for (const dependency of Object.keys(declaredVersions)) {
        const declared = parsed.dependencies?.[dependency] || parsed.devDependencies?.[dependency] || parsed.peerDependencies?.[dependency];
        const locked = parsed.packages?.[`node_modules/${dependency}`]?.version;
        if (typeof declared === 'string') declaredVersions[dependency].add(declared);
        if (typeof locked === 'string') lockedVersions[dependency].add(locked);
      }
    } catch { throw new Error(`Could not read ${manifest}`); }
  }
  let apiVersion: string | null = null;
  const calls: CallSite[] = [];
  const files: string[] = [];
  const tests: string[] = [];
  for (const [file, source] of contents) {
    if (!/\.[cm]?[jt]sx?$/.test(file) || file.endsWith('.d.ts')) continue;
    if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(file)) { tests.push(file); continue; }
    if (!/stripe|paymentIntents|@aws-sdk\/client-s3|\bfetch\s*\(|\baxios\./.test(source)) continue;
    const found = extractCalls(file, source);
    if (!found.length) continue;
    files.push(file);
    if (!apiVersion && found.some(call => call.endpoint.startsWith('POST /v1/'))) apiVersion = source.match(/apiVersion\s*:\s*['"`]([^'"`]+)['"`]/)?.[1] || null;
    calls.push(...found);
  }
  const tooManyCalls = calls.length > 200;
  if (tooManyCalls) calls.length = 200;
  const s3Calls = calls.filter(call => call.endpoint.startsWith('S3 '));
  const stripeCalls = calls.filter(call => call.endpoint.startsWith('POST /v1/'));
  const httpCalls = calls.filter(call => Boolean(call.origin));
  const provider = s3Calls.length && stripeCalls.length ? 'aws-s3+stripe' : s3Calls.length ? 'aws-s3' : stripeCalls.length ? 'stripe' : 'http';
  const packageName = s3Calls.length ? '@aws-sdk/client-s3' : 'stripe';
  const sdkVersions = lockedVersions[packageName].size ? lockedVersions[packageName] : declaredVersions[packageName];
  const sdkVersion = sdkVersions.size === 1 ? [...sdkVersions][0] : null;
  const limitations = ['Text scan flags possible calls for review; it does not prove API impact or parse request fields', 'Fixture, example, build, and test files are excluded'];
  if (sdkVersions.size > 1) limitations.push('Multiple SDK versions were found; the version at each call site requires review');
  else if (!sdkVersion && (s3Calls.length || stripeCalls.length)) limitations.push(`${s3Calls.length ? 'S3' : 'Stripe'} SDK version not found in scanned manifests`);
  if (stripeCalls.length && !apiVersion) limitations.push('Stripe API version not statically discoverable');
  if (httpCalls.length) limitations.push('HTTP calls are static URL candidates only; they have not been tied to a contract or tested');
  if (tooManyCalls) limitations.push('Only the first 200 call sites were retained');
  if (!calls.length) limitations.push('No recognizable Stripe, S3, or literal HTTPS call sites found; dynamic calls may exist');
  return { provider, sdkVersion, apiVersion, files, calls, tests, limitations };
}
