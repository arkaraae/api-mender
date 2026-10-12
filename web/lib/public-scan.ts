type GitHubTreeEntry = { path: string; type: string; mode: string; size: number };
type CallSite = { file: string; line: number; symbol: string; endpoint: string; fields: string[]; uncertain: boolean; reason: string };

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const branchPattern = /^[A-Za-z0-9_./-]{1,120}$/;
const ignoredDirectory = /(^|\/)(node_modules|dist|build|vendor|fixtures|examples|__tests__|\.next)\//;

async function githubJson(url: string): Promise<any> {
  const response = await fetch(url, { headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'api-mender-site' }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
  return response.json();
}

export function extractCalls(file: string, source: string): CallSite[] {
  const found: CallSite[] = [];
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
  const eligible = (tree.tree as GitHubTreeEntry[]).filter(file => file.type === 'blob' && file.mode === '100644' && Number.isInteger(file.size) && file.size <= 300_000 && file.path.length <= 256 && /^(package(-lock)?\.json|[^/].*\.[cm]?[jt]sx?)$/.test(file.path) && !ignoredDirectory.test(file.path) && !file.path.split('/').some(part => part === '.' || part === '..'));
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
  let sdkVersion: string | null = null;
  for (const manifest of ['package.json', 'package-lock.json']) {
    const body = contents.get(manifest);
    if (!body) continue;
    try {
      const parsed = JSON.parse(body);
      sdkVersion = manifest === 'package.json' ? parsed.dependencies?.stripe || sdkVersion : parsed.packages?.['node_modules/stripe']?.version || sdkVersion;
    } catch { throw new Error(`Could not read ${manifest}`); }
  }
  let apiVersion: string | null = null;
  const calls: CallSite[] = [];
  const files: string[] = [];
  const tests: string[] = [];
  for (const [file, source] of contents) {
    if (!/\.[cm]?[jt]sx?$/.test(file) || file.endsWith('.d.ts')) continue;
    if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(file)) { tests.push(file); continue; }
    if (!/stripe|paymentIntents/.test(source)) continue;
    files.push(file);
    if (!apiVersion) apiVersion = source.match(/apiVersion\s*:\s*['"`]([^'"`]+)['"`]/)?.[1] || null;
    calls.push(...extractCalls(file, source).filter(call => call.endpoint === 'POST /v1/payment_intents'));
  }
  const limitations = ['Text scan flags possible calls for review; it does not prove API impact or parse request fields', 'Fixture, example, build, and test files are excluded'];
  if (!sdkVersion) limitations.push('Stripe SDK version not found in root manifests');
  if (!apiVersion) limitations.push('Stripe API version not statically discoverable');
  if (!calls.length) limitations.push('No recognizable paymentIntents.create calls found; dynamic calls may exist');
  return { head, inventory: { provider: 'stripe', sdkVersion, apiVersion, files, calls, tests, limitations }, scannedAt: new Date().toISOString() };
}
